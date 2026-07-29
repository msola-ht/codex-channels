export type WeixinRequestAbortReason =
  | "aborted"
  | "network-abort"
  | "timeout";

export class WeixinRequestAbortError extends Error {
  constructor(
    readonly reason: WeixinRequestAbortReason,
    options?: ErrorOptions,
  ) {
    super("微信请求已中止", options);
    this.name = "WeixinRequestAbortError";
  }
}

export async function withWeixinRequestAbort<T>(
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
  },
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (options.signal?.aborted) {
    throw new WeixinRequestAbortError("aborted");
  }
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  timeout.unref?.();
  try {
    return await request(controller.signal);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new WeixinRequestAbortError(
        options.signal?.aborted
          ? "aborted"
          : timedOut
            ? "timeout"
            : "network-abort",
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
