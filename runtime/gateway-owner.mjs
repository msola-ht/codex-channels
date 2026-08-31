import { dirname, join } from "node:path";

import {
  createPrivateIpcConnection,
  privateIpcAcceptsConnections,
  privateIpcEndpointExists,
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

export function gatewayOwnerIsActive(configPath) {
  const socketPath = gatewayOwnerSocketPath(configPath);
  if (!privateIpcEndpointExists(socketPath)) return Promise.resolve(false);
  return privateIpcAcceptsConnections(socketPath);
}

export async function gatewayOwnerIsReady(configPath) {
  const socketPath = gatewayOwnerSocketPath(configPath);
  if (!privateIpcEndpointExists(socketPath)) return false;
  const owner = await readGatewayOwnerStatus(socketPath);
  return owner?.version === 1
    && Number.isSafeInteger(owner.pid)
    && owner.pid > 0
    && owner.ready === true;
}

function readGatewayOwnerStatus(socketPath) {
  return new Promise((resolveStatus) => {
    const socket = createPrivateIpcConnection(socketPath);
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveStatus(value);
    };
    const timer = setTimeout(() => finish(undefined), connectionTimeoutMs);
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
    socket.once("error", () => finish(undefined));
  });
}
