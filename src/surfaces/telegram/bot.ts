import { createHash } from "node:crypto";

import { Bot, type Context } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Logger } from "pino";

import {
  ConversationCommandService,
  conversationCommandNames,
  type ConversationCommandName,
  type ConversationUseCases,
  type DisplayPriceCurrency,
  type ExchangeRateSnapshot,
  type ProviderModelUsageEstimate,
  type ScheduledTaskConfirmation,
  type ScheduledTaskUseCases,
} from "../../application/index.js";
import {
  UserFacingError,
  type ConversationTarget,
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
  formatConversationScheduledConfirmation,
} from "../conversation-command-format.js";
import { formatTurnInputAppended } from "../input-copy.js";
import {
  formatOperationFailure,
  gatewayRequestFailedText,
  interactionStoppedText,
} from "../output-copy.js";
import { formatTextFileTooLarge } from "../text-file-copy.js";
import { SurfaceInputCoalescer } from "../surface-input-coalescer.js";
import { formatQuotedInput } from "../quoted-input.js";
import { surfaceCommandAliases } from "../slash-command.js";
import {
  formatConfigurationChange,
  formatStartupNotification,
  type StartupRuntimeInfo,
} from "./format.js";
import {
  renderTelegramCommandResult,
  scheduledTaskConfirmationKeyboard,
  formatTelegramThreadQueueDeleteConfirmation,
  formatTelegramThreadQueueItemAction,
  replyTelegramPanel,
  telegramPluginSelectionToken,
  threadQueueDeleteConfirmationKeyboard,
  threadQueueItemKeyboard,
  telegramThreadSectionToken,
  workspacePermissionFieldKeyboard,
  workspacePermissionPrompt,
} from "./command-renderer.js";
import { TelegramInteractionPort } from "./interactions.js";
import { TelegramApiExecutor } from "./api-executor.js";
import { telegramDefaultAccountId } from "./constants.js";
import {
  TelegramLifecycle,
  telegramUpdateGroupSize,
} from "./lifecycle.js";
import { TelegramOutbox, type TelegramFinalMessageFormat } from "./outbox.js";
import { maximumTelegramImageBytes, TelegramImageStore } from "./image-store.js";
import {
  maximumTelegramAudioBytes,
  maximumTelegramAudioDurationSeconds,
  TelegramAudioStore,
} from "./audio-store.js";
import { telegramErrorMetadata } from "./error-metadata.js";
import {
  maximumTelegramTextFileBytes,
  TelegramTextFileInput,
  TelegramTextFileInputError,
  type TelegramTextFilePort,
} from "./file-input.js";
import { formatTelegramUserFacingError } from "./user-error-renderer.js";
import { TelegramPluginTaskPrompts } from "./plugin-task-prompts.js";

export interface TelegramImagePort {
  start(): Promise<void>;
  close(): void;
  download(
    api: Parameters<TelegramImageStore["download"]>[0],
    fileId: string,
  ): ReturnType<TelegramImageStore["download"]>;
}

export interface TelegramAudioPort {
  start(): Promise<void>;
  close(): void;
  download(
    api: Parameters<TelegramAudioStore["download"]>[0],
    fileId: string,
  ): ReturnType<TelegramAudioStore["download"]>;
}

export interface TelegramSurfaceOptions {
  gatewayVersion: string;
  actorRegistry?: ConversationActorRegistry;
  threadSectionAccess?: SurfaceAccessPolicy;
  scheduledTasks?: ScheduledTaskUseCases;
  onFatal?: (error: Error) => void;
  imageStore?: TelegramImagePort;
  audioStore?: TelegramAudioPort;
  textFileInput?: TelegramTextFilePort;
  finalMessageFormat?: TelegramFinalMessageFormat;
  operationUpdateDisplay?: OperationUpdateDisplay;
  planUpdatesEnabled?: boolean;
  reasoningEnabled?: boolean;
  codexUpstreamUserAgent?: () => string | undefined;
  openAiConnectivity?: () => NonNullable<StartupRuntimeInfo["openAiConnectivity"]>;
  inputQuietWindowMs?: number;
  now?: () => number;
  debugEnabled?: boolean;
  exchangeRate?: () => ExchangeRateSnapshot | null;
  priceCurrency?: (
    provider: string | null | undefined,
  ) => DisplayPriceCurrency;
  remainingUsage?: (
    model: string,
    requestStartedAtMs?: number,
    modelProvider?: string,
  ) => Promise<ProviderModelUsageEstimate | null>;
}

export interface CreateTelegramSurfaceOptions extends TelegramSurfaceOptions {
  token: string;
  proxyUrl?: string;
  service: ConversationUseCases;
  access: SurfaceAccessPolicy;
  startupRecipients: ReadonlySet<number>;
  workspaces: Workspace[];
  uploadsDirectory: string;
  logger: Logger;
}

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

export class TelegramSurface {
  readonly surface = "telegram" as const;
  readonly accountId = telegramDefaultAccountId;
  readonly bot: Bot;
  readonly interactions: TelegramInteractionPort;
  readonly output: TelegramOutbox;
  private readonly outbox: TelegramOutbox;
  private readonly lifecycle: TelegramLifecycle;
  private readonly imageStore: TelegramImagePort;
  private readonly audioStore: TelegramAudioPort;
  private readonly textFileInput: TelegramTextFilePort;
  private readonly actorRegistry: ConversationActorRegistry | undefined;
  private readonly commands: ConversationCommandService;
  private readonly inputs: SurfaceInputCoalescer;
  private readonly pluginTaskPrompts: TelegramPluginTaskPrompts;
  private readonly now: () => number;
  private readonly debugEnabled: boolean;
  private readonly exchangeRate: (() => ExchangeRateSnapshot | null) | undefined;
  private readonly priceCurrency:
    | ((provider: string | null | undefined) => DisplayPriceCurrency)
    | undefined;
  private nextInputSequence = 0;
  private notificationRecipients: ReadonlySet<number>;

  constructor(
    token: string,
    proxyUrl: string | undefined,
    private readonly service: ConversationUseCases,
    private readonly access: SurfaceAccessPolicy,
    startupRecipients: ReadonlySet<number>,
    workspaces: Workspace[],
    uploadsDirectory: string,
    private readonly logger: Logger,
    options: TelegramSurfaceOptions,
  ) {
    this.bot = new Bot(token, {
      client: {
        timeoutSeconds: 30,
        ...(proxyUrl
          ? { baseFetchConfig: { agent: new HttpsProxyAgent(proxyUrl) } }
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
    this.actorRegistry = options.actorRegistry;
    this.now = options.now ?? Date.now;
    this.debugEnabled = options.debugEnabled ?? false;
    this.exchangeRate = options.exchangeRate;
    this.priceCurrency = options.priceCurrency;
    this.notificationRecipients = new Set(startupRecipients);
    this.commands = new ConversationCommandService(
      service,
      options.threadSectionAccess,
      options.scheduledTasks,
    );
    this.pluginTaskPrompts = new TelegramPluginTaskPrompts({ now: this.now });
    const apiExecutor = new TelegramApiExecutor(logger);
    this.outbox = new TelegramOutbox(this.bot.api, logger, apiExecutor, {
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
        ...(options.exchangeRate === undefined
          ? {}
          : { exchangeRate: options.exchangeRate }),
      ...(options.priceCurrency === undefined
        ? {}
        : { priceCurrency: options.priceCurrency }),
      ...(options.remainingUsage === undefined
        ? {}
        : { remainingUsage: options.remainingUsage }),
      debugEnabled: this.debugEnabled,
    });
    this.output = this.outbox;
    this.inputs = new SurfaceInputCoalescer(
      (inputTarget, input) => service.submit(inputTarget, input),
      {
        quietWindowMs: options.inputQuietWindowMs ?? 1_000,
      },
    );
    this.interactions = new TelegramInteractionPort(this.bot, logger, apiExecutor, this.outbox);
    this.imageStore = options.imageStore ?? new TelegramImageStore(uploadsDirectory, token, proxyUrl, logger);
    this.audioStore = options.audioStore
      ?? new TelegramAudioStore(uploadsDirectory, token, proxyUrl, logger);
    this.textFileInput = options.textFileInput
      ?? new TelegramTextFileInput(token, proxyUrl);
    this.lifecycle = new TelegramLifecycle(
      this.bot,
      logger,
      {
        messages: () => [...startupRecipients].map((chatId) => {
          const status = this.service.status(
            {
              surface: "telegram",
              accountId: telegramDefaultAccountId,
              conversationId: String(chatId),
            },
            { includeGitBranch: true },
          );
          return {
            chatId,
            text: formatStartupNotification(workspaces, status, {
              platform: process.platform,
              architecture: process.arch,
              gatewayVersion: options.gatewayVersion,
              nodeVersion: process.version,
              transport: "Unix WebSocket",
              codexUpstreamUserAgent: options.codexUpstreamUserAgent?.() ?? null,
              ...(options.openAiConnectivity
                ? { openAiConnectivity: options.openAiConnectivity() }
                : {}),
              debugEnabled: this.debugEnabled,
            }),
          };
        }),
      },
      options.onFatal,
    );
    this.registerHandlers();
  }

  sendChannelImage(conversationId: string, imagePath: string): Promise<void> {
    return this.output.sendChannelImage(conversationId, imagePath);
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
    ]);
    this.lifecycle.start();
  }

  async stop(): Promise<void> {
    const lifecycleStop = this.lifecycle.stop();
    await this.inputs.close();
    this.imageStore.close();
    this.audioStore.close();
    this.pluginTaskPrompts.clear();
    await this.interactions.close();
    await this.outbox.close();
    await lifecycleStop;
  }

  replaceNotificationRecipients(recipients: ReadonlySet<number>): void {
    this.notificationRecipients = new Set(recipients);
  }

  configurationChanged(change: SurfaceConfigurationChange): void {
    const replyMarkup = workspaceSwitchKeyboard(change.addedWorkspaces);
    const text = formatConfigurationChange(change);
    for (const chatId of this.notificationRecipients) {
      this.outbox.notifyPanel(
        String(chatId),
        text,
        replyMarkup.inline_keyboard.length > 0 ? replyMarkup : undefined,
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
        )),
    );
  }

  private registerHandlers(): void {
    this.bot.command("whoami", (context) => context.reply(`你的 Telegram 用户 ID：${context.from?.id ?? "未知"}`));
    this.bot.command(["start", "help", "h"], (context) =>
      replyTelegramPanel(
        context,
        [
          "Codex Connect Gateway",
          "",
          "普通文本会发送到当前 Codex Thread。",
          "发送 PNG/JPEG/WebP/非动画 GIF 图片时，可在图片说明中写明需要 Codex 处理的任务。",
          "发送 UTF-8 文本文件时，可在文件说明中写明需要 Codex 处理的任务。",
          "首次消息自动接续当前 Workspace 最近的空闲 CLI/App Server 会话。",
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
      this.bot.command(command, (context) => this.executeCommand(context, command));
    }
    this.bot.command("work", (context) =>
      this.executeCommand(context, surfaceCommandAliases.work));
    this.bot.command("r", (context) =>
      this.executeCommand(context, surfaceCommandAliases.r));
    this.bot.command("stop", async (context) => {
      if (this.interactions.stopForChat(String(context.chat.id))) {
        await context.reply(interactionStoppedText);
        return;
      }
      await this.executeCommand(context, "stop");
    });
    this.bot.callbackQuery(/^ws:([A-Za-z0-9_-]{43})$/, async (context) => {
      const workspace = this.service.listWorkspaces().find(
        (candidate) => workspaceSwitchToken(candidate.id) === context.match[1],
      );
      if (!workspace) {
        throw new UserFacingError(
          "workspace.selector.not-found",
          "Workspace 切换按钮已失效",
        );
      }
      const result = await this.commands.execute(
        target(context),
        "workspace",
        workspace.id,
      );
      await context.answerCallbackQuery({ text: `已切换到 ${workspace.id}` });
      await renderTelegramCommandResult(
        context,
        result,
        this.priceCurrency,
        this.exchangeRate?.() ?? null,
      );
    });
    this.bot.callbackQuery(
      /^wp:(sandbox|approval)$/,
      async (context) => {
        const field = context.match[1] === "sandbox"
          ? "sandbox"
          : "approval";
        await context.editMessageText(
          workspacePermissionPrompt(field),
          {
            parse_mode: "HTML",
            reply_markup: workspacePermissionFieldKeyboard(field),
          },
        );
        await context.answerCallbackQuery();
      },
    );
    this.bot.callbackQuery(
      /^wp:(sandbox|approval):([a-z-]+)$/,
      async (context) => {
        const field = context.match[1] === "sandbox"
          ? "sandbox"
          : "approval";
        const value = context.match[2]!;
        const result = await this.commands.execute(
          target(context),
          "workspaceperm",
          `${field} ${value}`,
        );
        await context.answerCallbackQuery({ text: "已更新工作区权限" });
        await context.editMessageText("已更新工作区权限。");
        await renderTelegramCommandResult(
          context,
          result,
          this.priceCurrency,
          this.exchangeRate?.() ?? null,
        );
      },
    );
    this.bot.callbackQuery(/^wp:profile$/, async (context) => {
      await context.answerCallbackQuery({
        text: "请输入权限 Profile 命令",
      });
      await context.editMessageText(
        "请输入权限 Profile，例如发送：\n/workspaceperm profile :read-only",
      );
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
          this.priceCurrency,
          this.exchangeRate?.() ?? null,
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
      );
      await renderTelegramCommandResult(
        context,
        result,
        this.priceCurrency,
        this.exchangeRate?.() ?? null,
      );
    });
    this.bot.callbackQuery(
      /^plugin:select:([A-Za-z0-9_-]{43})$/,
      async (context) => {
        await context.answerCallbackQuery({ text: "正在选择 Plugin" });
        const pluginTarget = target(context);
        const matches = (await this.service.listPlugins(pluginTarget)).plugins.filter(
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
    this.bot.callbackQuery(/^section:page:([1-9]\d*)$/, async (context) => {
      await context.answerCallbackQuery({ text: "正在加载 Thread 分区" });
      const result = await this.commands.execute(
        target(context),
        "section",
        `list ${context.match[1]}`,
        String(context.from.id),
      );
      await renderTelegramCommandResult(
        context,
        result,
        this.priceCurrency,
        this.exchangeRate?.() ?? null,
      );
    });
    this.bot.callbackQuery("section:pin", async (context) => {
      await context.answerCallbackQuery({ text: "正在固定当前会话" });
      const result = await this.commands.execute(
        target(context),
        "pin",
        "",
        String(context.from.id),
      );
      await renderTelegramCommandResult(
        context,
        result,
        this.priceCurrency,
        this.exchangeRate?.() ?? null,
      );
    });
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
        this.priceCurrency,
        this.exchangeRate?.() ?? null,
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
          this.priceCurrency,
          this.exchangeRate?.() ?? null,
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
          this.priceCurrency,
          this.exchangeRate?.() ?? null,
        );
      },
    );
    this.bot.callbackQuery(
      /^section:move:([A-Za-z0-9_-]{43})$/,
      async (context) => {
        const sectionTarget = target(context);
        const matches = (await this.service.listThreadSections(sectionTarget)).filter(
          (section) => telegramThreadSectionToken(section.id) === context.match[1],
        );
        if (matches.length !== 1) {
          throw new UserFacingError(
            "thread-section.selector.not-found",
            "Thread 分区按钮已失效",
          );
        }
        await context.answerCallbackQuery({ text: `正在移动到 ${matches[0]!.name}` });
        const result = await this.commands.execute(
          sectionTarget,
          "section",
          `move ${matches[0]!.id}`,
          String(context.from.id),
        );
        await renderTelegramCommandResult(
          context,
          result,
          this.priceCurrency,
          this.exchangeRate?.() ?? null,
        );
      },
    );
    this.bot.on("message:text", async (context) => {
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
        );
        await renderTelegramCommandResult(
          context,
          result,
          this.priceCurrency,
          this.exchangeRate?.() ?? null,
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
        await context.reply(formatTurnInputAppended("text"), {
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
    this.bot.on("message:document", async (context) => {
      const document = context.message.document;
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
      file.text,
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
    await this.inputs.flushPending(inputTarget, actorId);
    const audio = await this.audioStore.download(this.bot.api, fileId);
    const quotedText = telegramQuotedText(context.message?.reply_to_message);
    const currentText = caption?.trim();
    this.outbox.prepareTurnReplyTarget(
      inputTarget.conversationId,
      context.message!.message_id,
    );
    let submission;
    try {
      submission = await this.service.submit(inputTarget, {
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
    const result = await this.commands.execute(
      target(context),
      command,
      commandArguments(context),
      context.from ? String(context.from.id) : undefined,
    );
    await renderTelegramCommandResult(
      context,
      result,
      this.priceCurrency,
      this.exchangeRate?.() ?? null,
    );
  }

  private async authorize(context: Context, next: () => Promise<void>): Promise<void> {
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
    if (!accessContext || !this.access.isAllowed(accessContext)) {
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
      this.actorRegistry?.rememberActor(accessContext.target, accessContext.actorId);
      await next();
    } catch (error) {
      this.logger.error(
        {
          ...telegramErrorMetadata(error),
          chatId: context.chat?.id,
        },
        "Telegram 命令执行失败",
      );
      if (context.chat) {
        await context.reply(
          error instanceof UserFacingError
            ? formatOperationFailure(formatTelegramUserFacingError(error))
            : formatOperationFailure(gatewayRequestFailedText),
        );
      }
    } finally {
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
  return "other";
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
      callback_data: `ws:${workspaceSwitchToken(workspace.id)}`,
    }]),
  };
}

function workspaceSwitchToken(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("base64url");
}
