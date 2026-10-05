import { AsyncLocalStorage } from "node:async_hooks";

// The SDK drops generated-method options and obtains tokens before business HTTP.
// Scope the shared HTTP adapter to one invocation, including its authentication.
const requestSignal = new AsyncLocalStorage<AbortSignal>();

export function feishuSdkRequestSignal(explicit?: AbortSignal | null): AbortSignal | undefined {
  const scoped = requestSignal.getStore();
  return scoped && explicit && scoped !== explicit
    ? AbortSignal.any([scoped, explicit])
    : scoped ?? explicit ?? undefined;
}

export async function runFeishuSdkRequest<T>(
  request: () => Promise<T>,
  timeoutMs: number,
  timeoutError: Error,
  external?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  const cancel = (error: Error): void => {
    if (controller.signal.aborted) return;
    controller.abort(error);
    rejectCancellation(error);
  };
  const onAbort = (): void => {
    const error = new Error("飞书输出操作已取消");
    error.name = "AbortError";
    cancel(error);
  };
  const timer = setTimeout(() => cancel(timeoutError), timeoutMs);
  timer.unref();
  external?.addEventListener("abort", onAbort, { once: true });
  if (external?.aborted) onAbort();
  try {
    const operation = requestSignal.run(controller.signal, async () => {
      controller.signal.throwIfAborted();
      return request();
    });
    return await Promise.race([operation, cancellation]);
  } catch (error) {
    // Axios cancellation and SDK auth failures must preserve the first cause.
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onAbort);
    // A successful response may own a download stream: do not abort it here.
  }
}
