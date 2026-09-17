import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";

import WebSocket, { WebSocketServer } from "ws";

import { executableInvocation } from "./executable.mjs";
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
const maximumConnections = 4;
const maximumPayloadBytes = 128 * 1024 * 1024;
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
  codexBinary,
  dataDir,
  token,
  createTransport,
  acquireLease = () => acquireAppServerProviderLease(socketPath, primaryProvider),
  onEvent = () => undefined,
}) {
  if (primaryProvider !== "openai") {
    throw new Error("Codex Desktop App 共享只支持 OpenAI 主 Provider");
  }
  const bridgeToken = token ?? loadOrCreateDesktopAppBridgeToken(dataDir);
  let transportFactory = createTransport;
  if (transportFactory === undefined) {
    const { createAppServerTransport } = await import(
      "../dist/codex-client/index.js"
    );
    transportFactory = () => createAppServerTransport(
      { kind: "local-app-server", socketPath },
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
  const socket = new WebSocket("ws://localhost/", {
    perMessageDeflate: false,
    handshakeTimeout: connectTimeoutMs,
    maxPayload: maximumPayloadBytes,
    createConnection: () => createConnection(socketPath),
  });
  await waitForWebSocketOpen(socket, connectTimeoutMs);

  const lines = createInterface({ input, crlfDelay: Infinity });
  let upstreamQueue = Promise.resolve();
  let downstreamQueue = Promise.resolve();
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

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      fail(new Error("Codex App Server 返回了不支持的二进制 WebSocket 帧"));
      return;
    }
    downstreamQueue = downstreamQueue.then(() =>
      writeLine(output, decodeTextMessage(data))
    );
    void downstreamQueue.catch(fail);
  });
  socket.once("error", fail);
  socket.once("close", complete);
  lines.on("line", (line) => {
    upstreamQueue = upstreamQueue.then(() => sendText(socket, line));
    void upstreamQueue.catch(fail);
  });
  lines.once("close", () => {
    void upstreamQueue.then(() => {
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
    await upstreamQueue;
    await downstreamQueue;
  } finally {
    if (closeTimer !== undefined) clearTimeout(closeTimer);
    lines.close();
    socket.removeAllListeners();
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
}

export class DesktopAppBridge {
  #port;
  #token;
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

  constructor({ port, token, createTransport, acquireLease, onEvent = () => undefined }) {
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
    const token = authenticatedToken(request.url, this.#token);
    if (token === undefined) {
      rejectUpgrade(socket, 401, "Unauthorized");
      this.#onEvent({ type: "rejected", reason: "authentication" });
      return;
    }
    if (this.#pending.size + this.#sessions.size >= maximumConnections) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      this.#onEvent({ type: "rejected", reason: "capacity" });
      return;
    }
    const attempt = {
      socket,
      transport: undefined,
      lease: undefined,
      transportClosed: false,
      leaseClosed: false,
      task: undefined,
      abortTask: undefined,
    };
    this.#pending.add(attempt);
    attempt.task = this.#acceptUpgrade(attempt, request, head);
    void attempt.task;
  }

  async #acceptUpgrade(attempt, request, head) {
    let handedOff = false;
    try {
      attempt.lease = await this.#acquireLease();
      if (this.#closing || attempt.socket.destroyed) return;
      attempt.transport = await this.#createTransport();
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
    let upstreamQueue = Promise.resolve();
    let downstreamQueue = Promise.resolve();
    const closeSession = (code, reason, terminate = false) => {
      if (session.closePromise) return session.closePromise;
      session.closePromise = (async () => {
        session.removeTransportMessage?.();
        session.removeTransportClose?.();
        this.#sessions.delete(session);
        await closeWebSocket(webSocket, code, reason, terminate ? 250 : 0);
        try {
          await transport.close();
        } finally {
          await lease.close();
          this.#onEvent({ type: "disconnected", connections: this.#sessions.size });
        }
      })();
      return session.closePromise;
    };
    session.close = closeSession;
    session.removeTransportMessage = transport.onMessage((message) => {
      downstreamQueue = downstreamQueue.then(() => sendText(webSocket, message)).catch(() => {
        this.#onEvent({ type: "connection-error", stage: "downstream-send" });
        void closeSession(upstreamFailureCloseCode, "Upstream connection failed");
      });
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
      upstreamQueue = upstreamQueue.then(() => transport.send(message)).catch(() => {
        this.#onEvent({ type: "connection-error", stage: "upstream-send" });
        void closeSession(upstreamFailureCloseCode, "Upstream connection failed");
      });
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
    await Promise.allSettled([
      serverClosed,
      ...sessionCloses,
      ...[...this.#pending].map((attempt) => attempt.task),
      ...[...this.#pending].map((attempt) => attempt.abortTask),
    ]);
    this.#sessions.clear();
    this.#pending.clear();
    this.#started = false;
    this.#onEvent({ type: "stopped" });
  }
}

function authenticatedToken(requestUrl, expectedToken) {
  let parsed;
  try {
    parsed = new URL(requestUrl ?? "", `http://${bridgeHost}`);
  } catch {
    return undefined;
  }
  if (parsed.pathname !== bridgePath) return undefined;
  const tokens = parsed.searchParams.getAll("token");
  if (
    [...parsed.searchParams.keys()].length !== 1
    || tokens.length !== 1
    || !bridgeTokenPattern.test(tokens[0])
  ) return undefined;
  const actual = Buffer.from(tokens[0], "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? tokens[0]
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
