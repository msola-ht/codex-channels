import { setImmediate as yieldToPolling } from "node:timers/promises";
import { isEmergencyStopCommand } from "../slash-command.js";
import { validateWeixinAccountId } from "./credential-store.js";
import {
  WeixinProtocolError,
  type WeixinInboundMessage,
  type WeixinProtocolClient,
  type WeixinProtocolErrorCode,
} from "./protocol-client.js";
import type { WeixinUpdatesCursorStore } from "./updates-cursor-store.js";

export interface WeixinUpdatesRetryEvent {
  attempt: number;
  code: WeixinProtocolErrorCode;
  phase: "backoff" | "credential-pause" | "retry";
  delayMs: number;
  returnCode?: number;
  status?: number;
}

export interface WeixinUpdatesMonitor {
  run(signal: AbortSignal): Promise<void>;
}

export interface CreateWeixinUpdatesMonitorOptions {
  accountId: string;
  client: WeixinProtocolClient;
  cursorStore: WeixinUpdatesCursorStore;
  handleMessage(message: Extract<WeixinInboundMessage, {
    kind: "text" | "image" | "file" | "audio";
  }>, signal: AbortSignal): Promise<void>;
  maximumConsecutiveFailures?: number;
  recentMessageCapacity?: number;
  retryDelayMs?: number;
  backoffDelayMs?: number;
  staleCredentialPauseMs?: number;
  onPollStart?(): void;
  onPollSuccess?(atMs: number): void;
  onRetry?(event: WeixinUpdatesRetryEvent): void;
}

const staleCredentialReturnCode = -14;

export function createWeixinUpdatesMonitor(
  options: CreateWeixinUpdatesMonitorOptions,
): WeixinUpdatesMonitor {
  const accountId = validateWeixinAccountId(options.accountId);
  const maximumConsecutiveFailures = positiveInteger(
    options.maximumConsecutiveFailures ?? 3,
    "微信长轮询连续失败上限无效",
  );
  const recentMessageCapacity = positiveInteger(
    options.recentMessageCapacity ?? 1_000,
    "微信消息去重容量无效",
  );
  const retryDelayMs = nonNegativeNumber(
    options.retryDelayMs ?? 2_000,
    "微信长轮询重试间隔无效",
  );
  const backoffDelayMs = nonNegativeNumber(
    options.backoffDelayMs ?? 30_000,
    "微信长轮询退避间隔无效",
  );
  const staleCredentialPauseMs = nonNegativeNumber(
    options.staleCredentialPauseMs ?? 60 * 60 * 1_000,
    "微信失效凭据暂停时间无效",
  );
  const recentMessageIds = new RecentMessageIds(recentMessageCapacity);

  return {
    async run(signal) {
      if (signal.aborted) {
        return;
      }
      let cursor = await options.cursorStore.get(accountId) ?? "";
      let consecutiveFailures = 0;
      // Read ahead within a bounded window, but persist only the contiguous completed prefix.
      // The parser accepts at most 100 messages per batch; eight batches retain at most 800.
      const controller = new AbortController();
      const pollingSignal = AbortSignal.any([signal, controller.signal]);
      const conversations = new Map<string, Promise<void>>();
      const inFlightIds = new Map<string, Promise<void>>();
      const pendingBatches = new Set<Promise<void>>();
      let commitTail = Promise.resolve();
      let failure: { error: unknown } | undefined;
      const fail = (error: unknown): void => {
        failure ??= { error };
        controller.abort();
      };
      const dispatch = (message: WeixinInboundMessage): Promise<void> => {
        const existing = inFlightIds.get(message.messageId);
        if (existing) return existing;
        if (recentMessageIds.has(message.messageId)) return Promise.resolve();
        const key = message.kind === "ignored" ? undefined : message.conversationId;
        const urgent = message.kind === "text" && isEmergencyStopCommand(message.text);
        const previous = key === undefined || urgent ? Promise.resolve() : conversations.get(key) ?? Promise.resolve();
        const task = previous.then(async () => {
          if (failure) throw failure.error;
          if (message.kind !== "ignored") await options.handleMessage(message, pollingSignal);
          recentMessageIds.add(message.messageId);
        });
        inFlightIds.set(message.messageId, task);
        if (key !== undefined && !urgent) conversations.set(key, task);
        void task.then(() => {
          if (key !== undefined && conversations.get(key) === task) conversations.delete(key);
        }, fail);
        return task;
      };
      try {
        while (!pollingSignal.aborted) {
          if (pendingBatches.size >= 8) {
            await pendingBatches.values().next().value;
            continue;
          }
          let batch;
          options.onPollStart?.();
          try {
            batch = await options.client.getUpdates(cursor, pollingSignal);
            if (pollingSignal.aborted) break;
            options.onPollSuccess?.(Date.now());
          } catch (error) {
            if (pollingSignal.aborted) {
              break;
            }
            if (isTimeout(error)) {
              options.onPollSuccess?.(Date.now());
              continue;
            }
            if (isStaleCredential(error)) {
              consecutiveFailures = 0;
              options.onRetry?.({
                attempt: 1,
                code: error.code,
                phase: "credential-pause",
                delayMs: staleCredentialPauseMs,
                returnCode: staleCredentialReturnCode,
              });
              await abortableDelay(staleCredentialPauseMs, pollingSignal);
              continue;
            }
            if (!isRetryable(error)) {
              throw error;
            }
            consecutiveFailures += 1;
            if (consecutiveFailures >= maximumConsecutiveFailures) {
              options.onRetry?.({
                attempt: consecutiveFailures,
                code: error.code,
                phase: "backoff",
                delayMs: backoffDelayMs,
                ...(error.status === undefined ? {} : { status: error.status }),
              });
              consecutiveFailures = 0;
              await abortableDelay(backoffDelayMs, pollingSignal);
              continue;
            }
            options.onRetry?.({
              attempt: consecutiveFailures,
              code: error.code,
              phase: "retry",
              delayMs: retryDelayMs,
              ...(error.status === undefined ? {} : { status: error.status }),
            });
            await abortableDelay(retryDelayMs, pollingSignal);
            continue;
          }
          consecutiveFailures = 0;
          if (batch.messages.length > 0 && batch.cursor.length === 0) {
            throw new WeixinProtocolError(
              "invalid-response",
              "微信消息批次缺少可提交游标",
            );
          }
          const tasks = batch.messages.map(dispatch);
          // Attach rejection handling immediately, including failures in later batches.
          const handled = Promise.all(tasks).then(() => undefined);
          void handled.catch(fail);
          const nextCursor = batch.cursor;
          const previousCursor = cursor;
          const commit = commitTail.then(async () => {
            await handled;
            if (nextCursor.length > 0 && nextCursor !== previousCursor) {
              await options.cursorStore.set(accountId, nextCursor);
            }
            for (const message of batch.messages) inFlightIds.delete(message.messageId);
          });
          commitTail = commit;
          pendingBatches.add(commit);
          void commit.then(() => pendingBatches.delete(commit), fail);
          if (nextCursor.length > 0) cursor = nextCursor;
          // Let immediately completed handlers/checkpoints settle before fetching again.
          // Slow handlers do not hold the polling loop or emergency commands.
          await yieldToPolling();
        }
      } catch (error) {
        fail(error);
      } finally {
        // Keep ownership until started handlers settle; the input owner bounds shutdown waits.
        await Promise.allSettled([...inFlightIds.values()]);
        await commitTail.catch(fail);
      }
      if (failure) throw failure.error;
    },
  };
}

class RecentMessageIds {
  private readonly ids = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly capacity: number) {}

  has(messageId: string): boolean {
    return this.ids.has(messageId);
  }

  add(messageId: string): void {
    if (this.ids.has(messageId)) {
      return;
    }
    this.ids.add(messageId);
    this.order.push(messageId);
    if (this.order.length <= this.capacity) {
      return;
    }
    const removed = this.order.shift();
    if (removed !== undefined) {
      this.ids.delete(removed);
    }
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof WeixinProtocolError && error.code === "timeout";
}

function isStaleCredential(error: unknown): error is WeixinProtocolError {
  return error instanceof WeixinProtocolError
    && error.code === "api-error"
    && error.returnCode === staleCredentialReturnCode;
}

function isRetryable(error: unknown): error is WeixinProtocolError {
  return error instanceof WeixinProtocolError
    && (
      error.code === "network-error"
      || (
        error.code === "http-error"
        && (
          error.status === 429
          || (error.status !== undefined && error.status >= 500)
        )
      )
    );
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (milliseconds === 0 || signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    timeout.unref?.();
    signal.addEventListener("abort", finish, { once: true });

    function finish() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function positiveInteger(value: number, message: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(message);
  }
  return value;
}

function nonNegativeNumber(value: number, message: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(message);
  }
  return value;
}
