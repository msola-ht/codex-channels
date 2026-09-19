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
  isSupportedHttpRoute,
  parseListenAddress,
  resolveProxyRoute,
  responseOperation,
  upstreamPath,
  upstreamWebSocketPath,
  websocketProtocols,
  type ResolvedProxyRoute,
} from "./request-routing.js";
import {
  asRecord,
  boundedMessage,
  boundedString,
  createMetricsState,
  effectiveUpstreamUserAgent,
  HttpResponseMetricsObserver,
  httpResponseFormat,
  inspectResponseEvent,
  markMetricsFailed,
  observeResponseEvent,
  parseJsonPayload,
  websocketCloseErrorType,
  weeklyQuotaFromEvent,
  weeklyQuotaFromHeaders,
  type MetricsState,
  type ProviderProxyMetrics,
  type ProviderQuotaWindowSnapshot,
} from "./response-metrics-observer.js";
import { ModelTrafficDump } from "./traffic-dump.js";
import type { TrafficCallTiming } from "./traffic-call-timing.js";
import { createTopLevelStringFieldScanner, scanTopLevelStringField } from "./traffic-dump-content.js";

export type {
  ProviderProxyMetrics,
  ProviderQuotaWindowSnapshot,
  ProviderWeeklyQuotaSnapshot,
} from "./response-metrics-observer.js";

const quotaRefreshCloseTimeoutMs = 1_000;

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
  /** 仅官方 OpenAI 主代理启用的当前锁定 Codex 0.154.0 API 路径。 */
  allowOpenAiApiPaths?: boolean;
  /** 仅确认的官方 OpenAI 上游请求 Responses WebSocket timing 事件。 */
  requestOpenAiTimingMetrics?: boolean;
  /** 共享代理按 `/go/<account>/...` 前缀区分的账户 id（OpenCode Go 共享代理） */
  accountIds?: readonly string[];
  /** 共享代理无账户前缀请求归属的默认账户。 */
  defaultAccountId?: string;
  /** 私有 `/role/external` 路径对应的 agents.external 默认思考等级。 */
  externalRoleReasoningEffort?: string;
  /** 覆盖发给模型上游的完整 User-Agent；缺省时原样转发 App Server 生成的 UA。 */
  upstreamUserAgent?: string;
  /**
   * 模型请求与响应的完整报文转储；缺省时不记录。
   * 仅在 `[debug].model_traffic_dump` 开启时由组合层传入。
   */
  trafficDump?: {
    directory: string;
    /** 精简模式保留的 `input` 末尾条目数；缺省或 `0` 时转储完整报文。 */
    inputItems?: number;
    /** 单个数组条目的正文上限（字节）；缺省或 `0` 时按原样转储。 */
    itemMaxBytes?: number;
    /** 历史 session 的最长保留天数；`0` 关闭按时间清理。 */
    retentionDays?: number;
    label: string;
  };
  resolveUpstream?: (headers: IncomingHttpHeaders) => ProviderProxyUpstream | Promise<ProviderProxyUpstream>;
  timeoutMs?: number;
  quotaWindowsProvider?: (
    accountId?: string,
    signal?: AbortSignal,
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

export class ProviderProxy {
  private readonly server: Server;
  private readonly websocketServer = new WebSocketServer({ noServer: true });
  private readonly upstreamAgent: Agent | undefined;
  private readonly defaultUpstream: ProviderProxyUpstream;
  private readonly resolveUpstream: ProviderProxyOptions["resolveUpstream"];
  private readonly pendingUpgrades = new Set<Duplex>();
  private readonly accountIds: readonly string[] | undefined;
  private readonly defaultAccountId: string | undefined;
  private readonly externalRoleReasoningEffort: string | undefined;
  private readonly upstreamUserAgent: string | undefined;
  private readonly allowOpenAiApiPaths: boolean;
  private readonly requestOpenAiTimingMetrics: boolean;
  private readonly trafficDump: ModelTrafficDump | undefined;
  private readonly quotaWindowsProvider:
    | ((
        accountId?: string,
        signal?: AbortSignal,
      ) => Promise<readonly ProviderQuotaWindowSnapshot[] | null>)
    | undefined;
  private readonly timeoutMs: number;
  private readonly onMetrics:
    | ((metrics: ProviderProxyMetrics, accountId?: string) => void | Promise<void>)
    | undefined;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly quotaWindowsByAccount = new Map<
    string,
    readonly ProviderQuotaWindowSnapshot[] | null
  >();
  private readonly quotaRefreshByAccount = new Map<string, {
    controller: AbortController;
    promise: Promise<void>;
  }>();
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
    this.upstreamUserAgent = options.upstreamUserAgent;
    const externalRoleReasoningEffort = boundedString(
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
    this.requestOpenAiTimingMetrics = options.requestOpenAiTimingMetrics ?? false;
    this.onError = options.onError;
    this.trafficDump = options.trafficDump === undefined
      ? undefined
      : new ModelTrafficDump({
          directory: options.trafficDump.directory,
          label: options.trafficDump.label,
          ...(options.trafficDump.inputItems === undefined
            ? {}
            : { inputItems: options.trafficDump.inputItems }),
          ...(options.trafficDump.itemMaxBytes === undefined
            ? {}
            : { itemMaxBytes: options.trafficDump.itemMaxBytes }),
          ...(options.trafficDump.retentionDays === undefined
            ? {}
            : { retentionDays: options.trafficDump.retentionDays }),
          onError: (error) => {
            this.onError?.(error);
          },
        });
    this.quotaWindowsProvider = options.quotaWindowsProvider;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.onMetrics = options.onMetrics;
    this.server = createServer((request, response) => {
      void this.handleHttpRequest(request, response).catch((error: unknown) => {
        response.destroy();
        this.onError?.(asError(error));
      });
    });
    this.server.on("upgrade", (request, socket, head) => {
      void this.handleWebSocketUpgrade(request, socket, head).catch((error: unknown) => {
        socket.destroy();
        this.onError?.(asError(error));
      });
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
    if (this.quotaWindowsProvider) {
      const accounts = this.accountIds?.length
        ? this.accountIds
        : [this.defaultAccountId];
      for (const accountId of accounts) this.refreshQuotaWindows(accountId);
    }
  }

  address(): string {
    const address = this.server.address();
    if (address === null || typeof address === "string") return this.listenAddress;
    return `127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    for (const socket of this.pendingUpgrades) socket.destroy();
    const quotaRefreshes = [...this.quotaRefreshByAccount.values()];
    for (const refresh of quotaRefreshes) refresh.controller.abort();
    for (const client of this.websocketServer.clients) client.terminate();
    this.server.closeAllConnections?.();
    await Promise.all([
      new Promise<void>((resolveClose) => {
        this.server.close(() => resolveClose());
      }),
      settleWithin(
        quotaRefreshes.map((refresh) => refresh.promise),
        quotaRefreshCloseTimeoutMs,
      ),
    ]);
    await this.trafficDump?.close();
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAtMonotonicMs = performance.now();
    const startedAtMs = Date.now();
    const route = resolveProxyRoute(
      request.url,
      this.accountIds,
      this.defaultAccountId,
      this.externalRoleReasoningEffort !== undefined,
    );
    if (!route || !isSupportedHttpRoute(
      request.method,
      route,
      this.allowOpenAiApiPaths,
    )) {
      request.resume();
      rejectUnsupportedPath(response);
      return;
    }
    let upstreamTarget: ProviderProxyUpstream;
    const onPendingError = () => response.destroy();
    request.on("error", onPendingError);
    request.once("close", () => request.removeListener("error", onPendingError));
    try {
      upstreamTarget = await this.upstreamFor(request.headers);
    } catch (error) {
      const failedAtMonotonicMs = performance.now();
      if (this.stopped || response.destroyed) return;
      request.resume();
      const metadata = parseTurnMetadata(request.headers["x-codex-turn-metadata"]);
      const metrics = createMetricsState(metadata, startedAtMs, "http",
        responseOperation(route, metadata.operation),
        effectiveUpstreamUserAgent(request.headers, this.upstreamUserAgent), startedAtMonotonicMs, startedAtMonotonicMs);
      metrics.httpStatus = 502;
      if (route.externalRole) metrics.reasoningEffort = this.externalRoleReasoningEffort ?? null;
      markMetricsFailed(metrics, "provider_proxy_route_error", Date.now(), error, failedAtMonotonicMs);
      const exchange = this.trafficDump?.beginHttpExchange({
        ...(route.accountId === undefined ? {} : { accountId: route.accountId }),
        headers: request.headers, method: request.method ?? "GET",
        path: request.url ?? "", startedAtMs, startedAtMonotonicMs,
      });
      exchange?.responseHead(502, {});
      exchange?.observeRequestMetrics(metrics);
      exchange?.failure("upstream_route", undefined, failedAtMonotonicMs);
      if (route.kind === "response" || route.kind === "compact") {
        await this.deliverMetrics(metrics, route.accountId);
      }
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "provider_proxy_route_error" } }));
      this.onError?.(asError(error));
      return;
    }
    request.removeListener("error", onPendingError);
    if (this.stopped || response.destroyed) return;
    const forwardingStartedAtMonotonicMs = performance.now();
    const turnMetadata = parseTurnMetadata(
      request.headers["x-codex-turn-metadata"],
    );
    const metrics = createMetricsState(
      turnMetadata,
      startedAtMs,
      "http",
      responseOperation(route, turnMetadata.operation),
      effectiveUpstreamUserAgent(request.headers, this.upstreamUserAgent),
      forwardingStartedAtMonotonicMs,
      startedAtMonotonicMs,
    );
    const exchange = this.trafficDump?.beginHttpExchange({
      ...(route.accountId === undefined ? {} : { accountId: route.accountId }),
      headers: request.headers,
      method: request.method ?? "GET",
      path: request.url ?? "",
      startedAtMs,
      startedAtMonotonicMs,
    });
    exchange?.callTiming?.forwarding(forwardingStartedAtMonotonicMs);
    exchange?.observeRequestMetrics(metrics);
    const requestModelScanner = createTopLevelStringFieldScanner("model");
    const requestModelDecoder = new StringDecoder("utf8");
    if (route.externalRole) {
      metrics.reasoningEffort = this.externalRoleReasoningEffort ?? null;
    }
    const recordsResponseMetrics = route.kind === "response" || route.kind === "compact";
    let metricsDelivery: Promise<void> | undefined;
    const emitMetrics = (): Promise<void> => {
      if (!recordsResponseMetrics) return Promise.resolve();
      metrics.responseCompletedAtMs = Math.max(metrics.responseCompletedAtMs, Date.now());
      metricsDelivery ??= this.deliverMetrics(metrics, route.accountId);
      return metricsDelivery;
    };
    const upstreamRequest = upstreamTarget.protocol === "http"
      ? httpRequest
      : httpsRequest;
    const upstream = upstreamRequest({
      agent: upstreamTarget.agent ?? this.upstreamAgent,
      hostname: upstreamTarget.host,
      ...(upstreamTarget.port === undefined ? {} : { port: upstreamTarget.port }),
      path: upstreamPath(upstreamTarget.basePath, route.path),
      method: request.method,
      headers: forwardedRequestHeaders(
        request.headers,
        upstreamTarget.host,
        upstreamTarget.port,
        this.upstreamUserAgent,
      ),
    }, (upstreamResponse) => {
      exchange?.callTiming?.responseHead(performance.now());
      metrics.httpStatus = upstreamResponse.statusCode ?? null;
      metrics.responseFormat = httpResponseFormat(upstreamResponse.headers["content-type"]);
      metrics.weeklyQuota = weeklyQuotaFromHeaders(upstreamResponse.headers);
      exchange?.responseHead(
        upstreamResponse.statusCode ?? null,
        upstreamResponse.headers,
      );
      writeUpstreamHead(response, upstreamResponse);
      const metricsObserver = new HttpResponseMetricsObserver(metrics);
      let forwarding = Promise.resolve();
      upstreamResponse.on("data", (chunk: Buffer) => {
        const receivedAtMonotonicMs = performance.now();
        const receivedAtMs = Date.now();
        exchange?.responseChunk(chunk);
        const completed = metricsObserver.observeChunk(chunk, receivedAtMs, receivedAtMonotonicMs);
        if (!completed) {
          if (!response.write(chunk)) {
            upstreamResponse.pause();
            response.once("drain", () => upstreamResponse.resume());
          }
          return;
        }
        upstreamResponse.pause();
        forwarding = forwarding.then(async () => {
          await emitMetrics();
          await writeResponseChunk(response, chunk);
          upstreamResponse.resume();
        }).catch((error) => {
          this.onError?.(asError(error));
          upstreamResponse.destroy();
          response.destroy();
        });
      });
      upstreamResponse.on("end", () => {
        const endedAtMonotonicMs = performance.now();
        const endedAtMs = Date.now();
        const completed = metricsObserver.finish(endedAtMs, endedAtMonotonicMs);
        exchange?.responseEnd(endedAtMonotonicMs);
        forwarding = forwarding.then(async () => {
          if (completed || recordsResponseMetrics) await emitMetrics();
          response.end();
        }).catch((error) => {
          this.onError?.(asError(error));
          response.destroy();
        });
      });
      upstreamResponse.on("error", (error) => {
        const failedAtMonotonicMs = performance.now();
        if (metrics.status === "completed" && isExpectedStreamAbort(error)) {
          response.destroy();
          return;
        }
        markMetricsFailed(metrics, "upstream_response_error", Date.now(), error, failedAtMonotonicMs);
        exchange?.failure("upstream_response", error, failedAtMonotonicMs);
        void emitMetrics();
        response.destroy();
        this.onError?.(asError(error));
      });
    });
    upstream.setTimeout(this.timeoutMs, () => {
      upstream.destroy(new Error(`模型上游响应超时：${this.timeoutMs}ms`));
    });
    upstream.on("error", (error) => {
      const failedAtMonotonicMs = performance.now();
      markMetricsFailed(metrics, "upstream_request_error", Date.now(), error, failedAtMonotonicMs);
      exchange?.failure("upstream_request", error, failedAtMonotonicMs);
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
      const failedAtMonotonicMs = performance.now();
      markMetricsFailed(metrics, "client_request_error", Date.now(), error, failedAtMonotonicMs);
      exchange?.failure("client_request", error, failedAtMonotonicMs);
      void emitMetrics();
      upstream.destroy();
      this.onError?.(asError(error));
      response.destroy();
    });
    response.on("close", () => {
      const closedAtMonotonicMs = performance.now();
      if (!response.writableEnded) {
        if (metrics.status !== "completed") {
          markMetricsFailed(metrics, "client_disconnected", Date.now(), undefined, closedAtMonotonicMs);
          exchange?.failure("client_disconnected", undefined, closedAtMonotonicMs);
          void emitMetrics();
        } else {
          exchange?.failure("client_disconnected", undefined, closedAtMonotonicMs);
        }
        upstream.destroy();
      }
    });
    request.on("data", (chunk: Buffer) => {
      scanTopLevelStringField(requestModelScanner, requestModelDecoder.write(chunk));
      metrics.requestModel = boundedString(requestModelScanner.value);
      exchange?.requestChunk(chunk);
    });
    request.on("end", () => {
      exchange?.callTiming?.requestBodyEnd(performance.now());
      scanTopLevelStringField(requestModelScanner, requestModelDecoder.end());
      metrics.requestModel = boundedString(requestModelScanner.value);
      exchange?.requestEnd();
    });
    request.pipe(upstream);
  }

  private async handleWebSocketUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const startedAtMs = Date.now();
    const startedAtMonotonicMs = performance.now();
    const route = resolveProxyRoute(
      request.url,
      this.accountIds,
      this.defaultAccountId,
      this.externalRoleReasoningEffort !== undefined,
    );
    const recordsResponseMetrics = route?.kind === "response";
    if (
      !route
      || (!recordsResponseMetrics && !(
        this.allowOpenAiApiPaths && route.kind === "openai-websocket"
      ))
    ) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    let target: ProviderProxyUpstream;
    const onPendingError = () => socket.destroy();
    socket.on("error", onPendingError);
    socket.once("close", () => socket.removeListener("error", onPendingError));
    this.pendingUpgrades.add(socket);
    try {
      target = await this.upstreamFor(request.headers);
    } catch (error) {
      if (this.stopped || socket.destroyed) return;
      const exchange = this.trafficDump?.beginWebSocketExchange({
        ...(route.accountId === undefined ? {} : { accountId: route.accountId }),
        headers: request.headers, startedAtMs, url: request.url ?? "",
      });
      exchange?.failure("upstream_route");
      if (recordsResponseMetrics) {
        const metrics = createMetricsState(
          { threadId: null, turnId: null, operation: "response" }, startedAtMs,
          "websocket", "response",
          effectiveUpstreamUserAgent(request.headers, this.upstreamUserAgent), startedAtMonotonicMs,
        );
        metrics.httpStatus = 502;
        if (route.externalRole) metrics.reasoningEffort = this.externalRoleReasoningEffort ?? null;
        markMetricsFailed(metrics, "provider_proxy_route_error", Date.now(), error);
        await this.deliverMetrics(metrics, route.accountId);
      }
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      this.onError?.(asError(error));
      return;
    } finally {
      this.pendingUpgrades.delete(socket);
    }
    if (this.stopped || socket.destroyed) return;
    socket.removeListener("error", onPendingError);
    this.websocketServer.handleUpgrade(request, socket, head, (client) => {
      this.proxyWebSocket(
        request,
        client,
        route,
        target,
        recordsResponseMetrics,
      );
    });
  }

  private proxyWebSocket(
    request: IncomingMessage,
    client: WebSocket,
    route: ResolvedProxyRoute,
    target: ProviderProxyUpstream,
    recordsResponseMetrics = true,
  ): void {
    const scheme = target.protocol === "https" ? "wss" : "ws";
    const port = target.port === undefined ? "" : `:${target.port}`;
    const url = `${scheme}://${target.host}${port}${upstreamWebSocketPath(
      target.basePath,
      route.path,
      recordsResponseMetrics,
    )}`;
    const protocols = websocketProtocols(request.headers["sec-websocket-protocol"]);
    const exchange = this.trafficDump?.beginWebSocketExchange({
      ...(route.accountId === undefined ? {} : { accountId: route.accountId }),
      headers: request.headers,
      startedAtMs: Date.now(),
      url,
    });
    const upstream = new WebSocket(url, protocols, {
      ...(target.agent ?? this.upstreamAgent
        ? { agent: target.agent ?? this.upstreamAgent }
        : {}),
      headers: forwardedWebSocketHeaders(
        request.headers,
        target.host,
        target.port,
        this.upstreamUserAgent,
        recordsResponseMetrics && this.requestOpenAiTimingMetrics,
      ),
      handshakeTimeout: this.timeoutMs,
    });
    const pending: Array<{ data: RawData | string; isBinary: boolean; timing: TrafficCallTiming | undefined }> = [];
    let activeMetrics: MetricsState | undefined;
    let forwarding: Promise<void> | undefined;
    const failForwarding = (error: unknown): void => {
      this.onError?.(asError(error));
      client.terminate();
      upstream.terminate();
    };
    const forwardImmediately = (data: RawData, isBinary: boolean): void => {
      if (client.readyState !== WebSocket.OPEN) return;
      client.send(data, { binary: isBinary }, (error) => {
        if (error) failForwarding(error);
      });
    };

    client.on("message", (data, isBinary) => {
      const receivedAtMonotonicMs = performance.now();
      exchange?.webSocketFrame("client", data, isBinary, receivedAtMonotonicMs);
      const inspected = recordsResponseMetrics
        ? inspectClientWebSocketMessage(data, isBinary)
        : undefined;
      const startedAtMonotonicMs = performance.now();
      const callTiming = inspected?.metadata ? exchange?.callTiming : undefined;
      callTiming?.forwarding(startedAtMonotonicMs, upstream.readyState === WebSocket.OPEN);
      if (inspected?.metadata) {
        activeMetrics = inspected.recordsMetrics === false
          ? undefined
          : createMetricsState(
              inspected.metadata,
              inspected.requestStartedAtMs ?? Date.now(),
              "websocket",
              inspected.metadata.operation,
              effectiveUpstreamUserAgent(request.headers, this.upstreamUserAgent),
              startedAtMonotonicMs,
              receivedAtMonotonicMs,
            );
        if (activeMetrics) {
          activeMetrics.model = inspected.model ?? null;
          activeMetrics.requestModel = inspected.model ?? null;
          exchange?.observeRequestMetrics(activeMetrics);
          activeMetrics.serviceTier = inspected.serviceTier ?? null;
          activeMetrics.reasoningEffort = inspected.reasoningEffort
            ?? (route.externalRole
              ? this.externalRoleReasoningEffort ?? null
              : null);
        }
      }
      if (upstream.readyState === WebSocket.OPEN) {
        callTiming?.submitted(performance.now());
        upstream.send(data, { binary: isBinary });
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        pending.push({ data, isBinary, timing: callTiming });
      }
    });
    upstream.on("open", () => {
      for (const message of pending.splice(0)) {
        message.timing?.submitted(performance.now());
        upstream.send(message.data, { binary: message.isBinary });
      }
    });
    upstream.on("unexpected-response", (_request, response) => {
      const receivedAtMonotonicMs = performance.now();
      const receivedAtMs = Date.now();
      const statusCode = response.statusCode ?? 502;
      exchange?.failure("upstream_handshake", `HTTP ${statusCode}`, receivedAtMonotonicMs);
      if (!recordsResponseMetrics) {
        response.resume();
        client.terminate();
        upstream.terminate();
        return;
      }
      if (activeMetrics) {
        activeMetrics.httpStatus = statusCode;
        markMetricsFailed(activeMetrics, "upstream_handshake_error", receivedAtMs, undefined, receivedAtMonotonicMs);
        activeMetrics.responseCompletedAtMs = receivedAtMs;
        void this.deliverMetrics(activeMetrics, route.accountId);
        activeMetrics = undefined;
      } else {
        const fallback = createMetricsState(
          { threadId: null, turnId: null, operation: "response" },
          receivedAtMs,
          "websocket",
          "response",
          effectiveUpstreamUserAgent(request.headers, this.upstreamUserAgent),
          receivedAtMonotonicMs,
        );
        if (route.externalRole) {
          fallback.reasoningEffort = this.externalRoleReasoningEffort ?? null;
        }
        fallback.httpStatus = statusCode;
        markMetricsFailed(fallback, "upstream_handshake_error", Date.now());
        fallback.responseCompletedAtMs = receivedAtMs;
        void this.deliverMetrics(fallback, route.accountId);
      }
      response.resume();
      client.terminate();
      upstream.terminate();
    });
    upstream.on("message", (data, isBinary) => {
      const receivedAtMonotonicMs = performance.now();
      const receivedAtMs = Date.now();
      let completedMetrics: MetricsState | undefined;
      if (!isBinary && activeMetrics) {
        const currentMetrics = activeMetrics;
        const text = rawDataText(data);
        const observed = inspectResponseEvent(text, "", currentMetrics.firstContentMs === undefined);
        const { type, event: parsed } = observed;
        if (type === "codex.rate_limits") {
          currentMetrics.weeklyQuota = weeklyQuotaFromEvent(parsed);
        }
        if (observeResponseEvent(currentMetrics, type, parsed, receivedAtMs, receivedAtMonotonicMs)) {
          activeMetrics = undefined;
          completedMetrics = currentMetrics;
        }
      }
      exchange?.webSocketFrame("upstream", data, isBinary, receivedAtMonotonicMs);
      if (!completedMetrics && !forwarding) {
        forwardImmediately(data, isBinary);
        return;
      }
      const queued = (forwarding ?? Promise.resolve()).then(async () => {
        if (completedMetrics) {
          await this.deliverMetrics(completedMetrics, route.accountId);
        }
        if (client.readyState === WebSocket.OPEN) {
          await sendWebSocket(client, data, isBinary);
        }
      }).catch(failForwarding);
      forwarding = queued;
      void queued.finally(() => {
        if (forwarding === queued) forwarding = undefined;
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
    let failureAtMonotonicMs: number;
    const noteFailureType = (
      type: "websocket_closed" | "client_disconnected",
      at: number,
    ): void => {
      if (failureType !== undefined) return;
      failureType = type;
      failureAtMonotonicMs = at;
    };
    client.on("close", (code, reason) => {
      const closedAtMonotonicMs = performance.now();
      noteFailureType("client_disconnected", closedAtMonotonicMs);
      exchange?.webSocketClose("client", code, reason, closedAtMonotonicMs);
      closePeer(upstream, code, reason);
    });
    upstream.on("close", (code, reason) => {
      const closedAtMonotonicMs = performance.now();
      noteFailureType("websocket_closed", closedAtMonotonicMs);
      exchange?.webSocketClose("upstream", code, reason, closedAtMonotonicMs);
      closePeer(client, code, reason);
      if (!activeMetrics) return;
      const reasonType = websocketCloseErrorType(reason);
      if (reasonType) {
        markMetricsFailed(activeMetrics, "websocket_closed", Date.now(), undefined, failureAtMonotonicMs);
        activeMetrics.errorType = reasonType;
        activeMetrics.errorMessage = boundedMessage(reason.toString("utf8"));
      } else {
        markMetricsFailed(
          activeMetrics,
          failureType ?? "websocket_closed",
          Date.now(),
          undefined,
          failureAtMonotonicMs,
        );
      }
      void this.deliverMetrics(activeMetrics, route.accountId);
      activeMetrics = undefined;
    });
    client.on("error", (error) => {
      const failedAtMonotonicMs = performance.now();
      noteFailureType("client_disconnected", failedAtMonotonicMs);
      exchange?.failure("client_error", error, failureAtMonotonicMs);
      this.onError?.(asError(error));
      upstream.terminate();
    });
    upstream.on("error", (error) => {
      const failedAtMonotonicMs = performance.now();
      noteFailureType("websocket_closed", failedAtMonotonicMs);
      exchange?.failure("upstream_error", error, failureAtMonotonicMs);
      this.onError?.(asError(error));
      client.terminate();
    });
  }

  private async upstreamFor(headers: IncomingHttpHeaders): Promise<ProviderProxyUpstream> {
    return this.resolveUpstream?.(headers) ?? this.defaultUpstream;
  }

  private async deliverMetrics(
    metrics: MetricsState,
    accountId?: string,
  ): Promise<void> {
    const quotaWindows = this.quotaWindowsByAccount.get(
      quotaAccountKey(accountId),
    ) ?? null;
    this.refreshQuotaWindows(accountId);
    try {
      await this.onMetrics?.({ ...metrics, quotaWindows }, accountId);
    } catch (error) {
      this.onError?.(asError(error));
    }
  }

  private refreshQuotaWindows(accountId?: string): void {
    if (!this.quotaWindowsProvider || this.stopped) return;
    const key = quotaAccountKey(accountId);
    if (this.quotaRefreshByAccount.has(key)) return;
    const controller = new AbortController();
    const refresh = Promise.resolve()
      .then(() => this.quotaWindowsProvider!(accountId, controller.signal))
      .then((windows) => {
        if (!this.stopped) this.quotaWindowsByAccount.set(key, windows);
      })
      .catch((error) => {
        if (!controller.signal.aborted) this.onError?.(asError(error));
      })
      .finally(() => {
        this.quotaRefreshByAccount.delete(key);
      });
    this.quotaRefreshByAccount.set(key, { controller, promise: refresh });
  }
}

function quotaAccountKey(accountId?: string): string {
  return accountId ?? "";
}

async function settleWithin(
  promises: readonly Promise<unknown>[],
  timeoutMs: number,
): Promise<void> {
  if (promises.length === 0) return;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isExpectedStreamAbort(error: Error): boolean {
  return error.message === "aborted"
    && "code" in error
    && error.code === "ECONNRESET";
}

/**
 * 只读取出站 `response.create` 的指标字段，不改写帧内容：上游收到的请求与客户端发出的字节一致，
 * 避免出现客户端自相矛盾的私有元数据投影。
 */
function inspectClientWebSocketMessage(
  data: RawData,
  isBinary: boolean,
): {
  metadata?: TurnMetadata;
  recordsMetrics?: boolean;
  requestStartedAtMs?: number;
  model?: string;
  serviceTier?: string;
  reasoningEffort?: string;
} {
  if (isBinary) return {};
  const parsed = parseJsonPayload(rawDataText(data));
  if (parsed?.type !== "response.create") return {};
  const clientMetadata = asRecord(parsed.client_metadata);
  const rawMetadata = clientMetadata?.["x-codex-turn-metadata"];
  const requestStartedAtMs = requestStartTimestamp(clientMetadata);
  const model = boundedString(parsed.model) ?? undefined;
  const serviceTier = boundedString(parsed.service_tier) ?? undefined;
  const reasoning = asRecord(parsed.reasoning);
  const reasoningEffort = boundedString(reasoning?.effort) ?? undefined;
  const parsedMetadata = typeof rawMetadata === "string"
    ? parseJsonPayload(rawMetadata)
    : asRecord(rawMetadata);
  const metadata = parseTurnMetadataObject(parsedMetadata);
  const recordsMetrics = !(
    parsedMetadata?.request_kind === "prewarm"
    && parsed.generate === false
  );
  return {
    metadata,
    recordsMetrics,
    ...(requestStartedAtMs ? { requestStartedAtMs } : {}),
    ...(model ? { model } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
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

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
