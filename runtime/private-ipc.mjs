import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname } from "node:path";

import {
  readPrivateFileSync,
  securePrivateDirectorySync,
  securePrivateFileSync,
} from "./private-file.mjs";

const authenticationLimitBytes = 256;
const descriptorLimitBytes = 1_024;
const connectionTimeoutMs = 1_000;
const windowsPipePrefix = "\\\\.\\pipe\\codex-connect-";
const tokenPattern = /^[a-f0-9]{64}$/u;

export class PrivateIpcServer {
  #descriptorIdentity;
  #descriptor;
  #logicalPath;
  #server;
  #socketIdentity;

  constructor(logicalPath, listener) {
    this.#logicalPath = logicalPath;
    this.#server = createServer({ allowHalfOpen: true }, (socket) => {
      if (process.platform !== "win32") {
        listener(socket);
        return;
      }
      authenticateWindowsConnection(socket, this.#descriptor.token, listener);
    });
  }

  get listening() {
    return this.#server.listening;
  }

  async start(occupiedMessage) {
    mkdirSync(dirname(this.#logicalPath), { recursive: true, mode: 0o700 });
    securePrivateDirectorySync(dirname(this.#logicalPath));
    if (process.platform === "win32") {
      await this.#startWindows(occupiedMessage);
      return;
    }
    await removeStaleUnixEndpoint(this.#logicalPath, occupiedMessage);
    await listen(this.#server, this.#logicalPath, occupiedMessage);
    try {
      const status = lstatSync(this.#logicalPath);
      this.#socketIdentity = { dev: status.dev, ino: status.ino };
      chmodSync(this.#logicalPath, 0o600);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async #startWindows(occupiedMessage) {
    this.#descriptor = {
      version: 1,
      pipe: `${windowsPipePrefix}${randomUUID()}`,
      token: randomBytes(32).toString("hex"),
    };
    await listen(this.#server, this.#descriptor.pipe, occupiedMessage);
    try {
      await this.#claimWindowsDescriptor(occupiedMessage);
    } catch (error) {
      await closeServer(this.#server);
      throw error;
    }
  }

  async #claimWindowsDescriptor(occupiedMessage) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let descriptor;
      try {
        descriptor = openSync(this.#logicalPath, "wx", 0o600);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const stale = lstatSync(this.#logicalPath);
        assertPrivateIpcEndpointSync(this.#logicalPath);
        if (await privateIpcAcceptsConnections(this.#logicalPath)) {
          throw new Error(occupiedMessage, { cause: error });
        }
        const current = lstatSync(this.#logicalPath, { throwIfNoEntry: false });
        if (current?.dev === stale.dev && current.ino === stale.ino) {
          unlinkSync(this.#logicalPath);
        }
        continue;
      }
      try {
        writeFileSync(descriptor, `${JSON.stringify(this.#descriptor)}\n`, "utf8");
      } finally {
        closeSync(descriptor);
      }
      securePrivateFileSync(this.#logicalPath);
      const status = lstatSync(this.#logicalPath);
      this.#descriptorIdentity = { dev: status.dev, ino: status.ino };
      return;
    }
    throw new Error("Windows 私有 IPC 端点竞争失败");
  }

  async close() {
    await closeServer(this.#server);
    if (process.platform === "win32") {
      unlinkOwnedWindowsDescriptor(
        this.#logicalPath,
        this.#descriptorIdentity,
        this.#descriptor,
      );
      return;
    }
    unlinkOwnedUnixEndpoint(this.#logicalPath, this.#socketIdentity);
  }
}

export function privateIpcEndpointExists(logicalPath) {
  return lstatSync(logicalPath, { throwIfNoEntry: false }) !== undefined;
}

export function assertPrivateIpcEndpointSync(logicalPath) {
  const status = lstatSync(logicalPath, { throwIfNoEntry: false });
  if (!status) return undefined;
  if (process.platform === "win32") return readWindowsDescriptor(logicalPath);
  if (
    !status.isSocket()
    || status.uid !== process.getuid?.()
    || (status.mode & 0o077) !== 0
  ) {
    throw new Error(`私有 IPC Socket 路径不安全：${logicalPath}`);
  }
  return status;
}

export function createPrivateIpcConnection(logicalPath) {
  const endpoint = assertPrivateIpcEndpointSync(logicalPath);
  if (!endpoint) {
    const error = new Error(`私有 IPC 端点不存在：${logicalPath}`);
    error.code = "ENOENT";
    throw error;
  }
  const socket = createConnection(process.platform === "win32" ? endpoint.pipe : logicalPath);
  if (process.platform === "win32") {
    socket.prependOnceListener("connect", () => {
      socket.write(`${JSON.stringify({ token: endpoint.token })}\n`);
    });
  }
  return socket;
}

export function privateIpcAcceptsConnections(logicalPath) {
  if (!privateIpcEndpointExists(logicalPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let socket;
    try {
      socket = createPrivateIpcConnection(logicalPath);
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (active) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(active);
    };
    socket.setTimeout(connectionTimeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function authenticateWindowsConnection(socket, expectedToken, listener) {
  let received = Buffer.alloc(0);
  const fail = () => socket.destroy();
  socket.setTimeout(connectionTimeoutMs, fail);
  const onData = (chunk) => {
    received = Buffer.concat([received, chunk]);
    const newline = received.indexOf(0x0a);
    if (newline < 0) {
      if (received.length > authenticationLimitBytes) fail();
      return;
    }
    if (newline > authenticationLimitBytes) {
      fail();
      return;
    }
    let token;
    try {
      token = JSON.parse(received.subarray(0, newline).toString("utf8")).token;
    } catch {
      fail();
      return;
    }
    if (!sameToken(token, expectedToken)) {
      fail();
      return;
    }
    socket.removeListener("data", onData);
    socket.setTimeout(0);
    socket.pause();
    const remainder = received.subarray(newline + 1);
    if (remainder.length > 0) socket.unshift(remainder);
    listener(socket);
    socket.resume();
  };
  socket.on("data", onData);
}

function sameToken(actual, expected) {
  if (typeof actual !== "string" || !tokenPattern.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function readWindowsDescriptor(logicalPath) {
  let value;
  try {
    value = JSON.parse(readPrivateFileSync(logicalPath, descriptorLimitBytes));
  } catch (error) {
    throw new Error(`Windows 私有 IPC 端点不安全或描述无效：${logicalPath}`, { cause: error });
  }
  if (
    value?.version !== 1
    || typeof value.pipe !== "string"
    || !value.pipe.startsWith(windowsPipePrefix)
    || !tokenPattern.test(value.token)
  ) {
    throw new Error(`Windows 私有 IPC 端点不安全或描述无效：${logicalPath}`);
  }
  return value;
}

async function removeStaleUnixEndpoint(path, occupiedMessage) {
  const status = assertPrivateIpcEndpointSync(path);
  if (!status) return;
  if (await privateIpcAcceptsConnections(path)) throw new Error(occupiedMessage);
  const current = lstatSync(path, { throwIfNoEntry: false });
  if (current?.dev === status.dev && current.ino === status.ino) unlinkSync(path);
}

function listen(server, path, occupiedMessage) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error?.code === "EADDRINUSE" ? new Error(occupiedMessage) : error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function unlinkOwnedUnixEndpoint(path, identity) {
  if (!identity) return;
  const status = lstatSync(path, { throwIfNoEntry: false });
  if (status?.isSocket() && status.dev === identity.dev && status.ino === identity.ino) {
    unlinkSync(path);
  }
}

function unlinkOwnedWindowsDescriptor(path, identity, descriptor) {
  if (!identity || !descriptor) return;
  const status = lstatSync(path, { throwIfNoEntry: false });
  if (status?.dev !== identity.dev || status.ino !== identity.ino) return;
  const current = readWindowsDescriptor(path);
  if (current.pipe === descriptor.pipe && sameToken(current.token, descriptor.token)) {
    unlinkSync(path);
  }
}
