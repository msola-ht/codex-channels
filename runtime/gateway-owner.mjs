import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";

const connectionTimeoutMs = 1_000;
const maximumStatusBytes = 4_096;

export class GatewayOwnershipError extends Error {}

export class GatewayOwner {
  #identity;
  #ready = false;
  #readinessRevoked = false;
  #server;
  #socketPath;
  #sockets = new Set();
  #closePromise;

  constructor(configPath) {
    this.#socketPath = gatewayOwnerSocketPath(configPath);
    this.#server = createServer({ allowHalfOpen: true }, (socket) => {
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
    mkdirSync(dirname(this.#socketPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.#socketPath), 0o700);
    await removeStaleGatewaySocket(this.#socketPath);
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
        throw new GatewayOwnershipError("Gateway 已在运行，不能重复启动");
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

  markReady() {
    if (!this.#identity || !this.#server.listening) {
      throw new Error("Gateway 所有权尚未建立，不能标记就绪");
    }
    if (this.#readinessRevoked) return;
    this.#ready = true;
  }

  markNotReady() {
    if (!this.#identity || !this.#server.listening) {
      throw new Error("Gateway 所有权尚未建立，不能撤销就绪");
    }
    this.#readinessRevoked = true;
    this.#ready = false;
  }

  async #closeInternal() {
    for (const socket of this.#sockets) socket.destroy();
    if (this.#server.listening) {
      await new Promise((resolveClose) => this.#server.close(() => resolveClose()));
    }
    unlinkOwnedSocket(this.#socketPath, this.#identity);
  }
}

export function gatewayOwnerSocketPath(configPath) {
  return join(dirname(configPath), "runtime", "gateway-owner.sock");
}

export function gatewayOwnerIsActive(configPath) {
  const socketPath = gatewayOwnerSocketPath(configPath);
  const status = lstatSync(socketPath, { throwIfNoEntry: false });
  if (!status) return Promise.resolve(false);
  if (!status.isSocket() || status.uid !== process.getuid?.()) {
    throw new Error(`Gateway 所有权 Socket 路径不安全：${socketPath}`);
  }
  return socketAcceptsConnections(socketPath);
}

export async function gatewayOwnerIsReady(configPath) {
  const socketPath = gatewayOwnerSocketPath(configPath);
  const status = lstatSync(socketPath, { throwIfNoEntry: false });
  if (!status) return false;
  if (!status.isSocket() || status.uid !== process.getuid?.()) {
    throw new Error(`Gateway 所有权 Socket 路径不安全：${socketPath}`);
  }
  const owner = await readGatewayOwnerStatus(socketPath);
  return owner?.version === 1
    && Number.isSafeInteger(owner.pid)
    && owner.pid > 0
    && owner.ready === true;
}

async function removeStaleGatewaySocket(socketPath) {
  const status = lstatSync(socketPath, { throwIfNoEntry: false });
  if (!status) return;
  if (!status.isSocket() || status.uid !== process.getuid?.()) {
    throw new Error(`Gateway 所有权 Socket 路径不安全：${socketPath}`);
  }
  if (await socketAcceptsConnections(socketPath)) {
    throw new GatewayOwnershipError("Gateway 已在运行，不能重复启动");
  }
  const current = lstatSync(socketPath, { throwIfNoEntry: false });
  if (current?.dev === status.dev && current.ino === status.ino) {
    unlinkSync(socketPath);
  }
}

function socketAcceptsConnections(socketPath) {
  return new Promise((resolveCheck) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (active) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveCheck(active);
    };
    socket.setTimeout(connectionTimeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function readGatewayOwnerStatus(socketPath) {
  return new Promise((resolveStatus) => {
    const socket = createConnection(socketPath);
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

function unlinkOwnedSocket(socketPath, identity) {
  if (!identity) return;
  const status = lstatSync(socketPath, { throwIfNoEntry: false });
  if (status?.isSocket() && status.dev === identity.dev && status.ino === identity.ino) {
    unlinkSync(socketPath);
  }
}
