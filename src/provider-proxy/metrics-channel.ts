import {
  chmodSync,
  lstatSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";

import type { ProviderProxyMetrics } from "./proxy.js";

const maximumMetricsBytes = 8_192;

export class ProviderProxyMetricsServer {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private socketIdentity: Pick<Stats, "dev" | "ino"> | undefined;
  private started = false;
  private stopped = false;

  constructor(
    private readonly socketPath: string,
    private readonly onMetrics: (metrics: ProviderProxyMetrics) => void,
    private readonly onError?: (error: Error) => void,
  ) {
    this.server = createServer({ allowHalfOpen: true }, (socket) => {
      this.handleConnection(socket);
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await removeStaleSocket(this.socketPath);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.removeListener("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.socketPath);
    });
    try {
      const status = lstatSync(this.socketPath);
      this.socketIdentity = { dev: status.dev, ino: status.ino };
      chmodSync(this.socketPath, 0o600);
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
    if (this.server.listening) {
      await new Promise<void>((resolveClose) => {
        this.server.close(() => resolveClose());
      });
    }
    unlinkOwnedSocket(this.socketPath, this.socketIdentity);
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    let bytes = 0;
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximumMetricsBytes) {
        socket.destroy(new Error("模型代理指标超过大小限制"));
        return;
      }
      chunks.push(chunk);
    });
    socket.on("end", () => {
      try {
        const metrics = parseMetrics(Buffer.concat(chunks).toString("utf8"));
        if (metrics) {
          this.onMetrics(metrics);
        }
      } catch (error) {
        this.onError?.(asError(error));
      } finally {
        socket.end("ok\n");
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
    const socket = createConnection(socketPath);
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
      socket.end(`${JSON.stringify(metrics)}\n`);
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

async function removeStaleSocket(socketPath: string): Promise<void> {
  const status = lstatSync(socketPath, { throwIfNoEntry: false });
  if (!status) {
    return;
  }
  if (!status.isSocket() || status.uid !== process.getuid?.()) {
    throw new Error(`模型代理指标 Socket 路径已存在且不安全：${socketPath}`);
  }
  if (await socketAcceptsConnections(socketPath)) {
    throw new Error(`模型代理指标 Socket 已被占用：${socketPath}`);
  }
  unlinkSync(socketPath);
}

function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function unlinkOwnedSocket(
  socketPath: string,
  identity: Pick<Stats, "dev" | "ino"> | undefined,
): void {
  if (!identity) {
    return;
  }
  const status = lstatSync(socketPath, { throwIfNoEntry: false });
  if (
    status?.isSocket()
    && status.dev === identity.dev
    && status.ino === identity.ino
  ) {
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
  return record as unknown as ProviderProxyMetrics;
}

function oneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function nullableString(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.length <= 128);
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
