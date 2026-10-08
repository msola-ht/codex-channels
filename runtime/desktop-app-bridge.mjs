import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";

import WebSocket, { WebSocketServer } from "ws";

import { executableInvocation } from "./executable.mjs";
import { inspectAppServerUnixSocket } from "./app-server-unix-socket.mjs";
import {
  acquireAppServerProviderLease,
} from "./app-server-supervisor.mjs";
import {
  readPrivateFileSync,
  writePrivateFileAtomicSync,
} from "./private-file.mjs";
import { terminateChildProcess } from "./process-lifecycle.mjs";

const bridgeHost = "127.0.0.1";
const bridgePath = "/codex-app-server";
const bridgeTokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const providerIdPattern = /^[A-Za-z0-9_-]{1,64}$/u;
const maximumConnections = 4;
const maximumPayloadBytes = 128 * 1024 * 1024;
const maximumQueuedMessages = 128;
const forwardingTimeoutMs = 5_000;
const serviceRestartCloseCode = 1012;
const unsupportedDataCloseCode = 1003;
const upstreamFailureCloseCode = 1011;

export function desktopAppBridgeTokenPath(dataDir) {
  return join(dataDir, "credentials", "desktop-app-bridge-token");
}

export function loadOrCreateDesktopAppBridgeToken(dataDir) {
  const path = desktopAppBridgeTokenPath(dataDir);
  try {
    return readDesktopAppBridgeToken(dataDir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const token = randomBytes(32).toString("base64url");
    writePrivateFileAtomicSync(path, token);
    return token;
  }
}

export function readDesktopAppBridgeToken(dataDir) {
  const token = readPrivateFileSync(desktopAppBridgeTokenPath(dataDir), 128);
  if (!bridgeTokenPattern.test(token)) {
    throw new Error("Codex Desktop App 桥令牌文件格式无效");
  }
  return token;
}

export async function startDesktopAppBridge({
  port,
  socketPath,
  primaryProvider,
  providerSocketPaths = {},
  codexBinary,
  dataDir,
  token,
  createTransport,
  acquireLease = (provider) => acquireAppServerProviderLease(socketPath, provider),
  onEvent = () => undefined,
}) {
  if (primaryProvider !== "openai") {
    throw new Error("Codex Desktop App 共享只支持 OpenAI 主 Provider");
  }
  const socketPaths = new Map([[primaryProvider, socketPath]]);
  for (const [provider, targetSocketPath] of Object.entries(providerSocketPaths)) {
    if (!providerIdPattern.test(provider)
      || typeof targetSocketPath !== "string" || targetSocketPath.length === 0
      || targetSocketPath.includes("\0")
      || (provider === primaryProvider && targetSocketPath !== socketPath)) {
      throw new Error("Codex Desktop App Provider Socket 映射无效");
    }
    socketPaths.set(provider, targetSocketPath);
  }
  const bridgeToken = token ?? loadOrCreateDesktopAppBridgeToken(dataDir);
  let transportFactory = createTransport;
  if (transportFactory === undefined) {
    const { createAppServerTransport } = await import(
      "../dist/codex-client/index.js"
    );
    transportFactory = (provider) => createAppServerTransport(
      { kind: "local-app-server", socketPath: socketPaths.get(provider) },
      {
        codexBinary,
        createCodexProcessInvocation: (args) =>
          executableInvocation(codexBinary, args),
        terminateCodexProcess: terminateChildProcess,
      },
    );
  }
  const bridge = new DesktopAppBridge({
    port,
    token: bridgeToken,
    primaryProvider,
    providers: [...socketPaths.keys()],
    createTransport: transportFactory,
    acquireLease,
    onEvent,
  });
  await bridge.start();
  return bridge;
}

export async function proxyDesktopAppStdioToUnixSocket({
  socketPath,
  input = process.stdin,
  output = process.stdout,
  connectTimeoutMs = 10_000,
}) {
  if (typeof socketPath !== "string" || !socketPath || socketPath.includes("\0")) {
    throw new Error("Codex Desktop App Proxy 缺少有效的 Unix Socket 路径");
  }
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs < 1) {
    throw new Error("Codex Desktop App Proxy 连接超时必须是正整数");
  }
  const endpoint = inspectAppServerUnixSocket(socketPath);
  if (!endpoint?.available) {
    throw new Error("Codex Desktop App Proxy 的 Unix Socket 不可用");
  }
  const socket = new WebSocket("ws://localhost/", {
    perMessageDeflate: false,
    handshakeTimeout: connectTimeoutMs,
    maxPayload: maximumPayloadBytes,
    createConnection: () => createConnection(endpoint.path),
  });
  await waitForWebSocketOpen(socket, connectTimeoutMs);

  let closeTimer;
  let settled = false;
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolvePromise, rejectPromise) => {
    resolveCompletion = resolvePromise;
    rejectCompletion = rejectPromise;
  });
  const fail = (error) => {
    if (settled) return;
    settled = true;
    rejectCompletion(error instanceof Error ? error : new Error(String(error)));
    socket.terminate();
  };
  const complete = () => {
    if (settled) return;
    settled = true;
    resolveCompletion();
  };
  const upstreamQueue = forwardingQueue((line) => sendText(socket, line), fail);
  const downstreamQueue = forwardingQueue((message) => writeLine(output, message), fail);

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      fail(new Error("Codex App Server 返回了不支持的二进制 WebSocket 帧"));
      return;
    }
    downstreamQueue.push(decodeTextMessage(data));
  });
  socket.once("error", fail);
  socket.once("close", complete);
  output.on("error", fail);
  const removeInput = readDesktopLines(input, (line) => upstreamQueue.push(line), fail, () => {
    void upstreamQueue.drain().then(() => {
      if (settled) return;
      if (socket.readyState !== WebSocket.OPEN) {
        complete();
        return;
      }
      socket.close(1000, "Desktop stdio closed");
      closeTimer = setTimeout(() => socket.terminate(), 2_000);
      closeTimer.unref();
    }).catch(fail);
  });

  try {
    await completion;
    upstreamQueue.close();
    await downstreamQueue.drain();
  } finally {
    upstreamQueue.close();
    downstreamQueue.close();
    if (closeTimer !== undefined) clearTimeout(closeTimer);
    removeInput();
    output.off("error", fail);
    socket.removeAllListeners();
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
}

export class DesktopAppBridge {
  #port;
  #token;
  #primaryProvider;
  #providers;
  #createTransport;
  #acquireLease;
  #onEvent;
  #server;
  #webSocketServer;
  #pending = new Set();
  #sessions = new Set();
  #started = false;
  #closing = false;
  #closePromise;

  constructor({ port, token, primaryProvider = "openai", providers = [primaryProvider], createTransport, acquireLease, onEvent = () => undefined }) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("Codex Desktop App 桥端口必须是 1..65535 的整数");
    }
    if (!bridgeTokenPattern.test(token)) {
      throw new Error("Codex Desktop App 桥令牌格式无效");
    }
    if (typeof createTransport !== "function" || typeof acquireLease !== "function") {
      throw new TypeError("Codex Desktop App 桥缺少 Transport 或租约工厂");
    }
    this.#port = port;
    this.#token = token;
    if (primaryProvider !== "openai" || !Array.isArray(providers)
      || !providers.includes(primaryProvider)
      || providers.some(provider => typeof provider !== "string" || !providerIdPattern.test(provider))) {
      throw new Error("Codex Desktop App Provider 列表无效");
    }
    this.#primaryProvider = primaryProvider;
    this.#providers = new Set(providers);
    this.#createTransport = createTransport;
    this.#acquireLease = acquireLease;
    this.#onEvent = onEvent;
    this.#server = createServer((_request, response) => {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not Found\n");
    });
    this.#webSocketServer = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: maximumPayloadBytes,
    });
    this.#server.on("upgrade", (request, socket, head) => {
      this.#handleUpgrade(request, socket, head);
    });
  }

  async start() {
    if (this.#started) return;
    if (this.#closing) throw new Error("Codex Desktop App 桥正在关闭");
    await new Promise((resolvePromise, rejectPromise) => {
      const onError = (error) => {
        this.#server.off("listening", onListening);
        rejectPromise(error);
      };
      const onListening = () => {
        this.#server.off("error", onError);
        resolvePromise();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.#port, bridgeHost);
    });
    this.#started = true;
    this.#onEvent({ type: "started", port: this.#port });
  }

  address() {
    return this.#started && !this.#closing
      ? { host: bridgeHost, port: this.#port, path: bridgePath }
      : undefined;
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  #handleUpgrade(request, socket, head) {
    socket.on("error", () => undefined);
    if (this.#closing || !this.#started) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    if (request.headers["sec-websocket-protocol"] !== undefined) {
      rejectUpgrade(socket, 400, "Bad Request");
      this.#onEvent({ type: "rejected", reason: "protocol" });
      return;
    }
    const selection = authenticatedProvider(request.url, this.#token, this.#primaryProvider);
    if (selection === undefined) {
      rejectUpgrade(socket, 401, "Unauthorized");
      this.#onEvent({ type: "rejected", reason: "authentication" });
      return;
    }
    if (!this.#providers.has(selection.provider)) {
      rejectUpgrade(socket, 400, "Bad Request");
      this.#onEvent({ type: "rejected", reason: "provider" });
      return;
    }
    if (this.#pending.size + this.#sessions.size >= maximumConnections) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      this.#onEvent({ type: "rejected", reason: "capacity" });
      return;
    }
    const attempt = {
      socket,
      provider: selection.provider,
      transport: undefined,
      lease: undefined,
      transportClosed: false,
      leaseClosed: false,
      task: undefined,
      abortTask: undefined,
    };
    this.#pending.add(attempt);
    attempt.task = this.#acceptUpgrade(attempt, request, head);
    void attempt.task.catch(() => this.#onEvent({ type: "connection-error", stage: "upstream" }));
  }

  async #acceptUpgrade(attempt, request, head) {
    let handedOff = false;
    try {
      attempt.lease = await this.#acquireLease(attempt.provider);
      if (this.#closing || attempt.socket.destroyed) return;
      attempt.transport = await this.#createTransport(attempt.provider);
      await attempt.transport.connect();
      if (this.#closing || attempt.socket.destroyed) return;
      this.#webSocketServer.handleUpgrade(
        request,
        attempt.socket,
        head,
        (webSocket) => {
          handedOff = true;
          this.#startSession(webSocket, attempt.transport, attempt.lease);
        },
      );
    } catch {
      if (!attempt.socket.destroyed) {
        rejectUpgrade(attempt.socket, 502, "Bad Gateway");
      }
      this.#onEvent({ type: "connection-error", stage: "upstream" });
    } finally {
      this.#pending.delete(attempt);
      if (!handedOff) {
        await closeAttempt(attempt);
      }
    }
  }

  #startSession(webSocket, transport, lease) {
    const session = {
      webSocket,
      transport,
      lease,
      closePromise: undefined,
      close: undefined,
      removeTransportMessage: undefined,
      removeTransportClose: undefined,
    };
    this.#sessions.add(session);
    this.#onEvent({ type: "connected", connections: this.#sessions.size });
    const closeSession = (code, reason, terminate = false) => {
      if (session.closePromise) return session.closePromise;
      upstreamQueue.close();
      downstreamQueue.close();
      session.closePromise = (async () => {
        session.removeTransportMessage?.();
        session.removeTransportClose?.();
        await closeWebSocket(webSocket, code, reason, terminate ? 250 : 0);
        try {
          await transport.close();
        } finally {
          try { await lease.close(); }
          finally {
            this.#sessions.delete(session);
            this.#onEvent({ type: "disconnected", connections: this.#sessions.size });
          }
        }
      })();
      void session.closePromise.catch(() => this.#onEvent({ type: "connection-error", stage: "upstream" }));
      return session.closePromise;
    };
    const forwardingFailed = (stage) => {
      this.#onEvent({ type: "connection-error", stage });
      void closeSession(1013, "Desktop forwarding unavailable", true);
    };
    const upstreamQueue = forwardingQueue((message) => transport.send(message), () => forwardingFailed("upstream-send"));
    const downstreamQueue = forwardingQueue((message) => sendText(webSocket, message), () => forwardingFailed("downstream-send"));
    session.close = closeSession;
    session.removeTransportMessage = transport.onMessage((message) => {
      downstreamQueue.push(message);
    });
    session.removeTransportClose = transport.onClose(() => {
      void closeSession(upstreamFailureCloseCode, "Upstream connection closed");
    });
    webSocket.on("message", (data, isBinary) => {
      if (isBinary) {
        void closeSession(unsupportedDataCloseCode, "Binary frames are not supported");
        return;
      }
      const message = decodeTextMessage(data);
      upstreamQueue.push(message);
    });
    webSocket.once("error", () => {
      void closeSession(upstreamFailureCloseCode, "Desktop connection failed", true);
    });
    webSocket.once("close", () => {
      void closeSession(1000, "Desktop connection closed");
    });
  }

  async #close() {
    for (const attempt of this.#pending) {
      attempt.socket.destroy();
      attempt.abortTask = closeAttempt(attempt);
      void attempt.abortTask;
    }
    const serverClosed = !this.#started
      ? Promise.resolve()
      : new Promise((resolvePromise) => this.#server.close(() => resolvePromise()));
    const sessionCloses = [...this.#sessions].map((session) =>
      session.close(serviceRestartCloseCode, "Service restarting", true));
    this.#webSocketServer.close();
    const cleanup = Promise.allSettled([
      serverClosed,
      ...sessionCloses,
      ...[...this.#pending].map((attempt) => attempt.task),
      ...[...this.#pending].map((attempt) => attempt.abortTask),
    ]);
    let timer;
    try {
      const results = await Promise.race([
        cleanup,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Desktop 桥关闭超时，资源清理尚未完成")), forwardingTimeoutMs);
          timer.unref();
        }),
      ]);
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, "Desktop 桥资源清理失败");
    } finally {
      clearTimeout(timer);
    }
    this.#sessions.clear();
    this.#pending.clear();
    this.#started = false;
    this.#onEvent({ type: "stopped" });
  }
}

// Count the in-flight message as well as pending messages. Closing clears retained
// payloads and wakes the worker even when a transport callback never settles.
function forwardingQueue(send, onFailure) {
  let pending = [];
  let bytes = 0;
  let count = 0;
  let closed = false;
  let task;
  let failure;
  let cancel;
  const close = () => { closed = true; pending = []; cancel?.(); };
  const fail = (error) => {
    if (closed) return;
    failure = error;
    close();
    onFailure(error);
  };
  async function run() {
    try {
      while (!closed && pending.length > 0) {
        const message = pending.shift();
        let timer;
        try {
          await new Promise((resolve, reject) => {
            cancel = resolve;
            timer = setTimeout(() => reject(new Error("Desktop 消息转发超时")), forwardingTimeoutMs);
            timer.unref();
            void Promise.resolve().then(() => { if (!closed) return send(message); }).then(resolve, reject);
          });
        } catch (error) {
          fail(error);
        } finally {
          clearTimeout(timer);
          cancel = undefined;
          bytes -= Buffer.byteLength(message);
          count--;
        }
      }
    } finally {
      // Release ownership in the same microtask that observes an empty queue.
      // A later push must start a new worker, even before this promise settles.
      task = undefined;
    }
  }
  return {
    push(message) {
      if (closed) return;
      const size = Buffer.byteLength(message);
      if (count >= maximumQueuedMessages || bytes + size > maximumPayloadBytes) {
        fail(new Error("Desktop 消息转发队列超出容量"));
        return;
      }
      pending.push(message);
      count++;
      bytes += size;
      task ??= Promise.resolve().then(run);
    },
    close,
    async drain() { while (task) await task; if (failure) throw failure; },
  };
}

function readDesktopLines(input, onLine, onFailure, onEnd) {
  let chunks = [];
  let size = 0;
  let stopped = false;
  const fail = (error) => { stopped = true; chunks = []; onFailure(error); };
  const flush = () => {
    const line = Buffer.concat(chunks, size).toString("utf8").replace(/\r$/u, "");
    chunks = [];
    size = 0;
    onLine(line);
  };
  const data = (value) => {
    if (stopped) return;
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < buffer.length && !stopped) {
      const newline = buffer.indexOf(0x0a, offset);
      const end = newline === -1 ? buffer.length : newline;
      const part = buffer.subarray(offset, end);
      if (size + part.length > maximumPayloadBytes) {
        fail(new Error("Desktop JSONL 消息超出容量"));
        return;
      }
      chunks.push(part);
      size += part.length;
      if (newline !== -1) flush();
      offset = end + 1;
    }
  };
  const end = () => {
    if (stopped) return;
    if (size > 0) flush();
    stopped = true;
    onEnd();
  };
  input.on("error", fail);
  input.on("data", data);
  input.once("end", end);
  input.once("close", end);
  return () => {
    stopped = true;
    chunks = [];
    input.off("data", data);
    input.off("end", end);
    input.off("close", end);
    input.off("error", fail);
  };
}

function authenticatedProvider(requestUrl, expectedToken, primaryProvider) {
  let parsed;
  try {
    parsed = new URL(requestUrl ?? "", `http://${bridgeHost}`);
  } catch {
    return undefined;
  }
  if (parsed.pathname !== bridgePath) return undefined;
  const tokens = parsed.searchParams.getAll("token");
  const providers = parsed.searchParams.getAll("provider");
  if (
    [...parsed.searchParams.keys()].some(key => key !== "token" && key !== "provider")
    || tokens.length !== 1
    || providers.length > 1
    || (providers.length === 1 && !providerIdPattern.test(providers[0]))
    || !bridgeTokenPattern.test(tokens[0])
  ) return undefined;
  const actual = Buffer.from(tokens[0], "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? { provider: providers[0] ?? primaryProvider }
    : undefined;
}

function rejectUpgrade(socket, status, message) {
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function sendText(webSocket, message) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (webSocket.readyState !== WebSocket.OPEN) {
      rejectPromise(new Error("Desktop WebSocket 已关闭"));
      return;
    }
    webSocket.send(message, (error) => error ? rejectPromise(error) : resolvePromise());
  });
}

function writeLine(output, message) {
  return new Promise((resolvePromise, rejectPromise) => {
    output.write(`${message}\n`, (error) =>
      error ? rejectPromise(error) : resolvePromise());
  });
}

function waitForWebSocketOpen(socket, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      cleanup();
      socket.terminate();
      rejectPromise(new Error(`连接 Codex Unix WebSocket 超时：${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolvePromise();
    };
    const onError = (error) => {
      cleanup();
      rejectPromise(error);
    };
    const onClose = () => {
      cleanup();
      rejectPromise(new Error("Codex Unix WebSocket 在握手完成前关闭"));
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function closeWebSocket(webSocket, code, reason, terminateAfterMs) {
  if (webSocket.readyState === WebSocket.CLOSED) return Promise.resolve();
  if (webSocket.readyState !== WebSocket.OPEN) {
    webSocket.terminate();
    return Promise.resolve();
  }
  webSocket.close(code, reason);
  if (terminateAfterMs === 0) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timeout = setTimeout(() => {
      if (webSocket.readyState !== WebSocket.CLOSED) webSocket.terminate();
      resolvePromise();
    }, terminateAfterMs);
    timeout.unref();
    webSocket.once("close", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
  });
}

function decodeTextMessage(data) {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
}

async function closeAttempt(attempt) {
  attempt.socket.destroy();
  try {
    if (attempt.transport !== undefined && !attempt.transportClosed) {
      attempt.transportClosed = true;
      await attempt.transport.close();
    }
  } finally {
    if (attempt.lease !== undefined && !attempt.leaseClosed) {
      attempt.leaseClosed = true;
      await attempt.lease.close();
    }
  }
}
