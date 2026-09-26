import { conversationTargetKey } from "../../conversation-core/index.js";
import type { DeliveryJournal } from "../delivery-journal.js";
import { DurableInputQueue } from "../durable-input-queue.js";
import type { Bot } from "grammy";
import type { Logger } from "pino";

import {
  conversationCommandNames,
} from "../../application/index.js";
import { conversationCommandDescriptions } from "../conversation-command-help.js";
import { isEmergencyStopCommand } from "../slash-command.js";
import { formatTelegramPanelChunks } from "./html-format.js";
import { telegramErrorMetadata } from "./error-metadata.js";

export function telegramConversationCommandName(name: string): string {
  return name.replaceAll("-", "_");
}

const commands = [
  { command: "start", description: "使用说明" },
  ...conversationCommandNames.map((name) => ({
    command: telegramConversationCommandName(name),
    description: conversationCommandDescriptions[name],
  })),
  { command: "whoami", description: "显示 Telegram 用户 ID" },
];

const updateGroupSizes = new WeakMap<object, number>();
const updateSignals = new WeakMap<object, AbortSignal>();

export function telegramUpdateSignal(update: object): AbortSignal | undefined {
  return updateSignals.get(update);
}
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
  journal?: DeliveryJournal | undefined;
  acceptUpdate?(update: Parameters<Bot["handleUpdate"]>[0]): boolean;
}

export class TelegramLifecycle {
  private polling: Promise<void> | undefined;
  private readonly durable?: DurableInputQueue<Parameters<Bot["handleUpdate"]>[0]>;
  private startupNotificationTask: Promise<void> | undefined;
  private lifecycleAbort: AbortController | undefined;
  private inputAbort = new AbortController();
  private readonly updateProcessing = new Map<string, Promise<void>>();
  private readonly updateTasks = new Set<Promise<void>>();
  private readonly rejectedUpdateTasks = new Set<Promise<void>>();
  private readonly rejectedUpdates = new Set<number>();
  private readonly urgentUpdateTasks = new Set<Promise<void>>();
  private readonly capacityWaiters = new Set<() => void>();
  private pendingUpdateCount = 0;
  private readonly unconfirmedUpdates = new Map<number, boolean>();
  private stopping = false;
  private readonly closeTimeoutMs: number;

  constructor(
    private readonly bot: Bot,
    private readonly logger: Logger,
    private readonly startupNotification?: TelegramStartupNotification,
    private readonly onFatal?: (error: Error) => void,
    private readonly options: TelegramLifecycleOptions = {},
  ) {
    this.closeTimeoutMs = options.closeTimeoutMs ?? defaultCloseTimeoutMs;
    if (options.journal) this.durable = new DurableInputQueue({
      journal: options.journal, stream: "telegram:default:input", blockedByStream: "telegram:default:output",
      groupKey: update => update.message?.media_group_id,
      handle: async (update, signal, groupSize) => {
        if (groupSize > 1) updateGroupSizes.set(update, groupSize);
        await this.handleUpdate(update, signal);
      },
      onUncertain: id => this.logger.error({ deliveryId: id }, "Telegram 输入结果待核对，未自动重发"),
    });
  }

  start(): void {
    this.stopping = false;
    if (this.inputAbort.signal.aborted) {
      this.inputAbort = new AbortController();
      this.updateProcessing.clear();
      this.updateTasks.clear();
      this.urgentUpdateTasks.clear();
      this.pendingUpdateCount = 0;
      this.unconfirmedUpdates.clear();
    }
    this.lifecycleAbort?.abort();
    this.lifecycleAbort = new AbortController();
    const generation = this.lifecycleAbort;
    this.polling = this.run(this.lifecycleAbort.signal);
    this.logger.info("Telegram Gateway 正在连接");
    void this.polling.catch((error) => {
      this.logger.error(
        telegramErrorMetadata(error),
        "Telegram Long Polling 已停止",
      );
      if (!this.stopping && this.lifecycleAbort === generation) {
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
    this.inputAbort.abort();
    this.lifecycleAbort?.abort();
    this.lifecycleAbort = undefined;
    const polling = this.polling;
    const startup = this.startupNotificationTask;
    this.polling = undefined;
    this.startupNotificationTask = undefined;
    const updatesCompleted = await waitAtMost(Promise.allSettled([
      polling,
      startup,
      ...this.updateTasks,
      ...this.urgentUpdateTasks,
      ...this.rejectedUpdateTasks,
      this.durable?.close(),
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
  }

  private async run(signal: AbortSignal): Promise<void> {
    await this.initializeBot(signal);
    if (this.stopping || signal.aborted) {
      return;
    }
    this.logger.info({ username: this.bot.botInfo.username }, "Telegram Gateway 已启动");
    void this.registerCommandMenu(signal);
    this.startupNotificationTask = this.sendStartupNotification(signal);
    this.durable?.start();
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
          signal.throwIfAborted();
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
    const pending = this.unconfirmedUpdates;
    const inputSignal = this.inputAbort.signal;
    const maximumFailures = 12;
    while (!this.stopping && !signal.aborted) {
      try {
        await this.waitForUpdateCapacity(signal);
        if (this.stopping || signal.aborted) {
          return;
        }
        for (const [id, completed] of pending) {
          if (!completed) break;
          offset = id + 1;
        }
        const updates = await this.bot.api.getUpdates(
          {
            offset,
            timeout: 20,
            // Replayed entries already occupy capacity. Shrinking the fetch
            // limit by in-flight count can hide fresh controls behind them.
            limit: 100,
            allowed_updates: [],
          },
          signal as never,
        );
        if (signal.aborted || this.stopping) return;
        consecutiveFailures = 0;
        if (this.durable) {
          for (const id of this.rejectedUpdates) if (id < offset) this.rejectedUpdates.delete(id);
          let failed = false;
          let failure: unknown;
          for (const update of updates) {
            const control = isTelegramUrgentUpdate(update, this.bot.botInfo.username);
            if (this.options.acceptUpdate?.(update) === false) {
              this.handleRejectedUpdate(update, inputSignal);
            } else {
              // Preserve the ordinary prefix, but still admit controls already in this batch.
              if (failed && !control) continue;
              try {
                this.durable.accept(`telegram:default:${update.update_id}`, durableConversationKey(update), update, control);
              } catch (error) {
                if (!failed) failure = error;
                failed = true;
              }
            }
            if (!failed) offset = update.update_id + 1;
          }
          if (failed) throw failure;
          continue;
        }
        // Only a successful fetch proves that Telegram saw this offset. Keep
        // completed IDs across network failures and in-process reconnection.
        for (const id of pending.keys()) {
          if (id < offset) pending.delete(id);
        }
        // Only confirm the contiguous completed prefix. A later completed chat
        // must not acknowledge an earlier queued/unfinished update.
        const fresh = updates.filter(update => !pending.has(update.update_id));
        for (const update of fresh) pending.set(update.update_id, false);
        const complete = (ids: number[]): void => {
          if (inputSignal.aborted || inputSignal !== this.inputAbort.signal) return;
          for (const id of ids) pending.set(id, true);
        };
        const urgentUpdates = new Set(
          fresh.filter((update) => isTelegramUrgentUpdate(
            update,
            this.bot.botInfo.username,
          )),
        );
        for (const update of urgentUpdates) {
          void this.runUrgentUpdate(update).then(() => complete([update.update_id]));
        }
        for (const group of groupTelegramUpdates(
          fresh.filter((update) => !urgentUpdates.has(update)),
        )) {
          if (group.length > 1) {
            for (const update of group) {
              updateGroupSizes.set(update, group.length);
            }
          }
          void this.enqueueUpdateGroup(group).then(() => complete(group.map(update => update.update_id)));
        }
        // Unconfirmed updates are returned immediately, even with long polling.
        // Avoid a hot loop while retaining access to controls in this window.
        if (updates.length > 0 && fresh.length === 0) await waitWithAbort(250, signal);
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
  ): Promise<void> {
    const signal = this.inputAbort.signal;
    const key = updateConversationKey(group[0]!);
    this.pendingUpdateCount += group.length;
    const processing = (this.updateProcessing.get(key) ?? Promise.resolve()).then(async () => {
      if (signal.aborted) return;
      await Promise.all(group.map((update) => this.handleUpdate(update, signal)));
    });
    const task = processing.finally(() => {
      if (signal === this.inputAbort.signal) this.pendingUpdateCount -= group.length;
      this.updateTasks.delete(task);
      if (this.updateProcessing.get(key) === task) this.updateProcessing.delete(key);
      this.notifyUpdateCapacity();
    });
    this.updateProcessing.set(key, task);
    this.updateTasks.add(task);
    return task;
  }

  private runUrgentUpdate(
    update: Parameters<Bot["handleUpdate"]>[0],
  ): Promise<void> {
    const signal = this.inputAbort.signal;
    const task = Promise.resolve()
      .then(() => this.handleUpdate(update, signal))
      .finally(() => {
        this.urgentUpdateTasks.delete(task);
        this.notifyUpdateCapacity();
      });
    this.urgentUpdateTasks.add(task);
    return task;
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

  private handleRejectedUpdate(update: Parameters<Bot["handleUpdate"]>[0], signal: AbortSignal): void {
    if (this.rejectedUpdates.has(update.update_id)) return;
    this.rejectedUpdates.add(update.update_id);
    if (this.rejectedUpdates.size > maximumPendingUpdates) this.rejectedUpdates.delete(this.rejectedUpdates.values().next().value!);
    if (this.rejectedUpdateTasks.size >= 8) {
      this.logger.warn("Telegram 授权提示并发已满，省略非关键提示");
      return;
    }
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const task = this.handleUpdate(update, deadline).catch(() => undefined).finally(() => {
      this.rejectedUpdateTasks.delete(task);
    });
    this.rejectedUpdateTasks.add(task);
  }

  private async handleUpdate(
    update: Parameters<Bot["handleUpdate"]>[0],
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    updateSignals.set(update, signal);
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
      if (this.durable) throw error;
    }
  }
}

function isTelegramUrgentUpdate(
  update: Parameters<Bot["handleUpdate"]>[0],
  botUsername: string,
): boolean {
  if (update.callback_query?.data?.startsWith("ix:")) return true;
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

function durableConversationKey(update: Parameters<Bot["handleUpdate"]>[0]): string {
  const chat = update.message?.chat ?? update.edited_message?.chat ?? update.callback_query?.message?.chat;
  return conversationTargetKey({ surface: "telegram", accountId: "default", conversationId: chat ? String(chat.id) : `update:${update.update_id}` });
}

function updateConversationKey(update: Parameters<Bot["handleUpdate"]>[0]): string {
  const chat = update.message?.chat ?? update.edited_message?.chat ?? update.callback_query?.message?.chat;
  return chat ? `chat:${chat.id}` : `update:${update.update_id}`;
}

function groupTelegramUpdates(updates: ReadonlyArray<Parameters<Bot["handleUpdate"]>[0]>): Array<Array<Parameters<Bot["handleUpdate"]>[0]>> {
  const groups: Array<Array<Parameters<Bot["handleUpdate"]>[0]>> = [];
  for (const update of updates) {
    const mediaGroupId = update.message?.media_group_id;
    const previous = groups.at(-1);
    if (
      mediaGroupId !== undefined
      && previous?.at(-1)?.message?.media_group_id === mediaGroupId
      && updateConversationKey(previous.at(-1)!) === updateConversationKey(update)
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
