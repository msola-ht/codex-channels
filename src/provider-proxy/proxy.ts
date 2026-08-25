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
import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import WebSocket, {
  WebSocketServer,
  type RawData,
} from "ws";

import {
  endToEndHeaders,
  forwardedRequestHeaders,
  forwardedWebSocketHeaders,
  isOpenAiRealtimeWebSocketPath,
  isResponsesPath,
  isResponsesRequestPath,
  isSupportedHttpRequest,
  parseListenAddress,
  resolveAccountPath,
  responseOperation,
  upstreamPath,
  upstreamWebSocketPath,
  websocketProtocols,
} from "./request-routing.js";

const maximumJsonMetadataBytes = 1_048_576;
const maximumSseMetadataLineCharacters = 1_048_576;
const weeklyWindowMinutes = 7 * 24 * 60;
const percentScale = 1_000_000;

export interface ProviderWeeklyQuotaSnapshot {
  limitId: "codex";
  usedPercentMillionths: number;
  resetsAt: number;
  planType: string | null;
}

export interface ProviderQuotaWindowSnapshot {
  windowId: string;
  resetsAt: number | null;
}

export interface ProviderProxyMetrics {
  transport: "http" | "websocket";
  responseFormat: "sse" | "json" | "websocket" | "unknown";
  operation: "response" | "compact";
  threadId: string | null;
  turnId: string | null;
  model: string | null;
  serviceTier: string | null;
  reasoningEffort: string | null;
  status: "completed" | "failed" | "incomplete" | "unknown";
  httpStatus: number | null;
  errorType: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  incompleteReason: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  upstreamCreatedAt: number | null;
  upstreamCompletedAt: number | null;
  requestStartedAtMs: number;
  firstTokenAtMs: number | null;
  firstReasoningDeltaAtMs: number | null;
  lastReasoningDeltaAtMs: number | null;
  firstOutputDeltaAtMs: number | null;
  lastOutputDeltaAtMs: number | null;
  responseCompletedAtMs: number;
  weeklyQuota: ProviderWeeklyQuotaSnapshot | null;
  /** 请求完成时对应的官方配额窗口快照（如 OpenCode Go 5h/7d/月），缺省为 null。 */
  quotaWindows: readonly ProviderQuotaWindowSnapshot[] | null;
}

export interface ProviderProxyUpstream {
  agent?: Agent;
  host: string;
  port?: number;
  protocol: "http" | "https";
  basePath?: string;
}

export interface ProviderProxyOptions {
  upstreamAgent?: Agent;
  upstreamHost: string;
  upstreamPort?: number;
  upstreamProtocol?: "http" | "https";
  upstreamBasePath?: string;
  /** 仅官方 OpenAI 主代理启用的 Codex 0.148.0 API 路径。 */
  allowOpenAiApiPaths?: boolean;
  /** 共享代理按 `/go/<account>/...` 前缀区分的账户 id（OpenCode Go 共享代理） */
  accountIds?: readonly string[];
  /** 共享代理无账户前缀请求归属的默认账户。 */
  defaultAccountId?: string;
  /** 私有 `/role/external` 路径对应的 agents.external 默认思考等级。 */
  externalRoleReasoningEffort?: string;
  resolveUpstream?: (headers: IncomingHttpHeaders) => ProviderProxyUpstream;
  timeoutMs?: number;
  quotaWindowsProvider?: (
    accountId?: string,
  ) => Promise<readonly ProviderQuotaWindowSnapshot[] | null>;
  onMetrics?: (
    metrics: ProviderProxyMetrics,
    accountId?: string,
  ) => void | Promise<void>;
  onError?: (error: Error) => void;
}

interface TurnMetadata {
  threadId: string | null;
  turnId: string | null;
  operation: ProviderProxyMetrics["operation"];
}

interface MetricsState extends ProviderProxyMetrics {
  responseCompletedAtMs: number;
}

export class ProviderProxy {
  private readonly server: Server;
  private readonly websocketServer = new WebSocketServer({ noServer: true });
  private readonly upstreamAgent: Agent | undefined;
  private readonly defaultUpstream: ProviderProxyUpstream;
  private readonly resolveUpstream:
    | ((headers: IncomingHttpHeaders) => ProviderProxyUpstream)
    | undefined;
  private readonly accountIds: readonly string[] | undefined;
  private readonly defaultAccountId: string | undefined;
  private readonly externalRoleReasoningEffort: string | undefined;
  private readonly allowOpenAiApiPaths: boolean;
  private readonly quotaWindowsProvider:
    | ((accountId?: string) => Promise<readonly ProviderQuotaWindowSnapshot[] | null>)
    | undefined;
  private readonly timeoutMs: number;
  private readonly onMetrics:
    | ((metrics: ProviderProxyMetrics, accountId?: string) => void | Promise<void>)
    | undefined;
  private readonly onError: ((error: Error) => void) | undefined;
  private started = false;
  private stopped = false;

  constructor(private readonly listenAddress: string, options: ProviderProxyOptions) {
    this.upstreamAgent = options.upstreamAgent;
    this.defaultUpstream = {
      host: options.upstreamHost,
      ...(options.upstreamPort === undefined ? {} : { port: options.upstreamPort }),
      protocol: options.upstreamProtocol ?? "https",
      ...(options.upstreamBasePath === undefined
        ? {}
        : { basePath: options.upstreamBasePath }),
    };
    this.resolveUpstream = options.resolveUpstream;
    this.accountIds = options.accountIds;
    this.defaultAccountId = options.defaultAccountId;
    const externalRoleReasoningEffort = boundedReasoningEffort(
      options.externalRoleReasoningEffort,
    );
    if (
      options.externalRoleReasoningEffort !== undefined
      && externalRoleReasoningEffort === null
    ) {
      throw new Error("第三方子代理默认思考等级无效");
    }
    this.externalRoleReasoningEffort = externalRoleReasoningEffort ?? undefined;
    this.allowOpenAiApiPaths = options.allowOpenAiApiPaths ?? false;
    this.quotaWindowsProvider = options.quotaWindowsProvider;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.onMetrics = options.onMetrics;
    this.onError = options.onError;
    this.server = createServer((request, response) => {
      this.handleHttpRequest(request, response);
    });
    this.server.on("upgrade", (request, socket, head) => {
      this.handleWebSocketUpgrade(request, socket, head);
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
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
    if (address === null || typeof address === "string") return this.listenAddress;
    return `127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    for (const client of this.websocketServer.clients) client.terminate();
    this.server.closeAllConnections?.();
    await new Promise<void>((resolveClose) => {
      this.server.close(() => resolveClose());
    });
  }

  private handleHttpRequest(request: IncomingMessage, response: ServerResponse): void {
    const account = resolveAccountPath(
      request.url,
      this.accountIds,
      this.defaultAccountId,
      this.externalRoleReasoningEffort !== undefined,
    );
    if (!account || !isSupportedHttpRequest(
      request.method,
      account.path,
      this.allowOpenAiApiPaths,
    )) {
      request.resume();
      rejectUnsupportedPath(response);
      return;
    }
    const upstreamTarget = this.upstreamFor(request.headers);
    const turnMetadata = parseTurnMetadata(
      request.headers["x-codex-turn-metadata"],
    );
    const metrics = createMetricsState(
      turnMetadata,
      Date.now(),
      "http",
      responseOperation(account.path, turnMetadata.operation),
    );
    if (account.externalRole) {
      metrics.reasoningEffort = this.externalRoleReasoningEffort ?? null;
    }
    const recordsResponseMetrics = isResponsesRequestPath(account.path);
    let metricsDelivery: Promise<void> | undefined;
    const emitMetrics = (): Promise<void> => {
      if (!recordsResponseMetrics) return Promise.resolve();
      metrics.responseCompletedAtMs = Math.max(metrics.responseCompletedAtMs, Date.now());
      metricsDelivery ??= this.deliverMetrics(metrics, account.accountId);
      return metricsDelivery;
    };
    const upstreamRequest = upstreamTarget.protocol === "http"
      ? httpRequest
      : httpsRequest;
    const upstream = upstreamRequest({
      agent: upstreamTarget.agent ?? this.upstreamAgent,
      hostname: upstreamTarget.host,
      ...(upstreamTarget.port === undefined ? {} : { port: upstreamTarget.port }),
      path: upstreamPath(upstreamTarget.basePath, account.path),
      method: request.method,
      headers: forwardedRequestHeaders(
        request.headers,
        upstreamTarget.host,
        upstreamTarget.port,
      ),
    }, (upstreamResponse) => {
      metrics.httpStatus = upstreamResponse.statusCode ?? null;
      metrics.responseFormat = httpResponseFormat(upstreamResponse.headers["content-type"]);
      metrics.weeklyQuota = weeklyQuotaFromHeaders(upstreamResponse.headers);
      writeUpstreamHead(response, upstreamResponse);
      const decoder = new StringDecoder("utf8");
      let pending = "";
      let currentEvent = "";
      let sseMetadataOverflow = false;
      let jsonBytes = 0;
      let jsonOverflow = false;
      const jsonChunks: Buffer[] = [];
      let forwarding = Promise.resolve();
      const processLine = (line: string, receivedAtMs: number): boolean => {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
          return false;
        }
        if (!line.startsWith("data:")) return false;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") return false;
        const parsed = parseJsonPayload(payload);
        const type = typeof parsed?.type === "string" ? parsed.type : currentEvent;
        if (metrics.responseFormat === "unknown" && type.startsWith("response.")) {
          metrics.responseFormat = "sse";
        }
        return observeResponseEvent(metrics, type, parsed, receivedAtMs);
      };
      const processText = (text: string, receivedAtMs: number): boolean => {
        if (sseMetadataOverflow) return false;
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        if (
          pending.length > maximumSseMetadataLineCharacters
          || lines.some((line) => line.length > maximumSseMetadataLineCharacters)
        ) {
          sseMetadataOverflow = true;
          pending = "";
          currentEvent = "";
          return false;
        }
        return lines.some((line) => processLine(line, receivedAtMs));
      };
      upstreamResponse.on("data", (chunk: Buffer) => {
        const completed = metrics.responseFormat === "sse"
          || metrics.responseFormat === "unknown"
          ? processText(decoder.write(chunk), Date.now())
          : false;
        if (metrics.responseFormat === "json" && !jsonOverflow) {
          jsonBytes += chunk.length;
          if (jsonBytes <= maximumJsonMetadataBytes) jsonChunks.push(chunk);
          else {
            jsonOverflow = true;
            jsonChunks.length = 0;
          }
        }
        upstreamResponse.pause();
        forwarding = forwarding.then(async () => {
          if (completed) await emitMetrics();
          await writeResponseChunk(response, chunk);
          upstreamResponse.resume();
        }).catch((error) => {
          this.onError?.(asError(error));
          upstreamResponse.destroy();
          response.destroy();
        });
      });
      upstreamResponse.on("end", () => {
        const endedAtMs = Date.now();
        const completed = metrics.responseFormat === "sse"
          || metrics.responseFormat === "unknown"
          ? processText(decoder.end(), endedAtMs)
            || (pending ? processLine(pending.trimEnd(), endedAtMs) : false)
          : metrics.responseFormat === "json" && !jsonOverflow
            ? observeJsonResponse(
                metrics,
                parseJsonPayload(Buffer.concat(jsonChunks).toString("utf8")),
                endedAtMs,
              )
            : false;
        finalizeHttpStatus(metrics, endedAtMs);
        forwarding = forwarding.then(async () => {
          if (completed || isResponsesRequestPath(account.path)) await emitMetrics();
          response.end();
        }).catch((error) => {
          this.onError?.(asError(error));
          response.destroy();
        });
      });
      upstreamResponse.on("error", (error) => {
        if (metrics.status === "completed" && isExpectedStreamAbort(error)) {
          response.destroy();
          return;
        }
        markMetricsFailed(metrics, "upstream_response_error", error);
        void emitMetrics();
        response.destroy();
        this.onError?.(asError(error));
      });
    });
    upstream.setTimeout(this.timeoutMs, () => {
      upstream.destroy(new Error(`模型上游响应超时：${this.timeoutMs}ms`));
    });
    upstream.on("error", (error) => {
      markMetricsFailed(metrics, "upstream_request_error", error);
      void emitMetrics();
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { type: "provider_proxy_upstream_error" } }));
      } else {
        response.destroy();
      }
      this.onError?.(asError(error));
    });
    request.on("error", (error) => {
      markMetricsFailed(metrics, "client_request_error", error);
      void emitMetrics();
      upstream.destroy();
      this.onError?.(asError(error));
      response.destroy();
    });
    response.on("close", () => {
      if (!response.writableEnded) {
        if (metrics.status !== "completed") {
          markMetricsFailed(metrics, "client_disconnected");
          void emitMetrics();
        }
        upstream.destroy();
      }
    });
    request.pipe(upstream);
  }

  private handleWebSocketUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const account = resolveAccountPath(
      request.url,
      this.accountIds,
      this.defaultAccountId,
      this.externalRoleReasoningEffort !== undefined,
    );
    const recordsResponseMetrics = account
      ? isResponsesPath(account.path)
      : false;
    if (
      !account
      || (!recordsResponseMetrics && !(
        this.allowOpenAiApiPaths && isOpenAiRealtimeWebSocketPath(account.path)
      ))
    ) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    this.websocketServer.handleUpgrade(request, socket, head, (client) => {
      this.proxyWebSocket(
        request,
        client,
        account.accountId,
        recordsResponseMetrics,
      );
    });
  }

  private proxyWebSocket(
    request: IncomingMessage,
    client: WebSocket,
    accountId?: string,
    recordsResponseMetrics = true,
  ): void {
    const target = this.upstreamFor(request.headers);
    const scheme = target.protocol === "https" ? "wss" : "ws";
    const port = target.port === undefined ? "" : `:${target.port}`;
    const account = resolveAccountPath(
      request.url,
      this.accountIds,
      this.defaultAccountId,
      this.externalRoleReasoningEffort !== undefined,
    );
    const url = `${scheme}://${target.host}${port}${upstreamWebSocketPath(
      target.basePath,
      account?.path ?? "/responses",
      recordsResponseMetrics,
    )}`;
    const protocols = websocketProtocols(request.headers["sec-websocket-protocol"]);
    const upstream = new WebSocket(url, protocols, {
      ...(target.agent ?? this.upstreamAgent
        ? { agent: target.agent ?? this.upstreamAgent }
        : {}),
      headers: forwardedWebSocketHeaders(request.headers, target.host, target.port),
      handshakeTimeout: this.timeoutMs,
    });
    const pending: Array<{ data: RawData | string; isBinary: boolean }> = [];
    let activeMetrics: MetricsState | undefined;
    let forwarding = Promise.resolve();

    client.on("message", (data, isBinary) => {
      const sanitized = recordsResponseMetrics
        ? sanitizeClientWebSocketMessage(data, isBinary)
        : { data };
      if (sanitized.metadata) {
        activeMetrics = sanitized.recordsMetrics === false
          ? undefined
          : createMetricsState(
              sanitized.metadata,
              sanitized.requestStartedAtMs ?? Date.now(),
              "websocket",
              sanitized.metadata.operation,
            );
        if (activeMetrics) {
          activeMetrics.model = sanitized.model ?? null;
          activeMetrics.serviceTier = sanitized.serviceTier ?? null;
          activeMetrics.reasoningEffort = sanitized.reasoningEffort
            ?? (account?.externalRole
              ? this.externalRoleReasoningEffort ?? null
              : null);
        }
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(sanitized.data, { binary: isBinary });
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        pending.push({ data: sanitized.data, isBinary });
      }
    });
    upstream.on("open", () => {
      for (const message of pending.splice(0)) {
        upstream.send(message.data, { binary: message.isBinary });
      }
    });
    upstream.on("unexpected-response", (_request, response) => {
      const receivedAtMs = Date.now();
      const statusCode = response.statusCode ?? 502;
      if (!recordsResponseMetrics) {
        response.resume();
        client.terminate();
        upstream.terminate();
        return;
      }
      if (activeMetrics) {
        activeMetrics.httpStatus = statusCode;
        markMetricsFailed(activeMetrics, "upstream_handshake_error");
        activeMetrics.responseCompletedAtMs = receivedAtMs;
        void this.deliverMetrics(activeMetrics, accountId);
        activeMetrics = undefined;
      } else {
        const fallback = createMetricsState(
          { threadId: null, turnId: null, operation: "response" },
          receivedAtMs,
          "websocket",
          "response",
        );
        if (account?.externalRole) {
          fallback.reasoningEffort = this.externalRoleReasoningEffort ?? null;
        }
        fallback.httpStatus = statusCode;
        markMetricsFailed(fallback, "upstream_handshake_error");
        fallback.responseCompletedAtMs = receivedAtMs;
        void this.deliverMetrics(fallback, accountId);
      }
      response.resume();
      client.terminate();
      upstream.terminate();
    });
    upstream.on("message", (data, isBinary) => {
      const receivedAtMs = Date.now();
      forwarding = forwarding.then(async () => {
        if (!isBinary && activeMetrics) {
          const currentMetrics = activeMetrics;
          const parsed = parseJsonPayload(rawDataText(data));
          const type = typeof parsed?.type === "string" ? parsed.type : "";
          if (type === "codex.rate_limits") {
            currentMetrics.weeklyQuota = weeklyQuotaFromEvent(parsed);
          }
          if (observeResponseEvent(currentMetrics, type, parsed, receivedAtMs)) {
            activeMetrics = undefined;
            await this.deliverMetrics(currentMetrics, accountId);
          }
        }
        if (client.readyState === WebSocket.OPEN) {
          await sendWebSocket(client, data, isBinary);
        }
      }).catch((error) => {
        this.onError?.(asError(error));
        client.terminate();
        upstream.terminate();
      });
    });
    const closePeer = (peer: WebSocket, code: number, reason: Buffer): void => {
      if (peer.readyState === WebSocket.OPEN) {
        if (code === 1_005 || code === 1_006) peer.close();
        else peer.close(code, reason);
      }
      else if (peer.readyState === WebSocket.CONNECTING) peer.terminate();
    };
    let failureType: "websocket_closed" | "client_disconnected" | undefined;
    const noteFailureType = (
      type: "websocket_closed" | "client_disconnected",
    ): void => {
      failureType ??= type;
    };
    client.on("close", (code, reason) => {
      noteFailureType("client_disconnected");
      closePeer(upstream, code, reason);
    });
    upstream.on("close", (code, reason) => {
      noteFailureType("websocket_closed");
      closePeer(client, code, reason);
      if (!activeMetrics) return;
      const reasonType = websocketCloseErrorType(reason);
      if (reasonType) {
        markMetricsFailed(activeMetrics, "websocket_closed");
        activeMetrics.errorType = reasonType;
        activeMetrics.errorMessage = boundedMessage(reason.toString("utf8"));
      } else {
        markMetricsFailed(activeMetrics, failureType ?? "websocket_closed");
      }
      void this.deliverMetrics(activeMetrics, accountId);
      activeMetrics = undefined;
    });
    client.on("error", (error) => {
      noteFailureType("client_disconnected");
      this.onError?.(asError(error));
      upstream.terminate();
    });
    upstream.on("error", (error) => {
      noteFailureType("websocket_closed");
      this.onError?.(asError(error));
      client.terminate();
    });
  }

  private upstreamFor(headers: IncomingHttpHeaders): ProviderProxyUpstream {
    return this.resolveUpstream?.(headers) ?? this.defaultUpstream;
  }

  private async deliverMetrics(
    metrics: MetricsState,
    accountId?: string,
  ): Promise<void> {
    let quotaWindows: readonly ProviderQuotaWindowSnapshot[] | null = null;
    if (this.quotaWindowsProvider) {
      try {
        quotaWindows = await this.quotaWindowsProvider(accountId);
      } catch (error) {
        this.onError?.(asError(error));
      }
    }
    try {
      await this.onMetrics?.({ ...metrics, quotaWindows }, accountId);
    } catch (error) {
      this.onError?.(asError(error));
    }
  }
}

function isExpectedStreamAbort(error: Error): boolean {
  return error.message === "aborted"
    && "code" in error
    && error.code === "ECONNRESET";
}

function createMetricsState(
  metadata: TurnMetadata,
  startedAtMs: number,
  transport: ProviderProxyMetrics["transport"],
  operation: ProviderProxyMetrics["operation"],
): MetricsState {
  return {
    ...metadata,
    transport,
    responseFormat: transport === "websocket" ? "websocket" : "unknown",
    operation,
    model: null,
    serviceTier: null,
    reasoningEffort: null,
    status: "unknown",
    httpStatus: null,
    errorType: null,
    errorCode: null,
    errorMessage: null,
    incompleteReason: null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    totalTokens: null,
    upstreamCreatedAt: null,
    upstreamCompletedAt: null,
    requestStartedAtMs: startedAtMs,
    firstTokenAtMs: null,
    firstReasoningDeltaAtMs: null,
    lastReasoningDeltaAtMs: null,
    firstOutputDeltaAtMs: null,
    lastOutputDeltaAtMs: null,
    responseCompletedAtMs: startedAtMs,
    weeklyQuota: null,
    quotaWindows: null,
  };
}

function weeklyQuotaFromHeaders(
  headers: IncomingHttpHeaders,
): ProviderWeeklyQuotaSnapshot | null {
  for (const window of ["primary", "secondary"] as const) {
    const snapshot = weeklyQuotaSnapshot(
      headerNumber(headers[`x-codex-${window}-used-percent`]),
      headerNumber(headers[`x-codex-${window}-window-minutes`]),
      headerNumber(headers[`x-codex-${window}-reset-at`]),
      null,
    );
    if (snapshot) return snapshot;
  }
  return null;
}

function weeklyQuotaFromEvent(
  event: Record<string, unknown> | undefined,
): ProviderWeeklyQuotaSnapshot | null {
  const limitId = event?.metered_limit_name ?? event?.limit_name;
  if (limitId !== undefined && limitId !== "codex") return null;
  const planType = typeof event?.plan_type === "string" && event.plan_type.length > 0
    ? event.plan_type
    : null;
  const rateLimits = asRecord(event?.rate_limits);
  for (const key of ["primary", "secondary"] as const) {
    const window = asRecord(rateLimits?.[key]);
    const snapshot = weeklyQuotaSnapshot(
      finiteNonNegativeNumber(window?.used_percent),
      finiteNonNegativeNumber(window?.window_minutes),
      finiteNonNegativeNumber(window?.reset_at),
      planType,
    );
    if (snapshot) return snapshot;
  }
  return null;
}

function weeklyQuotaSnapshot(
  usedPercent: number | null,
  windowMinutes: number | null,
  resetsAt: number | null,
  planType: string | null,
): ProviderWeeklyQuotaSnapshot | null {
  if (
    usedPercent === null
    || usedPercent < 0
    || usedPercent > 100
    || windowMinutes !== weeklyWindowMinutes
    || resetsAt === null
    || !Number.isSafeInteger(resetsAt)
  ) return null;
  const usedPercentMillionths = Math.round(usedPercent * percentScale);
  return Number.isSafeInteger(usedPercentMillionths)
    ? { limitId: "codex", usedPercentMillionths, resetsAt, planType }
    : null;
}

function headerNumber(value: string | string[] | undefined): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return finiteNonNegativeNumber(Number(value));
}

function finiteNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function observeResponseEvent(
  metrics: MetricsState,
  type: string,
  event: Record<string, unknown> | undefined,
  receivedAtMs: number,
): boolean {
  const isReasoningDelta = type.includes("reasoning") && type.includes(".delta");
  const isOutputDelta = type === "response.output_text.delta"
    || type === "response.function_call_arguments.delta"
    || type === "response.custom_tool_call_input.delta";
  if (isReasoningDelta || isOutputDelta) metrics.firstTokenAtMs ??= receivedAtMs;
  if (isReasoningDelta) {
    metrics.firstReasoningDeltaAtMs ??= receivedAtMs;
    metrics.lastReasoningDeltaAtMs = receivedAtMs;
  }
  if (isOutputDelta) {
    metrics.firstOutputDeltaAtMs ??= receivedAtMs;
    metrics.lastOutputDeltaAtMs = receivedAtMs;
  }
  if (
    type === "response.completed"
    || type === "response.failed"
    || type === "response.incomplete"
  ) {
    observeResponseCompletion(metrics, type, event);
    metrics.responseCompletedAtMs = receivedAtMs;
    return true;
  }
  if (type === "error") {
    const error = asRecord(event?.error);
    const errorType = boundedString(error?.type) ?? "upstream_error";
    metrics.httpStatus = finiteNonNegativeNumber(event?.status);
    metrics.errorType = errorType;
    metrics.errorCode = boundedString(error?.code);
    metrics.errorMessage = boundedMessage(error?.message);
    markMetricsFailed(metrics, errorType);
    metrics.responseCompletedAtMs = receivedAtMs;
    return true;
  }
  return false;
}

function websocketCloseErrorType(reason: Buffer | string): string | null {
  const text = reason.toString("utf8").slice(0, 200).toLowerCase();
  if (text.includes("usage limit")) return "usage_limit_reached";
  if (text.includes("rate limit")) return "rate_limit_reached";
  return null;
}

function observeResponseCompletion(
  metrics: MetricsState,
  eventType: string,
  event: Record<string, unknown> | undefined,
): void {
  const response = asRecord(event?.response);
  metrics.status = eventType === "response.completed"
    ? "completed"
    : eventType === "response.failed"
      ? "failed"
      : "incomplete";
  observeResponseFields(metrics, response, event);
}

function observeResponseFields(
  metrics: MetricsState,
  response: Record<string, unknown> | undefined,
  event: Record<string, unknown> | undefined,
): void {
  metrics.model = boundedString(response?.model);
  metrics.serviceTier = boundedString(response?.service_tier);
  const usage = asRecord(response?.usage);
  const inputDetails = asRecord(usage?.input_tokens_details);
  const outputDetails = asRecord(usage?.output_tokens_details);
  metrics.inputTokens = tokenCount(usage?.input_tokens);
  metrics.cachedInputTokens = tokenCount(inputDetails?.cached_tokens);
  metrics.outputTokens = tokenCount(usage?.output_tokens);
  metrics.reasoningOutputTokens = tokenCount(outputDetails?.reasoning_tokens);
  metrics.totalTokens = tokenCount(usage?.total_tokens);
  metrics.upstreamCreatedAt = upstreamTimestamp(response?.created_at);
  metrics.upstreamCompletedAt = upstreamTimestamp(response?.completed_at);
  const error = asRecord(response?.error) ?? asRecord(event?.error);
  metrics.errorType = boundedString(error?.type);
  metrics.errorCode = boundedString(error?.code);
  metrics.errorMessage = boundedMessage(error?.message);
  metrics.incompleteReason = boundedString(
    asRecord(response?.incomplete_details)?.reason,
  );
}

function observeJsonResponse(
  metrics: MetricsState,
  response: Record<string, unknown> | undefined,
  receivedAtMs: number,
): boolean {
  if (!response) return false;
  const status = response.status;
  const eventType = status === "completed"
    ? "response.completed"
    : status === "failed"
      ? "response.failed"
      : status === "incomplete"
        ? "response.incomplete"
        : undefined;
  if (!eventType) {
    observeResponseFields(metrics, response, { response });
    return false;
  }
  observeResponseCompletion(metrics, eventType, { response });
  metrics.responseCompletedAtMs = receivedAtMs;
  return true;
}

function finalizeHttpStatus(metrics: MetricsState, completedAtMs: number): void {
  if (metrics.status !== "unknown") return;
  metrics.responseCompletedAtMs = completedAtMs;
  if (metrics.httpStatus !== null && metrics.httpStatus >= 400) {
    metrics.status = "failed";
    metrics.errorType ??= "http_error";
    return;
  }
  if (metrics.operation === "compact") {
    metrics.status = "completed";
    return;
  }
  metrics.status = "incomplete";
  metrics.incompleteReason ??= "response_not_observed";
}

function markMetricsFailed(
  metrics: MetricsState,
  errorType: string,
  error?: unknown,
): void {
  if (metrics.status === "completed") return;
  metrics.status = "failed";
  metrics.errorType = errorType;
  metrics.errorCode = nodeErrorCode(error);
  metrics.responseCompletedAtMs = Math.max(metrics.responseCompletedAtMs, Date.now());
}

function nodeErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/u.test(code)
    ? code
    : null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function upstreamTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function httpResponseFormat(
  contentType: string | string[] | undefined,
): ProviderProxyMetrics["responseFormat"] {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  if (typeof value !== "string") return "unknown";
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "text/event-stream") return "sse";
  if (mediaType === "application/json") return "json";
  return "unknown";
}

function boundedString(value: unknown): string | null {
  return typeof value === "string"
    && value.length <= 128
    && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(value)
    ? value
    : null;
}

function boundedMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const message = value
    .replace(/\p{Cc}/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (message.length === 0) return null;
  return message.length <= 500 ? message : `${message.slice(0, 500)}…`;
}

function sanitizeClientWebSocketMessage(
  data: RawData,
  isBinary: boolean,
): {
  data: RawData | string;
  metadata?: TurnMetadata;
  recordsMetrics?: boolean;
  requestStartedAtMs?: number;
  model?: string;
  serviceTier?: string;
  reasoningEffort?: string;
} {
  if (isBinary) return { data };
  const parsed = parseJsonPayload(rawDataText(data));
  if (parsed?.type !== "response.create") return { data };
  const clientMetadata = asRecord(parsed.client_metadata);
  const rawMetadata = clientMetadata?.["x-codex-turn-metadata"];
  const requestStartedAtMs = requestStartTimestamp(clientMetadata);
  const model = boundedString(parsed.model) ?? undefined;
  const serviceTier = boundedString(parsed.service_tier) ?? undefined;
  const reasoning = asRecord(parsed.reasoning);
  const reasoningEffort = boundedReasoningEffort(reasoning?.effort) ?? undefined;
  const parsedMetadata = typeof rawMetadata === "string"
    ? parseJsonPayload(rawMetadata)
    : asRecord(rawMetadata);
  const metadata = parseTurnMetadataObject(parsedMetadata);
  const recordsMetrics = !(
    parsedMetadata?.request_kind === "prewarm"
    && parsed.generate === false
  );
  if (!clientMetadata || rawMetadata === undefined) {
    return {
      data,
      metadata,
      recordsMetrics,
      ...(requestStartedAtMs ? { requestStartedAtMs } : {}),
      ...(model ? { model } : {}),
      ...(serviceTier ? { serviceTier } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  }
  const sanitizedMetadata = { ...clientMetadata };
  delete sanitizedMetadata["x-codex-turn-metadata"];
  return {
    data: JSON.stringify({ ...parsed, client_metadata: sanitizedMetadata }),
    metadata,
    recordsMetrics,
    ...(requestStartedAtMs ? { requestStartedAtMs } : {}),
    ...(model ? { model } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function boundedReasoningEffort(value: unknown): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(value)
    ? value
    : null;
}

function requestStartTimestamp(
  clientMetadata: Record<string, unknown> | undefined,
): number | undefined {
  const raw = clientMetadata?.["x-codex-ws-stream-request-start-ms"];
  if (typeof raw !== "string") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sendWebSocket(
  target: WebSocket,
  data: RawData | string,
  isBinary: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    target.send(data, { binary: isBinary }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function rawDataText(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}

function writeUpstreamHead(response: ServerResponse, upstream: IncomingMessage): void {
  const headers = endToEndHeaders(upstream.headers);
  if (upstream.statusMessage) {
    response.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, headers);
  } else {
    response.writeHead(upstream.statusCode ?? 502, headers);
  }
}

function writeResponseChunk(response: ServerResponse, chunk: Buffer): Promise<void> {
  if (response.destroyed || response.writableEnded) return Promise.resolve();
  if (response.write(chunk)) return Promise.resolve();
  return new Promise((resolve) => response.once("drain", resolve));
}

function rejectUnsupportedPath(response: ServerResponse): void {
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { type: "provider_proxy_unsupported_path" } }));
}

function parseTurnMetadata(value: string | string[] | undefined): TurnMetadata {
  return typeof value === "string"
    ? parseTurnMetadataObject(parseJsonPayload(value))
    : { threadId: null, turnId: null, operation: "response" };
}

function parseTurnMetadataObject(value: unknown): TurnMetadata {
  const parsed = asRecord(value);
  return {
    threadId: nonEmptyString(parsed?.thread_id),
    turnId: nonEmptyString(parsed?.turn_id),
    operation: parsed?.request_kind === "compaction" ? "compact" : "response",
  };
}

function parseJsonPayload(payload: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(payload) as unknown);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
