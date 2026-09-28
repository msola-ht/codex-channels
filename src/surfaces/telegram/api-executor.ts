import { checkpointDelivery } from "../delivery-receipt.js";
import { GrammyError, HttpError } from "grammy";
import type { Logger } from "pino";

import { isTelegramMessageNotModified, telegramErrorMetadata } from "./error-metadata.js";
import { observeSurfaceStage, surfaceDiagnosticContext, withSurfaceDiagnosticContext } from "../diagnostics.js";

interface TelegramApiCall {
  chatId: string;
  operation: string;
  critical: boolean;
}

export class TelegramApiExecutor {
  constructor(private readonly logger: Logger) {}

  /** A verified unchanged edit confirms the requested content, before receipt settlement. */
  async editMessageText(
    context: Omit<TelegramApiCall, "operation">,
    operation: (signal: AbortSignal) => Promise<unknown>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    await checkpointDelivery("editMessageText", async () => {
      try { await this.execute({ ...context, operation: "editMessageText" }, operation, signal); }
      catch (error) {
        if (signal.aborted || !isTelegramMessageNotModified(error)) throw error;
      }
    }, (error) => error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500);
  }

  async call<T>(
    context: TelegramApiCall,
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<T> {
    return checkpointDelivery(context.operation, () => this.execute(context, operation, signal),
      (error) => error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500);
  }

  private async execute<T>(
    context: TelegramApiCall,
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const maximumAttempts = context.critical ? 3 : 1;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        return await withSurfaceDiagnosticContext({
          ...surfaceDiagnosticContext(), component: "Telegram", conversationId: context.chatId,
        }, () => observeSurfaceStage(this.logger, {
          stage: "api", operation: context.operation, critical: context.critical,
          attempt, maximumAttempts, signal, errorMetadata: telegramErrorMetadata,
        }, () => operation(signal)));
      } catch (error) {
        if (signal.aborted) throw error;
        const delayMs = retryDelay(error, attempt, context.operation);
        if (attempt === maximumAttempts || delayMs === undefined || delayMs > 30_000) {
          throw error;
        }
        this.logger.warn(
          {
            ...surfaceDiagnosticContext(),
            component: "Telegram",
            chatId: context.chatId,
            operation: context.operation,
            attempt,
            maximumAttempts,
            retryInMs: delayMs,
            ...telegramErrorMetadata(error),
          },
          "Telegram API 请求失败，稍后重试",
        );
        await wait(delayMs, signal);
      }
    }
    throw new Error("Telegram API 重试状态异常");
  }
}

function retryDelay(error: unknown, attempt: number, operation: string): number | undefined {
  const idempotent = operation === "editMessageText" || operation === "deleteMessage";
  if (error instanceof GrammyError) {
    if (error.error_code === 429 && typeof error.parameters.retry_after === "number") {
      return Math.max(0, error.parameters.retry_after * 1_000);
    }
    if (idempotent && error.error_code >= 500) {
      return exponentialDelay(attempt);
    }
    return undefined;
  }
  if (idempotent && error instanceof HttpError) {
    return exponentialDelay(attempt);
  }
  return undefined;
}

function exponentialDelay(attempt: number): number {
  return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 150);
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Telegram API 请求已取消"));
      return;
    }
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error("Telegram API 请求已取消"));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, milliseconds);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
