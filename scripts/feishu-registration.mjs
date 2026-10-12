import { Worker } from "node:worker_threads";

/** SDK registration has no HTTP injection point; isolate its shared transport. */
export function registerFeishuApplication({
  source,
  signal,
  addons,
  onQRCodeReady,
  onStatusChange,
}) {
  if (signal?.aborted) return Promise.reject(registrationError("abort"));
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./feishu-registration-worker.mjs", import.meta.url),
      {
        workerData: { source, addons },
        // CLI callers may use --input-type; it is incompatible with a file worker.
        execArgv: process.execArgv.filter((argument, index, arguments_) =>
          !argument.startsWith("--input-type")
          && arguments_[index - 1] !== "--input-type"),
      },
    );
    let settled = false;
    const settle = async (error, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      // Wait for owned resources to close, including begin/poll still in flight.
      try {
        await worker.terminate();
      } catch {
        error = registrationError("registration-failed");
      }
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => {
      if (settled) return;
      worker.postMessage("abort");
      void settle(registrationError("abort"));
    };
    worker.on("message", (message) => {
      if (settled) return;
      try {
        switch (message.type) {
          case "qr": onQRCodeReady(message.value); break;
          case "status": onStatusChange?.(message.value); break;
          case "result": void settle(undefined, message.value); break;
          case "error": void settle(registrationError(message.code)); break;
          default: void settle(registrationError("registration-failed"));
        }
      } catch {
        void settle(registrationError("registration-failed"));
      }
    });
    worker.on("error", () => { void settle(registrationError("registration-failed")); });
    worker.on("exit", () => {
      if (!settled) void settle(registrationError("registration-failed"));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function registrationError(code) {
  const error = new Error("飞书扫码注册未完成");
  error.code = code;
  return error;
}
