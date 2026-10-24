import { Worker } from "node:worker_threads";

const shutdownTimeoutMs = 5_000;
const maximumRegistrationTimeoutMs = 300_000;
const workerErrorCodes = new Set(["sdk-unavailable", "registration-failed", "invalid-result"]);
let ownedWorker;

/** Run the connector in an owned worker, keeping SDK output and requests isolated. */
export function registerQqApplication({
  signal,
  onQRCodeReady,
  onQrExpired,
  timeoutMs = maximumRegistrationTimeoutMs,
} = {}) {
  if ((signal !== undefined && !(signal instanceof globalThis.AbortSignal))
    || typeof onQRCodeReady !== "function"
    || (onQrExpired !== undefined && typeof onQrExpired !== "function")
    || !Number.isInteger(timeoutMs) || timeoutMs <= 0
    || timeoutMs > maximumRegistrationTimeoutMs) {
    return Promise.reject(registrationError("invalid-options"));
  }
  if (signal?.aborted) return Promise.reject(registrationError("abort"));
  if (ownedWorker) return Promise.reject(registrationError("shutdown-failed"));

  return new Promise((resolve, reject) => {
    let worker;
    let registrationTimer;
    let settled = false;
    let exited;
    const startedAt = Date.now();
    const settle = async (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(registrationTimer);
      signal?.removeEventListener("abort", onAbort);
      if (worker) {
        let shutdownTimer;
        try {
          // Best-effort SDK cancellation precedes the owned worker shutdown.
          try { worker.postMessage("abort"); } catch { /* Worker may already have exited. */ }
          // Termination also stops SDK HTTPS requests that do not accept a signal.
          // Success requires both terminate() and the worker's actual exit event.
          await Promise.race([
            Promise.all([worker.terminate(), exited]),
            new Promise((_, rejectShutdown) => {
              shutdownTimer = setTimeout(
                () => rejectShutdown(registrationError("shutdown-failed")),
                shutdownTimeoutMs,
              );
            }),
          ]);
        } catch {
          error = registrationError("shutdown-failed");
        } finally {
          clearTimeout(shutdownTimer);
        }
      }
      // Cancellation may arrive while a successful worker is still shutting down.
      if (!error && signal?.aborted) error = registrationError("abort");
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => { void settle(registrationError("abort")); };
    // Register cancellation before acquiring the worker and recheck the signal.
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      worker = new Worker(new URL("./qq-registration-worker.mjs", import.meta.url), {
        // The SDK must never inherit the terminal, even on unexpected failures.
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 },
        execArgv: process.execArgv.filter((argument, index, arguments_) =>
          !argument.startsWith("--input-type")
          && arguments_[index - 1] !== "--input-type"),
      });
    } catch {
      void settle(registrationError("worker-start-failed"));
      return;
    }
    worker.stdout.resume();
    worker.stderr.resume();
    ownedWorker = worker;
    exited = new Promise((resolveExit) => worker.once("exit", code => {
      if (ownedWorker === worker) ownedWorker = undefined;
      resolveExit(code);
    }));
    worker.on("error", () => { void settle(registrationError("worker-failed")); });
    worker.on("exit", () => { void settle(registrationError("worker-exited")); });
    worker.on("messageerror", () => { void settle(registrationError("invalid-result")); });
    worker.on("message", (message) => {
      if (settled) return;
      if (Date.now() - startedAt >= timeoutMs) {
        void settle(registrationError("timeout"));
        return;
      }
      try {
        if (!isPlainObject(message)) throw registrationError("invalid-result");
        switch (message.type) {
          case "qr": {
            if (!isQrUrl(message.value)) throw registrationError("invalid-result");
            onQRCodeReady(message.value);
            break;
          }
          case "expired": onQrExpired?.(); break;
          case "result": {
            if (!isCredentials(message.value)) throw registrationError("invalid-result");
            void settle(undefined, message.value);
            break;
          }
          case "error": {
            const code = workerErrorCodes.has(message.code) ? message.code : "registration-failed";
            void settle(registrationError(code));
            break;
          }
          default: throw registrationError("invalid-result");
        }
      } catch {
        void settle(registrationError("invalid-result"));
      }
    });
    registrationTimer = setTimeout(
      () => { void settle(registrationError("timeout")); },
      Math.max(0, timeoutMs - (Date.now() - startedAt)),
    );
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object"
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function isString(value, maximumLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength
    && value.trim() === value && !/[\s\p{Cc}]/u.test(value);
}

function isCredentials(value) {
  return isPlainObject(value) && Object.keys(value).length === 3
    && isString(value.appId, 256) && isString(value.appSecret, 4_096)
    && isString(value.userOpenid, 256);
}

function isQrUrl(value) {
  if (!isString(value, 4_096)) return false;
  const url = new URL(value);
  return url.origin === "https://q.qq.com" && !url.username && !url.password && !url.hash
    && url.pathname === "/qqbot/openclaw/connect.html"
    && isString(url.searchParams.get("task_id"), 1_024);
}

function registrationError(code) {
  const descriptions = {
    abort: "QQ 扫码已取消",
    timeout: "QQ 扫码等待超时，请重新接入",
    "invalid-result": "QQ 扫码结果不受支持，需要单个机器人及完整的扫码用户 OpenID；未保存配置",
    "shutdown-failed": "QQ 扫码任务关闭未确认，请退出当前向导后重新接入",
    "sdk-unavailable": "QQ 扫码组件不可用，请检查当前安装的依赖",
  };
  const error = new Error(descriptions[code] ?? "QQ 扫码接入未完成，请检查到 q.qq.com 的直连网络后重试");
  error.code = code;
  return error;
}
