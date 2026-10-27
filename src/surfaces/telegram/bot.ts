import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { cloudUsageChoices, formatCloudUsage } from "../cloud-usage-format.js";
import { formatTelegramPanelChunks } from "./html-format.js";
import { TextAttachmentStore, textAttachmentBody } from "../text-attachment-store.js";
import { videoAttachmentBody } from "../video-attachment-store.js";
import { SurfaceShutdown } from "../surface-shutdown.js";
import { AttachmentInputLifecycle, type ReceivedAttachmentInput } from "../attachment-input-lifecycle.js";
import { Bot, type Context } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Logger } from "pino";

import {
  conversationCommandNames,
  listProviders,
  type ConversationCommandExecutor,
  type ConversationCommandResult,
  type ConversationCommandName,
  type ConversationExtensionUseCases,
  type ConversationSessionUseCases,
  type ConversationTurnUseCases,
  type ScheduledTaskConfirmation,
} from "../../application/index.js";
import {
  UserFacingError,
  type ConversationTarget,
  type OutputEvent,
} from "../../conversation-core/index.js";
import type {
  ConversationActorRegistry,
  SurfaceAccessPolicy,
  Workspace,
} from "../../policy/index.js";
import type {
  OperationUpdateDisplay,
  SurfaceConfigurationChange,
} from "../types.js";
import {
  conversationCommandHelpLines,
} from "../conversation-command-help.js";
import { formatConversationScheduledConfirmation } from "../conversation-scheduled-task-command-format.js";
import { formatConversationAutoReview } from "../conversation-workspace-status-command-format.js";
import { formatTurnInputAppended } from "../input-copy.js";
import { shouldHideRoutineConfiguration } from "../delivery-policy.js";
import {
  formatOperationFailure,
  gatewayRequestFailedText,
  interactionStoppedText,
} from "../output-copy.js";
import { formatTextFileTooLarge } from "../text-file-copy.js";
import { SurfaceInputBatcher } from "../surface-input-batcher.js";
import { surfaceErrorMetadata } from "../error-metadata.js";
import { formatQuotedInput } from "../quoted-input.js";
import { surfaceCommandAliases } from "../slash-command.js";
import {
  formatConfigurationChange,
  formatStartupNotification,
  type StartupRuntimeInfo,
} from "./format.js";
import {
  renderTelegramCommandResult,
  threadAutoReviewKeyboard,
  scheduledTaskConfirmationKeyboard,
  formatTelegramThreadQueueDeleteConfirmation,
  formatTelegramThreadQueueItemAction,
  telegramModelSelectionToken,
  telegramResetCreditListToken,
  replyTelegramPanel,
  telegramPluginSelectionToken,
  threadQueueDeleteConfirmationKeyboard,
  threadQueueItemKeyboard,
  telegramWorkspaceSwitchToken,
} from "./command-renderer.js";
import { TelegramInteractionPort } from "./interactions.js";
import { TelegramApiExecutor } from "./api-executor.js";
import { telegramDefaultAccountId } from "./constants.js";
import {
  TelegramLifecycle,
  telegramConversationCommandName,
  telegramUpdateGroupSize,
  isTelegramEmergencyStopUpdate,
} from "./lifecycle.js";
import { TelegramOutbox, type TelegramFinalMessageFormat } from "./outbox.js";
import { maximumTelegramImageBytes, TelegramImageStore } from "./image-store.js";
import {
  maximumTelegramAudioBytes,
  maximumTelegramAudioDurationSeconds,
  TelegramAudioStore,
} from "./audio-store.js";
import { telegramErrorMetadata } from "./error-metadata.js";
import { telegramAbortSignal } from "./sdk-signal.js";
import {
  maximumTelegramTextFileBytes,
  TelegramTextFileInput,
  TelegramTextFileInputError,
  type TelegramTextFilePort,
} from "./file-input.js";
import { formatTelegramUserFacingError } from "./user-error-renderer.js";
import { TelegramPluginTaskPrompts } from "./plugin-task-prompts.js";
import { TelegramVideoInput } from "./video-input.js";

export interface TelegramImagePort {
  start(): Promise<void>;
  close(): void;
  download(
    api: Parameters<TelegramImageStore["download"]>[0],
    fileId: string,
    signal?: AbortSignal,
  ): ReturnType<TelegramImageStore["download"]>;
}

export interface TelegramAudioPort {
  start(): Promise<void>;
  close(): void;
  download(
    api: Parameters<TelegramAudioStore["download"]>[0],
    fileId: string,
    signal?: AbortSignal,
  ): ReturnType<TelegramAudioStore["download"]>;
}

export interface TelegramSurfaceOptions {
  gatewayVersion: string;
  appServerTimezone?: string;
  commands: ConversationCommandExecutor;
  actorRegistry?: ConversationActorRegistry;
  onFatal?: (error: Error) => void;
  imageStore?: TelegramImagePort;
  audioStore?: TelegramAudioPort;
  textFileInput?: TelegramTextFilePort;
  videoDirectory?: string;
  finalMessageFormat?: TelegramFinalMessageFormat;
  operationUpdateDisplay?: OperationUpdateDisplay;
  displaySettings?: import("../types.js").SurfaceMessageDisplaySettings;
  planUpdatesEnabled?: boolean;
  reasoningEnabled?: boolean;
  codexUpstreamUserAgent?: () => string | undefined;
  officialOpenAiAuthenticated?: () => boolean | undefined;
  openAiConnectivity?: () => NonNullable<StartupRuntimeInfo["openAiConnectivity"]>;
  startupPresentationDetail?: (chatId: number) => "basic" | "detailed" | "full";
  startupDisplayPreset?: (chatId: number) => NonNullable<StartupRuntimeInfo["displayPreset"]>;
  startupRoutineNotificationsEnabled?: (chatId: number) => boolean;
  inputQuietWindowMs?: number;
  now?: () => number;
  autoCompactPercent?: (
    provider: string | null | undefined,
    model: string | null | undefined,
  ) => number | null;
}

export interface CreateTelegramSurfaceOptions extends TelegramSurfaceOptions {
  token: string;
  proxyUrl?: string;
  service: TelegramConversationUseCases;
  access: SurfaceAccessPolicy;
  startupRecipients: ReadonlySet<number>;
  workspaces: Workspace[];
  uploadsDirectory: string;
  logger: Logger;
}

export type TelegramConversationUseCases =
  & Pick<ConversationTurnUseCases, "touchActivity" | "submit" | "prepareAttachmentSubmission">
  & Pick<ConversationSessionUseCases, "status" | "statusForDisplay" | "listWorkspaces" | "selectedWorkspaceId">
  & Pick<ConversationExtensionUseCases, "modelState" | "listPlugins">;

export function createTelegramSurface(
  options: CreateTelegramSurfaceOptions,
): TelegramSurface {
  return new TelegramSurface(
    options.token,
    options.proxyUrl,
    options.service,
    options.access,
    options.startupRecipients,
    options.workspaces,
    options.uploadsDirectory,
    options.logger,
    options,
  );
}

type AutoReviewSelectionScope = { threadId: string };
type CommandReplyScope = { workspaceId: string; cwd: string | undefined; selectionScope: string | undefined; threadId: string | undefined };

export class TelegramSurface {
  readonly surface = "telegram" as const;
  readonly accountId = telegramDefaultAccountId;
  readonly bot: Bot;
  readonly interactions: TelegramInteractionPort;
  readonly output: TelegramOutbox;
  private readonly proxyAgent: HttpsProxyAgent<string> | undefined;
  private readonly outbox: TelegramOutbox;
  private readonly lifecycle: TelegramLifecycle;
  private readonly imageStore: TelegramImagePort;
  private readonly audioStore: TelegramAudioPort;
  private readonly textFileInput: TelegramTextFilePort;
  private readonly videoInput: TelegramVideoInput | undefined;
  private readonly actorRegistry: ConversationActorRegistry | undefined;
  private readonly commands: ConversationCommandExecutor;
  private readonly apiExecutor: TelegramApiExecutor;
  private readonly commandReplies = new WeakMap<Context, { signal: AbortSignal; scope: CommandReplyScope }>();
  private readonly usageEdits = new WeakMap<Context, { messageId: number; assertActive: () => void }>();
  private readonly usageSelections = new Map<string, {
    target: ConversationTarget; actorId: string; messageId: number; expiresAt: number;
    scope: CommandReplyScope; inputs: string[];
  }>();
  private readonly inputs: SurfaceInputBatcher;
  private readonly attachmentInputs = new AttachmentInputLifecycle();
  private readonly receivedAttachments = new WeakMap<object, ReceivedAttachmentInput>();
  private readonly receivedUpdates = new WeakSet<object>();
  private readonly privateConversations = new Map<string, string>();
  private readonly attachmentStops = new WeakSet<object>();
  private readonly rejectedAttachmentStops = new WeakSet<object>();
  private readonly pluginTaskPrompts: TelegramPluginTaskPrompts;
  private readonly now: () => number;
  private readonly idleResumeSelections = new Map<string, {
    target: ConversationTarget;
    actorId: string;
    threadId: string;
    messageId: number;
    expiresAt: number;
  }>();
  private readonly autoReviewSelections = new Map<string, {
    target: ConversationTarget;
    actorId: string;
    expiresAt: number;
  } & AutoReviewSelectionScope>();
  private nextInputSequence = 0;
  private notificationRecipients: ReadonlySet<number>;
  private readonly notificationRoutineEnabled: TelegramSurfaceOptions["startupRoutineNotificationsEnabled"];
  private stopping = false;
  private stopPromise: Promise<void> | undefined;

  constructor(
    token: string,
    proxyUrl: string | undefined,
    private readonly service: TelegramConversationUseCases,
    private readonly access: SurfaceAccessPolicy,
    startupRecipients: ReadonlySet<number>,
    workspaces: Workspace[],
    uploadsDirectory: string,
    private readonly logger: Logger,
    options: TelegramSurfaceOptions,
  ) {
    this.proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl, { keepAlive: true }) : undefined;
    this.bot = new Bot(token, {
      client: {
        timeoutSeconds: 30,
        ...(this.proxyAgent
          ? { baseFetchConfig: { agent: this.proxyAgent } }
          : {}),
      },
    });
    this.bot.use((context, next) => {
      logger.debug(
        {
          surface: "telegram",
          updateType: context.message
            ? "message"
            : context.callbackQuery
              ? "callback-query"
              : "other",
          messageType: telegramMessageType(context),
        },
        "Telegram 输入已到达 Gateway",
      );
      return next();
    });
    this.bot.use((context, next) => this.authorize(context, next));
    this.bot.use(async (context, next) => {
      const release = this.receivedUpdates.has(context.update)
        ? undefined : this.receiveAttachmentUpdate(context.update);
      try { await next(); } finally { release?.(); }
    });
    this.bot.use((context, next) => {
      if (context.chat && context.from) {
        this.service.touchActivity?.(target(context));
      }
      return next();
    });
    this.actorRegistry = options.actorRegistry;
    this.now = options.now ?? Date.now;
    this.notificationRecipients = new Set(startupRecipients);
    this.notificationRoutineEnabled = options.startupRoutineNotificationsEnabled;
    this.commands = options.commands;
    this.pluginTaskPrompts = new TelegramPluginTaskPrompts({ now: this.now });
    const apiExecutor = new TelegramApiExecutor(logger, (chatId, recipientNotification) => {
      const outputTarget: ConversationTarget = {
        surface: this.surface, accountId: this.accountId, conversationId: chatId,
      };
      if (recipientNotification) {
        const userId = Number(chatId);
        return Number.isSafeInteger(userId) && String(userId) === chatId
          && this.notificationRecipients.has(userId)
          && this.access.isAllowed({ target: outputTarget, actorId: chatId });
      }
      const privateActor = this.privateConversations.get(chatId);
      return (this.actorRegistry?.actors(outputTarget) ?? (privateActor === undefined ? [] : [privateActor]))
        .some(actorId => this.access.isAllowed({ target: outputTarget, actorId }));
    });
    this.apiExecutor = apiExecutor;
    this.outbox = new TelegramOutbox(this.bot.api, logger, apiExecutor, {
      ...(options.displaySettings ? { displaySettings: options.displaySettings } : {}),
      ...(options.finalMessageFormat
        ? { finalMessageFormat: options.finalMessageFormat }
        : {}),
      ...(options.operationUpdateDisplay !== undefined
        ? { operationUpdateDisplay: options.operationUpdateDisplay }
        : {}),
      ...(options.planUpdatesEnabled !== undefined
        ? { planUpdatesEnabled: options.planUpdatesEnabled }
        : {}),
      ...(options.reasoningEnabled !== undefined
        ? { reasoningEnabled: options.reasoningEnabled }
        : {}),
      deliverIdleReleased: (event, send) => this.deliverIdleReleased(event, send),
    });
    this.output = this.outbox;
    this.inputs = new SurfaceInputBatcher(
      (inputTarget, input, actorId) => service.submit(
        inputTarget,
        input,
        () => !this.stopping && this.access.isAllowed({ target: inputTarget, actorId }),
      ),
      {
        quietWindowMs: options.inputQuietWindowMs ?? 1_000,
      },
    );
    this.interactions = new TelegramInteractionPort(this.bot, logger, apiExecutor, this.outbox);
    this.imageStore = options.imageStore ?? new TelegramImageStore(uploadsDirectory, token, proxyUrl, logger);
    this.audioStore = options.audioStore
      ?? new TelegramAudioStore(uploadsDirectory, token, proxyUrl, logger);
    this.textFileInput = options.textFileInput
      ?? new TelegramTextFileInput(token, proxyUrl, undefined, new TextAttachmentStore(join(uploadsDirectory, "telegram-text"), () => logger.warn("文本附件清理失败")));
    this.videoInput = options.videoDirectory === undefined
      ? undefined
      : new TelegramVideoInput(options.videoDirectory, token, proxyUrl, logger);
    this.lifecycle = new TelegramLifecycle(
      this.bot,
      logger,
      {
        messages: async (signal) => {
          const messages: Array<{ chatId: number; text: ReturnType<typeof formatStartupNotification>; signal: AbortSignal }> = [];
          for (const chatId of startupRecipients) {
            signal.throwIfAborted();
            // Keep the original grant across status waits and every startup chunk.
            // Revoking then granting access again must not revive an old notice.
            const active = AbortSignal.any([signal, apiExecutor.authorizationSignal(String(chatId), true)]);
            if (active.aborted) continue;
            const status = await this.service.statusForDisplay(
              {
                surface: "telegram",
                accountId: telegramDefaultAccountId,
                conversationId: String(chatId),
              },
              active,
            ).catch(error => {
              if (active.aborted && !signal.aborted) return undefined;
              throw error;
            });
            signal.throwIfAborted();
            if (active.aborted || status === undefined) continue;
            const officialOpenAiAuthenticated = options.officialOpenAiAuthenticated?.();
            messages.push({
              chatId,
              signal: active,
              text: formatStartupNotification(workspaces, status, {
                platform: process.platform,
                architecture: process.arch,
                ...(options.appServerTimezone === undefined
                  ? {} : { appServerTimezone: options.appServerTimezone }),
                gatewayVersion: options.gatewayVersion,
                nodeVersion: process.version,
                transport: "Unix WebSocket",
                codexUpstreamUserAgent: options.codexUpstreamUserAgent?.() ?? null,
                ...(officialOpenAiAuthenticated === undefined
                  ? {}
                  : { officialOpenAiAuthenticated }),
                ...(options.openAiConnectivity
                  ? { openAiConnectivity: options.openAiConnectivity() }
                  : {}),
                presentationDetail: options.startupPresentationDetail?.(chatId) ?? "basic",
                ...(options.startupDisplayPreset ? { displayPreset: options.startupDisplayPreset(chatId) } : {}),
              }),
            });
          }
          return messages;
        },
        send: (chatId, html, signal) => apiExecutor.call(
          { chatId: String(chatId), operation: "sendMessage", critical: false, recipientNotification: true },
          requestSignal => this.bot.api.sendMessage(chatId, html,
            { parse_mode: "HTML", disable_notification: true }, telegramAbortSignal(requestSignal)),
          signal,
        ),
      },
      options.onFatal,
      {
        isInteractionUpdate: update => this.interactions.isInteractionUpdate(update),
        receiveUpdate: update => this.receiveAttachmentUpdate(update),
      },
    );
    this.registerHandlers();
  }

  sendChannelImage(conversationId: string, imagePath: string, isCurrent: () => boolean, signal?: AbortSignal): Promise<void> {
    return this.output.sendChannelImage(conversationId, imagePath, isCurrent, signal);
  }

  isPrivateConversation(target: ConversationTarget): boolean {
    return target.surface === this.surface && target.accountId === this.accountId
      && this.privateConversations.has(target.conversationId);
  }

  private rememberPrivateConversation(target: ConversationTarget, actorId: string): void {
    this.privateConversations.set(target.conversationId, actorId);
    if (this.privateConversations.size > 4_096) {
      this.privateConversations.delete(this.privateConversations.keys().next().value!);
    }
  }

  sendChannelFile(conversationId: string, filePath: string, fileName: string, isCurrent: () => boolean, mediaType?: import("../bounded-local-file.js").ChannelFileMediaType, signal?: AbortSignal): Promise<void> {
    return this.output.sendChannelFile(conversationId, filePath, fileName, isCurrent, mediaType, signal);
  }

  private queryGuard(target: ConversationTarget, actorId: string): () => void {
    const workspaceId = this.service.selectedWorkspaceId(target);
    const cwd = this.service.listWorkspaces().find(workspace => workspace.id === workspaceId)?.cwd;
    return () => {
      const currentId = this.service.selectedWorkspaceId(target);
      const currentCwd = this.service.listWorkspaces().find(workspace => workspace.id === currentId)?.cwd;
      if (this.stopping || !this.access.isAllowed({ target, actorId })
        || cwd === undefined || currentId !== workspaceId || currentCwd !== cwd) {
        throw new UserFacingError("command.authorization-changed", "命令授权已变化，请重新发起操作");
      }
    };
  }

  async presentScheduledTaskConfirmation(
    target: ConversationTarget,
    actorId: string,
    preview: ScheduledTaskConfirmation,
  ): Promise<void> {
    if (
      target.surface !== this.surface
      || target.accountId !== this.accountId
      || !this.access.isAllowed({ target, actorId })
    ) {
      return;
    }
    const result = { kind: "scheduled-confirmation" as const, preview };
    await this.outbox.deliverPanel(
      target.conversationId,
      formatConversationScheduledConfirmation(result),
      scheduledTaskConfirmationKeyboard(result),
    );
  }

  async start(): Promise<void> {
    await Promise.all([
      this.imageStore.start(),
      this.audioStore.start(),
      this.textFileInput.start?.(),
      this.videoInput?.start(),
    ]);
    if (this.stopping) return;
    this.lifecycle.start();
  }

  private async deliverIdleReleased(
    event: Extract<OutputEvent, { type: "conversation.idle.released" }>,
    send: (keyboard?: InlineKeyboardMarkup) => Promise<number | undefined>,
  ): Promise<void> {
    if (this.stopping) throw new Error("Telegram 正在关闭");
    const actors = [...new Set(this.actorRegistry?.actors(event.target) ?? [])]
      .filter(actorId => this.access.isAllowed({ target: event.target, actorId }));
    const actorId = actors.length === 1 ? actors[0] : undefined;
    if (actorId === undefined) {
      await send();
      return;
    }
    const token = randomBytes(18).toString("base64url");
    // The Outbox already owns ordering, cancellation and the delivery receipt.
    const messageId = await send({ inline_keyboard: [[{
      text: "恢复此会话",
      callback_data: `idle:resume:${token}`,
    }]] });
    if (this.stopping || messageId === undefined
      || !this.access.isAllowed({ target: event.target, actorId })) return;
    for (const [key, selection] of this.idleResumeSelections) {
      if (selection.expiresAt <= this.now()) this.idleResumeSelections.delete(key);
    }
    this.idleResumeSelections.set(token, {
      target: event.target, actorId, threadId: event.threadId, messageId,
      expiresAt: this.now() + 10 * 60_000,
    });
    while (this.idleResumeSelections.size > 100) {
      this.idleResumeSelections.delete(this.idleResumeSelections.keys().next().value!);
    }
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    const shutdown = new SurfaceShutdown();
    this.stopping = true;
    this.privateConversations.clear();
    this.attachmentInputs.close();
    const videoClose = shutdown.run("videos", () => this.videoInput?.close());
    const lifecycleStop = shutdown.run("lifecycle", () => this.lifecycle.stop());
    await videoClose;
    await shutdown.run("inputs", () => this.inputs.close());
    await shutdown.run("files", () => this.textFileInput.close?.());
    await shutdown.run("images", () => this.imageStore.close());
    await shutdown.run("audios", () => this.audioStore.close());
    this.pluginTaskPrompts.clear();
    this.autoReviewSelections.clear();
    this.usageSelections.clear();
    this.idleResumeSelections.clear();
    await shutdown.run("interactions", () => this.interactions.close());
    await shutdown.run("outbox", () => this.outbox.close());
    await lifecycleStop;
    await shutdown.run("proxy agent", () => this.proxyAgent?.destroy());
    shutdown.finish();
  }

  replaceNotificationRecipients(recipients: ReadonlySet<number>): void {
    this.notificationRecipients = new Set(recipients);
  }

  revalidateAccess(): void {
    for (const [conversationId, actorId] of this.privateConversations) {
      const target = { surface: this.surface, accountId: this.accountId, conversationId };
      if (!this.access.isAllowed({ target, actorId })) this.privateConversations.delete(conversationId);
    }
    this.outbox.revalidateAccess();
  }

  configurationChanged(change: SurfaceConfigurationChange): void {
    const replyMarkup = workspaceSwitchKeyboard(change.addedWorkspaces);
    const text = formatConfigurationChange(change);
    for (const chatId of this.notificationRecipients) {
      if (shouldHideRoutineConfiguration(change, this.notificationRoutineEnabled?.(chatId) ?? true)) continue;
      this.outbox.notifyPanel(
        String(chatId),
        text,
        replyMarkup.inline_keyboard.length > 0 ? replyMarkup : undefined,
        true,
      );
    }
  }

  async deliverConfigurationChange(change: SurfaceConfigurationChange): Promise<void> {
    const replyMarkup = workspaceSwitchKeyboard(change.addedWorkspaces);
    const text = formatConfigurationChange(change);
    await Promise.all(
      [...this.notificationRecipients].map((chatId) =>
        this.outbox.deliverPanel(
          String(chatId),
          text,
          replyMarkup.inline_keyboard.length > 0 ? replyMarkup : undefined,
          true,
        )),
    );
  }

  private registerHandlers(): void {
    this.bot.command("whoami", (context) => context.reply(`你的 Telegram 用户 ID：${context.from?.id ?? "未知"}`));
    this.bot.command(["start", "help", "h"], (context) =>
      replyTelegramPanel(
        context,
        [
          "## Codex Connect Gateway",
          "",
          "普通文本会发送到当前 Codex Session。",
          "发送 PNG/JPEG/WebP/非动画 GIF 图片时，可在图片说明中写明需要 Codex 处理的任务。",
          "发送 UTF-8 文本文件时，可在文件说明中写明需要 Codex 处理的任务。",
          "发送 MP4/WebM 视频或视频消息时，会暂存最多 20 MiB 的视频附件供当前会话调用视频 MCP；可附说明文字。",
          "没有绑定会话时会新建会话；继续历史会话请使用 /resume 显式选择。",
          "",
          ...conversationCommandHelpLines,
          "Telegram：",
          "- /whoami",
          "- /start · /help · /h",
        ].join("\n"),
      ),
    );
    for (const command of conversationCommandNames.filter(
      (candidate) => candidate !== "stop",
    )) {
      this.bot.command(telegramConversationCommandName(command), (context) =>
        this.executeCommand(context, command));
    }
    this.bot.command("work", (context) =>
      this.executeCommand(context, surfaceCommandAliases.work));
    this.bot.command("r", (context) =>
      this.executeCommand(context, surfaceCommandAliases.r));
    this.bot.command("stop", async (context) => {
      const cancelledInteraction = this.interactions.stopForChat(String(context.chat.id));
      await this.executeCommand(context, "stop");
      if (cancelledInteraction) await context.reply(interactionStoppedText);
    });
    this.bot.callbackQuery(/^(?:wp|ar):/, async (context) => {
      await context.answerCallbackQuery({ text: "工作区权限设置入口已停用，请使用原生 Codex 权限配置。" });
    });
    this.bot.callbackQuery(/^status-query:(metrics|usage|limits)$/, async context => {
      await context.answerCallbackQuery({ text: "正在查询" });
      const command = context.match[1];
      if (command !== "metrics" && command !== "usage" && command !== "limits") return;
      const result = await this.commands.execute(target(context), command, "", String(context.from.id));
      await this.renderCommandResult(context, result);
    });
    this.bot.callbackQuery(/^usage:([A-Za-z0-9_-]{24}):(\d{1,2})$/, async context => {
      const token = context.match[1]!;
      const pending = this.usageSelections.get(token);
      const inputTarget = target(context);
      const scope = this.commandReplyScope(inputTarget);
      const input = pending?.inputs[Number(context.match[2])];
      if (!pending || !input || pending.expiresAt <= this.now()
        || pending.actorId !== String(context.from.id)
        || pending.target.conversationId !== inputTarget.conversationId || pending.target.accountId !== inputTarget.accountId
        || pending.messageId !== context.callbackQuery.message?.message_id
        || scope.workspaceId !== pending.scope.workspaceId || scope.cwd !== pending.scope.cwd
        || scope.threadId !== pending.scope.threadId || scope.selectionScope !== pending.scope.selectionScope) {
        await context.answerCallbackQuery({ text: "用量卡片已失效，请重新执行 /usage" });
        return;
      }
      this.usageSelections.delete(token);
      const guard = (): void => {
        const original = this.commandReplies.get(context);
        original?.signal.throwIfAborted();
        const current = this.commandReplyScope(inputTarget);
        if (!original || this.stopping || pending.expiresAt <= this.now()
          || !this.access.isAllowed({ target: inputTarget, actorId: pending.actorId })
          || current.workspaceId !== pending.scope.workspaceId || current.cwd !== pending.scope.cwd
          || current.threadId !== pending.scope.threadId || current.selectionScope !== pending.scope.selectionScope) {
          throw new UserFacingError("command.authorization-changed", "用量卡片已失效，请重新执行 /usage");
        }
      };
      this.usageEdits.set(context, { messageId: pending.messageId, assertActive: guard });
      await context.answerCallbackQuery({ text: "正在查询" });
      guard();
      const result = await this.commands.execute(inputTarget, "usage", input, pending.actorId, guard);
      guard();
      await this.renderCommandResult(context, result);
    });
    this.bot.callbackQuery(/^idle:resume:([A-Za-z0-9_-]{24})$/, async (context) => {
      const token = context.match[1]!;
      const pending = this.idleResumeSelections.get(token);
      const callbackTarget = target(context);
      if (this.stopping || !pending || pending.expiresAt <= this.now()
        || pending.actorId !== String(context.from.id)
        || pending.target.conversationId !== callbackTarget.conversationId
        || pending.target.accountId !== callbackTarget.accountId
        || pending.messageId !== context.callbackQuery.message?.message_id
      ) {
        if (pending && pending.expiresAt <= this.now()) this.idleResumeSelections.delete(token);
        await context.answerCallbackQuery({ text: "恢复按钮已失效，请使用通知中的 /r 命令。" });
        return;
      }
      this.idleResumeSelections.delete(token);
      await context.answerCallbackQuery({ text: "正在恢复会话" });
      if (this.stopping || !this.access.isAllowed({ target: callbackTarget, actorId: pending.actorId })) return;
      const result = await this.commands.execute(callbackTarget, "resume", pending.threadId, pending.actorId);
      try { await context.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }); }
      catch (error) { this.logger.warn({ ...surfaceErrorMetadata(error) }, "空闲恢复按钮清理失败"); }
      await this.renderCommandResult(context, result);
    });
    this.bot.callbackQuery(/^tar:(on|off):([A-Za-z0-9_-]{24})$/, async (context) => {
      const token = context.match[2]!;
      const pending = this.autoReviewSelections.get(token);
      const callbackTarget = target(context);
      if (!pending || pending.expiresAt <= this.now()
        || pending.actorId !== String(context.from?.id ?? "")
        || pending.target.conversationId !== callbackTarget.conversationId
        || pending.target.accountId !== callbackTarget.accountId
      ) throw new UserFacingError("autoreview.stale-selection", "当前会话审批按钮已失效");
      this.autoReviewSelections.delete(token);
      await context.answerCallbackQuery({ text: "正在修改当前会话审批方式" });
      const result = await this.commands.selectAutoReview(callbackTarget, {
        threadId: pending.threadId,
        enabled: context.match[1] === "on",
      }, String(context.from.id));
      try { await context.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }); }
      catch (error) { this.logger.warn({ ...surfaceErrorMetadata(error) }, "当前会话审批按钮清理失败"); }
      await renderTelegramCommandResult(context, result);
    });
    this.bot.callbackQuery(/^ws:([A-Za-z0-9_-]{43})$/, async (context) => {
      const workspace = this.service.listWorkspaces().find(
        (candidate) => telegramWorkspaceSwitchToken(candidate.id) === context.match[1],
      );
      if (!workspace) {
        throw new UserFacingError(
          "workspace.selector.not-found",
          "Workspace 切换按钮已失效",
        );
      }
      const result = await this.commands.selectWorkspace(
        target(context),
        workspace.id,
        String(context.from.id),
      );
      await context.answerCallbackQuery({ text: `已切换到 ${workspace.id}` });
      await this.renderCommandResult(
        context,
        result,
      );
    });
    this.bot.callbackQuery(
      /^mp:([1-9]\d*):([A-Za-z0-9_-]{43})$/,
      async (context) => {
        const modelTarget = target(context);
        const guard = this.queryGuard(modelTarget, String(context.from.id));
        const selectionScope = this.service.status(modelTarget).selectionScope;
        const state = await this.service.modelState(modelTarget, guard);
        if (
          telegramModelSelectionToken(state, String(context.from.id)) !== context.match[2]
        ) {
          throw new UserFacingError(
            "model.selection.expired",
            "提供商列表已变化，请重新发送 /model 选择",
          );
        }
        const providers = listProviders(state.models);
        const provider = providers[Number(context.match[1]) - 1];
        if (!provider) {
          throw new UserFacingError(
            "model.selection.expired",
            "提供商列表已变化，请重新发送 /model 选择",
          );
        }
        await context.answerCallbackQuery({ text: "正在浏览提供商" });
        await context.editMessageReplyMarkup({
          reply_markup: { inline_keyboard: [] },
        });
        guard();
        if (this.service.status(modelTarget).selectionScope !== selectionScope) {
          throw new UserFacingError("model.selection.expired", "会话已变化，请重新发送 /model 选择");
        }
        const result = await this.commands.execute(
          modelTarget,
          "model",
          provider,
          String(context.from.id),
        );
        await this.renderCommandResult(
          context,
          result,
        );
      },
    );
    this.bot.callbackQuery(
      /^ms:([1-9]\d*):([A-Za-z0-9_-]{43})$/,
      async (context) => {
        const modelTarget = target(context);
        const guard = this.queryGuard(modelTarget, String(context.from.id));
        const selectionScope = this.service.status(modelTarget).selectionScope;
        const state = await this.service.modelState(modelTarget, guard);
        if (
          telegramModelSelectionToken(state, String(context.from.id)) !== context.match[2]
        ) {
          throw new UserFacingError(
            "model.selection.expired",
            "模型列表已变化，请重新发送 /model 选择",
          );
        }
        const selected = state.models[Number(context.match[1]) - 1];
        if (!selected || selected.available === false) {
          throw new UserFacingError(
            "model.selection.expired",
            "模型列表已变化，请重新发送 /model 选择",
          );
        }
        await context.answerCallbackQuery({ text: "正在选择模型" });
        await context.editMessageReplyMarkup({
          reply_markup: { inline_keyboard: [] },
        });
        guard();
        if (this.service.status(modelTarget).selectionScope !== selectionScope) {
          throw new UserFacingError("model.selection.expired", "会话已变化，请重新发送 /model 选择");
        }
        const result = await this.commands.selectModel(modelTarget, {
          provider: selected.provider ?? "openai",
          model: selected.model,
        }, String(context.from.id));
        await this.renderCommandResult(
          context,
          result,
        );
      },
    );
    this.bot.callbackQuery(
      /^me:([1-9]\d*):([A-Za-z0-9_-]{43})$/,
      async (context) => {
        const modelTarget = target(context);
        const guard = this.queryGuard(modelTarget, String(context.from.id));
        const selectionScope = this.service.status(modelTarget).selectionScope;
        const state = await this.service.modelState(modelTarget, guard);
        if (
          telegramModelSelectionToken(state, String(context.from.id)) !== context.match[2]
        ) {
          throw new UserFacingError(
            "model.selection.expired",
            "模型已变化，请重新发送 /model 选择",
          );
        }
        const model = state.models.find((candidate) =>
          candidate.model === state.model
          && (candidate.provider ?? "openai") === (state.modelProvider ?? "openai"));
        const effort = model?.supportedReasoningEfforts[Number(context.match[1]) - 1]?.effort;
        if (!effort) {
          throw new UserFacingError(
            "model.selection.expired",
            "模型已变化，请重新发送 /model 选择",
          );
        }
        await context.answerCallbackQuery({ text: "正在选择思考等级" });
        await context.editMessageReplyMarkup({
          reply_markup: { inline_keyboard: [] },
        });
        guard();
        if (this.service.status(modelTarget).selectionScope !== selectionScope) {
          throw new UserFacingError("model.selection.expired", "会话已变化，请重新发送 /model 选择");
        }
        const result = await this.commands.execute(
          modelTarget,
          "effort",
          effort,
          String(context.from.id),
        );
        await this.renderCommandResult(
          context,
          result,
        );
      },
    );
    this.bot.callbackQuery(/^rc:page:([1-9]\d{0,3})$/, async context => {
      await context.answerCallbackQuery({ text: "正在查询重置券" });
      const result = await this.commands.execute(target(context), "limits", `reset ${context.match[1]}`, String(context.from.id));
      await renderTelegramCommandResult(context, result);
    });
    this.bot.callbackQuery(/^rc:use:([1-9]\d{0,3}):([0-7]):([A-Za-z0-9_-]{43})$/, async context => {
      await context.answerCallbackQuery({ text: "正在核对重置券" });
      const actor = String(context.from.id);
      const listed = await this.commands.execute(target(context), "limits", `reset ${context.match[1]}`, actor);
      if (listed.kind !== "reset-credit" || listed.result.type !== "list"
        || telegramResetCreditListToken(listed, String(context.chat?.id ?? ""), actor) !== context.match[3]) {
        throw new UserFacingError("reset-credit.failed", "重置券列表已变化", { reason: "reset_stale" });
      }
      const credit = listed.result.credits[Number(context.match[2])];
      if (!credit) throw new UserFacingError("reset-credit.failed", "重置券列表已变化", { reason: "reset_stale" });
      const result = await this.commands.execute(target(context), "limits", `reset use ${credit.id}`, actor);
      await renderTelegramCommandResult(context, result);
    });
    this.bot.callbackQuery(/^rc:(confirm|cancel):([0-9a-f-]{36})$/, async context => {
      await context.answerCallbackQuery({ text: "正在处理重置券确认" });
      const result = await this.commands.execute(target(context), "limits", `reset ${context.match[1]} ${context.match[2]}`, String(context.from.id));
      // 业务结果已确定；清理旧按钮失败不能把已消费误报为消费失败。
      try { await context.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }); }
      catch (error) { this.logger.warn({ ...surfaceErrorMetadata(error) }, "重置券按钮清理失败"); }
      await renderTelegramCommandResult(context, result);
    });
    this.bot.callbackQuery(
      /^schedule:confirm:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
      async (context) => {
        await context.answerCallbackQuery({ text: "正在确认计划任务" });
        await context.editMessageReplyMarkup({
          reply_markup: { inline_keyboard: [] },
        });
        const result = await this.commands.execute(
          target(context),
          "schedule",
          `confirm ${context.match[1]}`,
          String(context.from.id),
        );
        await renderTelegramCommandResult(
          context,
          result,
        );
      },
    );
    this.bot.callbackQuery("schedule:cancel", async (context) => {
      await context.answerCallbackQuery({ text: "已取消" });
      await context.editMessageReplyMarkup({
        reply_markup: { inline_keyboard: [] },
      });
      await context.reply("已取消计划任务操作。未创建或删除任何任务。");
    });
    this.bot.callbackQuery(/^plugin:page:([1-9]\d*)$/, async (context) => {
      await context.answerCallbackQuery({ text: "正在加载 Plugin" });
      const result = await this.commands.execute(
        target(context),
        "plugin",
        `list ${context.match[1]}`,
        String(context.from.id),
      );
      await renderTelegramCommandResult(
        context,
        result,
      );
    });
    this.bot.callbackQuery(/^hooks:(?:page:[1-9]\d*|(?:trust|enable|disable):[0-9a-f]{16}\.[1-9]\d*|confirm:[0-9a-f]{32}|[0-9a-f]{16}\.[1-9]\d*)$/, async (context) => {
      await context.answerCallbackQuery({ text: "正在处理 Hooks" });
      const input = context.callbackQuery.data.slice("hooks:".length).replace(":", " ");
      const result = await this.commands.execute(
        target(context),
        "hooks",
        input,
        String(context.from.id),
      );
      if (input.startsWith("confirm ")) {
        try { await context.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }); }
        catch (error) { this.logger.warn(surfaceErrorMetadata(error), "Hook 确认按钮清理失败"); }
      }
      await renderTelegramCommandResult(context, result);
    });
    this.bot.callbackQuery(
      /^plugin:select:([A-Za-z0-9_-]{43})$/,
      async (context) => {
        await context.answerCallbackQuery({ text: "正在选择 Plugin" });
        const pluginTarget = target(context);
        const matches = (await this.service.listPlugins(pluginTarget, this.queryGuard(pluginTarget, String(context.from.id)))).plugins.filter(
          (plugin) => telegramPluginSelectionToken(plugin.id) === context.match[1],
        );
        if (matches.length !== 1) {
          throw new UserFacingError(
            "plugin.not-found",
            "指定的 Plugin 不存在",
          );
        }
        const plugin = matches[0]!;
        if (!plugin.enabled || !plugin.available) {
          throw new UserFacingError(
            "plugin.unavailable",
            "指定的 Plugin 未启用、被管理员禁用或暂不可调用",
          );
        }
        const prompt = await context.reply(
          formatTelegramPluginTaskPrompt(plugin.displayName),
          { reply_markup: { force_reply: true, selective: true } },
        );
        this.pluginTaskPrompts.add({
          chatId: pluginTarget.conversationId,
          actorId: String(context.from.id),
          messageId: prompt.message_id,
          pluginId: plugin.id,
          pluginName: plugin.displayName,
        });
      },
    );
    this.bot.callbackQuery(/^queue:(?:page|refresh):([1-9]\d*)$/, async (context) => {
      await context.answerCallbackQuery({ text: "正在加载 Queue" });
      const result = await this.commands.execute(
        target(context),
        "queue",
        `list ${context.match[1]}`,
        String(context.from.id),
      );
      await renderTelegramCommandResult(
        context,
        result,
      );
    });
    this.bot.callbackQuery(
      /^queue:item:([1-9]\d*):([A-Za-z0-9_-]{1,52})$/,
      async (context) => {
        const page = context.match[1]!;
        const itemId = context.match[2]!;
        const result = await this.commands.execute(
          target(context),
          "queue",
          `list ${page}`,
          String(context.from.id),
        );
        if (result.kind !== "thread-queue") {
          throw new UserFacingError(
            "queue.item-not-found",
            "Queue 条目按钮已失效，请刷新 /queue list",
          );
        }
        const item = result.result.items.find((candidate) => candidate.id === itemId);
        if (!item) {
          throw new UserFacingError(
            "queue.item-not-found",
            "Queue 条目按钮已失效，请刷新 /queue list",
          );
        }
        await context.answerCallbackQuery({ text: "已打开 Queue 条目" });
        await replyTelegramPanel(
          context,
          formatTelegramThreadQueueItemAction(item),
          threadQueueItemKeyboard(Number(page), item.id),
        );
      },
    );
    this.bot.callbackQuery(
      /^queue:start:([1-9]\d*):([A-Za-z0-9_-]{1,52})$/,
      async (context) => {
        await context.answerCallbackQuery({ text: "正在启动 Queue 条目" });
        const result = await this.commands.execute(
          target(context),
          "queue",
          `start ${context.match[2]}`,
          String(context.from.id),
        );
        await renderTelegramCommandResult(
          context,
          result,
        );
      },
    );
    this.bot.callbackQuery(
      /^queue:delete-confirm:([1-9]\d*):([A-Za-z0-9_-]{1,52})$/,
      async (context) => {
        const page = Number(context.match[1]);
        const itemId = context.match[2]!;
        const result = await this.commands.execute(
          target(context),
          "queue",
          `list ${page}`,
          String(context.from.id),
        );
        if (result.kind !== "thread-queue") {
          throw new UserFacingError(
            "queue.item-not-found",
            "Queue 条目按钮已失效，请刷新 /queue list",
          );
        }
        const item = result.result.items.find((candidate) => candidate.id === itemId);
        if (!item) {
          throw new UserFacingError(
            "queue.item-not-found",
            "Queue 条目按钮已失效，请刷新 /queue list",
          );
        }
        await context.answerCallbackQuery({ text: "请确认删除" });
        await replyTelegramPanel(
          context,
          formatTelegramThreadQueueDeleteConfirmation(item),
          threadQueueDeleteConfirmationKeyboard(page, item.id),
        );
      },
    );
    this.bot.callbackQuery(
      /^queue:delete:([1-9]\d*):([A-Za-z0-9_-]{1,52})$/,
      async (context) => {
        await context.answerCallbackQuery({ text: "正在删除 Queue 条目" });
        const result = await this.commands.execute(
          target(context),
          "queue",
          `delete ${context.match[2]}`,
          String(context.from.id),
        );
        await renderTelegramCommandResult(
          context,
          result,
        );
      },
    );
    this.bot.on("message:text", async (context) => {
      if (context.message.entities?.some(
        (entity) => entity.type === "bot_command" && entity.offset === 0,
      )) {
        throw new UserFacingError("command.unsupported", "Telegram 命令不受支持");
      }
      const pluginPrompt = this.pluginTaskPrompts.consume(
        String(context.chat.id),
        String(context.from.id),
        context.message.reply_to_message?.message_id ?? -1,
      );
      if (
        pluginPrompt.kind === "expired"
        || (
          pluginPrompt.kind === "none"
          && isTelegramPluginTaskPrompt(
            context.message.reply_to_message,
            this.bot.botInfo.id,
          )
        )
      ) {
        await context.reply("Plugin 任务提示已过期，请重新使用 /plugin 选择。", {
          reply_parameters: {
            message_id: context.message.message_id,
            allow_sending_without_reply: true,
          },
        });
        return;
      }
      if (pluginPrompt.kind === "forbidden") {
        await context.reply("该 Plugin 任务提示不属于当前用户。", {
          reply_parameters: {
            message_id: context.message.message_id,
            allow_sending_without_reply: true,
          },
        });
        return;
      }
      if (pluginPrompt.kind === "matched") {
        const result = await this.commands.execute(
          target(context),
          "plugin",
          `${pluginPrompt.pluginId} ${context.message.text.trim()}`,
          String(context.from.id),
        );
        await renderTelegramCommandResult(
          context,
          result,
        );
        return;
      }
      if (await this.interactions.handleText(context)) {
        return;
      }
      const inputTarget = target(context);
      this.outbox.prepareTurnReplyTarget(
        inputTarget.conversationId,
        context.message.message_id,
      );
      let result;
      try {
        result = await this.inputs.enqueue({
          target: inputTarget,
          actorId: String(context.from?.id ?? ""),
          sequence: this.takeInputSequence(),
          text: formatQuotedInput(
            context.message.text,
            telegramQuotedText(context.message.reply_to_message),
          ),
        });
      } catch (error) {
        this.outbox.discardPendingTurnReplyTarget(inputTarget.conversationId);
        throw error;
      }
      if (result.tail && result.submission.steered) {
        this.outbox.discardPendingTurnReplyTarget(inputTarget.conversationId);
      } else if (result.tail) {
        this.outbox.bindPendingTurnReplyTarget(
          inputTarget.conversationId,
          result.submission.threadId,
          result.submission.turnId,
        );
      }
      if (result.tail && result.submission.steered) {
        await context.reply(formatTurnInputAppended("text", false, context.message.text), {
          disable_notification: true,
          reply_parameters: {
            message_id: context.message.message_id,
            allow_sending_without_reply: true,
          },
        });
      }
    });
    this.bot.on("message:photo", async (context) => {
      const photo = context.message.photo.at(-1);
      if (!photo) {
        throw new Error("Telegram 图片消息缺少文件信息");
      }
      await this.submitImage(
        context,
        photo.file_id,
        photo.file_size,
        context.message.caption,
      );
    });
    this.bot.on("message:animation", async (context) => {
      const animation = context.message.animation;
      await this.submitImage(
        context,
        animation.file_id,
        animation.file_size,
        context.message.caption,
      );
    });
    this.bot.on(["message:voice", "message:audio"], async (context) => {
      const audio = context.message.voice ?? context.message.audio;
      if (!audio) {
        throw new Error("Telegram 语音消息缺少文件信息");
      }
      await this.submitAudio(
        context,
        audio.file_id,
        audio.file_size,
        audio.duration,
        context.message.caption,
      );
    });
    this.bot.on(["message:video", "message:video_note"], async (context) => {
      const video = context.message.video ?? context.message.video_note;
      if (!video) throw new Error("Telegram 视频消息缺少文件信息");
      await this.submitVideo(context, video.file_id, video.file_size, context.message.caption);
    });
    this.bot.on("message:document", async (context) => {
      const document = context.message.document;
      if (isVideoDocument(document.mime_type, document.file_name)) {
        await this.submitVideo(context, document.file_id, document.file_size, context.message.caption);
        return;
      }
      if (isSupportedImageDocument(document.mime_type, document.file_name)) {
        await this.submitImage(
          context,
          document.file_id,
          document.file_size,
          context.message.caption,
        );
        return;
      }
      if (
        document.file_size !== undefined
        && document.file_size > maximumTelegramTextFileBytes
      ) {
        await context.reply(
          `${formatTextFileTooLarge("Telegram")}。`,
        );
        return;
      }
      try {
        await this.submitTextFile(
          context,
          document.file_id,
          document.file_name ?? "未命名.txt",
          context.message.caption,
        );
      } catch (error) {
        if (error instanceof TelegramTextFileInputError) {
          await context.reply(`${error.message}。`);
          return;
        }
        throw error;
      }
    });
  }

  private async submitVideo(
    context: Context,
    fileId: string,
    fileSize: number | undefined,
    caption: string | undefined,
  ): Promise<void> {
    if (this.stopping) return;
    if (this.videoInput === undefined) {
      await context.reply("此 Gateway 未配置视频附件接入，暂不支持视频。");
      return;
    }
    const inputTarget = target(context);
    const actorId = String(context.from?.id ?? "");
    if (!this.access.isAllowed({ target: inputTarget, actorId })) return;
    const submitAttachment = await this.receivedAttachments.get(context.update)?.prepare() ?? this.service.prepareAttachmentSubmission?.(
      inputTarget,
      () => !this.stopping && this.access.isAllowed({ target: inputTarget, actorId }),
    );
    if (submitAttachment === undefined) {
      await context.reply("此 Gateway 的视频会话提交入口未就绪，请稍后重新发送。");
      return;
    }
    let file;
    try {
      await this.inputs.flushPending(inputTarget, actorId);
      if (this.stopping || !this.access.isAllowed({ target: inputTarget, actorId })) return;
      if (submitAttachment.signal.aborted) {
        throw new UserFacingError("video.unavailable", "视频输入已取消或超时，请重新发送。");
      }
      submitAttachment.captureTarget();
      try {
        file = await this.videoInput.download(this.bot.api, fileId, fileSize, { target: inputTarget, actorId }, submitAttachment.signal);
      } catch (error) {
        if (this.stopping) return;
        if (submitAttachment.signal.aborted) {
          throw new UserFacingError("video.unavailable", "视频输入已取消或超时，请重新发送。");
        }
        if (error instanceof UserFacingError && error.code.startsWith("video.")) {
          const text = error.code === "video.too-large"
            ? "Telegram 视频超过 20 MiB 限制，请压缩后重新发送。"
            : error.code === "video.unsupported"
              ? "视频附件仅支持内容有效的 MP4 或 WebM，请转换后重新发送。"
              : error.code === "video.capacity"
                ? "视频附件暂存容量已满，请稍后重新发送。"
                : "Telegram 视频下载或暂存失败，请重新发送。";
          await context.reply(text);
          return;
        }
        throw error;
      }
      if (this.stopping || !this.access.isAllowed({ target: inputTarget, actorId })) {
        return;
      }
      if (submitAttachment.signal.aborted) {
        throw new UserFacingError("video.unavailable", "视频输入已取消或超时，请重新发送。");
      }
      const message = context.message;
      if (!message) {
        throw new Error("Telegram 视频更新缺少消息信息");
      }
      const currentText = caption?.trim();
      const text = formatQuotedInput([
        "以下为用户通过 Telegram 上传的视频附件（仅作会话输入）：",
        ...(currentText ? ["用户说明：", currentText, ""] : []),
        videoAttachmentBody(file),
      ].join("\n"), telegramQuotedText(message.reply_to_message));
      this.outbox.prepareTurnReplyTarget(inputTarget.conversationId, message.message_id);
      let submission;
      try {
        submission = await submitAttachment.submit(text);
      } catch (error) {
        this.outbox.discardPendingTurnReplyTarget(inputTarget.conversationId);
        throw error;
      }
      if (this.stopping) return;
      if (submission.steered) {
        this.outbox.discardPendingTurnReplyTarget(inputTarget.conversationId);
        await context.reply(formatTurnInputAppended("file", Boolean(currentText)), {
          disable_notification: true,
          reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
        });
      } else {
        this.outbox.bindPendingTurnReplyTarget(
          inputTarget.conversationId,
          submission.threadId,
          submission.turnId,
        );
      }
    } finally {
      submitAttachment.dispose();
      if (file !== undefined) {
        if (submitAttachment.mayHaveSubmitted) this.videoInput.retain(file);
        else await this.videoInput.discard(file);
      }
    }
  }

  private async submitTextFile(
    context: Context,
    fileId: string,
    fileName: string,
    caption: string | undefined,
  ): Promise<void> {
    const sequence = this.takeInputSequence();
    const file = await this.textFileInput.download(
      this.bot.api,
      fileId,
      fileName,
    );
    if (!context.message) {
      throw new Error("Telegram 文件更新缺少消息信息");
    }
    const quotedText = telegramQuotedText(
      context.message.reply_to_message,
    );
    const currentText = caption?.trim();
    const text = formatQuotedInput([
      ...(currentText ? [currentText, ""] : []),
      "以下内容来自用户通过 Telegram 上传的 UTF-8 文本文件（仅作输入）：",
      `文件名：${file.fileName}`,
      "",
      textAttachmentBody(file),
    ].join("\n"), quotedText);
    const inputTarget = target(context);
    this.outbox.prepareTurnReplyTarget(
      inputTarget.conversationId,
      context.message.message_id,
    );
    let result;
    try {
      result = await this.inputs.enqueue({
        target: inputTarget,
        actorId: String(context.from?.id ?? ""),
        sequence,
        text,
      });
    } catch (error) {
      this.outbox.discardPendingTurnReplyTarget(inputTarget.conversationId);
      throw error;
    }
    if (result.tail && result.submission.steered) {
      this.outbox.discardPendingTurnReplyTarget(inputTarget.conversationId);
    } else if (result.tail) {
      this.outbox.bindPendingTurnReplyTarget(
        inputTarget.conversationId,
        result.submission.threadId,
        result.submission.turnId,
      );
    }
    if (result.tail && result.submission.steered) {
      await context.reply(formatTurnInputAppended("file", Boolean(currentText)), {
        disable_notification: true,
        reply_parameters: {
          message_id: context.message.message_id,
          allow_sending_without_reply: true,
        },
      });
    }
  }

  private async submitImage(
    context: Context,
    fileId: string,
    fileSize: number | undefined,
    caption: string | undefined,
  ): Promise<void> {
    const sequence = this.takeInputSequence();
    if (fileSize !== undefined && fileSize > maximumTelegramImageBytes) {
      throw new UserFacingError("image.too-large", "图片超过 10 MiB 限制");
    }
    const image = await this.imageStore.download(this.bot.api, fileId);
    if (!context.message) {
      throw new Error("Telegram 图片更新缺少消息信息");
    }
    const quotedText = telegramQuotedText(
      context.message.reply_to_message,
    );
    const currentText = caption?.trim();
    const inputTarget = target(context);
    const aggregationSize = telegramUpdateGroupSize(context.update);
    this.outbox.prepareTurnReplyTarget(
      inputTarget.conversationId,
      context.message.message_id,
    );
    let result;
    try {
      result = await this.inputs.enqueue({
        target: inputTarget,
        actorId: String(context.from?.id ?? ""),
        sequence,
        ...(context.message.media_group_id
          ? {
              aggregationKey: `telegram:${context.message.media_group_id}`,
              ...(aggregationSize === undefined
                ? {}
                : { aggregationSize }),
            }
          : {}),
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
        localImages: [{
          path: image.path,
          mimeType: image.mimeType,
          bytes: image.bytes,
        }],
      });
    } catch (error) {
      this.outbox.discardPendingTurnReplyTarget(inputTarget.conversationId);
      throw error;
    }
    if (result.tail && result.submission.steered) {
      this.outbox.discardPendingTurnReplyTarget(inputTarget.conversationId);
    } else if (result.tail) {
      this.outbox.bindPendingTurnReplyTarget(
        inputTarget.conversationId,
        result.submission.threadId,
        result.submission.turnId,
      );
    }
    if (result.tail && result.submission.steered && context.message) {
      await context.reply(formatTurnInputAppended("image", Boolean(currentText)), {
        disable_notification: true,
        reply_parameters: {
          message_id: context.message.message_id,
          allow_sending_without_reply: true,
        },
      });
    }
  }

  private async submitAudio(
    context: Context,
    fileId: string,
    fileSize: number | undefined,
    duration: number,
    caption: string | undefined,
  ): Promise<void> {
    if (fileSize !== undefined && fileSize > maximumTelegramAudioBytes) {
      throw new UserFacingError("audio.too-large", "音频超过 20 MiB 限制");
    }
    if (duration > maximumTelegramAudioDurationSeconds) {
      throw new UserFacingError("audio.too-large", "语音最长支持 5 分钟");
    }
    const inputTarget = target(context);
    const actorId = String(context.from?.id ?? "");
    const scope = await this.receivedAttachments.get(context.update)?.prepare() ?? this.service.prepareAttachmentSubmission?.(
      inputTarget,
      () => !this.stopping && this.access.isAllowed({ target: inputTarget, actorId }),
      "audio",
    );
    if (!scope) throw new UserFacingError("audio.unavailable", "语音提交能力尚未就绪");
    try {
      await this.inputs.flushPending(inputTarget, actorId);
      scope.captureTarget();
      const audio = await this.audioStore.download(this.bot.api, fileId, scope.signal);
      const quotedText = telegramQuotedText(context.message?.reply_to_message);
      const currentText = caption?.trim();
      this.outbox.prepareTurnReplyTarget(
        inputTarget.conversationId,
        context.message!.message_id,
      );
      let submission;
      try {
        submission = await scope.submit({
          ...(currentText || quotedText !== undefined
            ? {
                text: formatQuotedInput(
                  currentText || "请听取这段语音并根据内容协助我。",
                  quotedText,
                ),
              }
            : {}),
          localAudios: [{ path: audio.path }],
        });
      } catch (error) {
        this.outbox.discardPendingTurnReplyTarget(inputTarget.conversationId);
        throw error;
      }
      if (submission.steered) {
        this.outbox.discardPendingTurnReplyTarget(inputTarget.conversationId);
        await context.reply(formatTurnInputAppended("audio", Boolean(currentText)), {
          disable_notification: true,
          reply_parameters: {
            message_id: context.message!.message_id,
            allow_sending_without_reply: true,
          },
        });
      } else {
        this.outbox.bindPendingTurnReplyTarget(
          inputTarget.conversationId,
          submission.threadId,
          submission.turnId,
        );
      }
    } finally {
      scope.dispose();
    }
  }

  private takeInputSequence(): number {
    const sequence = this.nextInputSequence;
    this.nextInputSequence += 1;
    return sequence;
  }

  private async executeCommand(
    context: Context,
    command: ConversationCommandName,
  ): Promise<void> {
    if (!context.from) throw new UserFacingError("command.authorization-changed", "无法确认命令操作者");
    const result = await this.commands.execute(
      target(context),
      command,
      commandArguments(context),
      String(context.from.id),
    );
    if (result.kind === "outcome" && result.outcome.type === "turn.stop-requested"
      && this.attachmentStops.has(context.update)) result.outcome.stopped = true;
    if (result.kind === "auto-review") {
      await this.renderAutoReviewResult(context, result);
      return;
    }
    await this.renderCommandResult(
      context,
      result,
    );
  }

  private commandReplyScope(inputTarget: ConversationTarget): CommandReplyScope {
    const workspaceId = this.service.selectedWorkspaceId(inputTarget);
    const workspace = this.service.listWorkspaces().find(workspace => workspace.id === workspaceId);
    // /workspace must remain available to recover a removed selection.
    const status = workspace === undefined ? undefined : this.service.status(inputTarget);
    return {
      workspaceId,
      cwd: workspace?.cwd,
      selectionScope: status?.selectionScope,
      threadId: status?.threadId,
    };
  }

  private async renderCommandResult(context: Context, result: ConversationCommandResult): Promise<void> {
    const relevant = result.kind === "status" || result.kind === "workspaces" || result.kind === "models"
      || result.kind === "metrics" || result.kind === "usage" || result.kind === "limits"
      || result.kind === "sessions" || result.kind === "collaboration-mode"
      || result.kind === "outcome" && ["workspace.selected", "thread.resumed", "thread.unarchived", "thread.forked",
        "session.new", "thread.archived", "thread.renamed", "thread.pin-updated", "sessions.cleaned"].includes(result.outcome.type);
    if (!relevant) return renderTelegramCommandResult(context, result);
    const original = this.commandReplies.get(context);
    const inputTarget = target(context);
    const actorId = String(context.from?.id ?? "");
    if (!original) throw new UserFacingError("command.authorization-changed", "命令回复已失效，请重新发起操作");
    const assertActor = (): void => {
      original.signal.throwIfAborted();
      if (this.stopping || !this.access.isAllowed({ target: inputTarget, actorId })) {
        throw new UserFacingError("command.authorization-changed", "命令授权已变化，请重新发起操作");
      }
    };
    assertActor();
    let scope = original.scope;
    // Model queries and selections return their exact authoritative selection
    // scope, including browse-only changes. Status refreshes also carry it.
    if (result.kind === "models") scope = { ...scope, selectionScope: result.state.selectionScope,
      threadId: this.service.status(inputTarget).threadId };
    if (result.kind === "status") {
      if (result.status.workspaceId !== scope.workspaceId || result.status.cwd !== scope.cwd || result.status.threadId !== scope.threadId) {
        throw new UserFacingError("command.authorization-changed", "命令结果所属会话已变化，请重新查询");
      }
      scope = { ...scope, selectionScope: result.status.selectionScope };
    }
    if (result.kind === "outcome") {
      const outcome = result.outcome;
      // These completed mutations intentionally replace the query's original
      // binding. Capture the resulting scope once, before queueing any reply.
      if (["workspace.selected", "thread.resumed", "thread.unarchived", "thread.forked", "session.new", "thread.archived"].includes(outcome.type)) {
        scope = outcome.type === "workspace.selected" && outcome.workspace.id === original.scope.workspaceId
          ? original.scope : this.commandReplyScope(inputTarget);
        const status = this.service.status(inputTarget);
        if (outcome.type === "workspace.selected" && (scope.workspaceId !== outcome.workspace.id || scope.cwd !== outcome.workspace.cwd)
          || outcome.type === "workspace.selected" && outcome.workspace.id !== original.scope.workspaceId && status.threadId !== undefined
          || outcome.type !== "workspace.selected" && (scope.workspaceId !== original.scope.workspaceId || scope.cwd !== original.scope.cwd)
          || (outcome.type === "thread.resumed" || outcome.type === "thread.forked" || outcome.type === "thread.unarchived") && status.threadId !== outcome.threadId
          || (outcome.type === "session.new" || outcome.type === "thread.archived") && status.threadId !== undefined) {
          throw new UserFacingError("command.authorization-changed", "命令结果所属会话已变化，请重新查询");
        }
      }
    }
    const guard = (): void => {
      assertActor();
      this.usageEdits.get(context)?.assertActive();
      const current = this.commandReplyScope(inputTarget);
      if (current.workspaceId !== scope.workspaceId || current.cwd !== scope.cwd
        || current.selectionScope !== scope.selectionScope || current.threadId !== scope.threadId) {
        throw new UserFacingError("command.authorization-changed", "命令结果所属会话已变化，请重新查询");
      }
    };
    guard();
    await this.outbox.runOrdered(inputTarget.conversationId, async signal => {
      guard();
      if (result.kind === "usage" && result.result.kind === "cloud-usage") {
        const choices = cloudUsageChoices(result.result);
        const token = randomBytes(18).toString("base64url");
        const keyboard: InlineKeyboardMarkup = { inline_keyboard: [] };
        for (let index = 0; index < choices.length; index++) {
          const button = { text: choices[index]!.label, callback_data: `usage:${token}:${index}` };
          if (index < 3) (keyboard.inline_keyboard[0] ??= []).push(button);
          else keyboard.inline_keyboard.push([button]);
        }
        const text = formatTelegramPanelChunks(formatCloudUsage(result.result));
        if (text.length !== 1) throw new Error("Ollama 用量卡片超过消息上限");
        const messageId = this.usageEdits.get(context)?.messageId;
        const deliveredId = await this.apiExecutor.call({ chatId: inputTarget.conversationId,
          operation: messageId === undefined ? "sendMessage" : "editMessageText", critical: false }, async requestSignal => {
          guard();
          const options = { parse_mode: "HTML" as const, reply_markup: keyboard };
          if (messageId === undefined) return (await context.reply(text[0]!, options, telegramAbortSignal(requestSignal))).message_id;
          await this.bot.api.editMessageText(inputTarget.conversationId, messageId, text[0]!, options, telegramAbortSignal(requestSignal));
          return messageId;
        }, signal);
        guard();
        for (const [key, value] of this.usageSelections) if (value.expiresAt <= this.now()) this.usageSelections.delete(key);
        while (this.usageSelections.size >= 100) this.usageSelections.delete(this.usageSelections.keys().next().value!);
        this.usageSelections.set(token, { target: inputTarget, actorId,
          messageId: deliveredId, expiresAt: this.now() + 10 * 60_000, scope: { ...scope }, inputs: choices.map(choice => choice.input) });
        return;
      }
      await renderTelegramCommandResult(context, result, (text, options) => this.apiExecutor.call({
        chatId: inputTarget.conversationId, operation: "sendMessage", critical: false,
      }, requestSignal => {
        guard();
        return context.reply(text, options, telegramAbortSignal(requestSignal));
      }, signal));
    }, original.signal);
  }

  private registerAutoReviewSelection(
    context: Context,
    scope: AutoReviewSelectionScope,
  ): string | undefined {
    if (!context.from) return undefined;
    for (const [key, selection] of this.autoReviewSelections) {
      if (selection.expiresAt <= this.now()) this.autoReviewSelections.delete(key);
    }
    while (this.autoReviewSelections.size >= 100) {
      this.autoReviewSelections.delete(this.autoReviewSelections.keys().next().value!);
    }
    const token = randomBytes(18).toString("base64url");
    this.autoReviewSelections.set(token, {
      ...scope,
      target: target(context),
      actorId: String(context.from.id),
      expiresAt: this.now() + 5 * 60_000,
    });
    return token;
  }

  private async renderAutoReviewResult(
    context: Context,
    result: Extract<ConversationCommandResult, { kind: "auto-review" }>,
  ): Promise<void> {
    const { threadId, reviewer } = result.state;
    let token: string | undefined;
    if (threadId !== null && (reviewer === "user" || reviewer === "auto_review")) {
      token = this.registerAutoReviewSelection(context, {
        threadId,
      });
    }
    try {
      await replyTelegramPanel(context, formatConversationAutoReview(result), token ? threadAutoReviewKeyboard(token) : undefined);
    } catch (error) {
      if (token) this.autoReviewSelections.delete(token);
      throw error;
    }
  }

  private receiveAttachmentUpdate(update: Context["update"]): (() => void) | undefined {
    this.receivedUpdates.add(update);
    const message = update.message;
    if (!message?.from || message.chat.type !== "private" || this.stopping) return;
    const inputTarget: ConversationTarget = {
      surface: "telegram", accountId: this.accountId, conversationId: String(message.chat.id),
    };
    const actorId = String(message.from.id);
    const allowed = () => !this.stopping && this.access.isAllowed({ target: inputTarget, actorId });
    if (allowed()) this.rememberPrivateConversation(inputTarget, actorId);
    if (isTelegramEmergencyStopUpdate(update, this.bot)) {
      if (!allowed()) {
        this.rejectedAttachmentStops.add(update);
        return;
      }
      const stop = this.attachmentInputs.receiveStop(inputTarget);
      if (stop.cancelled) this.attachmentStops.add(update);
      return stop;
    }
    const kind = message.voice || message.audio ? "audio"
      : message.video || message.video_note || (message.document && isVideoDocument(message.document.mime_type, message.document.file_name))
        ? "video" : undefined;
    if (!kind) return;
    const receipt = this.attachmentInputs.receive(inputTarget, allowed, kind,
      () => this.service.prepareAttachmentSubmission?.(inputTarget, allowed, kind));
    this.receivedAttachments.set(update, receipt);
    return () => { receipt.dispose(); this.receivedAttachments.delete(update); };
  }

  private async authorize(context: Context, next: () => Promise<void>): Promise<void> {
    if (this.stopping) return;
    if (context.chat?.type !== "private") {
      if (context.message) await context.reply("此 Gateway 仅支持 Telegram 私聊，请在与机器人的私聊中使用。");
      else if (context.callbackQuery) await context.answerCallbackQuery({ text: "此 Gateway 仅支持 Telegram 私聊" });
      return;
    }
    if (isWhoAmICommand(context, this.bot.botInfo.username)) {
      await next();
      return;
    }
    const accessContext = context.chat && context.from
      ? {
          target: target(context),
          actorId: String(context.from.id),
        }
      : undefined;
    if (!accessContext || !this.access.isAllowed(accessContext) || this.rejectedAttachmentStops.has(context.update)) {
      if (context.message) {
        await context.reply("无权使用此 Gateway。可用 /whoami 查看自己的 Telegram 用户 ID。");
      } else if (context.callbackQuery) {
        await context.answerCallbackQuery({ text: "无权执行此操作" });
      }
      return;
    }
    const stopTyping = context.message && context.chat
      ? this.outbox.beginTyping(String(context.chat.id))
      : undefined;
    try {
      this.rememberPrivateConversation(accessContext.target, accessContext.actorId);
      this.actorRegistry?.rememberActor(accessContext.target, accessContext.actorId);
      this.commandReplies.set(context, {
        signal: this.apiExecutor.authorizationSignal(accessContext.target.conversationId),
        scope: this.commandReplyScope(accessContext.target),
      });
      await next();
    } catch (error) {
      this.logger.error(
        {
          ...telegramErrorMetadata(error),
          chatId: context.chat?.id,
        },
        "Telegram 命令执行失败",
      );
      if (context.chat && !this.stopping && this.access.isAllowed(accessContext)
        && !this.commandReplies.get(context)?.signal.aborted) {
        await context.reply(
          error instanceof UserFacingError
            ? formatOperationFailure(formatTelegramUserFacingError(error))
            : formatOperationFailure(gatewayRequestFailedText),
        );
      }
    } finally {
      this.commandReplies.delete(context);
      stopTyping?.();
    }
  }
}

function telegramQuotedText(
  message: { text?: string; caption?: string } | undefined,
): string | undefined {
  const text = message?.text?.trim() || message?.caption?.trim();
  return text || undefined;
}

function formatTelegramPluginTaskPrompt(pluginName: string): string {
  return `已选择 ${pluginName}。请回复此消息输入任务；提示 10 分钟内有效。`;
}

function isTelegramPluginTaskPrompt(
  message: { from?: { id: number }; text?: string } | undefined,
  botId: number,
): boolean {
  return message?.from?.id === botId
    && message.text?.startsWith("已选择 ") === true
    && message.text.endsWith("。请回复此消息输入任务；提示 10 分钟内有效。");
}

function telegramMessageType(context: Context): string | undefined {
  const message = context.message;
  if (!message) return undefined;
  if (message.text !== undefined) return "text";
  if (message.photo !== undefined) return "photo";
  if (message.animation !== undefined) return "animation";
  if (message.document !== undefined) return "document";
  if (message.voice !== undefined) return "voice";
  if (message.audio !== undefined) return "audio";
  if (message.video !== undefined) return "video";
  if (message.video_note !== undefined) return "video-note";
  return "other";
}

function isVideoDocument(mimeType: string | undefined, fileName: string | undefined): boolean {
  return mimeType?.startsWith("video/") === true
    || /\.(?:mp4|webm|mov|mkv|avi|m4v|mpeg|mpg)$/i.test(fileName ?? "");
}

function isSupportedImageDocument(mimeType: string | undefined, fileName: string | undefined): boolean {
  return mimeType === "image/png" ||
    mimeType === "image/jpeg" ||
    mimeType === "image/gif" ||
    mimeType === "image/webp" ||
    /\.(?:gif|png|jpe?g|webp)$/i.test(fileName ?? "");
}

function target(context: Context): ConversationTarget {
  if (!context.chat) {
    throw new Error("Telegram 更新缺少 Chat");
  }
  return {
    surface: "telegram",
    accountId: telegramDefaultAccountId,
    conversationId: String(context.chat.id),
  };
}

function commandArguments(context: Context): string {
  const text = context.message?.text ?? "";
  return text.replace(/^\/\w+(?:@\w+)?\s*/, "").trim();
}

function isWhoAmICommand(context: Context, botUsername: string): boolean {
  const text = context.message?.text;
  if (!text) {
    return false;
  }
  const match = /^\/whoami(?:@([a-z0-9_]+))?(?:\s|$)/i.exec(text);
  const addressedUsername = match?.[1];
  return match !== null
    && (addressedUsername === undefined
      || addressedUsername.toLowerCase() === botUsername.toLowerCase());
}

function workspaceSwitchKeyboard(workspaces: readonly Workspace[]): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: workspaces.map((workspace) => [{
      text: `切换到 ${workspace.name}`,
      callback_data: `ws:${telegramWorkspaceSwitchToken(workspace.id)}`,
    }]),
  };
}
