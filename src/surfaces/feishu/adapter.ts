import { textAttachmentBody } from "../text-attachment-store.js";
import {
  isConversationCommandName,
  type ConversationCommandExecutor,
  type ConversationCommandResult,
  type ConversationTurnUseCases,
  type ScheduledTaskConfirmation,
} from "../../application/index.js";
import {
  UserFacingError,
  type ConversationTarget,
} from "../../conversation-core/index.js";
import { formatTurnInputAppended } from "../input-copy.js";
import { parseSlashCommand } from "../slash-command.js";
import {
  formatOperationFailure,
  gatewayRequestFailedText,
  interactionStoppedText,
} from "../output-copy.js";
import { SurfaceInputCoalescer } from "../surface-input-coalescer.js";
import { formatQuotedInput } from "../quoted-input.js";

import type {
  FeishuCommandCenter,
  FeishuCommandCenterAction,
  FeishuCommandCenterChoices,
  FeishuCommandCenterResponse,
} from "./command-center.js";
import {
  renderQueueCommandCenterChoices,
  renderQueueItemChoices,
  renderQueueDeleteConfirmationChoices,
  renderCommandCenterInitialChoices,
  renderScheduleCreateChoices,
  renderScheduleCreateForm,
  renderScheduleTaskChoices,
  renderCommandCenterForm,
  renderCommandCenterChoices,
  renderWorkspacePermissionFieldChoices,
} from "./command-center-presentation.js";
import type { FeishuApplicationSetupController } from "./application-setup.js";
import {
  FeishuFileInputError,
  type FeishuFilePort,
} from "./file-input.js";
import type { FeishuInboxMessage } from "./inbox.js";
import type { FeishuImagePort } from "./media.js";
import {
  maximumFeishuAudioDurationMs,
  type FeishuAudioPort,
} from "./audio.js";
import type { FeishuOutbox } from "./outbox.js";
import type { FeishuOAuthControllerPort } from "./oauth.js";
import {
  renderFeishuDoctor,
  renderFeishuPermissionHelp,
  renderFeishuPermissionStatus,
  type FeishuPermissionRuntimeStatus,
} from "./permissions.js";
import {
  renderFeishuCommandResult,
  renderFeishuHelp,
  renderFeishuIdentity,
  renderFeishuUserFacingError,
} from "./renderer.js";

const maximumInboundImages = 4;
const feishuLocalSlashCommands = new Set([
  "start",
  "help",
  "whoami",
  "fs",
]);
const unsupportedMessageLinkText = [
  "暂不支持通过飞书复制的消息链接读取内容。",
  "请直接回复目标消息，再发送你的要求。",
].join("\n");

export class FeishuConversationAdapter {
  private readonly inputs: SurfaceInputCoalescer;
  private nextInputSequence = 0;

  constructor(
    private readonly conversations: Pick<
      ConversationTurnUseCases,
      "touchActivity" | "submit"
    >,
    private readonly outbox:
      & Pick<FeishuOutbox, "notifyMarkdown" | "notifyText">
      & Partial<Pick<
        FeishuOutbox,
        | "bindPendingTurnReplyTarget"
        | "discardPendingTurnReplyTarget"
        | "prepareTurnReplyTarget"
        | "replyMarkdown"
        | "replyToTurn"
      >>,
    private readonly images: Pick<FeishuImagePort, "download">,
    private readonly commands: ConversationCommandExecutor,
    private readonly permissionStatus: () => FeishuPermissionRuntimeStatus =
      () => ({
        connectionReady: false,
        cardActionObserved: false,
        menuEventObserved: false,
      }),
    private readonly oauth?: FeishuOAuthControllerPort,
    private readonly commandCenter?: Pick<FeishuCommandCenter, "open" | "openResponse">,
    private readonly applicationSetup?: Pick<
      FeishuApplicationSetupController,
      "openDoctor"
    >,
    private readonly interactions?: {
      stopForActor(target: ConversationTarget, actorId: string): boolean;
    },
    private readonly inputOptions: {
      quietWindowMs?: number;
      files?: Pick<FeishuFilePort, "download" | "discard">;
      audios?: Pick<FeishuAudioPort, "download">;
      readQuotedText?(messageId: string): Promise<string | undefined>;
      onQuotedTextError?(error: unknown): void;
      now?: () => number;
      debugEnabled?: boolean;
    } = { quietWindowMs: 0 },
  ) {
    this.inputs = new SurfaceInputCoalescer(
      (target, input) => conversations.submit(target, input),
      inputOptions,
    );
  }

  async presentScheduledTaskConfirmation(
    target: ConversationTarget,
    actorId: string,
    preview: ScheduledTaskConfirmation,
  ): Promise<void> {
    if (!this.commandCenter) return;
    const response = renderCommandCenterChoices("schedule", {
      kind: "scheduled-confirmation",
      preview,
    });
    if (response) {
      await this.commandCenter.openResponse(target, actorId, response);
    }
  }

  async handle(message: FeishuInboxMessage): Promise<void> {
    try {
      this.conversations.touchActivity?.(message.target);
      if (message.kind === "file" || message.kind === "files") {
        await this.handleFile(message);
        return;
      }
      if (message.kind === "audio") {
        await this.handleAudio(message);
        return;
      }
      if (message.kind === "image") {
        await this.handleImage(message);
        return;
      }
      const command = parseSupportedFeishuSlashCommand(message.text);
      if (command !== null) {
        if (command.name === "start" || command.name === "help") {
          if (this.commandCenter) {
            await this.commandCenter.open(message.target, message.actorId);
          } else {
            this.notifyMarkdown(
              message.target.conversationId,
              renderFeishuHelp(),
            );
          }
          return;
        }
        if (command.name === "whoami") {
          this.notifyMarkdown(
            message.target.conversationId,
            renderFeishuIdentity(message),
          );
          return;
        }
        const cancelledInteraction = command.name === "stop"
          && this.interactions?.stopForActor(message.target, message.actorId);
        if (command.name === "fs") {
          await this.handleFeishuCommand(
            message.actorId,
            message.target.accountId,
            message.target.conversationId,
            command.argumentsText,
          );
          return;
        }
        if (!isConversationCommandName(command.name)) {
          throw new UserFacingError(
            "command.unsupported",
            "飞书命令不受支持",
          );
        }
        const result = await this.commands.execute(
          message.target,
          command.name,
          command.argumentsText,
          message.actorId,
        );
        if (cancelledInteraction) this.notifyText(message.target.conversationId, interactionStoppedText);
        if ((result.kind === "workspace-permissions" || result.kind === "auto-review") && this.commandCenter) {
          const response = renderCommandCenterChoices(result.kind === "auto-review" ? "autoreview" : "workspaceperm", result);
          if (response) {
            await this.commandCenter.openResponse(message.target, message.actorId, response);
            return;
          }
        }
        if ((result.kind === "reset-credit" || result.kind === "limits") && this.commandCenter) {
          const response = renderCommandCenterChoices("limits", result);
          if (response) { await this.commandCenter.openResponse(message.target, message.actorId, response); return; }
        }
        if (result.kind === "scheduled-confirmation" && this.commandCenter) {
          const response = renderCommandCenterChoices("schedule", result);
          if (response) {
            await this.commandCenter.openResponse(message.target, message.actorId, response);
            return;
          }
        }
        if (
          result.kind === "models"
          && result.nextSelection === "effort"
          && this.commandCenter
        ) {
          const response = renderCommandCenterChoices("effort", result);
          if (response) {
            await this.commandCenter.openResponse(message.target, message.actorId, response);
            return;
          }
        }
        if (result.kind === "permissions" && this.commandCenter) {
          const response = renderCommandCenterChoices("permissions", result);
          if (response) {
            await this.commandCenter.openResponse(message.target, message.actorId, response);
            return;
          }
        }
        const rendered = renderFeishuCommandResult(
          result,
        );
        if (rendered !== null) {
          this.notifyMarkdown(message.target.conversationId, rendered);
        }
        return;
      }
      if (containsFeishuCopiedMessageLink(message.text)) {
        this.notifyText(
          message.target.conversationId,
          unsupportedMessageLinkText,
        );
        return;
      }
      const quotedText = await this.readQuotedText(message);
      this.outbox.prepareTurnReplyTarget?.(
        message.target.conversationId,
        message.messageId,
      );
      let submission;
      try {
        submission = await this.conversations.submit(
          message.target,
          formatQuotedInput(message.text, quotedText),
        );
      } catch (error) {
        this.outbox.discardPendingTurnReplyTarget?.(
          message.target.conversationId,
        );
        throw error;
      }
      if (submission.steered) {
        this.outbox.discardPendingTurnReplyTarget?.(
          message.target.conversationId,
        );
      } else {
        this.outbox.bindPendingTurnReplyTarget?.(
          message.target.conversationId,
          submission.threadId,
          submission.turnId,
        );
      }
      if (!submission.steered) {
        return;
      }
      if (!this.outbox.replyToTurn?.(
        message.target.conversationId,
        submission.threadId,
        submission.turnId,
        formatTurnInputAppended("text", false, message.text),
      )) this.notifyText(
        message.target.conversationId,
        formatTurnInputAppended("text", false, message.text),
      );
    } catch (error) {
      if (error instanceof FeishuOutputQueueError) {
        throw error;
      }
      const detail = error instanceof FeishuFileInputError
        ? error.message
        : error instanceof UserFacingError
          ? renderFeishuUserFacingError(error)
          : gatewayRequestFailedText;
      this.notifyText(
        message.target.conversationId,
        formatOperationFailure(detail),
      );
      throw error;
    }
  }

  async handleImageBatch(
    messages: readonly Extract<FeishuInboxMessage, { kind: "image" }>[],
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    this.conversations.touchActivity?.(messages[0]!.target);
    try {
      await this.submitImageBatch(messages);
    } catch (error) {
      if (error instanceof FeishuOutputQueueError) {
        throw error;
      }
      const detail = error instanceof UserFacingError
        ? renderFeishuUserFacingError(error)
        : gatewayRequestFailedText;
      this.notifyText(
        messages[0]!.target.conversationId,
        formatOperationFailure(detail),
      );
      throw error;
    }
  }

  close(): Promise<void> {
    return this.inputs.close();
  }

  async handleCommandCenterAction(
    target: ConversationTarget,
    action: FeishuCommandCenterAction,
    actorId: string,
    input = "",
  ): Promise<FeishuCommandCenterResponse | void> {
    this.conversations.touchActivity?.(target);
    try {
      if (action === "help") {
        this.notifyMarkdown(target.conversationId, renderFeishuHelp());
        return;
      }
      if (action === "workspace-autoreview-select") {
        const match = /^(on|off|clear) (\S{1,200})$/u.exec(input);
        if (!match) {
          throw new UserFacingError("workspace.permission.usage", "工作区审批按钮已失效，请重新发送 /workspaceperm", { reason: "stale-selection" });
        }
        const result = await this.commands.selectWorkspaceAutoReview(target, {
          workspaceId: match[2]!,
          value: match[1] === "on" ? "auto_review" : match[1] === "off" ? "user" : null,
        });
        const rendered = renderFeishuCommandResult(result);
        if (rendered !== null) this.notifyMarkdown(target.conversationId, rendered);
        return;
      }
      if (action === "thread-autoreview-select") {
        const match = /^(on|off) (\S{1,200})$/u.exec(input);
        if (!match) throw new UserFacingError("autoreview.stale-selection", "当前会话审批按钮已失效");
        const result = await this.commands.selectAutoReview(target, {
          threadId: match[2]!,
          enabled: match[1] === "on",
        });
        const rendered = renderFeishuCommandResult(result);
        if (rendered !== null) this.notifyMarkdown(target.conversationId, rendered);
        return;
      }
      if (action === "whoami") {
        this.notifyMarkdown(
          target.conversationId,
          renderFeishuIdentity({ target, actorId }),
        );
        return;
      }
      if (action === "feishu-status") {
        await this.handleFeishuCommand(
          actorId,
          target.accountId,
          target.conversationId,
          "status",
        );
        return;
      }
      if (action === "feishu-doctor") {
        await this.handleFeishuCommand(
          actorId,
          target.accountId,
          target.conversationId,
          "doctor",
        );
        return;
      }
      if (action === "queue") {
        const queueResponse = await this.handleQueueCommandCenterAction(
          target,
          actorId,
          input,
        );
        if (queueResponse) {
          return queueResponse;
        }
      }
      if (action === "schedule") {
        const scheduleResponse = await this.handleScheduleCommandCenterAction(
          target,
          actorId,
          input,
        );
        if (scheduleResponse) {
          return scheduleResponse;
        }
      }
      const initialChoices = input === ""
        ? renderCommandCenterInitialChoices(action)
        : undefined;
      if (initialChoices) {
        return initialChoices;
      }
      if (action === "workspaceperm" && isWorkspacePermissionField(input)) {
        return renderWorkspacePermissionFieldChoices(input);
      }
      if (action === "workspace-perm-profile") {
        return {
          kind: "form",
          title: "权限 Profile",
          action: "workspaceperm",
          fieldLabel: "Profile ID",
          placeholder: ":read-only、:workspace、:danger-full-access 或自定义",
          inputPrefix: "profile ",
        };
      }
      if (action === "plugin" && input !== "" && !/\s/u.test(input)) {
        return {
          kind: "form",
          title: `调用 ${input}`,
          description: "输入要交给该 Plugin 的任务。",
          action: "plugin",
          fieldLabel: "任务",
          placeholder: "例如：检查当前 PR",
          inputPrefix: `${input} `,
          multiline: true,
        };
      }
      const form = input === "" ? renderCommandCenterForm(action) : undefined;
      if (form) {
        return form;
      }
      if (!isConversationCommandName(action)) {
        throw new UserFacingError(
          "command.unsupported",
          "飞书命令不受支持",
        );
      }
      const cancelledInteraction = action === "stop" && this.interactions?.stopForActor(target, actorId);
      const result = action === "fast" && input === ""
        ? await this.commands.execute(target, "model", "", actorId)
        : await this.commands.execute(target, action, input, actorId);
      if (cancelledInteraction) this.notifyText(target.conversationId, interactionStoppedText);
      const followUpChoices = action === "model"
        && result.kind === "models"
        && result.nextSelection === "effort"
        ? renderCommandCenterChoices("effort", result)
        : undefined;
      const choices = followUpChoices ?? (
        (
          input === ""
          || action === "model"
          || action === "sessions"
          || action === "archived"
          || (action === "plugin" && result.kind === "plugins")
          || action === "schedule"
          || (action === "limits" && result.kind === "reset-credit")
        )
          ? renderCommandCenterChoices(action, result)
          : undefined
      );
      if (choices) {
        return choices;
      }
      const rendered = renderFeishuCommandResult(
        result,
      );
      if (rendered !== null) {
        this.notifyMarkdown(target.conversationId, rendered);
      }
    } catch (error) {
      if (error instanceof FeishuOutputQueueError) {
        throw error;
      }
      const detail = error instanceof UserFacingError
        ? renderFeishuUserFacingError(error)
        : gatewayRequestFailedText;
      this.notifyText(
        target.conversationId,
        formatOperationFailure(detail),
      );
      throw error;
    }
  }

  private async handleScheduleCommandCenterAction(
    target: ConversationTarget,
    actorId: string,
    input: string,
  ): Promise<FeishuCommandCenterResponse | undefined> {
    const normalized = input.trim();
    if (normalized === "") {
      return undefined;
    }
    if (normalized === "add") {
      return renderScheduleCreateChoices();
    }
    const createKind = /^add-(interval|once|monthly|daily|weekdays|weekly)$/u.exec(normalized)?.[1] as
      | "interval"
      | "once"
      | "monthly"
      | "daily"
      | "weekdays"
      | "weekly"
      | undefined;
    if (createKind) {
      return renderScheduleCreateForm(createKind);
    }
    const renameMatch = /^rename-task ([A-Za-z0-9_-]{1,128})$/u.exec(normalized);
    if (renameMatch) {
      return {
        kind: "form",
        title: "重命名计划任务",
        action: "schedule",
        fieldLabel: "任务名称",
        placeholder: "请输入新名称",
        inputPrefix: `rename ${renameMatch[1]} `,
      };
    }
    const taskMatch = /^task ([A-Za-z0-9_-]{1,128})$/u.exec(normalized);
    if (taskMatch) {
      const result = await this.commands.execute(
        target,
        "schedule",
        `runs ${taskMatch[1]}`,
        actorId,
      );
      if (result.kind !== "scheduled-runs") {
        return undefined;
      }
      return renderScheduleTaskChoices(result.result.task);
    }
    return undefined;
  }

  private async handleQueueCommandCenterAction(
    target: ConversationTarget,
    actorId: string,
    input: string,
  ): Promise<FeishuCommandCenterResponse | undefined> {
    const normalized = input.trim();
    if (normalized === "") {
      return this.loadQueueCommandCenterChoices(target, actorId, 1, 0);
    }
    if (normalized === "add") {
      return renderCommandCenterForm("queue");
    }
    const listMatch = /^list ([1-9]\d*)(?: chunk ([1-9]\d*))?$/u.exec(normalized);
    if (listMatch) {
      return this.loadQueueCommandCenterChoices(
        target,
        actorId,
        Number(listMatch[1]),
        Number(listMatch[2] ?? "1") - 1,
      );
    }
    const itemMatch = /^item ([1-9]\d*) ([1-9]\d*) ([A-Za-z0-9_-]{1,128})$/u.exec(normalized);
    if (itemMatch) {
      return this.loadQueueItemCommandCenterChoices(
        target,
        actorId,
        Number(itemMatch[1]),
        Number(itemMatch[2]) - 1,
        itemMatch[3]!,
      );
    }
    const deleteMatch = /^delete-confirm ([1-9]\d*) ([1-9]\d*) ([A-Za-z0-9_-]{1,128})$/u.exec(normalized);
    if (deleteMatch) {
      const result = await this.loadQueueResult(
        target,
        actorId,
        Number(deleteMatch[1]),
      );
      const item = result.result.items.find((candidate) => candidate.id === deleteMatch[3]);
      if (!item) {
        throw new UserFacingError(
          "queue.item-not-found",
          "Queue 条目按钮已失效，请刷新 Queue 列表",
        );
      }
      return renderQueueDeleteConfirmationChoices(
        Number(deleteMatch[1]),
        Number(deleteMatch[2]) - 1,
        item,
      );
    }
    return undefined;
  }

  private async loadQueueResult(
    target: ConversationTarget,
    actorId: string,
    page: number,
  ): Promise<Extract<ConversationCommandResult, { kind: "thread-queue" }>> {
    const result = await this.commands.execute(
      target,
      "queue",
      `list ${page}`,
      actorId,
    );
    if (result.kind !== "thread-queue") {
      throw new UserFacingError(
        "queue.item-not-found",
        "Queue 列表按钮已失效，请刷新 Queue 列表",
      );
    }
    return result;
  }

  private async loadQueueCommandCenterChoices(
    target: ConversationTarget,
    actorId: string,
    page: number,
    chunk: number,
  ): Promise<FeishuCommandCenterChoices> {
    const result = await this.loadQueueResult(target, actorId, page);
    return renderQueueCommandCenterChoices(result, chunk);
  }

  private async loadQueueItemCommandCenterChoices(
    target: ConversationTarget,
    actorId: string,
    page: number,
    chunk: number,
    itemId: string,
  ): Promise<FeishuCommandCenterChoices> {
    const result = await this.loadQueueResult(target, actorId, page);
    const item = result.result.items.find((candidate) => candidate.id === itemId);
    if (!item) {
      throw new UserFacingError(
        "queue.item-not-found",
        "Queue 条目按钮已失效，请刷新 Queue 列表",
      );
    }
    return renderQueueItemChoices(page, chunk, item);
  }

  private async handleFeishuCommand(
    actorId: string,
    appId: string,
    chatId: string,
    argumentsText: string,
  ): Promise<void> {
    const action = argumentsText.trim();
    const status = this.permissionStatus();
    if (action === "") {
      this.notifyMarkdown(chatId, renderFeishuPermissionHelp());
      return;
    }
    if (action === "status") {
      const userAuthorization = this.oauth
        ? await this.oauth.status(actorId)
        : "unavailable";
      this.notifyMarkdown(
        chatId,
        renderFeishuPermissionStatus(appId, status, userAuthorization),
      );
      return;
    }
    if (action === "doctor") {
      if (this.applicationSetup) {
        await this.applicationSetup.openDoctor(
          {
            surface: "feishu",
            accountId: appId,
            conversationId: chatId,
          },
          actorId,
          status,
        );
        return;
      }
      this.notifyMarkdown(
        chatId,
        renderFeishuDoctor(status),
      );
      return;
    }
    if (action === "revoke") {
      if (!this.oauth) {
        this.notifyText(chatId, "飞书用户授权模块尚未启用。");
        return;
      }
      const removed = await this.oauth.revoke(actorId);
      this.notifyText(
        chatId,
        removed
          ? "已清除当前飞书账号保存的本地授权凭据。"
          : "当前飞书账号没有已保存的授权凭据。",
      );
      return;
    }
    this.notifyText(
      chatId,
      "用法：/fs <status|doctor|revoke>",
    );
  }

  private async handleImage(
    message: Extract<FeishuInboxMessage, { kind: "image" }>,
  ): Promise<void> {
    await this.submitImageBatch([message]);
  }

  private async handleFile(
    message: Extract<FeishuInboxMessage, { kind: "file" | "files" }>,
  ): Promise<void> {
    if (this.inputOptions.files === undefined) {
      throw new FeishuFileInputError(
        "unsupported",
        "飞书当前未启用文本文件输入",
      );
    }
    const references = message.kind === "file" ? [message] : message.files;
    const imageKeys = message.kind === "files" ? message.imageKeys : [];
    if (references.length > 4) throw new UserFacingError("attachment.too-many", "一次最多处理 4 个文本附件");
    if (imageKeys.length > maximumInboundImages) throw new UserFacingError("image.too-many", "图片数量超过限制", { maximumImages: String(maximumInboundImages) });
    const files: Awaited<ReturnType<FeishuFilePort["download"]>>[] = [];
    let bytes = 0;
    const images: Awaited<ReturnType<FeishuImagePort["download"]>>[] = [];
    try {
      for (const reference of references) {
        const file = await this.inputOptions.files.download(message.messageId, reference.fileKey, reference.fileName);
        files.push(file);
        bytes += file.bytes;
        if (bytes > 1_000_000) throw new UserFacingError("attachment.too-large", "附件总大小超过 1,000,000 字节");
      }
      for (const imageKey of imageKeys) images.push(await this.images.download(message.messageId, imageKey));
    } catch (error) {
      await Promise.allSettled(files.map(file => this.inputOptions.files?.discard?.(file) ?? Promise.resolve()));
      throw error;
    }
    const quotedText = await this.readQuotedText(message);
    const text = formatQuotedInput([
      ...(message.kind === "files" && message.text ? [message.text, ""] : []),
      ...files.flatMap(file => [
        "以下内容来自用户通过飞书上传的 UTF-8 文本文件（仅作输入）：",
        `文件名：${file.fileName}`, "", textAttachmentBody(file), "",
      ]),
    ].join("\n").trimEnd(), quotedText);
    const sequence = this.nextInputSequence;
    this.nextInputSequence += 1;
    this.outbox.prepareTurnReplyTarget?.(
      message.target.conversationId,
      message.messageId,
    );
    let result;
    try {
      result = await this.inputs.enqueue({
        target: message.target,
        actorId: message.actorId,
        sequence,
        text,
        ...(images.length === 0 ? {} : { localImages: images.map(image => ({ path: image.path, mimeType: image.mimeType, bytes: image.bytes })) }),
      });
    } catch (error) {
      this.outbox.discardPendingTurnReplyTarget?.(
        message.target.conversationId,
      );
      throw error;
    }
    if (!result.tail) {
      return;
    }
    if (result.submission.steered) {
      this.outbox.discardPendingTurnReplyTarget?.(
        message.target.conversationId,
      );
      if (!this.outbox.replyToTurn?.(
        message.target.conversationId,
        result.submission.threadId,
        result.submission.turnId,
        formatTurnInputAppended("file"),
      )) this.notifyText(message.target.conversationId, formatTurnInputAppended("file"));
      return;
    }
    this.outbox.bindPendingTurnReplyTarget?.(
      message.target.conversationId,
      result.submission.threadId,
      result.submission.turnId,
    );
  }

  private async handleAudio(
    message: Extract<FeishuInboxMessage, { kind: "audio" }>,
  ): Promise<void> {
    if (this.inputOptions.audios === undefined) {
      throw new UserFacingError("audio.unsupported", "飞书当前未启用语音输入");
    }
    if (message.durationMs === undefined) {
      throw new UserFacingError(
        "audio.duration-missing",
        "无法确认飞书语音时长，请重新发送",
      );
    }
    if (message.durationMs > maximumFeishuAudioDurationMs) {
      throw new UserFacingError("audio.too-large", "语音最长支持 5 分钟");
    }
    await this.inputs.flushPending(message.target, message.actorId);
    const audio = await this.inputOptions.audios.download(
      message.messageId,
      message.fileKey,
    );
    const quotedText = await this.readQuotedText(message);
    this.outbox.prepareTurnReplyTarget?.(
      message.target.conversationId,
      message.messageId,
    );
    let submission;
    try {
      submission = await this.conversations.submit(message.target, {
        ...(quotedText === undefined
          ? {}
          : {
              text: formatQuotedInput(
                "请听取这段语音并根据内容协助我。",
                quotedText,
              ),
            }),
        localAudios: [{ path: audio.path }],
      });
    } catch (error) {
      this.outbox.discardPendingTurnReplyTarget?.(
        message.target.conversationId,
      );
      throw error;
    }
    if (submission.steered) {
      this.outbox.discardPendingTurnReplyTarget?.(
        message.target.conversationId,
      );
      if (!this.outbox.replyToTurn?.(
        message.target.conversationId,
        submission.threadId,
        submission.turnId,
        formatTurnInputAppended("audio"),
      )) this.notifyText(message.target.conversationId, formatTurnInputAppended("audio"));
      return;
    }
    this.outbox.bindPendingTurnReplyTarget?.(
      message.target.conversationId,
      submission.threadId,
      submission.turnId,
    );
  }

  private async submitImageBatch(
    messages: readonly Extract<FeishuInboxMessage, { kind: "image" }>[],
  ): Promise<void> {
    const imageCount = messages.reduce(
      (count, message) => count + message.imageKeys.length,
      0,
    );
    if (imageCount > maximumInboundImages) {
      throw new UserFacingError(
        "image.too-many",
        `一次最多处理 ${maximumInboundImages} 张图片`,
        { maximumImages: String(maximumInboundImages) },
      );
    }
    const replyMessage = messages[0]!;
    const prepared = await Promise.all(messages.map(async (message) => {
      const sequence = this.nextInputSequence;
      this.nextInputSequence += 1;
      const images = await Promise.all(message.imageKeys.map((imageKey) =>
        this.images.download(message.messageId, imageKey)
      ));
      const quotedText = await this.readQuotedText(message);
      const currentText = message.text?.trim();
      return {
        target: message.target,
        actorId: message.actorId,
        sequence,
        aggregationKey: `feishu:${replyMessage.messageId}`,
        ...(currentText
          ? { text: formatQuotedInput(currentText, quotedText) }
          : quotedText === undefined
            ? {}
            : {
                text: formatQuotedInput(
                  "请查看这张图片并根据图片内容协助我。",
                  quotedText,
                ),
              }),
        localImages: images.map((image) => ({
          path: image.path,
          mimeType: image.mimeType,
          bytes: image.bytes,
        })),
      };
    }));
    this.outbox.prepareTurnReplyTarget?.(
      replyMessage.target.conversationId,
      replyMessage.messageId,
    );
    let results;
    try {
      results = await Promise.all(
        prepared.map((input) => this.inputs.enqueue(input)),
      );
    } catch (error) {
      this.outbox.discardPendingTurnReplyTarget?.(
        replyMessage.target.conversationId,
      );
      throw error;
    }
    const submitted = results;
    const tail = submitted.find((result) => result.tail);
    if (tail?.submission.steered) {
      this.outbox.discardPendingTurnReplyTarget?.(
        replyMessage.target.conversationId,
      );
    } else if (tail) {
      this.outbox.bindPendingTurnReplyTarget?.(
        replyMessage.target.conversationId,
        tail.submission.threadId,
        tail.submission.turnId,
      );
    }
    if (tail?.submission.steered) {
      const appended = formatTurnInputAppended(
        "image",
        messages.some((message) => Boolean(message.text?.trim())),
      );
      if (!this.outbox.replyToTurn?.(
        replyMessage.target.conversationId,
        tail.submission.threadId,
        tail.submission.turnId,
        appended,
      )) this.notifyText(messages[0]!.target.conversationId, appended);
    }
  }

  private async readQuotedText(
    message: FeishuInboxMessage,
  ): Promise<string | undefined> {
    if (
      message.parentId === undefined
      || this.inputOptions.readQuotedText === undefined
    ) {
      return undefined;
    }
    try {
      return await this.inputOptions.readQuotedText(message.parentId);
    } catch (error) {
      this.inputOptions.onQuotedTextError?.(error);
      return undefined;
    }
  }

  private notifyText(chatId: string, text: string): void {
    if (!this.outbox.notifyText(chatId, text)) {
      throw new FeishuOutputQueueError();
    }
  }

  private notifyMarkdown(chatId: string, markdown: string): void {
    if (!this.outbox.notifyMarkdown(chatId, markdown)) {
      throw new FeishuOutputQueueError();
    }
  }
}

function parseSupportedFeishuSlashCommand(
  text: string,
): ReturnType<typeof parseSlashCommand> {
  let command: ReturnType<typeof parseSlashCommand>;
  try {
    command = parseSlashCommand(text);
  } catch (error) {
    if (
      error instanceof UserFacingError
      && error.code === "command.unsupported"
    ) {
      return null;
    }
    throw error;
  }
  if (
    command === null
    || (
      !feishuLocalSlashCommands.has(command.name)
      && !isConversationCommandName(command.name)
    )
  ) {
    return null;
  }
  return command;
}

function containsFeishuCopiedMessageLink(text: string): boolean {
  const candidates = text.match(/https:\/\/[^\s<>"'`]+/giu) ?? [];
  return candidates.some((candidate) => {
    try {
      const url = new URL(candidate);
      return url.hostname === "applink.feishu.cn"
        && url.pathname === "/client/message/link/open"
        && url.searchParams.has("token");
    } catch {
      return false;
    }
  });
}

function isWorkspacePermissionField(
  value: string,
): value is "sandbox" | "approval" {
  return value === "sandbox" || value === "approval";
}

class FeishuOutputQueueError extends Error {
  constructor() {
    super("飞书输出队列拒绝消息");
    this.name = "FeishuOutputQueueError";
  }
}
