import { createConnection } from "node:net";

import WebSocket from "ws";

import { executableInvocation } from "./executable.mjs";
import { terminateChildProcess } from "./process-lifecycle.mjs";

const defaultTimeoutMs = 3_000;
const handshakeTimeoutMs = 2_000;

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
}) {
  if (process.platform !== "win32") {
    return initializeUnixWebSocket(socketPath, clientInfo, timeoutMs);
  }
  const { createAppServerTransport } = await import(
    "../dist/codex-client/index.js"
  );
  const transport = createAppServerTransport(
    { kind: "local-app-server", socketPath },
    {
      codexBinary,
      connectTimeoutMs: timeoutMs,
      createCodexProcessInvocation: (args) => executableInvocation(codexBinary, args),
      terminateCodexProcess: terminateChildProcess,
    },
  );
  await transport.connect();
  try {
    return await initializeJsonRpcTransport(transport, clientInfo, timeoutMs);
  } finally {
    await transport.close();
  }
}

function initializeUnixWebSocket(socketPath, clientInfo, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket("ws://localhost/", {
      perMessageDeflate: false,
      handshakeTimeout: handshakeTimeoutMs,
      createConnection: () => createConnection(socketPath),
    });
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("initialize 握手超时")), timeoutMs);
    timeout.unref();
    const finish = (error, response) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.terminate();
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise(response);
      }
    };
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { clientInfo, capabilities: initializeCapabilities },
        }),
        (error) => error && finish(error),
      );
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      let message;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (message.id !== 1) {
        return;
      }
      if (message.error) {
        finish(new Error(`initialize 被拒绝：${message.error.message || "未知错误"}`));
        return;
      }
      socket.send(
        JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }),
        (error) => finish(
          error,
          typeof message.result?.userAgent === "string"
            ? message.result.userAgent
            : undefined,
        ),
      );
    });
    socket.once("error", finish);
    socket.once("close", () => finish(new Error("WebSocket 在握手完成前关闭")));
  });
}

function initializeJsonRpcTransport(transport, clientInfo, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("initialize 握手超时")), timeoutMs);
    timeout.unref();
    const removeMessage = transport.onMessage((raw) => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (message.id !== 1) {
        return;
      }
      if (message.error) {
        finish(new Error(`initialize 被拒绝：${message.error.message || "未知错误"}`));
        return;
      }
      void transport.send(
        JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }),
      ).then(
        () => finish(
          undefined,
          typeof message.result?.userAgent === "string"
            ? message.result.userAgent
            : undefined,
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
      clearTimeout(timeout);
      removeMessage();
      removeClose();
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise(response);
      }
    };
    void transport.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo, capabilities: initializeCapabilities },
    })).catch(finish);
  });
}
