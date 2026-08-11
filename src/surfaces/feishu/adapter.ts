import {
  ConversationCommandService,
  fastServiceTierId,
  isConversationCommandName,
  isFastServiceTier,
  type ConversationCommandResult,
  type ConversationUseCases,
} from "../../application/index.js";
import {
  UserFacingError,
  type ConversationTarget,
} from "../../conversation-core/index.js";
import type { SurfaceAccessPolicy } from "../../policy/index.js";
import { formatTurnInputAppended } from "../input-copy.js";
import { formatSessionListCommand } from "../conversation-command-format.js";
import { parseSlashCommand } from "../slash-command.js";
import {
  formatOperationFailure,
  gatewayRequestFailedText,
  interactionStoppedText,
} from "../output-copy.js";
import { SurfaceInputCoalescer } from "../surface-input-coalescer.js";
import { formatQuotedInput } from "../quoted-input.js";
import {
  executeVisionCommand,
  formatVisionCommandTiming,
  formatVisionCollectionReady,
  formatVisionImagesCollected,
} from "../vision-command.js";

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
    private readonly commandCenter?: Pick<FeishuCommandCenter, "open">,
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
    } = { quietWindowMs: 0 },
  ) {
    this.commands = new ConversationCommandService(
      conversations,
      inputOptions.threadSectionAccess,
    );
    this.inputs = new SurfaceInputCoalescer(
      (target, input) => conversations.submit(target, input),
      {
        ...inputOptions,
        onVisionCollectionReady: (target, imageCount, maximumImages) => {
          this.outbox.notifyMarkdown(
            target.conversationId,
            formatVisionCollectionReady(imageCount, maximumImages),
          );
        },
      },
    );
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
      const command = parseSlashCommand(message.text);
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
        if (command.name === "vision") {
          const now = this.inputOptions.now ?? Date.now;
          const receivedAtMs = message.receivedAtMs ?? now();
          await this.inputs.flushPending(message.target, message.actorId);
          const rendered = await executeVisionCommand(
            this.inputs,
            message.target,
            message.actorId,
            command.argumentsText,
          );
          this.notifyMarkdown(
            message.target.conversationId,
            this.inputOptions.debugEnabled
              ? formatVisionCommandTiming(rendered, {
                  createdAtMs: message.createdAtMs,
                  receivedAtMs,
                  respondedAtMs: now(),
                })
              : rendered,
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
    if (result.kind === "collected") {
      this.outbox.discardPendingTurnReplyTarget?.(
        message.target.conversationId,
      );
      throw new Error("文本输入不能进入图片收集");
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
    const collected = results.filter((result) => result.kind === "collected");
    const submitted = results.filter((result) => result.kind !== "collected");
    if (collected.length > 0 && submitted.length === 0) {
      this.outbox.discardPendingTurnReplyTarget?.(
        replyMessage.target.conversationId,
      );
      const imageCount = Math.max(...collected.map((result) => result.imageCount));
      this.notifyMarkdown(
        replyMessage.target.conversationId,
        formatVisionImagesCollected(
          imageCount,
          collected[0]!.maximumImages,
          collected[0]!.automatic,
        ),
      );
      return;
    }
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
      title: "追加下一 Turn",
      description: "内容会进入当前 Conversation 的有界内存队列。",
      action,
      fieldLabel: "补充要求",
      placeholder: "请输入下一轮需要继续处理的内容",
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
    return {
      title: `移动当前会话到分区 · 第 ${result.page}/${result.pageCount} 页`,
      description: "分区是 Codex App Server 全局状态；移动到自定义分区会取消固定。",
      choices: [
        ...result.sections.map((section) => ({
          label: `${section.name}${section.builtIn === "pinned" ? " · 固定" : ""}`,
          action: "section" as const,
          input: `move ${section.id}`,
        })),
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
    (model) => model.model === result.state.model,
  );
  if (action === "model") {
    if (result.state.models.length === 0) {
      return undefined;
    }
    return {
      title: "选择模型",
      description: `当前：${result.state.model}`,
      choices: result.state.models.map((model) => ({
        label: `${model.model === result.state.model ? "✓ " : ""}${model.displayName}${model.available === false ? "（暂不可用）" : ""}`,
        action: "model",
        input: model.model,
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

class FeishuOutputQueueError extends Error {
  constructor() {
    super("飞书输出队列拒绝消息");
    this.name = "FeishuOutputQueueError";
  }
}
