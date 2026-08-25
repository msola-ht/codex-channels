import {
  ConversationCommandService,
  fastServiceTierId,
  isConversationCommandName,
  isFastServiceTier,
  type ConversationCommandResult,
  type ConversationUseCases,
  type ScheduledTaskConfirmation,
  type ScheduledTaskUseCases,
} from "../../application/index.js";
import {
  UserFacingError,
  type ConversationTarget,
} from "../../conversation-core/index.js";
import type { SurfaceAccessPolicy } from "../../policy/index.js";
import { formatTurnInputAppended } from "../input-copy.js";
import {
  formatDelayMinutes,
  formatScheduledTaskStatusLabel,
  formatSessionListCommand,
  formatThreadQueueInputTypeLabel,
} from "../conversation-command-format.js";
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
  FeishuCommandCenterForm,
  FeishuCommandCenterResponse,
} from "./command-center.js";
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
import type {
  DisplayPriceCurrency,
  ExchangeRateSnapshot,
} from "../../application/index.js";
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
  private readonly commands: ConversationCommandService;
  private readonly inputs: SurfaceInputCoalescer;
  private nextInputSequence = 0;

  constructor(
    private readonly conversations: ConversationUseCases,
    private readonly outbox:
      & Pick<FeishuOutbox, "notifyMarkdown" | "notifyText">
      & Partial<Pick<
        FeishuOutbox,
        | "bindPendingTurnReplyTarget"
        | "discardPendingTurnReplyTarget"
        | "prepareTurnReplyTarget"
      >>,
    private readonly images: Pick<FeishuImagePort, "download">,
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
      files?: Pick<FeishuFilePort, "download">;
      audios?: Pick<FeishuAudioPort, "download">;
      readQuotedText?(messageId: string): Promise<string | undefined>;
      onQuotedTextError?(error: unknown): void;
      now?: () => number;
      debugEnabled?: boolean;
      exchangeRate?: () => ExchangeRateSnapshot | null;
      priceCurrency?: (
        provider: string | null | undefined,
      ) => DisplayPriceCurrency;
      threadSectionAccess?: SurfaceAccessPolicy;
      scheduledTasks?: ScheduledTaskUseCases;
    } = { quietWindowMs: 0 },
  ) {
    this.commands = new ConversationCommandService(
      conversations,
      inputOptions.threadSectionAccess,
      inputOptions.scheduledTasks,
    );
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
      if (message.kind === "file") {
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
        if (
          command.name === "stop"
          && this.interactions?.stopForActor(message.target, message.actorId)
        ) {
          this.notifyText(
            message.target.conversationId,
            interactionStoppedText,
          );
          return;
        }
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
        if (result.kind === "scheduled-confirmation" && this.commandCenter) {
          const response = renderCommandCenterChoices("schedule", result);
          if (response) {
            await this.commandCenter.openResponse(message.target, message.actorId, response);
            return;
          }
        }
        const rendered = renderFeishuCommandResult(
          result,
          this.inputOptions.priceCurrency,
          this.inputOptions.exchangeRate?.() ?? null,
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
      this.notifyText(
        message.target.conversationId,
        formatTurnInputAppended("text"),
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
    try {
      if (action === "help") {
        this.notifyMarkdown(target.conversationId, renderFeishuHelp());
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
      if (
        action === "stop"
        && this.interactions?.stopForActor(target, actorId)
      ) {
        this.notifyText(
          target.conversationId,
          interactionStoppedText,
        );
        return;
      }
      const result = action === "fast" && input === ""
        ? await this.commands.execute(target, "model", "", actorId)
        : await this.commands.execute(target, action, input, actorId);
      const choices = (
        input === ""
        || action === "sessions"
        || action === "archived"
        || (action === "plugin" && result.kind === "plugins")
        || (action === "section" && result.kind === "thread-sections")
        || action === "schedule"
      )
        ? renderCommandCenterChoices(action, result)
        : undefined;
      if (choices) {
        return choices;
      }
      const rendered = renderFeishuCommandResult(
        result,
        this.inputOptions.priceCurrency,
        this.inputOptions.exchangeRate?.() ?? null,
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
    message: Extract<FeishuInboxMessage, { kind: "file" }>,
  ): Promise<void> {
    if (this.inputOptions.files === undefined) {
      throw new FeishuFileInputError(
        "unsupported",
        "飞书当前未启用文本文件输入",
      );
    }
    const file = await this.inputOptions.files.download(
      message.messageId,
      message.fileKey,
      message.fileName,
    );
    const quotedText = await this.readQuotedText(message);
    const text = formatQuotedInput([
      "以下内容来自用户通过飞书上传的 UTF-8 文本文件（仅作输入）：",
      `文件名：${file.fileName}`,
      "",
      file.text,
    ].join("\n"), quotedText);
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
      this.notifyText(
        message.target.conversationId,
        formatTurnInputAppended("file"),
      );
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
      this.notifyText(
        message.target.conversationId,
        formatTurnInputAppended("audio"),
      );
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
      this.notifyText(
        messages[0]!.target.conversationId,
        formatTurnInputAppended(
          "image",
          messages.some((message) => Boolean(message.text?.trim())),
        ),
      );
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

const feishuQueueChoiceChunkSize = 13;

function renderQueueCommandCenterChoices(
  result: Extract<ConversationCommandResult, { kind: "thread-queue" }>,
  chunk: number,
): FeishuCommandCenterChoices {
  const items = result.result.items;
  const chunkCount = Math.max(1, Math.ceil(items.length / feishuQueueChoiceChunkSize));
  if (!Number.isSafeInteger(chunk) || chunk < 0 || chunk >= chunkCount) {
    throw new UserFacingError(
      "queue.item-not-found",
      "Queue 列表按钮已失效，请刷新 Queue 列表",
    );
  }
  const start = chunk * feishuQueueChoiceChunkSize;
  const visibleItems = items.slice(start, start + feishuQueueChoiceChunkSize);
  const choices: FeishuCommandCenterChoices["choices"][number][] = visibleItems.map((item) => ({
    label: queueChoiceLabel(item),
    action: "queue",
    input: `item ${result.result.page} ${chunk + 1} ${item.id}`,
  }));
  if (chunk > 0) {
    choices.push({
      label: "上一组",
      action: "queue",
      input: `list ${result.result.page} chunk ${chunk}`,
    });
  }
  if (chunk + 1 < chunkCount) {
    choices.push({
      label: "下一组",
      action: "queue",
      input: `list ${result.result.page} chunk ${chunk + 2}`,
    });
  }
  choices.push({
    label: "刷新",
    action: "queue",
    input: `list ${result.result.page} chunk ${chunk + 1}`,
  });
  choices.push({
    label: "新增文本",
    action: "queue",
    input: "add",
  });
  if (result.result.page > 1) {
    choices.push({
      label: "上一页",
      action: "queue",
      input: `list ${result.result.page - 1}`,
    });
  }
  if (result.result.page < result.result.pageCount) {
    choices.push({
      label: "下一页",
      action: "queue",
      input: `list ${result.result.page + 1}`,
    });
  }
  const firstVisible = visibleItems.length > 0 ? start + 1 : 0;
  const lastVisible = visibleItems.length > 0 ? start + visibleItems.length : 0;
  return {
    title: `App Server Queue · 第 ${result.result.page}/${result.result.pageCount} 页`,
    description: result.result.totalItemCount === 0
      ? "Queue 为空；可新增纯文本条目。更新与排序请使用 /queue update|reorder 文本命令。"
      : `当前显示第 ${firstVisible}-${lastVisible}/${items.length} 条；业务页最多 25 条，卡片按每组最多 ${feishuQueueChoiceChunkSize} 条展示。条目操作只使用安全预览，点击后可启动或删除；更新与排序请使用 /queue update|reorder 文本命令。`,
    choices,
  };
}

function renderQueueItemChoices(
  page: number,
  chunk: number,
  item: Extract<ConversationCommandResult, { kind: "thread-queue" }>["result"]["items"][number],
): FeishuCommandCenterChoices {
  return {
    title: "Queue 条目",
    description: [
      `ID：${item.id}`,
      `类型：${formatThreadQueueInputTypeLabel(item.inputType)}${item.editable ? " · 可更新" : " · 只读摘要"}`,
      `安全预览：${item.textPreview || "（无文本预览）"}`,
    ].join("\n"),
    choices: [
      {
        label: "启动",
        action: "queue",
        input: `start ${item.id}`,
      },
      {
        label: "删除",
        action: "queue",
        input: `delete-confirm ${page} ${chunk + 1} ${item.id}`,
      },
      {
        label: "返回列表",
        action: "queue",
        input: `list ${page} chunk ${chunk + 1}`,
      },
    ],
  };
}

function renderQueueDeleteConfirmationChoices(
  page: number,
  chunk: number,
  item: Extract<ConversationCommandResult, { kind: "thread-queue" }>["result"]["items"][number],
): FeishuCommandCenterChoices {
  return {
    title: "确认删除 Queue 条目",
    description: [
      `ID：${item.id}`,
      `安全预览：${item.textPreview || "（无文本预览）"}`,
      "删除后无法通过 Gateway 恢复。",
    ].join("\n"),
    choices: [
      {
        label: "确认删除",
        action: "queue",
        input: `delete ${item.id}`,
      },
      {
        label: "取消",
        action: "queue",
        input: `item ${page} ${chunk + 1} ${item.id}`,
      },
    ],
  };
}

function queueChoiceLabel(
  item: Extract<ConversationCommandResult, { kind: "thread-queue" }>["result"]["items"][number],
): string {
  return item.textPreview
    ? item.textPreview
    : `${formatThreadQueueInputTypeLabel(item.inputType)} Queue 条目`;
}

function renderCommandCenterInitialChoices(
  action: FeishuCommandCenterAction,
): FeishuCommandCenterChoices | undefined {
  if (action === "rules") {
    return {
      title: "项目规则",
      description: "仅操作当前已授权 Workspace 的项目规则。",
      choices: [
        { label: "生成并检查", action, input: "init" },
        { label: "仅检查", action, input: "check" },
      ],
    };
  }
  if (action === "review") {
    return {
      title: "开始 Review",
      description: "选择共享 Review 命令已有的目标类型。",
      choices: [
        { label: "未提交改动", action, input: " " },
        { label: "对比分支", action: "review-branch", input: "" },
        { label: "指定提交", action: "review-commit", input: "" },
        { label: "自定义说明", action: "review-custom", input: "" },
      ],
    };
  }
  if (action === "goal") {
    return {
      title: "Thread Goal",
      choices: [
        { label: "查看当前", action, input: " " },
        { label: "设置 Goal", action: "goal-set", input: "" },
        { label: "清除 Goal", action, input: "clear" },
      ],
    };
  }
  return undefined;
}

function renderScheduleCreateChoices(): FeishuCommandCenterChoices {
  return {
    title: "新增计划任务",
    description: "创建前会展示执行上下文预览，并要求二次确认。",
    choices: [
      { label: "每 N 分钟/小时", action: "schedule", input: "add-interval" },
      { label: "一次性", action: "schedule", input: "add-once" },
      { label: "每月指定日", action: "schedule", input: "add-monthly" },
      { label: "每天", action: "schedule", input: "add-daily" },
      { label: "工作日", action: "schedule", input: "add-weekdays" },
      { label: "每周指定日", action: "schedule", input: "add-weekly" },
      { label: "返回列表", action: "schedule", input: "list 1" },
    ],
  };
}

function renderScheduleCreateForm(
  kind: "interval" | "once" | "monthly" | "daily" | "weekdays" | "weekly",
): FeishuCommandCenterForm {
  const inputs = {
    interval: ["每 N 分钟/小时", "N(分钟或小时) 时区 任务文本", "30m Asia/Shanghai 检查项目状态"],
    once: ["一次性", "日期 时间 时区 任务文本", "2026-09-01 09:00 Asia/Shanghai 发送报告"],
    monthly: ["每月指定日", "日 时间 时区 任务文本", "1 09:00 Asia/Shanghai 汇总上月"],
    daily: ["每天", "HH:mm 时区 任务文本", "09:00 Asia/Shanghai 汇总昨日进展"],
    weekdays: ["工作日", "HH:mm 时区 任务文本", "09:00 Asia/Shanghai 检查待办"],
    weekly: ["每周指定日", "星期 HH:mm 时区 任务文本", "MO,FR 10:00 Asia/Shanghai 输出周报"],
  } as const;
  const [title, fieldLabel, placeholder] = inputs[kind];
  return {
    kind: "form",
    title: `新增计划任务 · ${title}`,
    description: "任务使用当前会话的 Workspace、Provider、模型和思考等级快照运行。",
    action: "schedule",
    fieldLabel,
    placeholder,
    inputPrefix: `add ${kind} `,
    multiline: true,
  };
}

function renderScheduleTaskChoices(
  task: Extract<ConversationCommandResult, { kind: "scheduled-tasks" }>["result"]["tasks"][number],
): FeishuCommandCenterChoices {
  return {
    title: task.name,
    description: `ID：${task.taskId}\n状态：${task.status}\n任务预览：${task.promptPreview}`,
    choices: [
      { label: "运行记录", action: "schedule", input: `runs ${task.taskId}` },
      { label: "立即运行", action: "schedule", input: `run ${task.taskId}` },
      ...(task.status === "paused"
        ? [{ label: "恢复", action: "schedule" as const, input: `resume ${task.taskId}` }]
        : [{ label: "暂停", action: "schedule" as const, input: `pause ${task.taskId}` }]),
      { label: "重命名", action: "schedule", input: `rename-task ${task.taskId}` },
      { label: "删除", action: "schedule", input: `delete ${task.taskId}` },
      { label: "返回列表", action: "schedule", input: "list 1" },
    ],
  };
}

function renderCommandCenterForm(
  action: FeishuCommandCenterAction,
): FeishuCommandCenterForm | undefined {
  if (action === "sessions-search") {
    return {
      kind: "form",
      title: "搜索会话",
      description: "按会话名称、预览或 Thread ID 搜索。",
      action: "sessions",
      fieldLabel: "搜索词",
      placeholder: "请输入搜索词",
    };
  }
  if (action === "archived-search") {
    return {
      kind: "form",
      title: "搜索已归档会话",
      description: "按会话名称、预览或 Thread ID 搜索。",
      action: "archived",
      fieldLabel: "搜索词",
      placeholder: "请输入搜索词",
    };
  }
  if (action === "rename") {
    return {
      kind: "form",
      title: "重命名会话",
      description: "输入新的会话名称。",
      action,
      fieldLabel: "会话名称",
      placeholder: "例如：飞书私聊收口",
    };
  }
  if (action === "queue") {
    return {
      kind: "form",
      title: "写入 App Server Queue",
      description: "纯文本会由 App Server 持久保存，默认容量为 100 条。",
      action,
      fieldLabel: "Queue 文本",
      placeholder: "请输入要排队的纯文本",
      inputPrefix: "add ",
      multiline: true,
    };
  }
  if (action === "review-branch") {
    return {
      kind: "form",
      title: "Review 分支",
      action: "review",
      fieldLabel: "基准分支",
      placeholder: "例如：main",
      inputPrefix: "branch ",
    };
  }
  if (action === "review-commit") {
    return {
      kind: "form",
      title: "Review 提交",
      action: "review",
      fieldLabel: "Commit SHA",
      placeholder: "请输入提交 SHA",
      inputPrefix: "commit ",
    };
  }
  if (action === "review-custom") {
    return {
      kind: "form",
      title: "自定义 Review",
      action: "review",
      fieldLabel: "Review 说明",
      placeholder: "请输入审查范围和要求",
      inputPrefix: "custom ",
      multiline: true,
    };
  }
  if (action === "goal-set") {
    return {
      kind: "form",
      title: "设置 Thread Goal",
      action: "goal",
      fieldLabel: "目标",
      placeholder: "请输入当前 Thread 的目标",
      inputPrefix: "set ",
      multiline: true,
    };
  }
  return undefined;
}

function renderCommandCenterChoices(
  action: FeishuCommandCenterAction,
  result: ConversationCommandResult,
): FeishuCommandCenterChoices | undefined {
  if (action === "schedule" && result.kind === "scheduled-tasks") {
    return {
      title: `Gateway 计划任务 · 第 ${result.result.page}/${result.result.pageCount} 页`,
      description: result.result.totalTaskCount === 0
        ? "当前没有计划任务。"
        : `共 ${result.result.totalTaskCount} 项；选择任务后可查看运行记录或执行管理操作。`,
      choices: [
        ...result.result.tasks.map((task) => ({
          label: `${formatScheduledTaskStatusLabel(task.status)} · ${task.name}`,
          action: "schedule" as const,
          input: `task ${task.taskId}`,
        })),
        { label: "新增", action: "schedule", input: "add" },
        ...(result.result.page > 1
          ? [{ label: "上一页", action: "schedule" as const, input: `list ${result.result.page - 1}` }]
          : []),
        ...(result.result.page < result.result.pageCount
          ? [{ label: "下一页", action: "schedule" as const, input: `list ${result.result.page + 1}` }]
          : []),
      ],
    };
  }
  if (action === "schedule" && result.kind === "scheduled-runs") {
    return {
      title: `运行记录 · ${result.result.task.name}`,
      description: [
        `第 ${result.result.page}/${result.result.pageCount} 页 · 共 ${result.result.totalRunCount} 条`,
        ...result.result.runs.map((run) =>
          `${run.selector}. ${run.state} · ${new Date(run.scheduledFor).toISOString()} · ${run.runId}`
        ),
      ].join("\n"),
      choices: [
        ...result.result.runs
          .filter((run) => run.state === "uncertain")
          .map((run) => ({
            label: `重试 uncertain · ${run.selector}`,
            action: "schedule" as const,
            input: `retry ${run.runId}`,
          })),
        ...(result.result.page > 1
          ? [{
              label: "上一页",
              action: "schedule" as const,
              input: `runs ${result.result.task.taskId} ${result.result.page - 1}`,
            }]
          : []),
        ...(result.result.page < result.result.pageCount
          ? [{
              label: "下一页",
              action: "schedule" as const,
              input: `runs ${result.result.task.taskId} ${result.result.page + 1}`,
            }]
          : []),
        { label: "返回任务", action: "schedule", input: `task ${result.result.task.taskId}` },
      ],
    };
  }
  if (action === "schedule" && result.kind === "scheduled-confirmation") {
    const task = result.preview.task;
    const actionLabel = result.preview.action === "create" ? "创建" : "删除";
    return {
      title: `确认${actionLabel}计划任务`,
      description: [
        "**任务**",
        `- 名称：${escapeFeishuCardMarkdown(task.name)}`,
        `- 计划：${escapeFeishuCardMarkdown(scheduleChoiceSummary(task.schedule))} · ${escapeFeishuCardMarkdown(task.timezone)}`,
        `- 下次运行：${escapeFeishuCardMarkdown(task.nextRunAt === null ? "无" : new Date(task.nextRunAt).toISOString())}`,
        "",
        "**执行配置**",
        `- Workspace：${escapeFeishuCardMarkdown(task.workspaceId)}`,
        `- Provider：${escapeFeishuCardMarkdown(task.modelProvider)}`,
        `- 模型：${escapeFeishuCardMarkdown(task.model ?? "默认")}`,
        `- 思考等级：${escapeFeishuCardMarkdown(task.reasoningEffort ?? "默认")}`,
        `- Sandbox：${escapeFeishuCardMarkdown(task.sandbox)}`,
        `- 权限 Profile：${escapeFeishuCardMarkdown(task.permissions ?? "未配置")}`,
        "- 网络：沿用 Workspace 当前权限",
        "- 审批：无人值守时一律拒绝",
        "",
        "**任务内容**",
        `- ${escapeFeishuCardMarkdown(task.promptPreview)}`,
        "",
        "该任务由 Gateway 无人值守执行；确认令牌 5 分钟内有效且仅可使用一次。",
      ].join("\n"),
      descriptionFormat: "markdown",
      choices: [
        {
          label: "确认",
          action: "schedule",
          input: `confirm ${result.preview.token}`,
          acceptedState: {
            title: `已确认${actionLabel}计划任务`,
            description: "请求已提交，原按钮已失效；执行结果见后续消息。",
            template: "green",
          },
        },
        {
          label: "取消",
          action: "schedule",
          input: "list 1",
          acceptedState: {
            title: `已取消${actionLabel}计划任务`,
            description: `未${actionLabel}计划任务，原按钮已失效。`,
            template: "grey",
          },
        },
      ],
    };
  }
  if (action === "plugin" && result.kind === "plugins") {
    const callable = result.plugins.filter((plugin) =>
      plugin.enabled && plugin.available
    );
    const searchSuffix = result.searchTerm ? ` search ${result.searchTerm}` : "";
    const navigation = [
      ...(result.page > 1
        ? [{
            label: "上一页",
            action: "plugin" as const,
            input: `list ${result.page - 1}${searchSuffix}`,
          }]
        : []),
      ...(result.page < result.pageCount
        ? [{
            label: "下一页",
            action: "plugin" as const,
            input: `list ${result.page + 1}${searchSuffix}`,
          }]
        : []),
    ];
    if (callable.length === 0 && navigation.length === 0) {
      return undefined;
    }
    return {
      title: `选择 Plugin · 第 ${result.page}/${result.pageCount} 页`,
      description: "仅显示当前页已启用且可调用的 Plugin，可继续翻页。",
      choices: [
        ...callable.map((plugin) => ({
          label: `${plugin.displayName} · ${plugin.id}`,
          action: "plugin" as const,
          input: plugin.id,
        })),
        ...navigation,
      ],
    };
  }
  if (
    (action === "resume" || action === "sessions")
    && result.kind === "sessions"
    && !result.archived
  ) {
    if (result.sessions.length === 0) {
      return undefined;
    }
    const backgroundThreadIds = new Set(result.backgroundThreadIds ?? []);
    return {
      title: "选择会话",
      description: "点击后切换到对应 Codex Thread。",
      choices: [
        {
          label: "搜索会话…",
          action: "sessions-search",
          input: "",
        },
        ...sessionNavigationChoices(result, "sessions"),
        ...result.sessions.map((session) => ({
          label: `${session.id === result.currentThreadId ? "✓ " : backgroundThreadIds.has(session.id) ? "后台 · " : ""}${(session.name ?? session.preview) || "未命名"}${session.model ? ` · 模型：${session.model}` : ""}`,
          action: "resume" as const,
          input: session.id,
        })),
      ],
    };
  }
  if (action === "archived" && result.kind === "sessions" && result.archived) {
    if (result.sessions.length === 0) {
      return undefined;
    }
    return {
      title: "恢复已归档会话",
      description: "点击后取消归档并切换到对应 Codex Thread。",
      choices: [
        {
          label: "搜索归档…",
          action: "archived-search",
          input: "",
        },
        ...sessionNavigationChoices(result, "archived"),
        ...result.sessions.map((session) => ({
          label: `${(session.name ?? session.preview) || "未命名"}${session.model ? ` · 模型：${session.model}` : ""}`,
          action: "unarchive" as const,
          input: session.id,
        })),
      ],
    };
  }
  if (action === "section" && result.kind === "thread-sections") {
    const navigation = [
      ...(result.page > 1
        ? [{ label: "上一页", action: "section" as const, input: `list ${result.page - 1}` }]
        : []),
      ...(result.page < result.pageCount
        ? [{ label: "下一页", action: "section" as const, input: `list ${result.page + 1}` }]
        : []),
    ];
    if (result.sections.length === 0 && navigation.length === 0) return undefined;
    const sectionChoices: Array<FeishuCommandCenterChoices["choices"][number]> = [];
    for (const section of result.sections) {
      if (section.builtIn === "pinned") {
        sectionChoices.push({
          label: `${section.name} · 固定`,
          action: "pin",
          input: "",
        });
      } else if (result.canManageCustomSections) {
        sectionChoices.push({
          label: section.name,
          action: "section",
          input: `move ${section.id}`,
        });
      }
    }
    const readOnlySections = result.sections.flatMap((section, index) =>
      section.builtIn === "pinned"
        ? []
        : [
            `${result.selectors[index] ?? section.id}. ${section.name} · 当前 Workspace：活动 ${section.currentWorkspaceActiveCount} / 归档 ${section.currentWorkspaceArchivedCount}`,
          ]
    );
    return {
      title: `${result.canManageCustomSections ? "固定或移动当前会话" : "查看分区或固定当前会话"} · 第 ${result.page}/${result.pageCount} 页`,
      description: result.canManageCustomSections
        ? "固定复用 /pin；移动到自定义分区会取消固定。"
        : [
            "可固定当前会话；自定义分区当前仅可查看和筛选。",
            ...(readOnlySections.length > 0
              ? ["", "自定义分区（只读）：", ...readOnlySections]
              : []),
          ].join("\n"),
      choices: [
        ...sectionChoices,
        ...navigation,
      ],
    };
  }
  if (action === "workspace" && result.kind === "workspaces") {
    if (result.workspaces.length === 0) {
      return undefined;
    }
    return {
      title: "选择工作区",
      choices: result.workspaces.map((workspace) => ({
        label: `${workspace.id === result.currentWorkspaceId ? "✓ " : ""}${workspace.name}`,
        action: "workspace",
        input: workspace.id,
      })),
    };
  }
  if (
    action === "workspaceperm"
    && result.kind === "workspace-permissions"
  ) {
    return {
      title: "工作区权限",
      description: `当前：${workspacePermissionSummary(result.workspace)}`,
      choices: [
        {
          label: `沙箱：${workspacePermissionLabel(
            "sandbox",
            result.workspace.sandbox,
          )}`,
          action: "workspaceperm",
          input: "sandbox",
        },
        {
          label: `审批：${workspacePermissionLabel(
            "approval",
            result.workspace.approvalPolicy,
          )}`,
          action: "workspaceperm",
          input: "approval",
        },
        {
          label: `权限 Profile：${result.workspace.permissions ?? "未配置"}`,
          action: "workspace-perm-profile",
          input: "",
        },
      ],
    };
  }
  if (result.kind !== "models") {
    return undefined;
  }
  const currentModel = result.state.models.find(
    (model) =>
      model.model === result.state.model
      && (model.provider ?? "openai") === (result.state.modelProvider ?? "openai"),
  );
  if (action === "model") {
    if (result.state.models.length === 0) {
      return undefined;
    }
    return {
      title: "选择模型",
      description: `当前：${result.state.model}`,
      choices: result.state.models.map((model, index) => ({
        label: `${model.model === result.state.model && (model.provider ?? "openai") === (result.state.modelProvider ?? "openai") ? "✓ " : ""}${model.displayName}${model.available === false ? "（暂不可用）" : ""}`,
        action: "model",
        input: String(index + 1),
      })),
    };
  }
  if (action === "effort") {
    const efforts = currentModel?.supportedReasoningEfforts ?? [];
    if (efforts.length === 0) {
      return undefined;
    }
    return {
      title: "选择思考等级",
      description: `当前：${result.state.effort ?? currentModel?.defaultReasoningEffort ?? "模型默认"}`,
      choices: efforts.map(
        (option) => ({
          label: `${option.effort === result.state.effort ? "✓ " : ""}${option.effort}`,
          action: "effort",
          input: option.effort,
        }),
      ),
    };
  }
  if (action === "fast") {
    const enabled = isFastServiceTier(
      result.state.serviceTier,
      currentModel,
    );
    return {
      title: "切换 Fast 模式",
      description: `当前：${enabled ? "开启" : "关闭"} · ${currentModel && fastServiceTierId(currentModel) ? "当前模型支持 Fast" : "当前模型不支持 Fast"}`,
      choices: [
        {
          label: `${enabled ? "✓ " : ""}开启`,
          action: "fast",
          input: "on",
        },
        {
          label: `${enabled ? "" : "✓ "}关闭`,
          action: "fast",
          input: "off",
        },
      ],
    };
  }
  return undefined;
}

function scheduleChoiceSummary(
  schedule: Extract<ConversationCommandResult, { kind: "scheduled-tasks" }>["result"]["tasks"][number]["schedule"],
): string {
  switch (schedule.type) {
    case "interval": return `每 ${formatDelayMinutes(schedule.intervalMinutes)}`;
    case "once": return "afterMinutes" in schedule
      ? `一次性 ${formatDelayMinutes(schedule.afterMinutes)}后`
      : `一次性 ${schedule.date} ${schedule.time}`;
    case "monthly": return `每月 ${schedule.day} 号 ${schedule.time}`;
    case "daily": return `每天 ${schedule.time}`;
    case "weekdays": return `工作日 ${schedule.time}`;
    case "weekly": return `每周 ${schedule.days.join(",")} ${schedule.time}`;
  }
}

function sessionNavigationChoices(
  result: Extract<ConversationCommandResult, { kind: "sessions" }>,
  action: "sessions" | "archived",
): FeishuCommandCenterChoices["choices"] {
  return [
    ...(result.page > 1
      ? [{
          label: "上一页",
          action,
          input: formatSessionListCommand(result, result.page - 1)
            .replace(/^\/(?:sessions|archived)\s*/u, ""),
        }]
      : []),
    ...(result.page < result.pageCount
      ? [{
          label: "下一页",
          action,
          input: formatSessionListCommand(result, result.page + 1)
            .replace(/^\/(?:sessions|archived)\s*/u, ""),
        }]
      : []),
  ];
}

function isWorkspacePermissionField(
  value: string,
): value is "sandbox" | "approval" {
  return value === "sandbox" || value === "approval";
}

function renderWorkspacePermissionFieldChoices(
  field: "sandbox" | "approval",
): FeishuCommandCenterChoices {
  if (field === "sandbox") {
    return {
      title: "选择沙箱模式",
      choices: [
        {
          label: "只读",
          action: "workspaceperm",
          input: "sandbox read-only",
        },
        {
          label: "工作区可写",
          action: "workspaceperm",
          input: "sandbox workspace-write",
        },
        {
          label: "完全访问",
          action: "workspaceperm",
          input: "sandbox danger-full-access",
        },
        {
          label: "清除（使用全局）",
          action: "workspaceperm",
          input: "sandbox clear",
        },
      ],
    };
  }
  return {
    title: "选择审批策略",
    choices: [
      {
        label: "不信任",
        action: "workspaceperm",
        input: "approval untrusted",
      },
      {
        label: "按需审批",
        action: "workspaceperm",
        input: "approval on-request",
      },
      {
        label: "免审批",
        action: "workspaceperm",
        input: "approval never",
      },
      {
        label: "清除（使用默认）",
        action: "workspaceperm",
        input: "approval clear",
      },
    ],
  };
}

function workspacePermissionSummary(
  workspace: Extract<
    ConversationCommandResult,
    { kind: "workspace-permissions" }
  >["workspace"],
): string {
  return [
    `沙箱：${workspacePermissionLabel("sandbox", workspace.sandbox)}`,
    `审批：${workspacePermissionLabel("approval", workspace.approvalPolicy)}`,
    `Profile：${workspace.permissions ?? "未配置"}`,
  ].join(" · ");
}

function workspacePermissionLabel(
  field: "sandbox" | "approval",
  value: string | undefined,
): string {
  if (value === undefined) {
    return "未配置";
  }
  const labels = field === "sandbox"
    ? ({
        "read-only": "只读",
        "workspace-write": "工作区可写",
        "danger-full-access": "完全访问",
      } as const)
    : ({
        untrusted: "不信任",
        "on-request": "按需审批",
        never: "免审批",
      } as const);
  return (labels as Record<string, string>)[value] ?? value;
}

function escapeFeishuCardMarkdown(value: string): string {
  return value
    .replace(/[\r\n]+/gu, " ")
    .replaceAll("\\", "\\\\")
    .replaceAll(/([`*_~[\]()>#+\-.!|{}])/gu, "\\$1");
}

class FeishuOutputQueueError extends Error {
  constructor() {
    super("飞书输出队列拒绝消息");
    this.name = "FeishuOutputQueueError";
  }
}
