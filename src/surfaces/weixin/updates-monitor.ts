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
    kind: "text" | "image";
  }>): Promise<void>;
  maximumConsecutiveFailures?: number;
  recentMessageCapacity?: number;
  retryDelayMs?: number;
  onRetry?(event: WeixinUpdatesRetryEvent): void;
}

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
        try {
          batch = await options.client.getUpdates(cursor, signal);
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          if (isTimeout(error)) {
            continue;
          }
          if (!isRetryable(error)) {
            throw error;
          }
          consecutiveFailures += 1;
          if (consecutiveFailures >= maximumConsecutiveFailures) {
            throw error;
          }
          options.onRetry?.({
            attempt: consecutiveFailures,
            code: error.code,
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
          if (message.kind === "text") {
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
