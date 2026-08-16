import { chmodSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { basename, dirname, extname, resolve } from "node:path";

import WebSocket from "ws";

import { managedModelProviderDefinitions } from "./model-provider-definitions.mjs";

const protocolVersion = 2;
const maximumResponseBytes = 16_384;
const maximumRequestBytes = 1_024;
const connectionTimeoutMs = 1_000;
const managedProviderIds = new Set(managedModelProviderDefinitions.map(({ id }) => id));

export class AppServerSupervisorOwner {
  #identity;
  #server;
  #socketPath;
  #sockets = new Set();
  #closePromise;
  #ensureProvider;

  constructor(primarySocketPath, topology, { ensureProvider } = {}) {
    this.#socketPath = appServerSupervisorSocketPath(primarySocketPath);
    const payload = `${JSON.stringify({
      version: protocolVersion,
      pid: process.pid,
      primaryProvider: topology.primaryProvider,
      managedProviders: topology.managedProviders,
      socketPaths: topology.socketPaths,
    })}\n`;
    this.#ensureProvider = ensureProvider;
    this.#server = createServer({ allowHalfOpen: true }, (socket) => {
      this.#sockets.add(socket);
      const chunks = [];
      let bytes = 0;
      socket.on("error", () => undefined);
      socket.on("close", () => this.#sockets.delete(socket));
      socket.setTimeout(connectionTimeoutMs, () => socket.destroy());
      socket.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maximumRequestBytes) {
          socket.destroy();
          return;
        }
        chunks.push(chunk);
        if (!chunk.includes(0x0a)) return;
        socket.pause();
        void this.#handleRequest(socket, Buffer.concat(chunks).toString("utf8"), payload);
      });
    });
  }

  async #handleRequest(socket, requestText, topologyPayload) {
    let request;
    try {
      request = JSON.parse(requestText.trim());
    } catch {
      socket.destroy();
      return;
    }
    if (request?.action === "inspect") {
      socket.end(topologyPayload);
      return;
    }
    if (
      request?.action !== "ensureProvider"
      || typeof request.provider !== "string"
      || !this.#ensureProvider
    ) {
      socket.end(`${JSON.stringify({ version: protocolVersion, ok: false })}\n`);
      return;
    }
    socket.setTimeout(15_000, () => socket.destroy());
    try {
      await this.#ensureProvider(request.provider);
      socket.end(`${JSON.stringify({
        version: protocolVersion,
        ok: true,
        provider: request.provider,
      })}\n`);
    } catch (error) {
      socket.end(`${JSON.stringify({
        version: protocolVersion,
        ok: false,
        provider: request.provider,
        error: error instanceof Error ? error.message.slice(0, 512) : "启动失败",
      })}\n`);
    }
  }

  async start() {
    await removeStaleSupervisorSocket(this.#socketPath);
    await new Promise((resolveListen, rejectListen) => {
      const onError = (error) => {
        this.#server.removeListener("listening", onListening);
        rejectListen(error);
      };
      const onListening = () => {
        this.#server.removeListener("error", onError);
        resolveListen();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.#socketPath);
    }).catch((error) => {
      if (error?.code === "EADDRINUSE") {
        throw new Error("Codex App Server 统一监管入口已在运行");
      }
      throw error;
    });
    try {
      const status = lstatSync(this.#socketPath);
      this.#identity = { dev: status.dev, ino: status.ino };
      chmodSync(this.#socketPath, 0o600);
    } catch (error) {
      await this.close();
      if (error?.code === "ENOENT") {
        throw new Error(
          `App Server 监管 Socket 无法创建（路径可能超过平台长度限制）：${this.#socketPath}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  close() {
    this.#closePromise ??= this.#closeInternal();
    return this.#closePromise;
  }

  async #closeInternal() {
    for (const socket of this.#sockets) socket.destroy();
    if (this.#server.listening) {
      await new Promise((resolveClose) => this.#server.close(() => resolveClose()));
    }
    unlinkOwnedSocket(this.#socketPath, this.#identity);
  }
}

export function appServerSupervisorSocketPath(primarySocketPath) {
  const extension = extname(primarySocketPath);
  const stem = basename(primarySocketPath, extension);
  return resolve(dirname(primarySocketPath), `${stem}-supervisor${extension}`);
}

export async function inspectAppServerSupervisor(primarySocketPath) {
  const socketPath = appServerSupervisorSocketPath(primarySocketPath);
  const status = assertSafeSupervisorSocket(socketPath);
  if (!status) return undefined;
  return parseTopology(await readSupervisorResponse(socketPath, { action: "inspect" }));
}

export async function ensureAppServerProvider(primarySocketPath, provider) {
  const socketPath = appServerSupervisorSocketPath(primarySocketPath);
  assertSafeSupervisorSocket(socketPath);
  const response = await readSupervisorResponse(socketPath, {
    action: "ensureProvider",
    provider,
  }, 15_000);
  let value;
  try {
    value = JSON.parse(response?.trim() ?? "");
  } catch {
    throw new Error(`模型 Provider 启动请求没有有效响应：${provider}`);
  }
  if (value?.version !== protocolVersion || value.provider !== provider || value.ok !== true) {
    throw new Error(
      typeof value?.error === "string" && value.error
        ? value.error
        : `模型 Provider 启动失败：${provider}`,
    );
  }
}

function assertSafeSupervisorSocket(socketPath) {
  const status = lstatSync(socketPath, { throwIfNoEntry: false });
  if (!status) return undefined;
  if (
    !status.isSocket()
    || status.uid !== process.getuid?.()
    || (status.mode & 0o077) !== 0
  ) {
    throw new Error(`App Server 监管 Socket 路径不安全：${socketPath}`);
  }
  return status;
}

export function sameAppServerTopology(actual, expected) {
  return actual?.version === protocolVersion
    && actual.primaryProvider === expected.primaryProvider
    && actual.managedProviders.length === expected.managedProviders.length
    && actual.managedProviders.every((provider, index) =>
      provider === expected.managedProviders[index])
    && actual.socketPaths.length === expected.socketPaths.length
    && actual.socketPaths.every((path, index) => path === expected.socketPaths[index]);
}

export async function prepareAppServerSocketPaths(socketPaths) {
  const occupied = await Promise.all(
    socketPaths.map((socketPath) => appServerSocketAcceptsWebSocket(socketPath)),
  );
  if (occupied.some(Boolean)) {
    throw new Error(
      "App Server Socket 已被未受监管的进程占用；请先停止现有 App Server 后重试",
    );
  }
  for (const socketPath of socketPaths) {
    preserveStaleSocket(socketPath);
  }
}

export async function appServerSocketAcceptsWebSocket(socketPath) {
  const status = lstatSync(socketPath, { throwIfNoEntry: false });
  if (!status) return false;
  if (!status.isSocket() || status.uid !== process.getuid?.()) {
    throw new Error(`App Server Socket 路径不安全：${socketPath}`);
  }
  return new Promise((resolveCheck) => {
    const socket = new WebSocket("ws://localhost/", {
      perMessageDeflate: false,
      createConnection: () => createConnection(socketPath),
    });
    let settled = false;
    const finish = (healthy) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.once("error", () => undefined);
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
      } else {
        socket.terminate();
      }
      resolveCheck(healthy);
    };
    const timer = setTimeout(() => finish(false), 1_500);
    socket.once("open", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function removeStaleSupervisorSocket(socketPath) {
  const status = lstatSync(socketPath, { throwIfNoEntry: false });
  if (!status) return;
  if (!status.isSocket() || status.uid !== process.getuid?.()) {
    throw new Error(`App Server 监管 Socket 路径不安全：${socketPath}`);
  }
  if (await socketAcceptsConnections(socketPath)) {
    throw new Error("Codex App Server 统一监管入口已在运行");
  }
  const current = lstatSync(socketPath, { throwIfNoEntry: false });
  if (current?.dev === status.dev && current.ino === status.ino) {
    unlinkSync(socketPath);
  }
}

function socketAcceptsConnections(socketPath) {
  return new Promise((resolveCheck) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolveCheck(true);
    });
    socket.once("error", () => resolveCheck(false));
  });
}

function readSupervisorResponse(socketPath, request, timeoutMs = 1_000) {
  return new Promise((resolveResponse) => {
    const socket = createConnection(socketPath);
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveResponse(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maximumResponseBytes) {
        finish(undefined);
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    socket.once("error", () => finish(undefined));
  });
}

function parseTopology(response) {
  if (typeof response !== "string") return undefined;
  let value;
  try {
    value = JSON.parse(response.trim());
  } catch {
    return undefined;
  }
  if (
    value?.version !== protocolVersion
    || !Number.isSafeInteger(value.pid)
    || value.pid <= 0
    || typeof value.primaryProvider !== "string"
    || !Array.isArray(value.managedProviders)
    || value.managedProviders.some((provider) => !managedProviderIds.has(provider))
    || new Set(value.managedProviders).size !== value.managedProviders.length
    || !Array.isArray(value.socketPaths)
    || value.socketPaths.length < 1
    || value.socketPaths.some((path) => typeof path !== "string" || path.length === 0)
  ) {
    return undefined;
  }
  return value;
}

function preserveStaleSocket(socketPath) {
  const status = lstatSync(socketPath, { throwIfNoEntry: false });
  if (!status) return;
  if (!status.isSocket() || status.uid !== process.getuid?.()) {
    throw new Error(`App Server Socket 路径不安全：${socketPath}`);
  }
  const extension = extname(socketPath);
  const stem = basename(socketPath, extension);
  const preserved = resolve(
    dirname(socketPath),
    `${stem}.stale-${Date.now()}-${status.ino}${extension}`,
  );
  renameSync(socketPath, preserved);
  console.warn(`检测到无效 Socket，已保留为：${preserved}`);
}

function unlinkOwnedSocket(socketPath, identity) {
  if (!identity) return;
  const status = lstatSync(socketPath, { throwIfNoEntry: false });
  if (status?.isSocket() && status.dev === identity.dev && status.ino === identity.ino) {
    unlinkSync(socketPath);
  }
}
