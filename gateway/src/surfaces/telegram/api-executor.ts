import { GrammyError, HttpError } from "grammy";
import type { Logger } from "pino";

interface TelegramApiCall {
  chatId: string;
  operation: string;
  critical: boolean;
}

export class TelegramApiExecutor {
  constructor(private readonly logger: Logger) {}

  async call<T>(context: TelegramApiCall, operation: () => Promise<T>): Promise<T> {
    const maximumAttempts = context.critical ? 3 : 1;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const delayMs = retryDelay(error, attempt);
        if (attempt === maximumAttempts || delayMs === undefined || delayMs > 30_000) {
          throw error;
        }
        this.logger.warn(
          {
            chatId: context.chatId,
            operation: context.operation,
            attempt,
            maximumAttempts,
            retryInMs: delayMs,
            error: safeErrorMessage(error),
          },
          "Telegram API 请求失败，稍后重试",
        );
        await wait(delayMs);
      }
    }
    throw new Error("Telegram API 重试状态异常");
  }
}

function retryDelay(error: unknown, attempt: number): number | undefined {
  if (error instanceof GrammyError) {
    if (error.error_code === 429 && typeof error.parameters.retry_after === "number") {
      return Math.max(0, error.parameters.retry_after * 1_000);
    }
    if (error.error_code >= 500) {
      return exponentialDelay(attempt);
    }
    return undefined;
  }
  if (error instanceof HttpError) {
    return exponentialDelay(attempt);
  }
  return undefined;
}

function exponentialDelay(attempt: number): number {
  return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 150);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
