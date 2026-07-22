import { Bot, type Context } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Logger } from "pino";

import type { ConversationService } from "../../conversation-core/service.js";
import type { ConversationTarget, OutputEvent } from "../../conversation-core/events.js";
import type { ReviewTarget } from "../../codex-protocol/index.js";
import type { EventBus } from "../../event-bus/event-bus.js";
import type { TelegramAccessPolicy } from "../../policy/telegram-access.js";
import {
  formatMcpServers,
  formatLimits,
  formatModels,
  formatPermissions,
  formatPlugins,
  formatSessions,
  formatSkills,
  formatStatus,
  formatUsage,
  formatWorkspaces,
  splitTelegramText,
} from "./format.js";
import { TelegramInteractionPort } from "./interactions.js";
import { TelegramApiExecutor } from "./api-executor.js";
import { TelegramOutbox } from "./outbox.js";

export class TelegramSurface {
  readonly bot: Bot;
  readonly interactions: TelegramInteractionPort;
  private readonly outbox: TelegramOutbox;
  private unsubscribeOutput: (() => void) | undefined;
  private polling: Promise<void> | undefined;
  private lifecycleAbort: AbortController | undefined;
  private stopping = false;

  constructor(
    token: string,
    proxyUrl: string | undefined,
    private readonly service: ConversationService,
    output: EventBus<OutputEvent>,
    private readonly access: TelegramAccessPolicy,
    private readonly logger: Logger,
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
    this.interactions = new TelegramInteractionPort(this.bot, logger, apiExecutor);
    this.outbox = new TelegramOutbox(this.bot.api, logger, apiExecutor);
    this.unsubscribeOutput = output.subscribe("telegram", (event) => this.outbox.handle(event));
    this.registerHandlers();
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.lifecycleAbort = new AbortController();
    this.polling = this.runTelegram(this.lifecycleAbort.signal);
    this.logger.info("Telegram Gateway 正在连接");
    void this.polling.catch((error) =>
      this.logger.error(
        { message: error instanceof Error ? error.message : String(error) },
        "Telegram Long Polling 已停止",
      ),
    );
  }

  private async runTelegram(signal: AbortSignal): Promise<void> {
    await this.initializeBot(signal);
    if (this.stopping || signal.aborted) {
      return;
    }
    this.logger.info({ username: this.bot.botInfo.username }, "Telegram Gateway 已启动");
    void this.registerCommandMenu(signal);
    await this.pollUpdates(signal);
  }

  private async registerCommandMenu(signal: AbortSignal): Promise<void> {
    try {
      await this.bot.api.setMyCommands([
        { command: "start", description: "使用说明" },
        { command: "resume", description: "列出或恢复 Codex 会话" },
        { command: "new", description: "下一条消息创建新会话" },
        { command: "status", description: "查看当前状态" },
        { command: "workspace", description: "列出或切换 Workspace" },
        { command: "stop", description: "停止当前任务" },
        { command: "rename", description: "命名当前会话" },
        { command: "compact", description: "压缩当前上下文" },
        { command: "fork", description: "分叉当前会话" },
        { command: "review", description: "启动代码审查" },
        { command: "model", description: "列出可用模型" },
        { command: "skills", description: "列出 Skills" },
        { command: "mcp", description: "列出 MCP Servers" },
        { command: "plugins", description: "列出 Plugins" },
        { command: "usage", description: "查看账号用量" },
        { command: "limits", description: "查看套餐与额度" },
        { command: "permissions", description: "查看权限配置" },
        { command: "goal", description: "查看或管理 Goal" },
        { command: "cancel", description: "取消当前交互请求" },
        { command: "whoami", description: "显示 Telegram 用户 ID" },
      ], signal as never);
    } catch (error) {
      this.logger.warn(
        { message: error instanceof Error ? error.message : String(error) },
        "Telegram 命令菜单注册失败，不影响 Long Polling",
      );
    }
  }

  private async initializeBot(lifecycleSignal: AbortSignal): Promise<void> {
    const maximumAttempts = 5;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      const attemptController = new AbortController();
      const cancelAttempt = (): void => attemptController.abort();
      lifecycleSignal.addEventListener("abort", cancelAttempt, { once: true });
      const timeout = setTimeout(cancelAttempt, 15_000);
      timeout.unref();
      try {
        await this.bot.init(attemptController.signal as never);
        return;
      } catch (error) {
        if (this.stopping || lifecycleSignal.aborted) {
          return;
        }
        if (attempt === maximumAttempts) {
          throw error;
        }
        this.logger.warn(
          {
            message: error instanceof Error ? error.message : String(error),
            attempt,
            maximumAttempts,
          },
          "Telegram 鉴权失败，稍后重试",
        );
        const ceiling = Math.min(8_000, 500 * 2 ** (attempt - 1));
        await waitWithAbort(
          Math.floor(ceiling / 2 + Math.random() * ceiling / 2),
          lifecycleSignal,
        );
      } finally {
        clearTimeout(timeout);
        lifecycleSignal.removeEventListener("abort", cancelAttempt);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.lifecycleAbort?.abort();
    this.lifecycleAbort = undefined;
    await this.interactions.close();
    this.unsubscribeOutput?.();
    this.unsubscribeOutput = undefined;
    await this.outbox.close();
    await this.polling?.catch(() => undefined);
    this.polling = undefined;
  }

  private async pollUpdates(signal: AbortSignal): Promise<void> {
    let offset = 0;
    let consecutiveFailures = 0;
    const maximumFailures = 12;
    while (!this.stopping && !signal.aborted) {
      try {
        const updates = await this.bot.api.getUpdates(
          { offset, timeout: 20, allowed_updates: [] },
          signal as never,
        );
        consecutiveFailures = 0;
        for (const update of updates) {
          offset = update.update_id + 1;
          try {
            await this.bot.handleUpdate(update);
          } catch (error) {
            this.logger.error(
              {
                message: error instanceof Error ? error.message : String(error),
                updateId: update.update_id,
              },
              "Telegram 更新处理失败",
            );
          }
        }
      } catch (error) {
        if (this.stopping || signal.aborted) {
          return;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= maximumFailures) {
          throw new Error(
            `Telegram Long Polling 连续失败 ${maximumFailures} 次：${error instanceof Error ? error.message : String(error)}`,
          );
        }
        this.logger.warn(
          {
            message: error instanceof Error ? error.message : String(error),
            attempt: consecutiveFailures,
            maximumFailures,
          },
          "Telegram Long Polling 请求失败，稍后重试",
        );
        await waitWithAbort(
          Math.min(10_000, 500 * 2 ** (consecutiveFailures - 1)) + Math.floor(Math.random() * 250),
          signal,
        );
      }
    }
  }

  private registerHandlers(): void {
    this.bot.command("whoami", (context) => context.reply(`你的 Telegram 用户 ID：${context.from?.id ?? "未知"}`));
    this.bot.command(["start", "help"], (context) =>
      context.reply(
        [
          "Codex Telegram Gateway",
          "",
          "普通文本会发送到当前 Codex Thread。",
          "首次消息自动接续当前 Workspace 最近的空闲 CLI/App Server 会话。",
          "",
          "/resume [序号|名称|Thread ID]",
          "/new",
          "/status",
          "/workspace [序号|ID|名称]",
          "/stop",
          "/rename <名称>",
          "/compact",
          "/fork",
          "/review [branch <分支>|commit <SHA>|custom <说明>]",
          "/model",
          "/skills · /mcp · /plugins · /usage · /limits · /permissions",
          "/goal [set <目标>|clear]",
          "/cancel",
        ].join("\n"),
      ),
    );
    this.bot.command("resume", (context) => this.resume(context));
    this.bot.command("new", async (context) => {
      await this.service.newSession(target(context));
      await context.reply("已退出当前会话，下一条普通消息将创建新的 Codex Thread。");
    });
    this.bot.command("status", async (context) => {
      await context.reply(formatStatus(this.service.status(target(context))));
    });
    this.bot.command("workspace", async (context) => {
      const selector = commandArguments(context);
      if (selector) {
        const workspace = await this.service.selectWorkspace(target(context), selector);
        await context.reply(`已切换 Workspace：${workspace.name}\n工作目录：${workspace.cwd}`);
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
      await context.reply(`当前会话已命名为：${name}`);
    });
    this.bot.command("compact", async (context) => {
      await this.service.compact(target(context));
      await context.reply("已请求压缩当前 Codex Thread。进度将通过标准事件返回。");
    });
    this.bot.command("fork", async (context) => {
      const threadId = await this.service.fork(target(context));
      await context.reply(`已分叉并切换到新 Codex Thread：${threadId}`);
    });
    this.bot.command("review", async (context) => {
      const reviewTarget = parseReviewTarget(commandArguments(context));
      const submission = await this.service.review(target(context), reviewTarget);
      await context.reply(`已启动 Codex Review：${submission.turnId}`);
    });
    this.bot.command("model", async (context) => {
      await this.replyChunks(context, formatModels(await this.service.listModels()));
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
  }

  private async resume(context: Context): Promise<void> {
    const selector = commandArguments(context);
    if (selector) {
      const threadId = await this.service.resume(target(context), selector);
      await context.reply(`已恢复 Codex Thread：${threadId}`);
      return;
    }
    const sessions = await this.service.listSessions(target(context));
    const text = formatSessions(sessions, this.service.status(target(context)).threadId);
    for (const chunk of splitTelegramText(text)) {
      await context.reply(chunk);
    }
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
      await context.reply(`Goal 已设置：${goal.objective}`);
      return;
    }
    const goal = await this.service.getGoal(target(context));
    await context.reply(
      goal
        ? `当前 Goal：${goal.objective}\n状态：${goal.status}\nTokens：${goal.tokensUsed}${goal.tokenBudget === null ? "" : ` / ${goal.tokenBudget}`}`
        : "当前 Thread 没有 Goal。使用 /goal set <目标> 设置。",
    );
  }

  private async replyChunks(context: Context, text: string): Promise<void> {
    for (const chunk of splitTelegramText(text)) {
      await context.reply(chunk);
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
    const stopTyping = context.message?.text && context.chat
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

function waitWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolveWait();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
  });
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
