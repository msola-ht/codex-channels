import { AsyncLocalStorage } from "node:async_hooks";

// The SDK drops generated-method options and obtains tokens before business HTTP.
// Scope the shared HTTP adapter to one invocation, including its authentication.
const requestContext = new AsyncLocalStorage<{ signal: AbortSignal; beforeSend: (() => void) | undefined }>();

export function checkFeishuSendGuard(beforeSend?: () => void): void {
  const result: unknown = beforeSend?.();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => undefined);
    throw new Error("飞书发送守卫必须同步完成");
  }
}

export function feishuSdkRequestSignal(explicit?: AbortSignal | null): AbortSignal | undefined {
  const context = requestContext.getStore();
  checkFeishuSendGuard(context?.beforeSend);
  const scoped = context?.signal;
  return scoped && explicit && scoped !== explicit
    ? AbortSignal.any([scoped, explicit])
    : scoped ?? explicit ?? undefined;
}

export async function runFeishuSdkRequest<T>(
  request: () => Promise<T>,
  timeoutMs: number,
  timeoutError: Error,
  external?: AbortSignal,
  beforeSend?: () => void,
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
    const operation = requestContext.run({ signal: controller.signal, beforeSend }, async () => {
      controller.signal.throwIfAborted();
      checkFeishuSendGuard(beforeSend);
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
