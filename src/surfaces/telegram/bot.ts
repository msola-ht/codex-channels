import { Bot, type Context } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Logger } from "pino";

import {
  ConversationCommandService,
  conversationCommandNames,
  type ConversationCommandName,
  type ConversationService,
} from "../../application/index.js";
import type { ConversationTarget, OutputEvent } from "../../conversation-core/index.js";
import { protocolVersion } from "../../codex-protocol/index.js";
import type { EventBus } from "../../event-bus/index.js";
import type {
  ConversationActorRegistry,
  SurfaceAccessPolicy,
  Workspace,
} from "../../policy/index.js";
import { formatStartupNotification } from "./format.js";
import {
  renderTelegramCommandResult,
  replyTelegramPanel,
} from "./command-renderer.js";
import { TelegramInteractionPort } from "./interactions.js";
import { TelegramApiExecutor } from "./api-executor.js";
import { telegramDefaultAccountId } from "./constants.js";
import { TelegramLifecycle } from "./lifecycle.js";
import { TelegramOutbox, type TelegramFinalMessageFormat } from "./outbox.js";
import { maximumTelegramImageBytes, TelegramImageStore } from "./image-store.js";

export interface TelegramImagePort {
  start(): Promise<void>;
  close(): void;
  download(
    api: Parameters<TelegramImageStore["download"]>[0],
    fileId: string,
  ): ReturnType<TelegramImageStore["download"]>;
}

export interface TelegramSurfaceOptions {
  actorRegistry?: ConversationActorRegistry;
  onFatal?: (error: Error) => void;
  imageStore?: TelegramImagePort;
  finalMessageFormat?: TelegramFinalMessageFormat;
  codexUpstreamUserAgent?: () => string | undefined;
}

export class TelegramSurface {
  readonly surface = "telegram" as const;
  readonly accountId = telegramDefaultAccountId;
  readonly bot: Bot;
  readonly interactions: TelegramInteractionPort;
  private readonly outbox: TelegramOutbox;
  private readonly lifecycle: TelegramLifecycle;
  private readonly imageStore: TelegramImagePort;
  private readonly actorRegistry: ConversationActorRegistry | undefined;
  private readonly commands: ConversationCommandService;
  private unsubscribeOutput: (() => void) | undefined;

  constructor(
    token: string,
    proxyUrl: string | undefined,
    private readonly service: ConversationService,
    output: EventBus<OutputEvent>,
    private readonly access: SurfaceAccessPolicy,
    startupRecipients: ReadonlySet<number>,
    workspaces: Workspace[],
    uploadsDirectory: string,
    private readonly logger: Logger,
    options: TelegramSurfaceOptions = {},
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
    this.commands = new ConversationCommandService(service);
    const apiExecutor = new TelegramApiExecutor(logger);
    this.outbox = new TelegramOutbox(this.bot.api, logger, apiExecutor, {
      ...(options.finalMessageFormat
        ? { finalMessageFormat: options.finalMessageFormat }
        : {}),
    });
    this.interactions = new TelegramInteractionPort(this.bot, logger, apiExecutor, this.outbox);
    this.imageStore = options.imageStore ?? new TelegramImageStore(uploadsDirectory, token, proxyUrl, logger);
    this.lifecycle = new TelegramLifecycle(
      this.bot,
      logger,
      {
        messages: () => [...startupRecipients].map((chatId) => {
          const status = this.service.status({
            surface: "telegram",
            accountId: telegramDefaultAccountId,
            conversationId: String(chatId),
          });
          return {
            chatId,
            text: formatStartupNotification(workspaces, status, {
              platform: process.platform,
              architecture: process.arch,
              gatewayVersion: protocolVersion.codexCli.replace(/^codex-cli\s+/, ""),
              nodeVersion: process.version,
              transport: "Unix WebSocket",
              codexUpstreamUserAgent: options.codexUpstreamUserAgent?.() ?? null,
            }),
          };
        }),
      },
      options.onFatal,
    );
    this.unsubscribeOutput = output.subscribe("telegram", (event) => this.outbox.handle(event));
    this.registerHandlers();
  }

  async start(): Promise<void> {
    await this.imageStore.start();
    this.lifecycle.start();
  }

  async stop(): Promise<void> {
    this.imageStore.close();
    const lifecycleStop = this.lifecycle.stop();
    await this.interactions.close();
    this.unsubscribeOutput?.();
    this.unsubscribeOutput = undefined;
    await this.outbox.close();
    await lifecycleStop;
  }

  private registerHandlers(): void {
    this.bot.command("whoami", (context) => context.reply(`你的 Telegram 用户 ID：${context.from?.id ?? "未知"}`));
    this.bot.command(["start", "help"], (context) =>
      replyTelegramPanel(
        context,
        [
          "Codex Connect Gateway",
          "",
          "普通文本会发送到当前 Codex Thread。",
          "发送 PNG/JPEG 图片时，可在图片说明中写明需要 Codex 处理的任务。",
          "首次消息自动接续当前 Workspace 最近的空闲 CLI/App Server 会话。",
          "",
          "/resume [序号|名称|Thread ID]",
          "/sessions [搜索词] · /archived [搜索词]",
          "/new",
          "/archive · /unarchive <序号|名称|Thread ID>",
          "/status",
          "/workspace [序号|ID|名称]",
          "/stop",
          "/rename <名称>",
          "/compact",
          "/fork",
          "/review [branch <分支>|commit <SHA>|custom <说明>]",
          "/model [序号|模型 ID|名称]",
          "/effort [序号|档位]",
          "/fast [on|off|status]",
          "/skills · /mcp · /plugins · /usage · /limits · /permissions",
          "/diff · /plan",
          "/goal [set <目标>|clear]",
          "/cancel",
        ].join("\n"),
      ),
    );
    for (const command of conversationCommandNames) {
      this.bot.command(command, (context) => this.executeCommand(context, command));
    }
    this.bot.command("cancel", async (context) => {
      const cancelled = this.interactions.cancelForChat(String(context.chat.id));
      await context.reply(cancelled ? "已取消当前交互请求。" : "当前没有待处理的交互请求。");
    });
    this.bot.on("message:text", async (context) => {
      if (await this.interactions.handleText(context)) {
        return;
      }
      const submission = await this.service.submit(target(context), context.message.text);
      this.outbox.setTurnReplyTarget(
        submission.threadId,
        submission.turnId,
        context.message.message_id,
      );
      if (submission.steered) {
        await context.reply("已将补充要求追加到当前 Turn。", {
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
    this.bot.on("message:document", async (context) => {
      const document = context.message.document;
      if (!isSupportedImageDocument(document.mime_type, document.file_name)) {
        await context.reply("仅支持 PNG 和 JPEG 图片文件。");
        return;
      }
      await this.submitImage(
        context,
        document.file_id,
        document.file_size,
        context.message.caption,
      );
    });
  }

  private async submitImage(
    context: Context,
    fileId: string,
    fileSize: number | undefined,
    caption: string | undefined,
  ): Promise<void> {
    if (fileSize !== undefined && fileSize > maximumTelegramImageBytes) {
      throw new Error("图片超过 10 MiB 限制");
    }
    const image = await this.imageStore.download(this.bot.api, fileId);
    if (!context.message) {
      throw new Error("Telegram 图片更新缺少消息信息");
    }
    const submission = await this.service.submit(target(context), {
      text: caption?.trim() || "请查看这张图片并根据图片内容协助我。",
      localImages: [{ path: image.path }],
    });
    this.outbox.setTurnReplyTarget(
      submission.threadId,
      submission.turnId,
      context.message.message_id,
    );
    if (submission.steered && context.message) {
      await context.reply("已将图片和补充要求追加到当前 Turn。", {
        disable_notification: true,
        reply_parameters: {
          message_id: context.message.message_id,
          allow_sending_without_reply: true,
        },
      });
    }
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
      this.logger.error({ err: error, chatId: context.chat?.id }, "Telegram 命令执行失败");
      if (context.chat) {
        await context.reply(`操作失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      stopTyping?.();
    }
  }
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
