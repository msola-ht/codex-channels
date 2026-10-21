import { codexProcessInvocation } from "./owned-process.mjs";
import { terminateChildProcess } from "./process-lifecycle.mjs";

const defaultTimeoutMs = 3_000;
const unclosedTransports = new Set();

export async function closePendingAppServerReads() {
  const results = await Promise.allSettled([...unclosedTransports].map(async transport => {
    await transport.close();
    unclosedTransports.delete(transport);
  }));
  if (results.some(result => result.status === "rejected")) {
    throw new Error("App Server 读取连接清理未确认");
  }
}

const initializeCapabilities = {
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: null,
};

/**
 * 连接本机 Codex App Server 并完成 initialize 握手，返回 App Server 生成的完整
 * User-Agent。调用方应使用官方非全局客户端身份（如 `codex_app_server_daemon`）
 * 握手，避免修改 App Server 进程级 originator 或 UA 后缀；App Server 未运行或
 * 握手失败时抛出异常，由调用方决定降级。
 */
export async function readAppServerUserAgent({
  socketPath,
  codexBinary,
  clientInfo,
  timeoutMs = defaultTimeoutMs,
  signal,
}) {
  const deadline = globalThis.AbortSignal.timeout(timeoutMs);
  const cancellation = signal ? globalThis.AbortSignal.any([signal, deadline]) : deadline;
  cancellation.throwIfAborted();
  await closePendingAppServerReads();
  cancellation.throwIfAborted();
  const { createAppServerTransport } = await import(
    "../dist/codex-client/index.js"
  );
  const transport = createAppServerTransport(
    { kind: "local-app-server", socketPath },
    {
      connectTimeoutMs: timeoutMs,
      createCodexProcessInvocation: (args) => codexProcessInvocation(codexBinary, args),
      terminateCodexProcess: terminateChildProcess,
    },
  );
  let closing;
  const close = () => closing ??= transport.close().catch(error => {
    unclosedTransports.add(transport);
    throw error;
  });
  const abort = () => { void close().catch(() => undefined); };
  cancellation.addEventListener("abort", abort, { once: true });
  try {
    cancellation.throwIfAborted();
    await transport.connect();
    cancellation.throwIfAborted();
    return await initializeJsonRpcTransport(transport, clientInfo, cancellation);
  } finally {
    cancellation.removeEventListener("abort", abort);
    await close();
  }
}

function initializeJsonRpcTransport(transport, clientInfo, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const removeMessage = transport.onMessage((raw) => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message) || message.id !== 1) {
        return;
      }
      if (message.error) {
        finish(new Error("App Server initialize 被拒绝"));
        return;
      }
      if (typeof message.result?.userAgent !== "string" || message.result.userAgent.length === 0) {
        finish(new Error("App Server initialize 未返回 User-Agent"));
        return;
      }
      void transport.send(
        JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }),
      ).then(
        () => finish(
          undefined,
          message.result.userAgent,
        ),
        finish,
      );
    });
    const removeClose = transport.onClose((error) => {
      finish(error ?? new Error("App Server Transport 在握手完成前关闭"));
    });
    const finish = (error, response) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", abort);
      removeMessage();
      removeClose();
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise(response);
      }
    };
    const abort = () => finish(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    void transport.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo, capabilities: initializeCapabilities },
    })).catch(finish);
  });
}
