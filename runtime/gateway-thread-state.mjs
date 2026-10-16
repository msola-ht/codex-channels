import { dirname, join } from "node:path";

import { createPrivateIpcConnectionAsync, PrivateIpcServer } from "./private-ipc.mjs";

const version = 1;
const maximumThreads = 100;
const maximumRequestBytes = 8_192;
const maximumResponseBytes = 32_768;
const serverTimeoutMs = 2_500;
// Leave time to serialize partial results before the IPC's hard deadline.
export const threadStateReadTimeoutMs = serverTimeoutMs - 500;
const requestTimeoutMs = 3_000;
const threadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const statuses = new Set(["active", "idle", "systemError", "notLoaded"]);
const reasons = new Set(["gateway_unavailable", "provider_unavailable", "thread_unavailable", "timeout", "invalid_response"]);

function validThreadIds(threadIds) {
  return Array.isArray(threadIds) && threadIds.length <= maximumThreads
    && threadIds.every(id => typeof id === "string" && threadIdPattern.test(id))
    && new Set(threadIds).size === threadIds.length;
}

function unknownStates(threadIds, reason) {
  return threadIds.map(threadId => ({ threadId, status: "unknown", reason }));
}

function parseStates(value, threadIds) {
  if (!Array.isArray(value) || value.length !== threadIds.length) throw new Error("Thread 状态响应无效");
  return value.map((state, index) => {
    if (!state || state.threadId !== threadIds[index]) throw new Error("Thread 状态身份不匹配");
    if (state.status === "unknown" && reasons.has(state.reason)) {
      return { threadId: state.threadId, status: "unknown", reason: state.reason };
    }
    if (!statuses.has(state.status) || !Number.isSafeInteger(state.observedAtMs) || state.observedAtMs < 0) {
      throw new Error("Thread 状态响应无效");
    }
    return { threadId: state.threadId, status: state.status, observedAtMs: state.observedAtMs };
  });
}

export function gatewayThreadStateSocketPath(configPath) {
  return join(dirname(configPath), "runtime", "gateway-thread-state.sock");
}

/** Only current metadata crosses this private channel; no history or routing hints are returned. */
export class GatewayThreadStateServer {
  #server;
  #closing = false;
  #closePromise;
  #controllers = new Set();
  #sockets = new Set();
  #operations = new Set();

  constructor(configPath, readStates) {
    if (typeof readStates !== "function") throw new Error("Gateway Thread 状态处理器无效");
    this.#server = new PrivateIpcServer(
      gatewayThreadStateSocketPath(configPath),
      socket => this.#handle(socket, readStates),
      { maximumConnections: 4, connectionTimeoutMs: requestTimeoutMs + 500 },
    );
  }

  start() {
    return this.#server.start("Gateway Thread 状态 IPC 已在运行");
  }

  close() {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close() {
    this.#closing = true;
    const closing = this.#server.close();
    for (const controller of this.#controllers) controller.abort();
    for (const socket of this.#sockets) socket.destroy();
    await Promise.allSettled([...this.#operations]);
    await closing;
  }

  #handle(socket, readStates) {
    if (this.#closing) { socket.destroy(); return; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(Object.assign(new Error("Thread 状态查询超时"), { name: "TimeoutError" })), serverTimeoutMs);
    this.#controllers.add(controller);
    this.#sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => { this.#sockets.delete(socket); controller.abort(); });
    socket.once("end", () => { controller.abort(); socket.destroy(); });
    const operation = (async () => {
      let threadIds;
      try {
        const request = await readRequest(socket, controller.signal);
        if (request?.version !== version || request.method !== "thread/states"
          || Object.keys(request).some(key => !["version", "method", "threadIds"].includes(key))
          || !validThreadIds(request.threadIds)) throw new Error("Thread 状态请求无效");
        threadIds = request.threadIds;
        const states = await untilAborted(() => readStates(threadIds, controller.signal), controller.signal);
        const response = { version, states: parseStates(states, threadIds) };
        if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
      } catch {
        if (socket.destroyed) return;
        if (!threadIds) { socket.destroy(); return; }
        const reason = controller.signal.reason?.name === "TimeoutError" ? "timeout" : "thread_unavailable";
        socket.end(`${JSON.stringify({ version, states: unknownStates(threadIds, reason) })}\n`);
      }
    })();
    const tracked = operation.finally(() => {
      clearTimeout(timeout);
      this.#controllers.delete(controller);
      this.#operations.delete(tracked);
    });
    this.#operations.add(tracked);
  }
}

function untilAborted(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); })
      .then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function readRequest(socket, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let done = false;
    const finish = (value, failed) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", abort);
      socket.removeListener("data", onData);
      socket.removeListener("close", abort);
      if (failed) reject(new Error("Thread 状态请求未确认"));
      else resolve(value);
    };
    const abort = () => finish(undefined, true);
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > maximumRequestBytes) { abort(); return; }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      try { finish(JSON.parse(Buffer.concat(chunks).toString("utf8").trim()), false); }
      catch { abort(); }
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.once("close", abort);
    socket.on("data", onData);
    if (signal.aborted) abort();
  });
}

export function requestGatewayThreadStates(configPath, threadIds, signal) {
  signal?.throwIfAborted();
  if (!Array.isArray(threadIds) || threadIds.length > maximumThreads
    || !threadIds.every(id => typeof id === "string")) throw new Error("Thread 状态请求需要最多 100 个标识");
  const requested = [...threadIds];
  const valid = [...new Set(requested.filter(id => threadIdPattern.test(id)))];
  if (valid.length === 0) return Promise.resolve(unknownStates(requested, "invalid_response"));
  return requestValidThreadStates(configPath, valid, signal).then(states => {
    const byId = new Map(states.map(state => [state.threadId, state]));
    return requested.map(threadId => byId.get(threadId) ?? { threadId, status: "unknown", reason: "invalid_response" });
  });
}

function requestValidThreadStates(configPath, threadIds, signal) {
  return new Promise((resolve, reject) => {
    let socket;
    let done = false;
    let bytes = 0;
    const chunks = [];
    const controller = new AbortController();
    const finish = (states, cancelled = false) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      controller.abort();
      socket?.destroy();
      if (cancelled) reject(signal.reason);
      else resolve(states);
    };
    const fail = reason => finish(unknownStates(threadIds, reason));
    const abort = () => finish(undefined, true);
    const timeout = setTimeout(() => fail("timeout"), requestTimeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    void createPrivateIpcConnectionAsync(gatewayThreadStateSocketPath(configPath), { signal: controller.signal }).then(connection => {
      socket = connection;
      socket.on("error", () => fail("gateway_unavailable"));
      if (done) { socket.destroy(); return; }
      socket.once("connect", () => socket.write(`${JSON.stringify({ version, method: "thread/states", threadIds })}\n`));
      socket.once("end", () => fail("invalid_response"));
      socket.once("close", () => fail("gateway_unavailable"));
      socket.on("data", chunk => {
        if (done) return;
        bytes += chunk.length;
        if (bytes > maximumResponseBytes) { fail("invalid_response"); return; }
        chunks.push(chunk);
        if (!chunk.includes(10)) return;
        try {
          const response = JSON.parse(Buffer.concat(chunks).toString("utf8").trim());
          if (response?.version !== version) throw new Error("Thread 状态响应版本无效");
          finish(parseStates(response.states, threadIds));
        } catch { fail("invalid_response"); }
      });
    }).catch(() => fail("gateway_unavailable"));
    if (signal?.aborted) abort();
  });
}
