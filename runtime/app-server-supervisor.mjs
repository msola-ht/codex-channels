import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, renameSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Duplex } from "node:stream";

import WebSocket from "ws";

import {
  assertPrivateIpcEndpointSync,
  createPrivateIpcConnection,
  PrivateIpcServer,
} from "./private-ipc.mjs";
import { resolveExecutableInvocation } from "./executable.mjs";
import {
  assertPrivateDirectoryAccessSync,
  readPrivateFileSync,
  securePrivateDirectorySync,
  secureAppServerSocketDirectorySync,
} from "./private-file.mjs";
import { terminateChildProcess } from "./process-lifecycle.mjs";
import { inspectAppServerUnixSocket } from "./app-server-unix-socket.mjs";
import { codexHomePath } from "./codex-home.mjs";
import { loadManagedModelProviderDefinitions } from "./model-provider-definitions.mjs";
import { managedProviderDirectory, managedProviderMarkerPath, readManagedMarker } from "./model-provider-runtime.mjs";
import { readCodexConfigFile } from "./model-provider-managed-runtime.mjs";

const protocolVersion = 5;
const desktopAppHostProtocolVersion = 2;
const desktopAppProviderProtocolVersion = 1;
const providerSettingsProtocolVersion = 1;
const providerSettingsTimeoutMs = 30_000;
const maximumResponseBytes = 16_384;
const maximumRequestBytes = 4_096;
const connectionTimeoutMs = 1_000;
const providerIdPattern = /^[A-Za-z0-9_-]{1,64}$/u;

export class AppServerSupervisorOwner {
  #server;
  #socketPath;
  #sockets = new Set();
  #closePromise;
  #closing = false;
  #ensureProvider;
  #releaseProvider;
  #applyProviderSettings;
  #providerSettingsSnapshot;
  #attachDesktopApp;
  #detachDesktopApp;
  #desktopAppProviderSelectionEnabled;
  #topology;
  #runningProviders = new Set();
  #releasedProviders = new Set();
  #providerLeases = new Map();
  #desktopAppLeases = new Set();
  #desktopAppAttachmentKey;
  #desktopAppProvider;
  #desktopAppOperation = Promise.resolve();
  #providerOperations = new Map();

  constructor(
    primarySocketPath,
    topology,
    { ensureProvider, releaseProvider, applyProviderSettings, providerSettingsSnapshot, attachDesktopApp, detachDesktopApp, desktopAppProviderSelectionEnabled = false } = {},
  ) {
    this.#socketPath = appServerSupervisorSocketPath(primarySocketPath);
    this.#topology = topology;
    this.#ensureProvider = ensureProvider;
    this.#releaseProvider = releaseProvider;
    this.#applyProviderSettings = applyProviderSettings;
    this.#providerSettingsSnapshot = providerSettingsSnapshot;
    this.#attachDesktopApp = attachDesktopApp;
    this.#detachDesktopApp = detachDesktopApp;
    this.#desktopAppProviderSelectionEnabled = desktopAppProviderSelectionEnabled;
    const listener = (socket) => {
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
    };
    this.#server = new PrivateIpcServer(this.#socketPath, listener);
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
        leasedProviders: this.#leasedProviders(),
        ...(this.#desktopAppProviderSelectionEnabled ? { desktopAppProviderProtocolVersion } : {}),
        ...(process.platform === "darwin" && this.#attachDesktopApp && this.#detachDesktopApp
          ? { desktopAppHostProtocolVersion }
          : {}),
        desktopAppAttached: this.#desktopAppLeases.size > 0,
        ...(this.#desktopAppLeases.size > 0 ? { desktopAppProvider: this.#desktopAppProvider } : {}),
      })}\n`);
      return;
    }
    if (request?.action === "leaseDesktopApp") {
      if (
        process.platform !== "darwin"
        || request.desktopAppHostProtocolVersion !== desktopAppHostProtocolVersion
        || this.#topology.primaryProvider !== "openai"
        || typeof request.provider !== "string"
        || !providerIds(this.#topology).includes(request.provider)
        || typeof request.pipePath !== "string"
        || request.pipePath.length === 0
        || request.pipePath.length > 1_024
        || typeof request.appPath !== "string"
        || request.appPath.length === 0
        || request.appPath.length > 1_024
        || typeof request.toolsEnabled !== "boolean"
        || !this.#attachDesktopApp
        || !this.#detachDesktopApp
      ) {
        socket.end(`${JSON.stringify({ version: protocolVersion, ok: false })}\n`);
        return;
      }
      socket.setTimeout(20_000, () => socket.destroy());
      const controller = new AbortController();
      const cancel = () => controller.abort(new Error("Desktop Host 附加已取消"));
      socket.once("close", cancel);
      const attachmentKey = JSON.stringify([
        request.provider,
        request.appPath,
        request.pipePath,
        request.toolsEnabled,
      ]);
      const removeLease = () => {
        if (!this.#desktopAppLeases.delete(socket)) return;
        if (this.#desktopAppLeases.size > 0 || !this.#detachDesktopApp) return;
        void this.#runDesktopAppOperation(() => this.#runProviderOperation(request.provider, async () => {
          if (this.#desktopAppLeases.size === 0) {
            await this.#detachDesktopApp();
            this.#desktopAppAttachmentKey = undefined;
            this.#desktopAppProvider = undefined;
          }
        })).catch((error) => {
          if (!this.#closing) {
            console.error(
              `Codex Desktop App Host 租约清理失败：${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        });
      };
      socket.once("close", removeLease);
      try {
        const canAttach = () => {
          controller.signal.throwIfAborted();
          return (this.#providerLeases.get(request.provider)?.size ?? 0) === 0;
        };
        await this.#runDesktopAppOperation(() => this.#runProviderOperation(request.provider, async () => {
          if (!canAttach()) {
            throw new Error("目标 App Server 正被其他客户端租约占用");
          }
          if (
            this.#desktopAppLeases.size > 0
            && this.#desktopAppAttachmentKey !== attachmentKey
          ) {
            throw new Error("另一个 Codex Desktop App Host 租约仍在使用中");
          }
          await this.#attachDesktopApp({
            provider: request.provider,
            appPath: request.appPath,
            pipePath: request.pipePath,
            toolsEnabled: request.toolsEnabled,
          }, controller.signal, canAttach);
          if (socket.destroyed) {
            if (this.#desktopAppLeases.size === 0) await this.#detachDesktopApp?.();
            return;
          }
          this.#desktopAppLeases.add(socket);
          this.#desktopAppAttachmentKey = attachmentKey;
          this.#desktopAppProvider = request.provider;
          this.#releasedProviders.delete(request.provider);
          this.#runningProviders.add(request.provider);
        }));
        if (socket.destroyed) return;
        socket.setTimeout(0);
        socket.resume();
        socket.write(`${JSON.stringify({
          version: protocolVersion,
          desktopAppHostProtocolVersion,
          ok: true,
          provider: request.provider,
        })}\n`);
      } catch (error) {
        removeLease();
        socket.end(`${JSON.stringify({
          version: protocolVersion,
          desktopAppHostProtocolVersion,
          ok: false,
          provider: request.provider,
          error: error instanceof Error ? error.message.slice(0, 512) : "Desktop Host 附加失败",
        })}\n`);
      } finally {
        socket.removeListener("close", cancel);
      }
      return;
    }
    if (request?.action === "leaseProvider") {
      if (
        typeof request.provider !== "string"
        || !providerIdPattern.test(request.provider)
        || !providerIds(this.#topology).includes(request.provider)
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
    if (request?.action === "applyProviderSettings") {
      if (request.settingsProtocolVersion !== providerSettingsProtocolVersion
        || typeof request.provider !== "string" || !providerIdPattern.test(request.provider)
        || !providerIds(this.#topology).includes(request.provider) || !this.#applyProviderSettings) {
        socket.end(`${JSON.stringify({ version: protocolVersion, settingsProtocolVersion: providerSettingsProtocolVersion, ok: false })}\n`);
        return;
      }
      const controller = new AbortController();
      const cancel = () => controller.abort(new Error("Provider 设置应用已取消"));
      socket.once("close", cancel);
      const timer = setTimeout(() => { cancel(); socket.destroy(); }, providerSettingsTimeoutMs);
      socket.setTimeout(0);
      try {
        const canApply = () => {
          controller.signal.throwIfAborted();
          return !this.#hasProviderLease(request.provider);
        };
        const result = await this.#runProviderOperation(request.provider, async () => {
          const outcome = !canApply()
            ? { applied: false, reason: "leased" }
            : await this.#applyProviderSettings(request.provider, controller.signal, canApply);
          const snapshot = this.#providerSettingsSnapshot?.(request.provider);
          return snapshot === undefined ? outcome : { ...outcome, snapshot };
        });
        if (!controller.signal.aborted) socket.end(`${JSON.stringify({ version: protocolVersion,
          settingsProtocolVersion: providerSettingsProtocolVersion, ok: true, provider: request.provider, ...result })}\n`);
      } catch {
        if (!socket.destroyed) socket.end(`${JSON.stringify({ version: protocolVersion,
          settingsProtocolVersion: providerSettingsProtocolVersion, ok: false, provider: request.provider })}\n`);
      } finally {
        clearTimeout(timer);
        socket.removeListener("close", cancel);
      }
      return;
    }
    if (request?.action === "releaseProvider") {
      if (
        typeof request.provider !== "string"
        || !providerIdPattern.test(request.provider)
        || !providerIds(this.#topology).includes(request.provider)
        || !this.#releaseProvider
      ) {
        socket.end(`${JSON.stringify({ version: protocolVersion, ok: false })}\n`);
        return;
      }
      if (this.#hasProviderLease(request.provider)) {
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
          if (this.#hasProviderLease(request.provider)) {
            return { released: false, reason: "leased" };
          }
          const wasRunning = this.#runningProviders.has(request.provider);
          this.#runningProviders.delete(request.provider);
          this.#releasedProviders.add(request.provider);
          try {
            const didRelease = await this.#releaseProvider(request.provider);
            if (this.#hasProviderLease(request.provider)) {
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
      || !providerIds(this.#topology).includes(request.provider)
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

  #runDesktopAppOperation(operation) {
    const current = this.#desktopAppOperation.catch(() => undefined).then(operation);
    this.#desktopAppOperation = current;
    return current;
  }

  #hasProviderLease(provider) {
    return (this.#providerLeases.get(provider)?.size ?? 0) > 0
      || (
        provider === this.#desktopAppProvider
        && this.#desktopAppLeases.size > 0
      );
  }

  #leasedProviders() {
    const providers = new Set(this.#providerLeases.keys());
    if (this.#desktopAppLeases.size > 0) providers.add(this.#desktopAppProvider);
    return [...providers];
  }

  async start() {
    if (this.#closing) throw new Error("App Server 监管入口正在关闭");
    try {
      await this.#server.start("Codex App Server 统一监管入口已在运行");
    } catch (error) {
      if (error?.code === "ERR_PRIVATE_IPC_PATH") {
        throw new Error(`App Server 监管 Socket 无法创建（路径可能超过平台长度限制）：${this.#socketPath}`, { cause: error });
      }
      throw error;
    }
  }

  markRunning(provider) {
    this.#releasedProviders.delete(provider);
    this.#runningProviders.add(provider);
  }

  markReleased(provider) {
    this.#runningProviders.delete(provider);
    this.#releasedProviders.add(provider);
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
    await this.#server.close();
    await Promise.allSettled([this.#desktopAppOperation]);
    await Promise.allSettled([...this.#providerOperations.values()]);
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
  if (response === undefined) {
    throw new Error(
      `无法连接 App Server 监管入口：${socketPath}；`
      + "请运行 codexc status appserver 确认服务正在运行",
    );
  }
  let value;
  try {
    value = JSON.parse(response.trim());
  } catch {
    throw new Error(`模型 Provider 启动请求没有有效响应：${provider}`);
  }
  if (value?.version !== protocolVersion || value.provider !== provider || value.ok !== true) {
    throw new Error(
      supervisorVersionMismatch(value)
        ? supervisorVersionMismatchMessage(value)
        : typeof value?.error === "string" && value.error
          ? value.error
          : `模型 Provider 启动失败：${provider}`,
    );
  }
}

export async function acquireAppServerProviderLease(primarySocketPath, provider) {
  const socketPath = appServerSupervisorSocketPath(primarySocketPath);
  assertSafeSupervisorSocket(socketPath);
  return new Promise((resolveLease, rejectLease) => {
    const socket = process.platform === "win32"
      ? createPrivateIpcConnection(socketPath)
      : createConnection(socketPath);
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
          supervisorVersionMismatch(value)
            ? supervisorVersionMismatchMessage(value)
            : typeof value?.error === "string" && value.error
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

export async function acquireMacDesktopAppHostLease(
  primarySocketPath,
  { provider, pipePath, appPath, toolsEnabled },
) {
  if (process.platform !== "darwin") {
    throw new Error("Codex Desktop App 可信 Host 只支持 macOS");
  }
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
      () => fail("Codex Desktop App Host 附加超时"),
      20_000,
    );
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        action: "leaseDesktopApp",
        desktopAppHostProtocolVersion,
        provider,
        pipePath,
        appPath,
        toolsEnabled,
      })}\n`);
    });
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > maximumResponseBytes) {
        fail("Codex Desktop App Host 响应过大");
        return;
      }
      const newline = response.indexOf(0x0a);
      if (newline < 0) return;
      let value;
      try {
        value = JSON.parse(response.subarray(0, newline).toString("utf8"));
      } catch {
        fail("Codex Desktop App Host 没有有效响应");
        return;
      }
      if (
        value?.version !== protocolVersion
        || value.desktopAppHostProtocolVersion !== desktopAppHostProtocolVersion
        || value.provider !== provider
        || value.ok !== true
      ) {
        fail(
          supervisorVersionMismatch(value)
            ? supervisorVersionMismatchMessage(value)
            : value?.desktopAppHostProtocolVersion !== desktopAppHostProtocolVersion
              ? "App Server 服务不支持当前 Desktop Host；请重启 App Server 服务后重试"
              : typeof value?.error === "string" && value.error
                ? value.error
                : "Codex Desktop App Host 附加失败",
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
    socket.once("error", () => fail("Codex Desktop App Host 连接失败"));
    socket.once("end", () => fail("Codex Desktop App Host 连接提前关闭"));
  });
}

export async function releaseAppServerProvider(primarySocketPath, provider) {
  const socketPath = appServerSupervisorSocketPath(primarySocketPath);
  assertSafeSupervisorSocket(socketPath);
  const response = await readSupervisorResponse(socketPath, {
    action: "releaseProvider",
    provider,
  }, 15_000);
  if (response === undefined) {
    throw new Error(
      `无法连接 App Server 监管入口：${socketPath}；`
      + "请运行 codexc status appserver 确认服务正在运行",
    );
  }
  let value;
  try {
    value = JSON.parse(response.trim());
  } catch {
    throw new Error(`模型 Provider 释放请求没有有效响应：${provider}`);
  }
  if (value?.version !== protocolVersion || value.provider !== provider || value.ok !== true) {
    throw new Error(
      supervisorVersionMismatch(value)
        ? supervisorVersionMismatchMessage(value)
        : typeof value?.error === "string" && value.error
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

/** Cancellation withdraws work before release; an already released instance is restored by its owner. */
export async function applyAppServerProviderSettings(primarySocketPath, provider, signal) {
  signal?.throwIfAborted();
  const socketPath = appServerSupervisorSocketPath(primarySocketPath);
  assertSafeSupervisorSocket(socketPath);
  const response = await readSupervisorResponse(socketPath, {
    action: "applyProviderSettings", settingsProtocolVersion: providerSettingsProtocolVersion, provider,
  }, providerSettingsTimeoutMs, signal);
  signal?.throwIfAborted();
  let value;
  try { value = JSON.parse(response); } catch { throw new Error("Provider 设置应用未确认"); }
  if (value?.version !== protocolVersion || value.settingsProtocolVersion !== providerSettingsProtocolVersion) {
    throw new Error("App Server 监管入口不支持定向设置应用，请运行 codexc restart appserver 后重试");
  }
  if (value.provider !== provider || value.ok !== true
    || Object.keys(value).some(key => !["version", "settingsProtocolVersion", "provider", "ok", "applied", "reason", "changed", "snapshot"].includes(key))) {
    throw new Error("Provider 设置应用失败");
  }
  const snapshot = value.snapshot;
  if (snapshot !== undefined && (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || Object.keys(snapshot).length !== 2 || typeof snapshot.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(snapshot.fingerprint)
    || !(snapshot.defaultModel === null || (typeof snapshot.defaultModel === "string" && snapshot.defaultModel.length > 0)))) {
    throw new Error("Provider 设置应用快照无效");
  }
  const captured = snapshot === undefined ? {} : { snapshot };
  if (value.applied === true && value.reason === undefined && typeof value.changed === "boolean") return { applied: true, changed: value.changed, ...captured };
  if (value.applied === false && value.changed === undefined && ["leased", "active"].includes(value.reason)) return { applied: false, reason: value.reason, ...captured };
  throw new Error("Provider 设置应用响应无效");
}

export function readAppServerProviderSettingsFingerprint(provider, environment = process.env) {
  const definition = loadManagedModelProviderDefinitions(environment).find(value => value.id === provider);
  if (!definition) throw new Error("Provider 不属于受管设置范围");
  const marker = readManagedMarker(environment, definition);
  if (!marker) throw new Error("Provider 管理标记不可用");
  const profilePath = join(codexHomePath(environment), marker.mode === "exclusive" ? "config.toml" : definition.profileFileName);
  const parts = [
    readPrivateFileSync(managedProviderMarkerPath(environment, definition)),
    marker.mode === "exclusive" ? readCodexConfigFile(profilePath) : readPrivateFileSync(profilePath),
    readPrivateFileSync(join(managedProviderDirectory(environment, definition), definition.catalogFileName), 2_097_152),
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function supervisorVersionMismatch(value) {
  return typeof value?.version === "number" && value.version !== protocolVersion;
}

function supervisorVersionMismatchMessage(value) {
  return `App Server 监管协议版本不匹配（服务 ${value.version}，客户端 ${protocolVersion}）；`
    + "请运行 codexc restart all 后重试";
}

function assertSafeSupervisorSocket(socketPath) {
  if (process.platform === "win32") return assertPrivateIpcEndpointSync(socketPath);
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
  if (process.platform === "win32") {
    for (const directory of new Set(socketPaths.map((socketPath) => dirname(socketPath)))) {
      const existing = lstatSync(directory, { throwIfNoEntry: false });
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!existing) securePrivateDirectorySync(directory);
      secureAppServerSocketDirectorySync(directory);
    }
  }
  const occupied = await Promise.all(
    socketPaths.map((socketPath) => appServerSocketAcceptsWebSocket(socketPath)),
  );
  if (occupied.some(Boolean)) {
    throw new Error(
      "App Server Socket 已被未受监管的进程占用；请先停止现有 App Server 后重试",
    );
  }
  if (process.platform === "win32") return;
  for (const socketPath of socketPaths) {
    preserveStaleSocket(socketPath);
  }
}

export async function appServerSocketAcceptsWebSocket(socketPath) {
  if (process.platform === "win32") {
    const parent = lstatSync(dirname(socketPath), { throwIfNoEntry: false });
    if (!parent) return false;
    assertPrivateDirectoryAccessSync(dirname(socketPath));
    return windowsAppServerProxyAcceptsWebSocket(socketPath);
  }
  if (!lstatSync(dirname(socketPath), { throwIfNoEntry: false })) return false;
  const endpoint = inspectAppServerUnixSocket(socketPath);
  if (!endpoint?.available) return false;
  return new Promise((resolveCheck) => {
    const socket = new WebSocket("ws://localhost/", {
      perMessageDeflate: false,
      createConnection: () => createConnection(endpoint.path),
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

function readSupervisorResponse(socketPath, request, timeoutMs = 1_000, signal) {
  return new Promise((resolveResponse) => {
    const socket = process.platform === "win32"
      ? createPrivateIpcConnection(socketPath)
      : createConnection(socketPath);
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      resolveResponse(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const abort = () => finish(undefined);
    signal?.addEventListener("abort", abort, { once: true });
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
    if (signal?.aborted) abort();
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
    || !validProviderStateList(value.runningProviders, providerIds(value))
    || !validProviderStateList(value.releasedProviders, providerIds(value))
    || !validProviderStateList(value.leasedProviders, providerIds(value))
    || (
      value.desktopAppHostProtocolVersion !== undefined
      && value.desktopAppHostProtocolVersion !== desktopAppHostProtocolVersion
    )
    || (value.desktopAppProviderProtocolVersion !== undefined
      && value.desktopAppProviderProtocolVersion !== desktopAppProviderProtocolVersion)
    || (
      value.desktopAppAttached !== undefined
      && typeof value.desktopAppAttached !== "boolean"
    )
    || (value.desktopAppProvider !== undefined
      && (!providerIds(value).includes(value.desktopAppProvider) || value.desktopAppAttached !== true))
  ) {
    return undefined;
  }
  return value;
}

function providerIds(value) {
  return [value.primaryProvider, ...value.managedProviders];
}

function validProviderStateList(value, providerIds) {
  return Array.isArray(value)
    && value.every((provider) =>
      providerIdPattern.test(provider) && providerIds.includes(provider))
    && new Set(value).size === value.length;
}

function preserveStaleSocket(socketPath) {
  const status = lstatSync(socketPath, { throwIfNoEntry: false });
  if (!status) return;
  const endpoint = inspectAppServerUnixSocket(socketPath);
  if (!endpoint || endpoint.identity.dev !== status.dev || endpoint.identity.ino !== status.ino) {
    throw new Error("App Server Socket 在检查期间发生变化");
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

async function windowsAppServerProxyAcceptsWebSocket(socketPath) {
  const invocation = resolveExecutableInvocation(
    process.env.CODEX_BINARY || "codex",
    ["app-server", "proxy", "--sock", socketPath],
  );
  const child = spawn(invocation.file, invocation.args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  child.stderr.resume();
  const connection = new AppServerProxyDuplex(child.stdout, child.stdin);
  const socket = new WebSocket("ws://localhost/", {
    perMessageDeflate: false,
    handshakeTimeout: 1_500,
    createConnection: () => connection,
  });
  return new Promise((resolveCheck) => {
    let settled = false;
    const finish = (healthy) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.once("error", () => undefined);
      socket.terminate();
      connection.destroy();
      void stopProxyChild(child).then(() => resolveCheck(healthy));
    };
    socket.once("open", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
    child.once("error", () => finish(false));
    child.once("exit", () => finish(false));
  });
}

class AppServerProxyDuplex extends Duplex {
  constructor(source, sink) {
    super();
    this.source = source;
    this.sink = sink;
    source.on("data", (chunk) => {
      if (!this.push(chunk)) source.pause();
    });
    source.once("end", () => this.push(null));
    source.once("error", (error) => this.destroy(error));
    sink.once("error", (error) => this.destroy(error));
  }

  _read() {
    this.source.resume();
  }

  _write(chunk, encoding, callback) {
    this.sink.write(chunk, encoding, callback);
  }

  _final(callback) {
    this.sink.end(callback);
  }

  _destroy(error, callback) {
    this.source.destroy();
    this.sink.destroy();
    callback(error);
  }

  setTimeout(_timeout, callback) {
    if (callback) this.once("timeout", callback);
    return this;
  }

  setNoDelay() {
    return this;
  }

  setKeepAlive() {
    return this;
  }
}

async function stopProxyChild(child) {
  if (child.exitCode !== null) return;
  child.stdin.end();
  if (await waitForChildExit(child, 1_000)) return;
  await terminateChildProcess(child, { gracePeriodMs: 0, forcePeriodMs: 1_000 });
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolveWait(false);
    }, timeoutMs);
    timer.unref();
    const onExit = () => {
      clearTimeout(timer);
      resolveWait(true);
    };
    child.once("exit", onExit);
  });
}
