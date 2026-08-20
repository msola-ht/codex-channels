import { chmodSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { basename, dirname, extname, resolve } from "node:path";

import WebSocket from "ws";

const protocolVersion = 4;
const maximumResponseBytes = 16_384;
const maximumRequestBytes = 1_024;
const connectionTimeoutMs = 1_000;
const minimumUnixSocketPathLimitBytes = 104;
const providerIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export class AppServerSupervisorOwner {
  #identity;
  #server;
  #socketPath;
  #sockets = new Set();
  #closePromise;
  #closing = false;
  #ensureProvider;
  #releaseProvider;
  #topology;
  #runningProviders = new Set();
  #releasedProviders = new Set();
  #providerLeases = new Map();
  #providerOperations = new Map();

  constructor(primarySocketPath, topology, { ensureProvider, releaseProvider } = {}) {
    this.#socketPath = appServerSupervisorSocketPath(primarySocketPath);
    this.#topology = topology;
    this.#ensureProvider = ensureProvider;
    this.#releaseProvider = releaseProvider;
    this.#server = createServer({ allowHalfOpen: true }, (socket) => {
      this.#sockets.add(socket);
      const chunks = [];
      let bytes = 0;
      socket.on("error", () => undefined);
      socket.on("close", () => this.#sockets.delete(socket));
      socket.on("end", () => socket.end());
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
        void this.#handleRequest(socket, Buffer.concat(chunks).toString("utf8"));
      });
    });
  }

  async #handleRequest(socket, requestText) {
    let request;
    try {
      request = JSON.parse(requestText.trim());
    } catch {
      socket.destroy();
      return;
    }
    if (request?.action === "inspect") {
      socket.end(`${JSON.stringify({
        version: protocolVersion,
        pid: process.pid,
        primaryProvider: this.#topology.primaryProvider,
        managedProviders: this.#topology.managedProviders,
        socketPaths: this.#topology.socketPaths,
        runningProviders: [...this.#runningProviders],
        releasedProviders: [...this.#releasedProviders],
        leasedProviders: [...this.#providerLeases.keys()],
      })}\n`);
      return;
    }
    if (request?.action === "leaseProvider") {
      if (
        typeof request.provider !== "string"
        || !providerIdPattern.test(request.provider)
        || !this.#ensureProvider
      ) {
        socket.end(`${JSON.stringify({ version: protocolVersion, ok: false })}\n`);
        return;
      }
      socket.setTimeout(15_000, () => socket.destroy());
      const leases = this.#providerLeases.get(request.provider) ?? new Set();
      leases.add(socket);
      this.#providerLeases.set(request.provider, leases);
      const removeLease = () => {
        leases.delete(socket);
        if (leases.size === 0) this.#providerLeases.delete(request.provider);
      };
      socket.once("close", removeLease);
      try {
        await this.#runProviderOperation(request.provider, async () => {
          if (socket.destroyed) return;
          await this.#ensureProvider(request.provider);
          this.#releasedProviders.delete(request.provider);
          this.#runningProviders.add(request.provider);
        });
        if (socket.destroyed) return;
        socket.setTimeout(0);
        socket.resume();
        socket.write(`${JSON.stringify({
          version: protocolVersion,
          ok: true,
          provider: request.provider,
        })}\n`);
      } catch (error) {
        removeLease();
        socket.end(`${JSON.stringify({
          version: protocolVersion,
          ok: false,
          provider: request.provider,
          error: error instanceof Error ? error.message.slice(0, 512) : "启动失败",
        })}\n`);
      }
      return;
    }
    if (request?.action === "releaseProvider") {
      if (
        typeof request.provider !== "string"
        || !providerIdPattern.test(request.provider)
        || !this.#releaseProvider
      ) {
        socket.end(`${JSON.stringify({ version: protocolVersion, ok: false })}\n`);
        return;
      }
      if ((this.#providerLeases.get(request.provider)?.size ?? 0) > 0) {
        socket.end(`${JSON.stringify({
          version: protocolVersion,
          ok: true,
          provider: request.provider,
          released: false,
          reason: "leased",
        })}\n`);
        return;
      }
      socket.setTimeout(15_000, () => socket.destroy());
      try {
        const result = await this.#runProviderOperation(request.provider, async () => {
          if ((this.#providerLeases.get(request.provider)?.size ?? 0) > 0) {
            return { released: false, reason: "leased" };
          }
          const wasRunning = this.#runningProviders.has(request.provider);
          this.#runningProviders.delete(request.provider);
          this.#releasedProviders.add(request.provider);
          try {
            const didRelease = await this.#releaseProvider(request.provider);
            if ((this.#providerLeases.get(request.provider)?.size ?? 0) > 0) {
              await this.#ensureProvider(request.provider);
              this.#releasedProviders.delete(request.provider);
              this.#runningProviders.add(request.provider);
              return { released: false, reason: "leased" };
            }
            return didRelease
              ? { released: true, reason: "released" }
              : { released: false, reason: "not-running" };
          } catch (error) {
            this.#releasedProviders.delete(request.provider);
            if (wasRunning) this.#runningProviders.add(request.provider);
            throw error;
          }
        });
        socket.end(`${JSON.stringify({
          version: protocolVersion,
          ok: true,
          provider: request.provider,
          ...result,
        })}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({
          version: protocolVersion,
          ok: false,
          provider: request.provider,
          error: error instanceof Error ? error.message.slice(0, 512) : "释放失败",
        })}\n`);
      }
      return;
    }
    if (
      request?.action !== "ensureProvider"
      || typeof request.provider !== "string"
      || !providerIdPattern.test(request.provider)
      || !this.#ensureProvider
    ) {
      socket.end(`${JSON.stringify({ version: protocolVersion, ok: false })}\n`);
      return;
    }
    socket.setTimeout(15_000, () => socket.destroy());
    try {
      await this.#runProviderOperation(request.provider, async () => {
        await this.#ensureProvider(request.provider);
        this.#releasedProviders.delete(request.provider);
        this.#runningProviders.add(request.provider);
      });
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

  #runProviderOperation(provider, operation) {
    const previous = this.#providerOperations.get(provider) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => {
      if (this.#closing) {
        throw new Error("App Server 监管入口正在关闭");
      }
      return operation();
    });
    this.#providerOperations.set(provider, current);
    current.finally(() => {
      if (this.#providerOperations.get(provider) === current) {
        this.#providerOperations.delete(provider);
      }
    }).catch(() => undefined);
    return current;
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
      if (
        error?.code === "ENAMETOOLONG"
        || (
          error?.code === "EINVAL"
          && Buffer.byteLength(this.#socketPath) > minimumUnixSocketPathLimitBytes
        )
      ) {
        throw new Error(
          `App Server 监管 Socket 无法创建（路径可能超过平台长度限制）：${this.#socketPath}`,
          { cause: error },
        );
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
    if (!this.#closePromise) {
      this.#closing = true;
      this.#closePromise = this.#closeInternal();
    }
    return this.#closePromise;
  }

  async #closeInternal() {
    for (const socket of this.#sockets) socket.destroy();
    if (this.#server.listening) {
      await new Promise((resolveClose) => this.#server.close(() => resolveClose()));
    }
    await Promise.allSettled([...this.#providerOperations.values()]);
    unlinkOwnedSocket(this.#socketPath, this.#identity);
  }
}

export function appServerSupervisorSocketPath(primarySocketPath) {
  const extension = extname(primarySocketPath);
  const stem = basename(primarySocketPath, extension);
  return resolve(dirname(primarySocketPath), `${stem}-supervisor${extension}`);
}

export async function inspectAppServerSupervisor(primarySocketPath) {
  const inspection = await inspectAppServerSupervisorState(primarySocketPath);
  return inspection.status === "ready" ? inspection.topology : undefined;
}

export async function inspectAppServerSupervisorState(primarySocketPath) {
  const socketPath = appServerSupervisorSocketPath(primarySocketPath);
  const status = assertSafeSupervisorSocket(socketPath);
  if (!status) return { status: "missing" };
  const topology = parseTopology(
    await readSupervisorResponse(socketPath, { action: "inspect" }),
  );
  return topology === undefined
    ? { status: "incompatible" }
    : { status: "ready", topology };
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

export async function acquireAppServerProviderLease(primarySocketPath, provider) {
  const socketPath = appServerSupervisorSocketPath(primarySocketPath);
  assertSafeSupervisorSocket(socketPath);
  return new Promise((resolveLease, rejectLease) => {
    const socket = createConnection(socketPath);
    let response = Buffer.alloc(0);
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      rejectLease(new Error(message));
    };
    const timer = setTimeout(
      () => fail(`模型 Provider 租约请求超时：${provider}`),
      15_000,
    );
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ action: "leaseProvider", provider })}\n`);
    });
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > maximumResponseBytes) {
        fail(`模型 Provider 租约响应过大：${provider}`);
        return;
      }
      const newline = response.indexOf(0x0a);
      if (newline < 0) return;
      let value;
      try {
        value = JSON.parse(response.subarray(0, newline).toString("utf8"));
      } catch {
        fail(`模型 Provider 租约请求没有有效响应：${provider}`);
        return;
      }
      if (value?.version !== protocolVersion || value.provider !== provider || value.ok !== true) {
        fail(
          typeof value?.error === "string" && value.error
            ? value.error
            : `模型 Provider 租约获取失败：${provider}`,
        );
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.pause();
      socket.on("error", () => undefined);
      let closePromise;
      resolveLease({
        close() {
          closePromise ??= new Promise((resolveClose) => {
            if (socket.destroyed) {
              resolveClose();
              return;
            }
            socket.once("close", resolveClose);
            socket.end();
          });
          return closePromise;
        },
      });
    });
    socket.once("error", () => fail(`模型 Provider 租约连接失败：${provider}`));
    socket.once("end", () => fail(`模型 Provider 租约连接提前关闭：${provider}`));
  });
}

export async function releaseAppServerProvider(primarySocketPath, provider) {
  const socketPath = appServerSupervisorSocketPath(primarySocketPath);
  assertSafeSupervisorSocket(socketPath);
  const response = await readSupervisorResponse(socketPath, {
    action: "releaseProvider",
    provider,
  }, 15_000);
  let value;
  try {
    value = JSON.parse(response?.trim() ?? "");
  } catch {
    throw new Error(`模型 Provider 释放请求没有有效响应：${provider}`);
  }
  if (value?.version !== protocolVersion || value.provider !== provider || value.ok !== true) {
    throw new Error(
      typeof value?.error === "string" && value.error
        ? value.error
        : `模型 Provider 释放失败：${provider}`,
    );
  }
  if (
    !["released", "leased", "not-running"].includes(value.reason)
    || (value.released === true) !== (value.reason === "released")
  ) {
    throw new Error(`模型 Provider 释放响应无效：${provider}`);
  }
  return { released: value.released, reason: value.reason };
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
    || value.managedProviders.some((provider) => !providerIdPattern.test(provider))
    || new Set(value.managedProviders).size !== value.managedProviders.length
    || !Array.isArray(value.socketPaths)
    || value.socketPaths.length < 1
    || value.socketPaths.some((path) => typeof path !== "string" || path.length === 0)
    || !validProviderStateList(value.runningProviders, value.managedProviders)
    || !validProviderStateList(value.releasedProviders, value.managedProviders)
    || !validProviderStateList(value.leasedProviders, value.managedProviders)
  ) {
    return undefined;
  }
  return value;
}

function validProviderStateList(value, managedProviders) {
  return Array.isArray(value)
    && value.every((provider) =>
      providerIdPattern.test(provider) && managedProviders.includes(provider))
    && new Set(value).size === value.length;
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
