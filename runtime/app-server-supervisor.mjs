import { chmodSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { basename, dirname, extname, resolve } from "node:path";

import WebSocket from "ws";

const protocolVersion = 1;
const maximumResponseBytes = 16_384;
const connectionTimeoutMs = 1_000;

export class AppServerSupervisorOwner {
  #identity;
  #server;
  #socketPath;
  #sockets = new Set();
  #closePromise;

  constructor(primarySocketPath, topology) {
    this.#socketPath = appServerSupervisorSocketPath(primarySocketPath);
    const payload = `${JSON.stringify({
      version: protocolVersion,
      pid: process.pid,
      primaryProvider: topology.primaryProvider,
      managedProvider: topology.managedProvider ?? null,
      socketPaths: topology.socketPaths,
    })}\n`;
    this.#server = createServer({ allowHalfOpen: true }, (socket) => {
      this.#sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => this.#sockets.delete(socket));
      socket.setTimeout(connectionTimeoutMs, () => socket.destroy());
      socket.end(payload);
    });
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
  const status = lstatSync(socketPath, { throwIfNoEntry: false });
  if (!status) return undefined;
  if (
    !status.isSocket()
    || status.uid !== process.getuid?.()
    || (status.mode & 0o077) !== 0
  ) {
    throw new Error(`App Server 监管 Socket 路径不安全：${socketPath}`);
  }
  return parseTopology(await readSupervisorResponse(socketPath));
}

export function sameAppServerTopology(actual, expected) {
  return actual?.version === protocolVersion
    && actual.primaryProvider === expected.primaryProvider
    && actual.managedProvider === (expected.managedProvider ?? null)
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

function readSupervisorResponse(socketPath) {
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
    const timer = setTimeout(() => finish(undefined), 1_000);
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
    || ![null, "deepseek"].includes(value.managedProvider)
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
