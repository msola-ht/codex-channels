import { Bot, type Context } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Logger } from "pino";

import type { ConversationService } from "../../application/index.js";
import type { ConversationTarget, OutputEvent } from "../../conversation-core/index.js";
import { protocolVersion, type ReviewTarget } from "../../codex-protocol/index.js";
import type { EventBus } from "../../event-bus/index.js";
import type { TelegramAccessPolicy, Workspace } from "../../policy/index.js";
import {
  formatMcpServers,
  formatDiff,
  formatLimits,
  formatModels,
  formatPermissions,
  formatPlugins,
  formatPlan,
  formatReasoningEfforts,
  formatSessions,
  formatSkills,
  formatStatus,
  formatStartupNotification,
  formatUsage,
  formatWorkspaces,
} from "./format.js";
import { formatTelegramDiffChunks, formatTelegramPanelChunks } from "./html-format.js";
import { TelegramInteractionPort } from "./interactions.js";
import { TelegramApiExecutor } from "./api-executor.js";
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
  onFatal?: (error: Error) => void;
  imageStore?: TelegramImagePort;
  finalMessageFormat?: TelegramFinalMessageFormat;
  codexUpstreamUserAgent?: () => string | undefined;
}

export class TelegramSurface {
  readonly bot: Bot;
  readonly interactions: TelegramInteractionPort;
  private readonly outbox: TelegramOutbox;
  private readonly lifecycle: TelegramLifecycle;
  private readonly imageStore: TelegramImagePort;
  private unsubscribeOutput: (() => void) | undefined;

  constructor(
    token: string,
    proxyUrl: string | undefined,
    private readonly service: ConversationService,
    output: EventBus<OutputEvent>,
    private readonly access: TelegramAccessPolicy,
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
      this.replyPanelChunks(
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
          "/skills · /mcp · /plugins · /usage · /limits · /permissions",
          "/diff · /plan",
          "/goal [set <目标>|clear]",
          "/cancel",
        ].join("\n"),
      ),
    );
    this.bot.command("resume", (context) => this.resume(context));
    this.bot.command("sessions", async (context) => {
      const searchTerm = commandArguments(context);
      const sessions = await this.service.listSessions(target(context), {
        ...(searchTerm ? { searchTerm } : {}),
      });
      await this.replyChunks(
        context,
        formatSessions(sessions, this.service.status(target(context)).threadId, {
          ...(searchTerm ? { searchTerm } : {}),
        }),
      );
    });
    this.bot.command("archived", async (context) => {
      const searchTerm = commandArguments(context);
      const sessions = await this.service.listSessions(target(context), {
        archived: true,
        ...(searchTerm ? { searchTerm } : {}),
      });
      await this.replyChunks(context, formatSessions(sessions, undefined, {
        archived: true,
        ...(searchTerm ? { searchTerm } : {}),
      }));
    });
    this.bot.command("new", async (context) => {
      await this.service.newSession(target(context));
      await context.reply("已退出当前会话，下一条普通消息将创建新的 Codex Thread。");
    });
    this.bot.command("archive", async (context) => {
      const threadId = await this.service.archive(target(context));
      await this.replyPanelChunks(
        context,
        `已归档 Codex Thread\nThread：${threadId}\n下一条普通消息将创建新会话。`,
      );
    });
    this.bot.command("unarchive", async (context) => {
      const threadId = await this.service.unarchive(target(context), commandArguments(context));
      await this.replyPanelChunks(context, `已取消归档并切换会话\nThread：${threadId}`);
    });
    this.bot.command("status", async (context) => {
      await this.replyPanelChunks(context, formatStatus(this.service.status(target(context))));
    });
    this.bot.command("workspace", async (context) => {
      const selector = commandArguments(context);
      if (selector) {
        const workspace = await this.service.selectWorkspace(target(context), selector);
        await this.replyPanelChunks(
          context,
          `已切换 Workspace\nWorkspace：${workspace.name}\n工作目录：${workspace.cwd}`,
        );
        return;
      }
      const current = this.service.status(target(context));
      await this.replyChunks(
        context,
        formatWorkspaces(this.service.listWorkspaces(), current.workspaceId),
      );
    });
    this.bot.command("stop", async (context) => {
      const stopped = await this.service.stop(target(context));
      await context.reply(stopped ? "已请求停止当前任务。" : "当前没有运行中的任务。");
    });
    this.bot.command("rename", async (context) => {
      const name = commandArguments(context);
      await this.service.rename(target(context), name);
      await this.replyPanelChunks(context, `会话已重命名\n名称：${name}`);
    });
    this.bot.command("compact", async (context) => {
      await this.service.compact(target(context));
      await context.reply("已请求压缩当前 Codex Thread。进度将通过标准事件返回。");
    });
    this.bot.command("fork", async (context) => {
      const threadId = await this.service.fork(target(context));
      await this.replyPanelChunks(context, `已分叉并切换到新会话\nThread：${threadId}`);
    });
    this.bot.command("review", async (context) => {
      const reviewTarget = parseReviewTarget(commandArguments(context));
      const submission = await this.service.review(target(context), reviewTarget);
      await this.replyPanelChunks(context, `已启动 Codex Review\nTurn：${submission.turnId}`);
    });
    this.bot.command("model", async (context) => {
      const selector = commandArguments(context);
      const state = selector
        ? await this.service.selectModel(target(context), selector)
        : await this.service.modelState(target(context));
      await this.replyChunks(context, formatModels(state));
    });
    this.bot.command("effort", async (context) => {
      const selector = commandArguments(context);
      const state = selector
        ? await this.service.selectEffort(target(context), selector)
        : await this.service.modelState(target(context));
      await this.replyChunks(context, formatReasoningEfforts(state));
    });
    this.bot.command("skills", async (context) => {
      await this.replyChunks(context, formatSkills(await this.service.listSkills(target(context))));
    });
    this.bot.command("mcp", async (context) => {
      await this.replyChunks(context, formatMcpServers(await this.service.listMcpServers(target(context))));
    });
    this.bot.command("plugins", async (context) => {
      await this.replyChunks(context, formatPlugins(await this.service.listPlugins(target(context))));
    });
    this.bot.command("usage", async (context) => {
      await this.replyChunks(context, formatUsage(await this.service.accountUsage()));
    });
    this.bot.command("limits", async (context) => {
      await this.replyChunks(context, formatLimits(await this.service.accountRateLimits()));
    });
    this.bot.command("permissions", async (context) => {
      await this.replyChunks(context, formatPermissions(await this.service.listPermissionProfiles(target(context))));
    });
    this.bot.command("diff", async (context) => {
      for (const chunk of formatTelegramDiffChunks(formatDiff(this.service.artifacts(target(context))))) {
        await context.reply(chunk, { parse_mode: "HTML" });
      }
    });
    this.bot.command("plan", async (context) => {
      await this.replyChunks(context, formatPlan(this.service.artifacts(target(context))));
    });
    this.bot.command("goal", (context) => this.goal(context));
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
        reply_parameters: {
          message_id: context.message.message_id,
          allow_sending_without_reply: true,
        },
      });
    }
  }

  private async resume(context: Context): Promise<void> {
    const selector = commandArguments(context);
    if (selector) {
      const threadId = await this.service.resume(target(context), selector);
      await this.replyPanelChunks(context, `已恢复 Codex Thread\nThread：${threadId}`);
      return;
    }
    const sessions = await this.service.listSessions(target(context));
    const text = formatSessions(sessions, this.service.status(target(context)).threadId);
    await this.replyPanelChunks(context, text);
  }

  private async goal(context: Context): Promise<void> {
    const input = commandArguments(context);
    if (input === "clear") {
      await this.service.clearGoal(target(context));
      await context.reply("已清除当前 Thread Goal。");
      return;
    }
    if (input.startsWith("set ")) {
      const goal = await this.service.setGoal(target(context), input.slice(4));
      await this.replyPanelChunks(context, `Goal 已设置\n目标：${goal.objective}`);
      return;
    }
    const goal = await this.service.getGoal(target(context));
    await this.replyPanelChunks(
      context,
      goal
        ? `当前 Goal：${goal.objective}\n状态：${goal.status}\nTokens：${goal.tokensUsed}${goal.tokenBudget === null ? "" : ` / ${goal.tokenBudget}`}`
        : "当前 Thread 没有 Goal。使用 /goal set <目标> 设置。",
    );
  }

  private async replyChunks(context: Context, text: string): Promise<void> {
    await this.replyPanelChunks(context, text);
  }

  private async replyPanelChunks(context: Context, text: string): Promise<void> {
    for (const chunk of formatTelegramPanelChunks(text)) {
      await context.reply(chunk, { parse_mode: "HTML" });
    }
  }

  private async authorize(context: Context, next: () => Promise<void>): Promise<void> {
    if (context.message?.text?.startsWith("/whoami")) {
      await next();
      return;
    }
    if (!this.access.isAllowed(context.from?.id)) {
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
  return { surface: "telegram", conversationId: String(context.chat.id) };
}

function commandArguments(context: Context): string {
  const text = context.message?.text ?? "";
  return text.replace(/^\/\w+(?:@\w+)?\s*/, "").trim();
}

function parseReviewTarget(input: string): ReviewTarget {
  if (!input) {
    return { type: "uncommittedChanges" };
  }
  const [kind, ...rest] = input.split(/\s+/);
  const value = rest.join(" ").trim();
  if (kind === "branch" && value) {
    return { type: "baseBranch", branch: value };
  }
  if (kind === "commit" && value) {
    return { type: "commit", sha: value, title: null };
  }
  if (kind === "custom" && value) {
    return { type: "custom", instructions: value };
  }
  throw new Error("用法：/review [branch <分支>|commit <SHA>|custom <说明>]");
}
