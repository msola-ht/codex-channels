import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  linkSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { lstat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  readPrivateFileSync,
  readPrivateConfigFile,
  ensurePrivateDirectorySync,
  securePrivateFileSync,
} from "./private-file.mjs";

const authenticationLimitBytes = 256;
const descriptorLimitBytes = 1_024;
const connectionTimeoutMs = 1_000;
const windowsPipePrefix = "\\\\.\\pipe\\codex-connect-";
const tokenPattern = /^[a-f0-9]{64}$/u;

export class PrivateIpcServer {
  #descriptorIdentity;
  #descriptorPublished = false;
  #descriptor;
  #logicalPath;
  #server;
  #socketIdentity;
  #sockets = new Set();
  #starting;
  #closing;
  #closed = false;

  constructor(logicalPath, listener, bounds) {
    this.#logicalPath = logicalPath;
    this.#server = createServer({ allowHalfOpen: true }, (socket) => {
      this.#sockets.add(socket);
      const timer = bounds ? setTimeout(() => socket.destroy(), bounds.connectionTimeoutMs) : undefined;
      socket.once("close", () => { clearTimeout(timer); this.#sockets.delete(socket); });
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

  start(occupiedMessage) {
    if (this.#closed) return Promise.reject(new Error("私有 IPC 服务已关闭"));
    this.#starting ??= this.#start(occupiedMessage).catch(async error => {
      try { await this.#closeResources(); }
      catch (cleanupError) {
        this.#closed = true;
        throw new AggregateError([error, cleanupError], "私有 IPC 启动失败且清理未确认", { cause: cleanupError });
      }
      this.#starting = undefined;
      throw error;
    });
    return this.#starting;
  }

  async #start(occupiedMessage) {
    ensurePrivateDirectorySync(dirname(this.#logicalPath));
    if (process.platform === "win32") {
      await this.#startWindows(occupiedMessage);
      return;
    }
    const maximumPathBytes = process.platform === "linux" ? 107 : 103;
    if (Buffer.byteLength(this.#logicalPath) > maximumPathBytes || this.#logicalPath.includes("\0")) {
      throw Object.assign(new Error("私有 IPC Socket 路径无效或超过平台长度限制"), { code: "ERR_PRIVATE_IPC_PATH" });
    }
    await removeStaleUnixEndpoint(this.#logicalPath, occupiedMessage);
    if (this.#closed) throw new Error("私有 IPC 服务已关闭");
    // libuv unlinks its bind pathname on close without checking the inode. Bind
    // under an unpublished name so it never owns cleanup of the public endpoint.
    const boundPath = await listenUnpublishedUnix(this.#server, this.#logicalPath, occupiedMessage);
    try {
      if (this.#closed) throw new Error("私有 IPC 服务已关闭");
      const status = lstatSync(boundPath);
      this.#socketIdentity = { dev: status.dev, ino: status.ino };
      chmodSync(boundPath, 0o600);
      // link is exclusive: a competing publisher must never be overwritten.
      linkSync(boundPath, this.#logicalPath);
      // Keep the bind name occupied until libuv closes and unlinks it. Releasing
      // it early lets a later owner publish there and be deleted by this close.
    } catch (error) {
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
    if (this.#closed) throw new Error("私有 IPC 服务已关闭");
    await this.#claimWindowsDescriptor(occupiedMessage);
  }

  async #claimWindowsDescriptor(occupiedMessage) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.#closed) throw new Error("私有 IPC 服务已关闭");
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
        if (this.#closed) throw new Error("私有 IPC 服务已关闭", { cause: error });
        const current = lstatSync(this.#logicalPath, { throwIfNoEntry: false });
        if (current?.dev === stale.dev && current.ino === stale.ino) {
          unlinkSync(this.#logicalPath);
        }
        continue;
      }
      try {
        const status = fstatSync(descriptor);
        this.#descriptorIdentity = { dev: status.dev, ino: status.ino };
        writeFileSync(descriptor, `${JSON.stringify(this.#descriptor)}\n`, "utf8");
      } finally {
        closeSync(descriptor);
      }
      securePrivateFileSync(this.#logicalPath);
      const status = lstatSync(this.#logicalPath);
      if (!status.isFile() || status.dev !== this.#descriptorIdentity.dev || status.ino !== this.#descriptorIdentity.ino) {
        throw new Error("Windows 私有 IPC 描述文件在发布期间发生变化");
      }
      this.#descriptorPublished = true;
      return;
    }
    throw new Error("Windows 私有 IPC 端点竞争失败");
  }

  close() {
    this.#closed = true;
    if (this.#closing) return this.#closing;
    const closing = (async () => {
      await this.#starting?.catch(() => {});
      await this.#closeResources();
    })().catch(error => {
      if (this.#closing === closing) this.#closing = undefined;
      throw error;
    });
    this.#closing = closing;
    return closing;
  }

  async #closeResources() {
    const closing = closeServer(this.#server);
    for (const socket of this.#sockets) socket.destroy();
    await closing;
    if (process.platform === "win32") {
      unlinkOwnedWindowsDescriptor(
        this.#logicalPath,
        this.#descriptorIdentity,
        this.#descriptor,
        this.#descriptorPublished,
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

/** Inspect the current descriptor asynchronously; callers include this read in their deadline. */
export async function createPrivateIpcConnectionAsync(logicalPath, { signal } = {}) {
  signal?.throwIfAborted();
  let endpoint;
  if (process.platform === "win32") {
    endpoint = parseWindowsDescriptor(await readPrivateConfigFile(logicalPath, { signal, maximumBytes: descriptorLimitBytes }), logicalPath);
  } else {
    const status = await lstat(logicalPath);
    if (!status.isSocket() || status.uid !== process.getuid?.() || (status.mode & 0o077) !== 0) {
      throw new Error(`私有 IPC Socket 路径不安全：${logicalPath}`);
    }
  }
  signal?.throwIfAborted();
  const socket = createConnection({ path: endpoint?.pipe ?? logicalPath, signal });
  if (endpoint) socket.prependOnceListener("connect", () => {
    socket.write(`${JSON.stringify({ token: endpoint.token })}\n`);
  });
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
    const cancellation = new AbortController();
    const finish = (value, failed) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      cancellation.abort();
      socket?.destroy();
      if (failed) reject(new Error("Private IPC request unconfirmed"));
      else resolve(value);
    };
    const abort = () => finish(undefined, true);
    try {
      const payload = `${JSON.stringify(request)}\n`;
      timer = setTimeout(abort, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      void createPrivateIpcConnectionAsync(logicalPath, { signal: cancellation.signal }).then(connection => {
        socket = connection;
        socket.on("error", abort);
        if (done) { socket.destroy(); return; }
        socket.once("connect", () => { if (!done) socket.write(payload); });
        socket.once("close", abort);
        socket.once("end", abort);
        socket.on("data", chunk => {
          if (done) return;
          bytes += chunk.length;
          if (bytes > maximumBytes) { abort(); return; }
          chunks.push(chunk);
          if (!chunk.includes(10)) return;
          try { finish(JSON.parse(Buffer.concat(chunks).toString("utf8").trim()), false); }
          catch { abort(); }
        });
      }).catch(abort);
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
  let settled = false;
  const fail = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
  };
  const timer = setTimeout(fail, connectionTimeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    socket.removeListener("data", onData);
    socket.removeListener("error", fail);
    socket.removeListener("end", fail);
    socket.removeListener("close", onClose);
  };
  const onClose = () => { settled = true; cleanup(); };
  const onData = (chunk) => {
    if (settled) return;
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
    settled = true;
    cleanup();
    socket.pause();
    const remainder = received.subarray(newline + 1);
    if (remainder.length > 0) socket.unshift(remainder);
    listener(socket);
    socket.resume();
  };
  socket.on("data", onData);
  socket.on("error", fail);
  socket.once("end", fail);
  socket.once("close", onClose);
}

function sameToken(actual, expected) {
  if (typeof actual !== "string" || !tokenPattern.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function readWindowsDescriptor(logicalPath) {
  try {
    return parseWindowsDescriptor(readPrivateFileSync(logicalPath, descriptorLimitBytes), logicalPath);
  } catch (error) {
    throw new Error(`Windows 私有 IPC 端点不安全或描述无效：${logicalPath}`, { cause: error });
  }
}

function parseWindowsDescriptor(content, logicalPath) {
  const value = JSON.parse(content);
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

function unlinkOwnedWindowsDescriptor(path, identity, descriptor, published) {
  if (!identity || !descriptor) return;
  const status = lstatSync(path, { throwIfNoEntry: false });
  if (status?.dev !== identity.dev || status.ino !== identity.ino) return;
  if (!published) {
    // A failed write or ACL operation may leave an unreadable descriptor. Only
    // remove the regular file created by this attempt, never a replacement.
    if (status.isFile()) unlinkSync(path);
    return;
  }
  const current = readWindowsDescriptor(path);
  if (current.pipe === descriptor.pipe && sameToken(current.token, descriptor.token)) {
    unlinkSync(path);
  }
}
