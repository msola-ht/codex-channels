import { dirname, join } from "node:path";

import {
  createPrivateIpcConnectionAsync,
  PrivateIpcServer,
} from "./private-ipc.mjs";

const connectionTimeoutMs = 1_000;
const maximumStatusBytes = 4_096;

export class GatewayOwnershipError extends Error {}

export class GatewayOwner {
  #ready = false;
  #readinessRevoked = false;
  #server;
  #socketPath;
  #sockets = new Set();
  #closePromise;

  constructor(configPath) {
    this.#socketPath = gatewayOwnerSocketPath(configPath);
    this.#server = new PrivateIpcServer(this.#socketPath, (socket) => {
      this.#sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => this.#sockets.delete(socket));
      socket.setTimeout(connectionTimeoutMs, () => socket.destroy());
      socket.end(`${JSON.stringify({
        version: 1,
        pid: process.pid,
        ready: this.#ready,
      })}\n`);
    });
  }

  async start() {
    try {
      await this.#server.start("Gateway 已在运行，不能重复启动");
    } catch (error) {
      if (error instanceof Error && error.message === "Gateway 已在运行，不能重复启动") {
        throw new GatewayOwnershipError(error.message);
      }
      throw error;
    }
  }

  close() {
    this.#closePromise ??= this.#closeInternal();
    return this.#closePromise;
  }

  markReady() {
    if (!this.#server.listening) {
      throw new Error("Gateway 所有权尚未建立，不能标记就绪");
    }
    if (this.#readinessRevoked) return;
    this.#ready = true;
  }

  markNotReady() {
    if (!this.#server.listening) {
      throw new Error("Gateway 所有权尚未建立，不能撤销就绪");
    }
    this.#readinessRevoked = true;
    this.#ready = false;
  }

  async #closeInternal() {
    for (const socket of this.#sockets) socket.destroy();
    await this.#server.close();
  }
}

export function gatewayOwnerSocketPath(configPath) {
  return join(dirname(configPath), "runtime", "gateway-owner.sock");
}

export function gatewayOwnerIsActive(configPath, signal) {
  const socketPath = gatewayOwnerSocketPath(configPath);
  return readGatewayOwnerStatus(socketPath, signal, true).then(Boolean, () => {
    signal?.throwIfAborted();
    return false;
  });
}

export async function gatewayOwnerIsReady(configPath, signal) {
  const socketPath = gatewayOwnerSocketPath(configPath);
  const owner = await readGatewayOwnerStatus(socketPath, signal);
  return owner?.version === 1
    && Number.isSafeInteger(owner.pid)
    && owner.pid > 0
    && owner.ready === true;
}

function readGatewayOwnerStatus(socketPath, signal, activeOnly = false) {
  signal?.throwIfAborted();
  return new Promise((resolveStatus, rejectStatus) => {
    let socket;
    const cancellation = new AbortController();
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      cancellation.abort();
      socket?.destroy();
      if (error !== undefined) rejectStatus(error);
      else resolveStatus(value);
    };
    const timer = setTimeout(() => finish(undefined), connectionTimeoutMs);
    const abort = () => finish(undefined, signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    void createPrivateIpcConnectionAsync(socketPath, { signal: cancellation.signal }).then(connection => {
      socket = connection;
      socket.on("error", () => finish(undefined));
      if (settled) { socket.destroy(); return; }
      if (activeOnly) socket.once("connect", () => finish(true));
      socket.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maximumStatusBytes) {
          finish(undefined);
          return;
        }
        chunks.push(chunk);
      });
      socket.once("end", () => {
        try {
          finish(JSON.parse(Buffer.concat(chunks).toString("utf8").trim()));
        } catch {
          finish(undefined);
        }
      });
      socket.once("close", () => finish(undefined));
    }).catch(error => finish(undefined, error?.code === "ENOENT" ? undefined : error));
    if (signal?.aborted) abort();
  });
}
