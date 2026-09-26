import type { Logger } from "pino";

/** 根据错误判断是否重试，并给出下一次尝试前的等待毫秒数。 */
export type DeliveryRetryDelay = (error: unknown, attempt: number) => number | undefined;

export interface DeliveryRetryOptions {
  component: string;
  /** 含首次尝试在内的最大尝试次数。 */
  maximumAttempts: number;
  /** 超过该等待时间就不再等待，直接抛出最后一次错误。 */
  maximumDelayMs: number;
  delayMs: DeliveryRetryDelay;
  logger: Logger;
  metadata?(error: unknown): Record<string, unknown>;
}

/**
 * 渠道发送失败后的有界重试。
 *
 * 只重试能证明请求未被平台接受的失败：显式拒绝、限流和服务端错误。超时、网络中断和
 * 响应不可解析都可能已经送达，各渠道的 delayMs 对它们返回 undefined，因此不会重试，
 * 避免产生重复消息或重复文件。等待期间会话队列保持占用，所以延迟上限必须有限。
 */
export async function withDeliveryRetry<T>(
  options: DeliveryRetryOptions,
  call: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      const delayMs = attempt >= options.maximumAttempts
        ? undefined
        : options.delayMs(error, attempt);
      if (delayMs === undefined || delayMs > options.maximumDelayMs) {
        throw error;
      }
      options.logger.warn(
        {
          component: options.component,
          attempt,
          maximumAttempts: options.maximumAttempts,
          retryInMs: delayMs,
          ...(options.metadata?.(error) ?? {}),
        },
        "渠道发送失败，稍后重试",
      );
      await waitBeforeRetry(delayMs, signal, error);
    }
  }
}

/** 指数退避加抖动，与 Telegram 现有重试保持同一量级。 */
export function exponentialRetryDelay(attempt: number): number {
  return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 150);
}

function waitBeforeRetry(
  milliseconds: number,
  signal: AbortSignal | undefined,
  cause: unknown,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledRetryError(cause));
      return;
    }
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cancelledRetryError(cause));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 等待重试期间被取消时，取消错误必须保留真正失败的发送错误作为 cause；
 * 否则日志与 `errorChain` 只能看到一次无原因的取消，无法定位平台返回码。
 */
function cancelledRetryError(cause: unknown): Error {
  return new Error("渠道发送重试已取消", { cause });
}
