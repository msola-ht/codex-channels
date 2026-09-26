import { GrammyError, HttpError } from "grammy";
import type { Logger } from "pino";

import { telegramErrorMetadata } from "./error-metadata.js";

interface TelegramApiCall {
  chatId: string;
  operation: string;
  critical: boolean;
}

class TelegramApiTimeoutError extends Error {
  readonly code = "ETIMEDOUT";
  constructor() { super("Telegram API 请求超时"); }
}

export class TelegramApiExecutor {
  constructor(private readonly logger: Logger) {}

  async call<T>(
    context: TelegramApiCall,
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal = new AbortController().signal,
    onLateResult?: (result: T) => Promise<void>,
  ): Promise<T> {
    const startedAt = performance.now();
    const budgetMs = context.critical ? 120_000 : 5_000;
    const maximumAttempts = context.critical ? 6 : 1;
    let deliveryUncertain = false;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      signal.throwIfAborted();
      const attemptStartedAt = performance.now();
      const timeoutMs = Math.max(1, Math.min(context.critical ? 30_000 : 5_000,
        budgetMs - (attemptStartedAt - startedAt)));
      try {
        const result = await callAttempt(operation, signal, timeoutMs, onLateResult);
        if (attempt > 1) this.logger.info({ ...context, attempt,
          elapsedMs: Math.round(performance.now() - startedAt) }, "Telegram API 重试后已恢复");
        return result;
      } catch (error) {
        const metadata = telegramErrorMetadata(error);
        if (context.operation === "editMessageText" && metadata.telegramErrorKind === "message_not_modified") {
          // Callers recognize this as an already-visible result. Do not report
          // a routine no-op as a delivery failure or retry it.
          this.logger.debug({ ...context, ...metadata }, "Telegram 消息内容未变化");
          throw error;
        }
        const elapsedMs = performance.now() - startedAt;
        const delayMs = retryDelay(error, attempt);
        // A lost response to a create operation may already have created a message.
        // Do not retry a create operation whose delivery result is unknown.
        deliveryUncertain ||= isTelegramDeliveryUncertain(error, context.operation);
        const attemptLimit = deliveryUncertain ? attempt : maximumAttempts;
        const retry = !signal.aborted && attempt < attemptLimit
          && delayMs !== undefined && delayMs < budgetMs - elapsedMs;
        this.logger.warn({ ...context, ...metadata, attempt, maximumAttempts: attemptLimit,
          attemptMs: Math.round(performance.now() - attemptStartedAt), elapsedMs: Math.round(elapsedMs),
          deliveryUncertain, cancelled: signal.aborted, ...(retry ? { retryInMs: delayMs } : {}) },
        retry ? "Telegram API 请求失败，稍后重试" : "Telegram API 请求失败，已结束本次投递");
        if (!retry) throw error;
        await wait(delayMs, signal);
      }
    }
    throw new Error("Telegram API 重试状态异常");
  }
}

export function isTelegramDeliveryUncertain(error: unknown, operation = "sendMessage"): boolean {
  return operation.startsWith("send")
    && (error instanceof HttpError || error instanceof TelegramApiTimeoutError
      || (error instanceof GrammyError && error.error_code >= 500))
    && !["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]
      .includes(String(telegramErrorMetadata(error).networkCode ?? ""));
}

async function callAttempt<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, timeoutMs: number,
  onLateResult?: (result: T) => Promise<void>): Promise<T> {
  const timeout = new AbortController();
  const combined = AbortSignal.any([signal, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(new TelegramApiTimeoutError()), timeoutMs);
  timer.unref();
  let onAbort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    // Let a transport that returns a message after caller cancellation pass that
    // result back to interaction cleanup. The attempt deadline still bounds it.
    onAbort = () => reject(new TelegramApiTimeoutError());
    timeout.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    combined.throwIfAborted();
    const pending = operation(combined).then(async (result) => {
      // A transport can ignore abort and return a created interaction after the
      // deadline. Its owner must still invalidate that specific message.
      if (timeout.signal.aborted) await onLateResult?.(result);
      return result;
    });
    return await Promise.race([pending, cancelled]);
  } finally {
    clearTimeout(timer);
    timeout.signal.removeEventListener("abort", onAbort);
  }
}

function retryDelay(error: unknown, attempt: number): number | undefined {
  if (error instanceof GrammyError) {
    if (error.error_code === 429 && typeof error.parameters.retry_after === "number"
      && Number.isFinite(error.parameters.retry_after) && error.parameters.retry_after >= 0) {
      return error.parameters.retry_after * 1_000;
    }
    if (error.error_code < 500) return undefined;
  } else if (!(error instanceof HttpError) && !(error instanceof TelegramApiTimeoutError)) {
    return undefined;
  }
  return Math.min(15_000, 1_000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 150);
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason instanceof Error ? signal.reason : new Error("Telegram API 请求已取消")); return; }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Telegram API 请求已取消"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
