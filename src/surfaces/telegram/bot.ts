import { createHash } from "node:crypto";

import { Bot, type Context } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Logger } from "pino";

import {
  ConversationCommandService,
  conversationCommandNames,
  type ConversationCommandName,
  type ConversationUseCases,
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
import { conversationCommandHelpLines } from "../conversation-command-format.js";
import { formatTurnInputAppended } from "../input-copy.js";
import {
  formatOperationFailure,
  gatewayRequestFailedText,
  interactionStoppedText,
} from "../output-copy.js";
import { formatTextFileTooLarge } from "../text-file-copy.js";
import { SurfaceInputCoalescer } from "../surface-input-coalescer.js";
import { formatQuotedInput } from "../quoted-input.js";
import {
  executeVisionCommand,
  formatVisionImagesCollected,
} from "../vision-command.js";
import { surfaceCommandAliases } from "../slash-command.js";
import {
  formatConfigurationChange,
  formatStartupNotification,
} from "./format.js";
import {
  renderTelegramCommandResult,
  replyTelegramPanel,
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
  onFatal?: (error: Error) => void;
  imageStore?: TelegramImagePort;
  audioStore?: TelegramAudioPort;
  textFileInput?: TelegramTextFilePort;
  finalMessageFormat?: TelegramFinalMessageFormat;
  operationUpdateDisplay?: OperationUpdateDisplay;
  planUpdatesEnabled?: boolean;
  codexUpstreamUserAgent?: () => string | undefined;
  inputQuietWindowMs?: number;
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
    this.bot.use((context, next) => this.authorize(context, next));
    this.actorRegistry = options.actorRegistry;
    this.notificationRecipients = new Set(startupRecipients);
    this.commands = new ConversationCommandService(service);
    this.inputs = new SurfaceInputCoalescer(
      (inputTarget, input) => service.submit(inputTarget, input),
      {
        quietWindowMs: options.inputQuietWindowMs ?? 1_000,
      },
    );
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
    });
    this.output = this.outbox;
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
            }),
          };
        }),
      },
      options.onFatal,
    );
    this.registerHandlers();
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
          "发送 PNG/JPEG 图片时，可在图片说明中写明需要 Codex 处理的任务。",
          "发送 UTF-8 文本文件时，可在文件说明中写明需要 Codex 处理的任务。",
          "首次消息自动接续当前 Workspace 最近的空闲 CLI/App Server 会话。",
          "",
          ...conversationCommandHelpLines,
          "Telegram：",
          "- /vision <要求> · /vision <2–4> <要求> · /vision cancel",
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
    this.bot.command("vision", async (context) => {
      await this.inputs.flushPending(
        target(context),
        String(context.from?.id ?? ""),
      );
      await context.reply(await executeVisionCommand(
        this.inputs,
        target(context),
        String(context.from?.id ?? ""),
        commandArguments(context),
      ));
    });
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
      await renderTelegramCommandResult(context, result);
    });
    this.bot.on("message:text", async (context) => {
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
      if (result.kind === "collected") {
        this.outbox.discardPendingTurnReplyTarget(inputTarget.conversationId);
        throw new Error("纯文本不能进入图片收集");
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
    if (result.kind === "collected") {
      this.outbox.discardPendingTurnReplyTarget(inputTarget.conversationId);
      throw new Error("文本文件不能进入图片收集");
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
        localImages: [{ path: image.path, bytes: image.bytes }],
      });
    } catch (error) {
      this.outbox.discardPendingTurnReplyTarget(inputTarget.conversationId);
      throw error;
    }
    if (result.kind === "collected") {
      this.outbox.discardPendingTurnReplyTarget(inputTarget.conversationId);
      await context.reply(formatVisionImagesCollected(
        result.imageCount,
        result.maximumImages,
        result.automatic,
      ), {
        disable_notification: true,
        reply_parameters: {
          message_id: context.message.message_id,
          allow_sending_without_reply: true,
        },
      });
      return;
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
    );
    await renderTelegramCommandResult(context, result);
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

function isSupportedImageDocument(mimeType: string | undefined, fileName: string | undefined): boolean {
  return mimeType === "image/png" ||
    mimeType === "image/jpeg" ||
    /\.(?:png|jpe?g)$/i.test(fileName ?? "");
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
