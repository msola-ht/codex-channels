import { dirname, join } from "node:path";

import {
  createPrivateIpcConnection,
  PrivateIpcServer,
} from "./private-ipc.mjs";

const protocolVersion = 1;
const maximumMessageBytes = 4_096;
const requestTimeoutMs = 20_000;
const providerPattern = /^[a-z0-9][a-z0-9_-]{0,127}$/u;

export class GatewayAccountRefreshError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "GatewayAccountRefreshError";
    this.code = code;
  }
}

export class GatewayAccountRefreshServer {
  #closing = false;
  #closePromise;
  #operations = new Set();
  #server;
  #sockets = new Set();

  constructor(configPath, refreshAccount) {
    if (typeof refreshAccount !== "function") {
      throw new Error("Gateway 账户刷新处理器无效");
    }
    this.#server = new PrivateIpcServer(
      gatewayAccountRefreshSocketPath(configPath),
      (socket) => this.#handleConnection(socket, refreshAccount),
    );
  }

  start() {
    return this.#server.start("Gateway 账户刷新 IPC 已在运行");
  }

  close() {
    this.#closePromise ??= this.#closeInternal();
    return this.#closePromise;
  }

  #handleConnection(socket, refreshAccount) {
    if (this.#closing) {
      socket.destroy();
      return;
    }
    this.#sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => this.#sockets.delete(socket));
    socket.setTimeout(requestTimeoutMs, () => socket.destroy(new Error("账户刷新请求超时")));
    const operation = readJsonLine(socket)
      .then(parseRefreshRequest)
      .then(async ({ provider }) => {
        const supported = await refreshAccount(provider);
        if (!supported) {
          writeJsonLine(socket, {
            version: protocolVersion,
            ok: false,
            error: { code: "provider_not_found", message: "账户来源不存在或不支持刷新" },
          });
          return;
        }
        writeJsonLine(socket, { version: protocolVersion, ok: true, provider });
      })
      .catch((error) => {
        const invalidRequest = error instanceof GatewayAccountRefreshError
          && error.code === "invalid_request";
        writeJsonLine(socket, {
          version: protocolVersion,
          ok: false,
          error: {
            code: invalidRequest ? "invalid_request" : "refresh_failed",
            message: invalidRequest ? error.message : "账户刷新失败",
          },
        });
      });
    const tracked = operation.finally(() => this.#operations.delete(tracked));
    this.#operations.add(tracked);
  }

  async #closeInternal() {
    this.#closing = true;
    const serverClosing = this.#server.close();
    await Promise.allSettled([...this.#operations]);
    for (const socket of this.#sockets) socket.destroy();
    await serverClosing;
  }
}

export function gatewayAccountRefreshSocketPath(configPath) {
  return join(dirname(configPath), "runtime", "gateway-account-refresh.sock");
}

export function requestGatewayAccountRefresh(configPath, provider) {
  if (typeof provider !== "string" || !providerPattern.test(provider)) {
    return Promise.reject(new GatewayAccountRefreshError(
      "invalid_request",
      "账户刷新 Provider 无效",
    ));
  }
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = createPrivateIpcConnection(gatewayAccountRefreshSocketPath(configPath));
    } catch (error) {
      reject(new GatewayAccountRefreshError(
        "gateway_unavailable",
        "Gateway 未运行或账户刷新接口不可用",
        { cause: error },
      ));
      return;
    }
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new GatewayAccountRefreshError(
      "gateway_unavailable",
      "Gateway 账户刷新请求超时",
    )), requestTimeoutMs);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        version: protocolVersion,
        method: "account/refresh",
        provider,
      })}\n`);
    });
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maximumMessageBytes) {
        finish(new GatewayAccountRefreshError(
          "invalid_response",
          "Gateway 账户刷新响应过大",
        ));
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => {
      let response;
      try {
        response = parseRefreshResponse(Buffer.concat(chunks).toString("utf8"));
      } catch (error) {
        finish(error);
        return;
      }
      if (!response.ok) {
        finish(new GatewayAccountRefreshError(response.error.code, response.error.message));
        return;
      }
      finish(undefined, { provider: response.provider });
    });
    socket.once("error", (error) => finish(new GatewayAccountRefreshError(
      "gateway_unavailable",
      "Gateway 未运行或账户刷新接口不可用",
      { cause: error },
    )));
    socket.once("close", () => finish(new GatewayAccountRefreshError(
      "gateway_unavailable",
      "Gateway 账户刷新连接已关闭",
    )));
  });
}

function readJsonLine(socket) {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("end", onEnd);
      if (error) reject(error);
      else resolve(value);
    };
    const onError = () => finish(new GatewayAccountRefreshError(
      "invalid_request",
      "账户刷新请求连接异常",
    ));
    const onEnd = () => finish(new GatewayAccountRefreshError(
      "invalid_request",
      "账户刷新请求不完整",
    ));
    const onData = (chunk) => {
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(0x0a);
      if (newline < 0) {
        if (received.length > maximumMessageBytes) {
          finish(new GatewayAccountRefreshError("invalid_request", "账户刷新请求过大"));
        }
        return;
      }
      if (
        newline > maximumMessageBytes
        || received.subarray(newline + 1).toString("utf8").trim() !== ""
      ) {
        finish(new GatewayAccountRefreshError("invalid_request", "账户刷新请求格式无效"));
        return;
      }
      try {
        finish(undefined, JSON.parse(received.subarray(0, newline).toString("utf8")));
      } catch {
        finish(new GatewayAccountRefreshError("invalid_request", "账户刷新请求不是有效 JSON"));
      }
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

function parseRefreshRequest(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || value.version !== protocolVersion
    || value.method !== "account/refresh"
    || typeof value.provider !== "string"
    || !providerPattern.test(value.provider)
    || Object.keys(value).some((key) => !["version", "method", "provider"].includes(key))
  ) {
    throw new GatewayAccountRefreshError("invalid_request", "账户刷新请求格式无效");
  }
  return { provider: value.provider };
}

function parseRefreshResponse(content) {
  let value;
  try {
    value = JSON.parse(content.trim());
  } catch {
    throw new GatewayAccountRefreshError("invalid_response", "Gateway 账户刷新响应无效");
  }
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || value.version !== protocolVersion
    || typeof value.ok !== "boolean"
  ) {
    throw new GatewayAccountRefreshError("invalid_response", "Gateway 账户刷新响应无效");
  }
  if (value.ok) {
    if (typeof value.provider !== "string" || !providerPattern.test(value.provider)) {
      throw new GatewayAccountRefreshError("invalid_response", "Gateway 账户刷新响应无效");
    }
    return { ok: true, provider: value.provider };
  }
  if (
    value.error === null
    || typeof value.error !== "object"
    || typeof value.error.code !== "string"
    || typeof value.error.message !== "string"
  ) {
    throw new GatewayAccountRefreshError("invalid_response", "Gateway 账户刷新响应无效");
  }
  return {
    ok: false,
    error: { code: value.error.code, message: value.error.message },
  };
}

function writeJsonLine(socket, value) {
  if (socket.destroyed) return;
  socket.end(`${JSON.stringify(value)}\n`);
}
