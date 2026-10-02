import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { basename, dirname, join } from "node:path";

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
  #boundedSockets = new Set();

  constructor(logicalPath, listener, bounds) {
    this.#logicalPath = logicalPath;
    this.#server = createServer({ allowHalfOpen: true }, (socket) => {
      if (bounds) {
        this.#boundedSockets.add(socket);
        const timer = setTimeout(() => socket.destroy(), bounds.connectionTimeoutMs);
        socket.once("close", () => { clearTimeout(timer); this.#boundedSockets.delete(socket); });
      }
      if (process.platform !== "win32") {
        listener(socket);
        return;
      }
      authenticateWindowsConnection(socket, this.#descriptor.token, listener);
    });
    if (bounds) this.#server.maxConnections = bounds.maximumConnections;
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
    const maximumPathBytes = process.platform === "linux" ? 107 : 103;
    if (Buffer.byteLength(this.#logicalPath) > maximumPathBytes || this.#logicalPath.includes("\0")) {
      throw Object.assign(new Error("私有 IPC Socket 路径无效或超过平台长度限制"), { code: "ERR_PRIVATE_IPC_PATH" });
    }
    await removeStaleUnixEndpoint(this.#logicalPath, occupiedMessage);
    // libuv unlinks its bind pathname on close without checking the inode. Bind
    // under an unpublished name so it never owns cleanup of the public endpoint.
    const boundPath = await listenUnpublishedUnix(this.#server, this.#logicalPath, occupiedMessage);
    try {
      const status = lstatSync(boundPath);
      this.#socketIdentity = { dev: status.dev, ino: status.ino };
      chmodSync(boundPath, 0o600);
      // link is exclusive: a competing publisher must never be overwritten.
      linkSync(boundPath, this.#logicalPath);
      // Keep the bind name occupied until libuv closes and unlinks it. Releasing
      // it early lets a later owner publish there and be deleted by this close.
    } catch (error) {
      await this.close();
      if (error?.code === "EEXIST") throw new Error(occupiedMessage, { cause: error });
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
    for (const socket of this.#boundedSockets) socket.destroy();
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

/** One bounded JSON exchange. Callers own response validation and confirmation semantics. */
export function requestPrivateIpcJson(logicalPath, request, { timeoutMs, maximumBytes, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Private IPC request cancelled")); return; }
    let socket;
    let timer;
    let done = false;
    let bytes = 0;
    const chunks = [];
    const finish = (value, failed) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket?.destroy();
      if (failed) reject(new Error("Private IPC request unconfirmed"));
      else resolve(value);
    };
    const abort = () => finish(undefined, true);
    try {
      const payload = `${JSON.stringify(request)}\n`;
      timer = setTimeout(abort, timeoutMs);
      socket = createPrivateIpcConnection(logicalPath);
      signal?.addEventListener("abort", abort, { once: true });
      socket.once("connect", () => { if (!done) socket.write(payload); });
      socket.on("error", abort);
      socket.once("close", abort);
      socket.on("data", chunk => {
        if (done) return;
        bytes += chunk.length;
        if (bytes > maximumBytes) { abort(); return; }
        chunks.push(chunk);
        if (!chunk.includes(10)) return;
        try { finish(JSON.parse(Buffer.concat(chunks).toString("utf8").trim()), false); }
        catch { abort(); }
      });
      if (signal?.aborted) abort();
    } catch { abort(); }
  });
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
      reject(error?.code === "EADDRINUSE" ? new Error(occupiedMessage, { cause: error }) : error);
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

async function listenUnpublishedUnix(server, logicalPath, occupiedMessage) {
  // Never lengthen the configured Socket path (including short macOS fixtures).
  const nameLength = Math.min(24, Buffer.byteLength(basename(logicalPath)));
  for (let attempt = 0; attempt < 16; attempt++) {
    const path = join(dirname(logicalPath), randomBytes(24).toString("base64url").slice(0, nameLength));
    // Default macOS volumes are case-insensitive: binding S already occupies s.
    // Reject case-only aliases on every platform without changing path lengths.
    if (path.toLowerCase() === logicalPath.toLowerCase()) continue;
    try {
      await listen(server, path, occupiedMessage);
      return path;
    } catch (error) {
      if (error?.cause?.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(occupiedMessage);
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
