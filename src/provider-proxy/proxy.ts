import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";

export interface ProviderProxyMetrics {
  threadId: string | null;
  turnId: string | null;
  requestStartedAtMs: number;
  firstResponseByteAtMs: number | null;
  firstReasoningDeltaAtMs: number | null;
  lastReasoningDeltaAtMs: number | null;
  firstOutputDeltaAtMs: number | null;
  lastOutputDeltaAtMs: number | null;
}

export interface ProviderProxyOptions {
  upstreamHost: string;
  upstreamPort?: number;
  upstreamProtocol?: "http" | "https";
  timeoutMs?: number;
  onMetrics?: (metrics: ProviderProxyMetrics) => void;
  onError?: (error: Error) => void;
}

interface TurnMetadata {
  threadId: string | null;
  turnId: string | null;
}

export class ProviderProxy {
  private readonly server: Server;
  private readonly upstreamHost: string;
  private readonly upstreamPort: number | undefined;
  private readonly upstreamProtocol: "http" | "https";
  private readonly timeoutMs: number;
  private readonly onMetrics: ((metrics: ProviderProxyMetrics) => void) | undefined;
  private readonly onError: ((error: Error) => void) | undefined;
  private started = false;
  private stopped = false;

  constructor(private readonly listenAddress: string, options: ProviderProxyOptions) {
    this.upstreamHost = options.upstreamHost;
    this.upstreamPort = options.upstreamPort;
    this.upstreamProtocol = options.upstreamProtocol ?? "https";
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.onMetrics = options.onMetrics;
    this.onError = options.onError;
    this.server = createServer((request, response) => {
      this.handleRequest(request, response);
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onListenError = (error: Error): void => {
        this.server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.removeListener("error", onListenError);
        resolve();
      };
      this.server.once("error", onListenError);
      this.server.once("listening", onListening);
      const { host, port } = parseListenAddress(this.listenAddress);
      this.server.listen(port, host);
    });
    this.started = true;
  }

  address(): string {
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      return this.listenAddress;
    }
    return `127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    if (!this.started || this.stopped) {
      return;
    }
    this.stopped = true;
    this.server.closeAllConnections?.();
    await new Promise<void>((resolveClose) => {
      this.server.close(() => resolveClose());
    });
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    if (!request.url?.startsWith("/responses")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: { type: "provider_proxy_unsupported_path" },
      }));
      return;
    }
    const requestChunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => requestChunks.push(chunk));
    request.on("error", (error) => {
      this.onError?.(asError(error));
      response.destroy();
    });
    request.on("end", () => {
      const body = Buffer.concat(requestChunks);
      const metadata = parseTurnMetadata(request.headers["x-codex-turn-metadata"]);
      const requestStartedAtMs = Date.now();
      let firstResponseByteAtMs: number | null = null;
      let firstReasoningDeltaAtMs: number | null = null;
      let lastReasoningDeltaAtMs: number | null = null;
      let firstOutputDeltaAtMs: number | null = null;
      let lastOutputDeltaAtMs: number | null = null;
      const upstreamRequest = this.upstreamProtocol === "http"
        ? httpRequest
        : httpsRequest;
      const upstream = upstreamRequest({
        hostname: this.upstreamHost,
        ...(this.upstreamPort === undefined ? {} : { port: this.upstreamPort }),
        path: request.url ?? "/",
        method: request.method,
        headers: {
          ...request.headers,
          host: this.upstreamPort === undefined
            ? this.upstreamHost
            : `${this.upstreamHost}:${this.upstreamPort}`,
        },
      }, (upstreamResponse) => {
        let pending = "";
        let currentEvent = "";
        upstreamResponse.on("data", (chunk: Buffer) => {
          const receivedAtMs = Date.now();
          firstResponseByteAtMs ??= receivedAtMs;
          const canContinue = response.write(chunk);
          if (!canContinue) {
            upstreamResponse.pause();
            response.once("drain", () => upstreamResponse.resume());
          }
          pending += chunk.toString("utf8");
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
              continue;
            }
            if (!line.startsWith("data:")) {
              continue;
            }
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") {
              continue;
            }
            const parsed = parseJsonPayload(payload);
            const type = typeof parsed?.type === "string"
              ? parsed.type
              : currentEvent;
            if (type.includes("reasoning_text.delta")) {
              firstReasoningDeltaAtMs ??= receivedAtMs;
              lastReasoningDeltaAtMs = receivedAtMs;
            } else if (type.includes("output_text.delta")) {
              firstOutputDeltaAtMs ??= receivedAtMs;
              lastOutputDeltaAtMs = receivedAtMs;
            }
          }
        });
        upstreamResponse.on("end", () => {
          const tail = pending.trimEnd();
          if (tail.startsWith("data:")) {
            const payload = tail.slice(5).trim();
            if (payload && payload !== "[DONE]") {
              const parsed = parseJsonPayload(payload);
              const type = typeof parsed?.type === "string"
                ? parsed.type
                : currentEvent;
              const receivedAtMs = Date.now();
              if (type.includes("reasoning_text.delta")) {
                firstReasoningDeltaAtMs ??= receivedAtMs;
                lastReasoningDeltaAtMs = receivedAtMs;
              } else if (type.includes("output_text.delta")) {
                firstOutputDeltaAtMs ??= receivedAtMs;
                lastOutputDeltaAtMs = receivedAtMs;
              }
            }
          }
          response.end();
          this.onMetrics?.({
            threadId: metadata.threadId,
            turnId: metadata.turnId,
            requestStartedAtMs,
            firstResponseByteAtMs,
            firstReasoningDeltaAtMs,
            lastReasoningDeltaAtMs,
            firstOutputDeltaAtMs,
            lastOutputDeltaAtMs,
          });
        });
        upstreamResponse.on("error", (error) => {
          response.destroy();
          this.onError?.(asError(error));
        });
      });
      upstream.setTimeout(this.timeoutMs, () => {
        upstream.destroy(new Error(`模型上游响应超时：${this.timeoutMs}ms`));
      });
      upstream.on("error", (error) => {
        if (!response.headersSent) {
          response.writeHead(502, { "content-type": "application/json" });
          response.end(JSON.stringify({
            error: { type: "provider_proxy_upstream_error" },
          }));
        } else {
          response.destroy();
        }
        this.onError?.(asError(error));
      });
      response.on("close", () => {
        if (!response.writableEnded) {
          upstream.destroy();
        }
      });
      upstream.write(body);
      upstream.end();
    });
  }
}

function parseTurnMetadata(value: string | string[] | undefined): TurnMetadata {
  if (typeof value !== "string") {
    return { threadId: null, turnId: null };
  }
  const parsed = parseJsonPayload(value);
  if (!parsed) {
    return { threadId: null, turnId: null };
  }
  return {
    threadId: nonEmptyString(parsed.thread_id),
    turnId: nonEmptyString(parsed.turn_id),
  };
}

function parseJsonPayload(
  payload: string,
): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseListenAddress(value: string): { host: string; port: number } {
  const separatorIndex = value.lastIndexOf(":");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error(`代理监听地址无效：${value}`);
  }
  const host = value.slice(0, separatorIndex);
  const port = Number(value.slice(separatorIndex + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`代理监听端口无效：${value}`);
  }
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error(`代理监听地址必须为回环地址：${value}`);
  }
  return { host, port };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
