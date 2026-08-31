import { chmodSync, lstatSync, unlinkSync, type Stats } from "node:fs";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";

import {
  createPrivateIpcConnection,
  PrivateIpcServer,
} from "../../runtime/private-ipc.mjs";

import type { ProviderProxyMetrics } from "./proxy.js";

const maximumMetricsBytes = 8_192;

export class ProviderProxyMetricsServer {
  private readonly server: Server | undefined;
  private readonly windowsServer: PrivateIpcServer | undefined;
  private readonly sockets = new Set<Socket>();
  private socketIdentity: Pick<Stats, "dev" | "ino"> | undefined;
  private started = false;
  private stopped = false;

  constructor(
    private readonly socketPath: string,
    private readonly onMetrics: (metrics: ProviderProxyMetrics) => void,
    private readonly onError?: (error: Error) => void,
  ) {
    const listener = (socket: Socket): void => this.handleConnection(socket);
    if (process.platform === "win32") {
      this.windowsServer = new PrivateIpcServer(this.socketPath, listener);
      this.server = undefined;
    } else {
      this.server = createServer({ allowHalfOpen: true }, listener);
      this.windowsServer = undefined;
    }
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (process.platform !== "win32") {
      await removeStaleUnixSocket(this.socketPath);
      await listenUnixServer(this.server!, this.socketPath);
      try {
        const status = lstatSync(this.socketPath);
        this.socketIdentity = { dev: status.dev, ino: status.ino };
        chmodSync(this.socketPath, 0o600);
        this.started = true;
      } catch (error) {
        await this.close();
        throw error;
      }
      return;
    }
    try {
      await this.windowsServer!.start(`模型代理指标 Socket 已被占用：${this.socketPath}`);
      this.started = true;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    if (process.platform === "win32") {
      await this.windowsServer!.close();
      return;
    }
    if (this.server!.listening) {
      await new Promise<void>((resolveClose) => {
        this.server!.close(() => resolveClose());
      });
    }
    unlinkOwnedUnixSocket(this.socketPath, this.socketIdentity);
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    let bytes = 0;
    const chunks: Buffer[] = [];
    let handled = false;
    socket.on("data", (chunk: Buffer) => {
      if (handled) {
        return;
      }
      bytes += chunk.length;
      if (bytes > maximumMetricsBytes) {
        socket.destroy(new Error("模型代理指标超过大小限制"));
        return;
      }
      chunks.push(chunk);
      const payload = Buffer.concat(chunks);
      const newline = payload.indexOf(10);
      if (newline < 0) {
        return;
      }
      handled = true;
      socket.pause();
      try {
        const metrics = parseMetrics(payload.subarray(0, newline).toString("utf8"));
        if (metrics) {
          this.onMetrics(metrics);
        }
      } catch (error) {
        this.onError?.(asError(error));
      } finally {
        socket.end("ok\n");
      }
    });
    socket.on("end", () => {
      if (!handled) {
        socket.end();
      }
    });
    socket.on("error", (error) => this.onError?.(asError(error)));
    socket.on("close", () => this.sockets.delete(socket));
  }
}

export function sendProviderProxyMetrics(
  socketPath: string,
  metrics: ProviderProxyMetrics,
): Promise<void> {
  return new Promise((resolve) => {
    let socket: Socket;
    try {
      socket = process.platform === "win32"
        ? createPrivateIpcConnection(socketPath)
        : createConnection(socketPath);
    } catch {
      resolve();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve();
    };
    socket.setTimeout(1_000, finish);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(metrics)}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      if (chunk.includes(10)) {
        finish();
      }
    });
    socket.once("end", finish);
    socket.once("error", finish);
  });
}

async function removeStaleUnixSocket(socketPath: string): Promise<void> {
  const status = lstatSync(socketPath, { throwIfNoEntry: false });
  if (!status) return;
  if (!status.isSocket() || status.uid !== process.getuid?.()) {
    throw new Error(`模型代理指标 Socket 路径已存在且不安全：${socketPath}`);
  }
  if (await unixSocketAcceptsConnections(socketPath)) {
    throw new Error(`模型代理指标 Socket 已被占用：${socketPath}`);
  }
  unlinkSync(socketPath);
}

function unixSocketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function listenUnixServer(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function unlinkOwnedUnixSocket(
  socketPath: string,
  identity: Pick<Stats, "dev" | "ino"> | undefined,
): void {
  if (!identity) return;
  const status = lstatSync(socketPath, { throwIfNoEntry: false });
  if (status?.isSocket() && status.dev === identity.dev && status.ino === identity.ino) {
    unlinkSync(socketPath);
  }
}

function parseMetrics(value: string): ProviderProxyMetrics | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    !oneOf(record.transport, ["http", "websocket"])
    || !oneOf(record.responseFormat, ["sse", "json", "websocket", "unknown"])
    || !oneOf(record.operation, ["response", "compact"])
    || !nullableString(record.threadId)
    || !nullableString(record.turnId)
    || !nullableString(record.model)
    || !nullableString(record.serviceTier)
    || !oneOf(record.status, ["completed", "failed", "incomplete", "unknown"])
    || !nullableHttpStatus(record.httpStatus)
    || !nullableString(record.errorType)
    || !nullableString(record.errorCode)
    || (record.errorMessage !== undefined && !nullableMessage(record.errorMessage))
    || !nullableString(record.incompleteReason)
    || !nullableTokenCount(record.inputTokens)
    || !nullableTokenCount(record.cachedInputTokens)
    || !nullableTokenCount(record.outputTokens)
    || !nullableTokenCount(record.reasoningOutputTokens)
    || !nullableTokenCount(record.totalTokens)
    || !nullableFiniteNumber(record.upstreamCreatedAt)
    || !nullableFiniteNumber(record.upstreamCompletedAt)
    || !finiteNumber(record.requestStartedAtMs)
    || !nullableFiniteNumber(record.firstTokenAtMs)
    || !nullableFiniteNumber(record.firstReasoningDeltaAtMs)
    || !nullableFiniteNumber(record.lastReasoningDeltaAtMs)
    || !nullableFiniteNumber(record.firstOutputDeltaAtMs)
    || !nullableFiniteNumber(record.lastOutputDeltaAtMs)
    || !finiteNumber(record.responseCompletedAtMs)
  ) {
    return undefined;
  }
  const weeklyQuota = record.weeklyQuota;
  if (weeklyQuota !== undefined && !nullableWeeklyQuota(weeklyQuota)) {
    return undefined;
  }
  const quotaWindows = record.quotaWindows;
  if (quotaWindows !== undefined && !nullableQuotaWindows(quotaWindows)) {
    return undefined;
  }
  const quota = weeklyQuota as Record<string, unknown> | null | undefined;
  return {
    ...record,
    reasoningEffort: normalizeReasoningEffort(record.reasoningEffort),
    errorMessage: typeof record.errorMessage === "string"
      ? record.errorMessage
      : null,
    weeklyQuota: quota === null || quota === undefined
      ? null
      : { ...quota, planType: quota.planType ?? null },
    quotaWindows: quotaWindows === null || quotaWindows === undefined
      ? null
      : quotaWindows,
  } as unknown as ProviderProxyMetrics;
}

function normalizeReasoningEffort(value: unknown): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(value)
    ? value
    : null;
}

function nullableQuotaWindows(value: unknown): boolean {
  if (value === null) return true;
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const window = entry as Record<string, unknown>;
    return typeof window.windowId === "string"
      && window.windowId.length > 0
      && window.windowId.length <= 64
      && (
        window.resetsAt === null
        || (
          typeof window.resetsAt === "number"
          && Number.isSafeInteger(window.resetsAt)
          && window.resetsAt >= 0
        )
      );
  });
}

function nullableWeeklyQuota(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const quota = value as Record<string, unknown>;
  return quota.limitId === "codex"
    && typeof quota.usedPercentMillionths === "number"
    && Number.isSafeInteger(quota.usedPercentMillionths)
    && quota.usedPercentMillionths >= 0
    && quota.usedPercentMillionths <= 100_000_000
    && typeof quota.resetsAt === "number"
    && Number.isSafeInteger(quota.resetsAt)
    && quota.resetsAt >= 0
    && (
      quota.planType === undefined
      || quota.planType === null
      || (
        typeof quota.planType === "string"
        && quota.planType.length > 0
        && quota.planType.length <= 64
      )
    );
}

function oneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function nullableString(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.length <= 128);
}

function nullableMessage(value: unknown): boolean {
  return value === null
    || (typeof value === "string" && value.length > 0 && value.length <= 500);
}

function finiteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nullableFiniteNumber(value: unknown): boolean {
  return value === null || finiteNumber(value);
}

function nullableTokenCount(value: unknown): boolean {
  return value === null
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function nullableHttpStatus(value: unknown): boolean {
  return value === null
    || (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
