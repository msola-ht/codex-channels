import type { Bot } from "grammy";
import type { Logger } from "pino";

import {
  conversationCommandNames,
} from "../../application/index.js";
import { conversationCommandDescriptions } from "../conversation-command-format.js";
import { isEmergencyStopCommand } from "../slash-command.js";
import { formatTelegramPanelChunks } from "./html-format.js";
import { telegramErrorMetadata } from "./error-metadata.js";

const commands = [
  { command: "start", description: "使用说明" },
  ...conversationCommandNames.map((name) => ({
    command: name,
    description: conversationCommandDescriptions[name],
  })),
  { command: "whoami", description: "显示 Telegram 用户 ID" },
];

const updateGroupSizes = new WeakMap<object, number>();
const maximumPendingUpdates = 1_000;
const maximumUrgentUpdates = 100;
const defaultCloseTimeoutMs = 5_000;

export function telegramUpdateGroupSize(update: object): number | undefined {
  return updateGroupSizes.get(update);
}

class TelegramLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramLifecycleError";
  }
}

export interface TelegramStartupNotification {
  messages: () => ReadonlyArray<{ chatId: number; text: string }> | Promise<ReadonlyArray<{ chatId: number; text: string }>>;
}

export interface TelegramLifecycleOptions {
  closeTimeoutMs?: number;
}

export class TelegramLifecycle {
  private polling: Promise<void> | undefined;
  private startupNotificationTask: Promise<void> | undefined;
  private lifecycleAbort: AbortController | undefined;
  private updateProcessing = Promise.resolve();
  private readonly urgentUpdateTasks = new Set<Promise<void>>();
  private readonly capacityWaiters = new Set<() => void>();
  private pendingUpdateCount = 0;
  private stopping = false;
  private readonly closeTimeoutMs: number;

  constructor(
    private readonly bot: Bot,
    private readonly logger: Logger,
    private readonly startupNotification?: TelegramStartupNotification,
    private readonly onFatal?: (error: Error) => void,
    options: TelegramLifecycleOptions = {},
  ) {
    this.closeTimeoutMs = options.closeTimeoutMs ?? defaultCloseTimeoutMs;
  }

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
    const updatesCompleted = await waitAtMost(Promise.allSettled([
      this.updateProcessing,
      ...this.urgentUpdateTasks,
    ]), this.closeTimeoutMs);
    if (!updatesCompleted) {
      this.logger.warn(
        {
          pendingUpdateCount: this.pendingUpdateCount,
          urgentUpdateCount: this.urgentUpdateTasks.size,
        },
        "Telegram 更新处理未在关闭等待上限内完成",
      );
    }
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
      messages = await this.startupNotification.messages();
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
        await this.waitForUpdateCapacity(signal);
        if (this.stopping || signal.aborted) {
          return;
        }
        const updates = await this.bot.api.getUpdates(
          {
            offset,
            timeout: 20,
            limit: Math.max(
              1,
              Math.min(
                100,
                maximumPendingUpdates - this.pendingUpdateCount,
                maximumUrgentUpdates - this.urgentUpdateTasks.size,
              ),
            ),
            allowed_updates: [],
          },
          signal as never,
        );
        consecutiveFailures = 0;
        const emergencyStops = new Set(
          updates.filter((update) => isTelegramEmergencyStopUpdate(
            update,
            this.bot.botInfo.username,
          )),
        );
        for (const update of emergencyStops) {
          this.runUrgentUpdate(update);
        }
        for (const group of groupTelegramUpdates(
          updates.filter((update) => !emergencyStops.has(update)),
        )) {
          if (group.length > 1) {
            for (const update of group) {
              updateGroupSizes.set(update, group.length);
            }
          }
          this.enqueueUpdateGroup(group);
        }
        for (const update of updates) {
          offset = update.update_id + 1;
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

  private enqueueUpdateGroup(
    group: ReadonlyArray<Parameters<Bot["handleUpdate"]>[0]>,
  ): void {
    this.pendingUpdateCount += group.length;
    const processing = this.updateProcessing.then(async () => {
      await Promise.all(group.map((update) => this.handleUpdate(update)));
    });
    this.updateProcessing = processing.finally(() => {
      this.pendingUpdateCount -= group.length;
      this.notifyUpdateCapacity();
    });
  }

  private runUrgentUpdate(
    update: Parameters<Bot["handleUpdate"]>[0],
  ): void {
    const task = Promise.resolve()
      .then(() => this.handleUpdate(update))
      .finally(() => {
        this.urgentUpdateTasks.delete(task);
        this.notifyUpdateCapacity();
      });
    this.urgentUpdateTasks.add(task);
  }

  private async waitForUpdateCapacity(signal: AbortSignal): Promise<void> {
    while (
      !signal.aborted
      && (
        this.pendingUpdateCount >= maximumPendingUpdates
        || this.urgentUpdateTasks.size >= maximumUrgentUpdates
      )
    ) {
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          signal.removeEventListener("abort", finish);
          this.capacityWaiters.delete(finish);
          resolve();
        };
        this.capacityWaiters.add(finish);
        signal.addEventListener("abort", finish, { once: true });
      });
    }
  }

  private notifyUpdateCapacity(): void {
    for (const notify of [...this.capacityWaiters]) notify();
  }

  private async handleUpdate(
    update: Parameters<Bot["handleUpdate"]>[0],
  ): Promise<void> {
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
}

function isTelegramEmergencyStopUpdate(
  update: Parameters<Bot["handleUpdate"]>[0],
  botUsername: string,
): boolean {
  const text = update.message?.text;
  if (text === undefined) {
    return false;
  }
  const normalized = text.trim();
  return isEmergencyStopCommand(normalized)
    || normalized === `/stop@${botUsername}`;
}

async function waitAtMost(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function groupTelegramUpdates<T extends {
  message?: { media_group_id?: string };
}>(updates: readonly T[]): T[][] {
  const groups: T[][] = [];
  for (const update of updates) {
    const mediaGroupId = update.message?.media_group_id;
    const previous = groups.at(-1);
    if (
      mediaGroupId !== undefined
      && previous?.at(-1)?.message?.media_group_id === mediaGroupId
    ) {
      previous.push(update);
      continue;
    }
    groups.push([update]);
  }
  return groups;
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
