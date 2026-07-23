import type { Bot } from "grammy";
import type { Logger } from "pino";

import { formatTelegramPanelChunks } from "./html-format.js";

const commands = [
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
  { command: "model", description: "查看或切换模型" },
  { command: "effort", description: "查看或切换思考强度" },
  { command: "fast", description: "查看或切换 Fast 模式" },
  { command: "skills", description: "列出 Skills" },
  { command: "mcp", description: "列出 MCP Servers" },
  { command: "plugins", description: "列出 Plugins" },
  { command: "usage", description: "查看账号用量" },
  { command: "limits", description: "查看套餐与额度" },
  { command: "permissions", description: "查看权限配置" },
  { command: "goal", description: "查看或管理 Goal" },
  { command: "cancel", description: "取消当前交互请求" },
  { command: "whoami", description: "显示 Telegram 用户 ID" },
];

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
      const failure = asError(error);
      this.logger.error(
        { message: failure.message },
        "Telegram Long Polling 已停止",
      );
      if (!this.stopping) {
        this.onFatal?.(failure);
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
          { message: error instanceof Error ? error.message : String(error) },
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
            message: error instanceof Error ? error.message : String(error),
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
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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
