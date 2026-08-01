import {
  createServer,
  request as httpRequest,
  type Agent,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { StringDecoder } from "node:string_decoder";

export interface ProviderProxyMetrics {
  threadId: string | null;
  turnId: string | null;
  requestStartedAtMs: number;
  firstReasoningDeltaAtMs: number | null;
  lastReasoningDeltaAtMs: number | null;
}

export interface ProviderProxyOptions {
  upstreamAgent?: Agent;
  upstreamHost: string;
  upstreamPort?: number;
  upstreamProtocol?: "http" | "https";
  timeoutMs?: number;
  onMetrics?: (metrics: ProviderProxyMetrics) => void | Promise<void>;
  onError?: (error: Error) => void;
}

interface TurnMetadata {
  threadId: string | null;
  turnId: string | null;
}

export class ProviderProxy {
  private readonly server: Server;
  private readonly upstreamAgent: Agent | undefined;
  private readonly upstreamHost: string;
  private readonly upstreamPort: number | undefined;
  private readonly upstreamProtocol: "http" | "https";
  private readonly timeoutMs: number;
  private readonly onMetrics:
    | ((metrics: ProviderProxyMetrics) => void | Promise<void>)
    | undefined;
  private readonly onError: ((error: Error) => void) | undefined;
  private started = false;
  private stopped = false;

  constructor(private readonly listenAddress: string, options: ProviderProxyOptions) {
    this.upstreamAgent = options.upstreamAgent;
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
    if (!isResponsesPath(request.url)) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: { type: "provider_proxy_unsupported_path" },
      }));
      return;
    }

    const metadata = parseTurnMetadata(request.headers["x-codex-turn-metadata"]);
    const requestStartedAtMs = Date.now();
    let firstReasoningDeltaAtMs: number | null = null;
    let lastReasoningDeltaAtMs: number | null = null;
    let metricsEmitted = false;
    let metricsBarrierConsumed = false;
    let metricsDelivery: Promise<void> | undefined;
    const emitMetrics = (): Promise<void> => {
      if (metricsDelivery) {
        return metricsDelivery;
      }
      metricsEmitted = true;
      try {
        metricsDelivery = Promise.resolve(this.onMetrics?.({
          threadId: metadata.threadId,
          turnId: metadata.turnId,
          requestStartedAtMs,
          firstReasoningDeltaAtMs,
          lastReasoningDeltaAtMs,
        })).catch((error) => {
          this.onError?.(asError(error));
        });
      } catch (error) {
        this.onError?.(asError(error));
        metricsDelivery = Promise.resolve();
      }
      return metricsDelivery;
    };

    const upstreamRequest = this.upstreamProtocol === "http"
      ? httpRequest
      : httpsRequest;
    const upstream = upstreamRequest({
      agent: this.upstreamAgent,
      hostname: this.upstreamHost,
      ...(this.upstreamPort === undefined ? {} : { port: this.upstreamPort }),
      path: request.url ?? "/responses",
      method: request.method,
      headers: forwardedRequestHeaders(
        request.headers,
        this.upstreamHost,
        this.upstreamPort,
      ),
    }, (upstreamResponse) => {
      const responseHeaders = endToEndHeaders(upstreamResponse.headers);
      if (upstreamResponse.statusMessage) {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage,
          responseHeaders,
        );
      } else {
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      }
      const decoder = new StringDecoder("utf8");
      let pending = "";
      let currentEvent = "";
      const processLine = (line: string, receivedAtMs: number): void => {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
          return;
        }
        if (!line.startsWith("data:")) {
          return;
        }
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") {
          return;
        }
        const parsed = parseJsonPayload(payload);
        const type = typeof parsed?.type === "string" ? parsed.type : currentEvent;
        if (type.includes("reasoning_text.delta")) {
          firstReasoningDeltaAtMs ??= receivedAtMs;
          lastReasoningDeltaAtMs = receivedAtMs;
          return;
        }
        if (
          type.includes("output_text.delta")
          || type === "response.completed"
        ) {
          if (!metricsEmitted && firstReasoningDeltaAtMs !== null) {
            void emitMetrics();
          }
        }
      };
      const processText = (text: string, receivedAtMs: number): void => {
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          processLine(line, receivedAtMs);
        }
      };

      upstreamResponse.on("data", (chunk: Buffer) => {
        const receivedAtMs = Date.now();
        processText(decoder.write(chunk), receivedAtMs);
        const pendingMetrics = metricsDelivery;
        if (pendingMetrics && !metricsBarrierConsumed) {
          metricsBarrierConsumed = true;
          upstreamResponse.pause();
          void pendingMetrics.finally(() => {
            forwardResponseChunk(response, upstreamResponse, chunk);
          });
          return;
        }
        forwardResponseChunk(response, upstreamResponse, chunk);
      });
      upstreamResponse.on("end", () => {
        processText(decoder.end(), Date.now());
        if (pending) {
          processLine(pending.trimEnd(), Date.now());
        }
        if (!metricsEmitted) {
          void emitMetrics();
        }
        void (metricsDelivery ?? Promise.resolve()).finally(() => response.end());
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
    request.on("error", (error) => {
      upstream.destroy();
      this.onError?.(asError(error));
      response.destroy();
    });
    response.on("close", () => {
      if (!response.writableEnded) {
        upstream.destroy();
      }
    });
    request.pipe(upstream);
  }
}

function forwardResponseChunk(
  response: ServerResponse,
  upstreamResponse: IncomingMessage,
  chunk: Buffer,
): void {
  if (response.destroyed || response.writableEnded) {
    upstreamResponse.destroy();
    return;
  }
  if (response.write(chunk)) {
    upstreamResponse.resume();
    return;
  }
  upstreamResponse.pause();
  response.once("drain", () => upstreamResponse.resume());
}

function isResponsesPath(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    return new URL(value, "http://127.0.0.1").pathname === "/responses";
  } catch {
    return false;
  }
}

function forwardedRequestHeaders(
  headers: IncomingHttpHeaders,
  upstreamHost: string,
  upstreamPort: number | undefined,
): IncomingHttpHeaders {
  const forwarded = endToEndHeaders(headers);
  delete forwarded["x-codex-turn-metadata"];
  forwarded.host = upstreamPort === undefined
    ? upstreamHost
    : `${upstreamHost}:${upstreamPort}`;
  return forwarded;
}

function endToEndHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  const connectionTokens = typeof headers.connection === "string"
    ? headers.connection.split(",").map((value) => value.trim().toLowerCase())
    : [];
  for (const name of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    ...connectionTokens,
  ]) {
    delete result[name];
  }
  return result;
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
