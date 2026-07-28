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
    kind: "text" | "image" | "file";
  }>): Promise<void>;
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
      while (!signal.aborted) {
        let batch;
        options.onPollStart?.();
        try {
          batch = await options.client.getUpdates(cursor, signal);
          options.onPollSuccess?.(Date.now());
        } catch (error) {
          if (signal.aborted) {
            return;
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
            await abortableDelay(staleCredentialPauseMs, signal);
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
            await abortableDelay(backoffDelayMs, signal);
            continue;
          }
          options.onRetry?.({
            attempt: consecutiveFailures,
            code: error.code,
            phase: "retry",
            delayMs: retryDelayMs,
            ...(error.status === undefined ? {} : { status: error.status }),
          });
          await abortableDelay(retryDelayMs, signal);
          continue;
        }
        consecutiveFailures = 0;
        if (batch.messages.length > 0 && batch.cursor.length === 0) {
          throw new WeixinProtocolError(
            "invalid-response",
            "微信消息批次缺少可提交游标",
          );
        }
        const messages: WeixinInboundMessage[] = [];
        const batchMessageIds = new Set<string>();
        for (const message of batch.messages) {
          if (
            recentMessageIds.has(message.messageId)
            || batchMessageIds.has(message.messageId)
          ) {
            continue;
          }
          batchMessageIds.add(message.messageId);
          messages.push(message);
        }
        for (let index = 0; index < messages.length;) {
          const message = messages[index]!;
          if (message.kind === "image") {
            const imageMessages: Array<Extract<
              WeixinInboundMessage,
              { kind: "image" }
            >> = [];
            while (messages[index]?.kind === "image") {
              imageMessages.push(messages[index] as Extract<
                WeixinInboundMessage,
                { kind: "image" }
              >);
              index += 1;
            }
            await Promise.all(
              imageMessages.map((imageMessage) =>
                options.handleMessage(imageMessage)
              ),
            );
            for (const imageMessage of imageMessages) {
              recentMessageIds.add(imageMessage.messageId);
            }
            continue;
          }
          if (message.kind === "text" || message.kind === "file") {
            await options.handleMessage(message);
          }
          recentMessageIds.add(message.messageId);
          index += 1;
        }
        if (batch.cursor.length > 0 && batch.cursor !== cursor) {
          await options.cursorStore.set(accountId, batch.cursor);
          cursor = batch.cursor;
        }
      }
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
