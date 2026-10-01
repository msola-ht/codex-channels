import { dirname, join } from "node:path";

import {
  createPrivateIpcConnection,
  PrivateIpcServer,
} from "./private-ipc.mjs";

const protocolVersion = 2;
const maximumMessageBytes = 4_096;
const maximumResponseBytes = 524_288;
const requestTimeoutMs = 20_000;
const providerPattern = /^[a-z0-9][a-z0-9_-]{0,127}$/u;

export class GatewayAccountRefreshError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "GatewayAccountRefreshError";
    this.code = code;
    // 公开文案只由受控原因生成，绝不使用内部异常 message。
    this.reason = options?.reason;
  }
}

/** 未知内部异常一律折叠为固定文案，避免上游报文或凭据随 IPC 离开网关进程。 */
function refreshFailure(error) {
  if (error instanceof GatewayAccountRefreshError) {
    if (["reset_stale", "reset_busy", "reset_unavailable", "reset_unknown"].includes(error.code)) {
      return { code: error.code, message: "重置券操作未完成，请刷新核对状态" };
    }
    if (error.code === "invalid_request") {
      return { code: "invalid_request", message: error.message };
    }
    if (error.code === "refresh_failed") {
      const messages = {
        configuration: "账户配置不可用，请检查配置",
        timeout: "账户查询超时，请重试",
        authentication: "账户认证失败，请检查配置",
        "rate-limited": "账户请求受限，请稍后重试",
        upstream: "账户服务暂不可用，请稍后重试",
        network: "账户连接失败，请稍后重试",
        "invalid-response": "账户数据暂时无法读取",
        internal: "账户刷新失败",
      };
      return { code: "refresh_failed", message: Object.hasOwn(messages, error.reason) ? messages[error.reason] : "账户刷新失败" };
    }
  }
  return { code: "refresh_failed", message: "账户刷新失败" };
}

export class GatewayAccountRefreshServer {
  #closing = false;
  #closePromise;
  #operations = new Set();
  #server;
  #sockets = new Set();
  #controllers = new Set();

  constructor(configPath, refreshAccount, resetCredits) {
    if (typeof refreshAccount !== "function") {
      throw new Error("Gateway 账户刷新处理器无效");
    }
    this.#server = new PrivateIpcServer(
      gatewayAccountRefreshSocketPath(configPath),
      (socket) => this.#handleConnection(socket, refreshAccount, resetCredits),
    );
  }

  start() {
    return this.#server.start("Gateway 账户刷新 IPC 已在运行");
  }

  close() {
    this.#closePromise ??= this.#closeInternal();
    return this.#closePromise;
  }

  #handleConnection(socket, refreshAccount, resetCredits) {
    if (this.#closing) {
      socket.destroy();
      return;
    }
    const controller = new AbortController();
    this.#controllers.add(controller);
    this.#sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => { this.#sockets.delete(socket); controller.abort(); });
    socket.once("end", () => { controller.abort(); socket.destroy(); });
    socket.setTimeout(requestTimeoutMs, () => socket.destroy(new Error("账户刷新请求超时")));
    const operation = readJsonLine(socket)
      .then(parseRefreshRequest)
      .then(async (request) => {
        if (request.method !== "account/refresh") {
          if (!resetCredits) throw new GatewayAccountRefreshError("provider_not_found", "重置券操作不可用");
          const result = await cancellableRefresh(() => resetCredits(request, controller.signal), controller.signal);
          writeJsonLine(socket, { version: protocolVersion, ok: true, result });
          return;
        }
        const { provider } = request;
        const supported = await cancellableRefresh(() => refreshAccount(provider, controller.signal), controller.signal);
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
        writeJsonLine(socket, {
          version: protocolVersion,
          ok: false,
          error: refreshFailure(error),
        });
      });
    const tracked = operation.finally(() => { this.#operations.delete(tracked); this.#controllers.delete(controller); });
    this.#operations.add(tracked);
  }

  async #closeInternal() {
    this.#closing = true;
    const serverClosing = this.#server.close();
    for (const controller of this.#controllers) controller.abort();
    for (const socket of this.#sockets) socket.destroy();
    await Promise.allSettled([...this.#operations]);
    await serverClosing;
  }
}

export function gatewayAccountRefreshSocketPath(configPath) {
  return join(dirname(configPath), "runtime", "gateway-account-refresh.sock");
}

export function requestGatewayAccountRefresh(configPath, provider, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (typeof provider !== "string" || !providerPattern.test(provider)) {
    return Promise.reject(new GatewayAccountRefreshError(
      "invalid_request",
      "账户刷新 Provider 无效",
    ));
  }
  return requestGatewayAccountOperation(configPath, { method: "account/refresh", provider }, signal);
}

export function requestGatewayResetCredits(configPath, request, signal) {
  if (!["reset/list", "reset/preview", "reset/consume"].includes(request?.method)) return Promise.reject(new GatewayAccountRefreshError("invalid_request", "重置券请求无效"));
  return requestGatewayAccountOperation(configPath, request, signal);
}

function requestGatewayAccountOperation(configPath, request, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  try { parseRefreshRequest({ ...request, version: protocolVersion }); } catch (error) { return Promise.reject(error); }
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
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new GatewayAccountRefreshError(
      "gateway_unavailable",
      "Gateway 账户刷新请求超时",
    )), requestTimeoutMs);
    const abort = () => finish(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        version: protocolVersion,
        ...request,
      })}\n`);
    });
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maximumResponseBytes) {
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
      finish(undefined, request.method === "account/refresh" ? { provider: response.provider } : response.result);
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
      socket.removeListener("close", onEnd);
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
    socket.once("close", onEnd);
  });
}

function parseRefreshRequest(value) {
  if (value?.version === protocolVersion && ["reset/list", "reset/preview", "reset/consume"].includes(value.method)) {
    const field = value.method === "reset/preview" ? "creditId" : value.method === "reset/consume" ? "attemptId" : null;
    if (Object.keys(value).some(key => !["version", "method", field].includes(key))
      || (field !== null && (typeof value[field] !== "string" || !value[field] || value[field].length > 256 || /[\0\r\n]/u.test(value[field])))) {
      throw new GatewayAccountRefreshError("invalid_request", "重置券请求无效");
    }
    return value;
  }
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
  return { method: value.method, provider: value.provider };
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
  if (value.ok && Object.hasOwn(value, "result")) return { ok: true, result: value.result };
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

// Release IPC ownership even if a faulty callback does not cooperate with cancellation.
function cancellableRefresh(action, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { signal.removeEventListener("abort", abort); reject(signal.reason); return; }
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return action();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
