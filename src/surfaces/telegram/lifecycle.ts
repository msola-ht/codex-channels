import type { Bot } from "grammy";
import type { Logger } from "pino";

import {
  conversationCommandNames,
  type ConversationCommandName,
} from "../../application/index.js";
import { formatTelegramPanelChunks } from "./html-format.js";
import { telegramErrorMetadata } from "./error-metadata.js";

const commandDescriptions = {
  resume: "列出或恢复 Codex 会话",
  sessions: "搜索可恢复会话",
  archived: "搜索已归档会话",
  new: "下一条消息创建新会话",
  archive: "归档当前会话",
  unarchive: "恢复已归档会话",
  status: "查看当前状态",
  workspace: "列出或切换 Workspace",
  stop: "停止当前任务",
  queue: "排到下一 Turn",
  rename: "命名当前会话",
  compact: "压缩当前上下文",
  fork: "分叉当前会话",
  review: "启动代码审查",
  model: "查看或切换模型",
  effort: "查看或切换思考强度",
  fast: "查看或切换 Fast 模式",
  skills: "列出 Skills",
  mcp: "列出 MCP Servers",
  plugins: "列出 Plugins",
  usage: "查看账号用量",
  limits: "查看套餐与额度",
  permissions: "查看权限配置",
  diff: "查看当前 Turn Diff",
  plan: "查看当前 Turn 计划",
  goal: "查看或管理 Goal",
} satisfies Record<ConversationCommandName, string>;

const commands = [
  { command: "start", description: "使用说明" },
  ...conversationCommandNames.map((name) => ({
    command: name,
    description: commandDescriptions[name],
  })),
  { command: "cancel", description: "取消当前交互请求" },
  { command: "whoami", description: "显示 Telegram 用户 ID" },
];

class TelegramLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramLifecycleError";
  }
}

export interface TelegramStartupNotification {
  messages: () => ReadonlyArray<{ chatId: number; text: string }>;
}

export class TelegramLifecycle {
  private polling: Promise<void> | undefined;
  private startupNotificationTask: Promise<void> | undefined;
  private lifecycleAbort: AbortController | undefined;
  private stopping = false;

  constructor(
    private readonly bot: Bot,
    private readonly logger: Logger,
    private readonly startupNotification?: TelegramStartupNotification,
    private readonly onFatal?: (error: Error) => void,
  ) {}

  start(): void {
    this.stopping = false;
    this.lifecycleAbort = new AbortController();
    this.polling = this.run(this.lifecycleAbort.signal);
    this.logger.info("Telegram Gateway 正在连接");
    void this.polling.catch((error) => {
      this.logger.error(
        telegramErrorMetadata(error),
        "Telegram Long Polling 已停止",
      );
      if (!this.stopping) {
        this.onFatal?.(
          error instanceof TelegramLifecycleError
            ? error
            : new TelegramLifecycleError("Telegram Long Polling 已停止"),
        );
      }
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.lifecycleAbort?.abort();
    this.lifecycleAbort = undefined;
    await this.polling?.catch(() => undefined);
    this.polling = undefined;
    await this.startupNotificationTask?.catch(() => undefined);
    this.startupNotificationTask = undefined;
  }

  private async run(signal: AbortSignal): Promise<void> {
    await this.initializeBot(signal);
    if (this.stopping || signal.aborted) {
      return;
    }
    this.logger.info({ username: this.bot.botInfo.username }, "Telegram Gateway 已启动");
    void this.registerCommandMenu(signal);
    this.startupNotificationTask = this.sendStartupNotification(signal);
    await this.pollUpdates(signal);
  }

  private async sendStartupNotification(signal: AbortSignal): Promise<void> {
    if (!this.startupNotification) {
      return;
    }
    let messages: ReadonlyArray<{ chatId: number; text: string }>;
    try {
      messages = this.startupNotification.messages();
    } catch (error) {
      if (!this.stopping && !signal.aborted) {
        this.logger.warn(
          telegramErrorMetadata(error),
          "Telegram 启动联通通知生成失败，不影响 Long Polling",
        );
      }
      return;
    }
    for (const { chatId, text } of messages) {
      try {
        for (const chunk of formatTelegramPanelChunks(text)) {
          await this.bot.api.sendMessage(
            chatId,
            chunk,
            { parse_mode: "HTML", disable_notification: true },
            signal as never,
          );
        }
      } catch (error) {
        if (this.stopping || signal.aborted) {
          return;
        }
        this.logger.warn(
          {
            chatId,
            ...telegramErrorMetadata(error),
          },
          "Telegram 启动联通通知发送失败，不影响 Long Polling",
        );
      }
    }
  }

  private async registerCommandMenu(signal: AbortSignal): Promise<void> {
    try {
      await this.bot.api.setMyCommands(commands, signal as never);
    } catch (error) {
      this.logger.warn(
        telegramErrorMetadata(error),
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
            ...telegramErrorMetadata(error),
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
                ...telegramErrorMetadata(error),
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
          throw new TelegramLifecycleError(
            `Telegram Long Polling 连续失败 ${maximumFailures} 次`,
          );
        }
        this.logger.warn(
          {
            ...telegramErrorMetadata(error),
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
