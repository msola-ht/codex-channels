import { modelRequestDiagnostics, chatDiagnosticsHeader, type ChatDiagnosticsChannel } from "./chat-diagnostics.js";
import { autoReviewMetadata } from "../../runtime/auto-review-metadata.mjs";
import { modelRequestPolicy } from "../../runtime/model-request-policy.mjs";
import { sanitizeModelRequestUrl } from "../../runtime/model-request-address.mjs";
import { OllamaWebSearch, ModelConversionError, normalizeResponsesRequest, prepareOllamaFreeform, type OllamaFreeformResponse, type DirectResponsesRequest, type SamplingParameters } from "../model-api/index.js";
import { randomUUID } from "node:crypto";
import { sendOllamaSearchResponses } from "./ollama-web-search.js";
import { consumeDirectResponses, DirectResponsesObserver } from "./direct-responses.js";
import {
  createServer,
  request as httpRequest,
  type Agent,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ClientRequest,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { Writable, type Duplex } from "node:stream";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";

import WebSocket, {
  WebSocketServer,
  type RawData,
} from "ws";

import {
  endToEndHeaders,
  chatBridgeAuthorizationHeader,
  forwardedRequestHeaders,
  forwardedWebSocketHeaders,
  isSupportedHttpRoute,
  parseListenAddress,
  resolveProxyRoute,
  upstreamPath,
  upstreamWebSocketPath,
  websocketProtocols,
  type ResolvedProxyRoute,
} from "./request-routing.js";
import {
  asRecord,
  boundedString,
  createMetricsState,
  effectiveUpstreamUserAgent,
  HttpResponseMetricsObserver,
  httpResponseFormat,
  inspectResponseEvent,
  markMetricsFailed,
  observeJsonResponse,
  observeResponseEvent,
  observeRequestSubmitted,
  observeRequestActivity,
  incompleteRequestActivity,
  observeChatTiming,
  invalidateGenerationTiming,
  parseJsonPayload,
  requestServiceTier,
  websocketCloseErrorType,
  weeklyQuotaFromEvent,
  weeklyQuotaFromHeaders,
  type MetricsState,
  type ProviderProxyMetrics,
  type ProviderQuotaWindowsSnapshot,
} from "./response-metrics-observer.js";
import { ModelTrafficDump } from "./traffic-dump.js";
import type { TrafficCallTiming } from "./traffic-call-timing.js";
import { createJsonStringFieldScanner, scanJsonStringField } from "./traffic-dump-content.js";
import {
  ChatBodyTooLargeError,
  drainRejectedRequest,
  readModelBody,
  waitForChatOperation,
} from "./chat-io.js";
import { finishProxyResponse, sendProxyWebSocket, waitForProxyOperation, writeResponseChunk } from "./proxy-delivery.js";
import { ChatUpstreamError, ModelRequestTimeoutError, type ModelRequestStage } from "./chat-errors.js";
import {
  maximumBufferedModelRequests,
  maximumModelRequestBytes,
  maximumModelWebSocketQueueBytes,
  maximumProviderImageUploadBytes,
} from "./model-request-limits.js";
import { deepseekImageMediaType, type DeepseekImageMediaType } from "./deepseek-file-upload.js";

export type {
  ProviderProxyMetrics,
  ProviderQuotaWindowSnapshot,
  ProviderQuotaWindowsSnapshot,
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

export interface ProviderImageUpload {
  kind: "deepseek";
  authorize(authorization: string | undefined): boolean;
  describe(signal: AbortSignal): Promise<{ revision: string }>;
  upload(input: {
    bytes: Buffer;
    mediaType: DeepseekImageMediaType;
    revision: string;
    signal: AbortSignal;
  }): Promise<string>;
}

export interface ProviderProxyOptions {
  upstreamAgent?: Agent;
  upstreamHost: string;
  upstreamPort?: number;
  upstreamProtocol?: "http" | "https";
  upstreamBasePath?: string;
  /** 仅官方 OpenAI 主代理启用的当前锁定 Codex 0.162.0 API 路径。 */
  allowOpenAiApiPaths?: boolean;
  /** 多账户共享代理按 `/go/<account>/...` 前缀区分的账户 id。 */
  accountIds?: readonly string[];
  /** 共享代理无账户前缀请求归属的默认账户。 */
  defaultAccountId?: string;
  /** 覆盖发给模型上游的完整 User-Agent；缺省时原样转发 App Server 生成的 UA。 */
  upstreamUserAgent?: string;
  /** Only enable for the local Chat conversion bridge. Never forwarded to App Server. */
  chatDiagnostics?: ChatDiagnosticsChannel;
  /** Private local-hop identity; never replaces upstream Authorization. */
  localChatBridgeToken?: string;
  /** Server-owned upload path for a Provider that accepts file references. */
  imageUpload?: ProviderImageUpload;
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
  resolveUpstream?: (headers: IncomingHttpHeaders, signal: AbortSignal) => ProviderProxyUpstream | Promise<ProviderProxyUpstream>;
  /** Re-read this provider's enabled model catalogue before sending Responses requests. */
  isModelEnabled?: (model: string, signal: AbortSignal) => Promise<boolean>;
  /** Read enablement and sampling from one validated catalogue snapshot. */
  readModelCapabilities?: (model: string, signal: AbortSignal) => Promise<{ sampling?: SamplingParameters } | undefined>;
  /**
   * 第三方 Responses 上游不认识 Codex 私有输入项时改写发往上游的正文：
   * `agent_message` 降级为普通 user 消息，并删除工具参数 schema 里的 `encrypted` 标记。
   * 只对第三方 Responses 上游开启；官方 OpenAI 路由保持原样。
   */
  normalizeResponsesInput?: boolean;
  /** Trusted OLC family only; never inferred from URLs, model names, or client input. */
  ollamaFreeform?: boolean;
  ollamaWebSearch?: boolean;
  /** Synchronous current account, credential and catalogue material check. */
  authorizeOllamaSearch?(authorization: string): () => void;
  quotaWindowsProvider?: (
    accountId?: string,
    signal?: AbortSignal,
  ) => Promise<ProviderQuotaWindowsSnapshot | null>;
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
  requestPurpose?: "autoApprovalReview" | null;
  reviewerThreadId?: string | null;
  reviewerTurnId?: string | null;
}

interface BufferedResponsesBody {
  search?: OllamaWebSearch;
  adapter?: OllamaFreeformResponse;
  body: Buffer;
  parsed: unknown;
  sampling?: SamplingParameters;
}

export class ProviderProxy {
  private readonly server: Server;
  private readonly websocketServer: WebSocketServer;
  private readonly upstreamAgent: Agent | undefined;
  private readonly defaultUpstream: ProviderProxyUpstream;
  private readonly resolveUpstream: ProviderProxyOptions["resolveUpstream"];
  private readonly isModelEnabled: ProviderProxyOptions["isModelEnabled"];
  private readonly readModelCapabilities: ProviderProxyOptions["readModelCapabilities"];
  private readonly normalizeResponsesInput: boolean;
  private readonly ollamaFreeform: boolean;
  private readonly ollamaWebSearch: boolean;
  private readonly authorizeOllamaSearch: ProviderProxyOptions["authorizeOllamaSearch"];
  private readonly modelAuthorizations = new Set<AbortController>();
  private readonly pendingUpgrades = new Set<Duplex>();
  private readonly pendingRequests = new Set<AbortController>();
  private readonly activeImageUploads = new Set<AbortController>();
  private readonly imageUploadOperations = new Set<Promise<string>>();
  private readonly normalizationOperations = new Set<Promise<void>>();
  private readonly shutdownController = new AbortController();
  private readonly accountIds: readonly string[] | undefined;
  private readonly defaultAccountId: string | undefined;
  private readonly upstreamUserAgent: string | undefined;
  private readonly allowOpenAiApiPaths: boolean;
  private readonly chatDiagnostics: ChatDiagnosticsChannel | undefined;
  private readonly localChatBridgeToken: string | undefined;
  private readonly imageUpload: ProviderImageUpload | undefined;
  private readonly trafficDump: ModelTrafficDump | undefined;
  private readonly quotaWindowsProvider:
    | ((
        accountId?: string,
        signal?: AbortSignal,
      ) => Promise<ProviderQuotaWindowsSnapshot | null>)
    | undefined;
  private readonly onMetrics:
    | ((metrics: ProviderProxyMetrics, accountId?: string) => void | Promise<void>)
    | undefined;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly quotaWindowsByAccount = new Map<
    string,
    ProviderQuotaWindowsSnapshot | null
  >();
  private readonly quotaRefreshByAccount = new Map<string, {
    controller: AbortController;
    promise: Promise<void>;
  }>();
  private started = false;
  private stopped = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private listenerClosed = false;

  constructor(private readonly listenAddress: string, options: ProviderProxyOptions) {
    this.websocketServer = new WebSocketServer({ noServer: true,
      maxPayload: maximumModelRequestBytes,
    });
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
    this.isModelEnabled = options.isModelEnabled;
    this.readModelCapabilities = options.readModelCapabilities;
    this.normalizeResponsesInput = options.normalizeResponsesInput ?? false;
    this.ollamaFreeform = options.ollamaFreeform ?? false;
    this.ollamaWebSearch = options.ollamaWebSearch ?? false;
    this.authorizeOllamaSearch = options.authorizeOllamaSearch?.bind(options);
    this.accountIds = options.accountIds;
    this.defaultAccountId = options.defaultAccountId;
    this.upstreamUserAgent = options.upstreamUserAgent;
    this.chatDiagnostics = options.chatDiagnostics;
    this.localChatBridgeToken = options.localChatBridgeToken;
    this.imageUpload = options.imageUpload;
    this.allowOpenAiApiPaths = options.allowOpenAiApiPaths ?? false;
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
    if (this.stopped) throw new Error("模型代理已关闭，不能重新启动");
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

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closing) return this.closing;
    this.stopped = true;
    const closing = this.finishClose().then(() => { this.closed = true; }).finally(() => {
      if (this.closing === closing) this.closing = undefined;
    });
    this.closing = closing;
    return closing;
  }

  private async finishClose(): Promise<void> {
    this.shutdownController.abort(new Error("模型代理已关闭"));
    for (const controller of this.pendingRequests) controller.abort();
    for (const controller of this.activeImageUploads) controller.abort();
    for (const controller of this.modelAuthorizations) controller.abort();
    for (const socket of this.pendingUpgrades) socket.destroy();
    const quotaRefreshes = [...this.quotaRefreshByAccount.values()];
    for (const refresh of quotaRefreshes) refresh.controller.abort();
    for (const client of this.websocketServer.clients) client.terminate();
    this.server.closeAllConnections?.();
    const results = await Promise.allSettled([
      Promise.resolve().then(async () => {
        if (this.listenerClosed) return;
        if (this.server.listening) await new Promise<void>((resolveClose, rejectClose) => {
          this.server.close(error => error ? rejectClose(error) : resolveClose());
        });
        this.listenerClosed = true;
      }),
      settleWithin(quotaRefreshes.map((refresh) => refresh.promise), quotaRefreshCloseTimeoutMs),
      Promise.allSettled([...this.imageUploadOperations]),
      Promise.resolve().then(async () => { await Promise.allSettled([...this.normalizationOperations]); await this.trafficDump?.close(); }),
    ]);
    const failures: unknown[] = [];
    for (const result of results) if (result.status === "rejected") failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, "模型代理资源未完全关闭");
  }

  private async handleImageUpload(
    request: IncomingMessage,
    response: ServerResponse,
    requestSignal: AbortSignal,
  ): Promise<void> {
    const reject = (status: number, code: string, message: string): void => {
      if (response.destroyed || response.headersSent) return;
      request.resume();
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
      response.end(JSON.stringify({ error: { code, message } }));
    };
    const remote = request.socket.remoteAddress;
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      reject(403, "image_upload_forbidden", "图片上传只接受本机回环请求");
      return;
    }
    if (!this.imageUpload!.authorize(request.headers.authorization)) {
      reject(403, "image_upload_forbidden", "图片上传调用身份无效");
      return;
    }
    if (this.activeImageUploads.size >= maximumBufferedModelRequests) {
      reject(503, "image_upload_capacity_exceeded", "图片上传容量已满");
      return;
    }
    const revision = request.headers["x-codexc-image-upload-revision"];
    if (typeof revision !== "string" || !/^[a-f0-9]{64}$/u.test(revision)) {
      reject(400, "image_upload_invalid", "图片上传版本无效");
      return;
    }
    const contentType = request.headers["content-type"];
    const contentEncoding = request.headers["content-encoding"];
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(contentType ?? "")
      || (contentEncoding !== undefined && contentEncoding !== "identity")) {
      reject(400, "image_upload_invalid", "图片上传格式无效");
      return;
    }
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maximumProviderImageUploadBytes) {
      await drainRejectedRequest(request);
      reject(413, "image_upload_too_large", "图片超过 10 MiB 限制");
      return;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([requestSignal, controller.signal]);
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort(new ModelRequestTimeoutError("upload"));
      },
      modelRequestPolicy.preparationTimeoutMs,
    );
    this.activeImageUploads.add(controller);
    try {
      const current = await waitForChatOperation(this.imageUpload!.describe(signal), signal);
      if (current.revision !== revision) {
        reject(409, "image_upload_stale", "模型配置已变化，请重新发送图片");
        return;
      }
      let bytes: Buffer;
      try {
        bytes = await readModelBody(request, signal, maximumProviderImageUploadBytes);
      } catch (error) {
        if (error instanceof ChatBodyTooLargeError) {
          await drainRejectedRequest(request);
          reject(413, "image_upload_too_large", "图片超过 10 MiB 限制");
          return;
        }
        throw error;
      }
      const mediaType = deepseekImageMediaType(bytes);
      if (mediaType === undefined || mediaType !== contentType) {
        reject(400, "image_upload_invalid", "图片内容与声明格式不一致");
        return;
      }
      const checked = await waitForChatOperation(this.imageUpload!.describe(signal), signal);
      if (checked.revision !== revision) {
        reject(409, "image_upload_stale", "模型配置已变化，请重新发送图片");
        return;
      }
      const operation = this.imageUpload!.upload({ bytes, mediaType, revision, signal });
      this.imageUploadOperations.add(operation);
      void operation.finally(() => this.imageUploadOperations.delete(operation)).catch(() => undefined);
      const fileId = await waitForChatOperation(operation, signal);
      signal.throwIfAborted();
      if (!/^file-api-[A-Za-z0-9_-]{1,128}$/u.test(fileId)) throw new Error("Invalid image file ID");
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ fileId }));
    } catch {
      if (timedOut) reject(504, "image_upload_timeout", "图片上传超时，请稍后重试");
      else if (!signal.aborted) reject(502, "image_upload_failed", "图片上传失败，请稍后重试");
    } finally {
      clearTimeout(timer);
      this.activeImageUploads.delete(controller);
      controller.abort();
    }
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const signal = this.requestSignal(response);
    if (request.method === "GET" && request.url === "/_codexc/image-upload-route") {
      request.resume();
      if (this.imageUpload && !this.imageUpload.authorize(request.headers.authorization)) {
        response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: { code: "image_upload_forbidden", message: "图片上传调用身份无效" } }));
        return;
      }
      try {
        let result: Record<string, unknown>;
        if (this.allowOpenAiApiPaths) {
          // Query the same live resolver as model traffic. No upstream request or
          // credentials are needed: this header selects the ChatGPT route.
          const upstream = await this.upstreamFor({ "chatgpt-account-id": "route-inspection" }, signal);
          const supported = upstream.protocol === "https" && upstream.host === "chatgpt.com"
            && (upstream.port === undefined || upstream.port === 443)
            && upstream.basePath === "/backend-api/codex";
          result = supported
            ? { supported: true, kind: "openai", backendOrigin: "https://chatgpt.com" }
            : { supported: false };
        } else if (this.imageUpload !== undefined) {
          const { revision } = await waitForChatOperation(this.imageUpload.describe(signal), signal);
          result = { supported: true, kind: this.imageUpload.kind, revision };
        } else {
          result = { supported: false };
        }
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(result));
      } catch {
        if (!response.destroyed) response.writeHead(503).end();
      }
      return;
    }
    if (request.method === "POST" && request.url === "/_codexc/image-upload" && this.imageUpload !== undefined) {
      await this.handleImageUpload(request, response, signal);
      return;
    }
    const startedAtMonotonicMs = performance.now();
    const startedAtMs = Date.now();
    const route = resolveProxyRoute(
      request.url,
      this.accountIds,
      this.defaultAccountId,
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
    const contentEncoding = request.headers["content-encoding"];
    if (contentEncoding !== undefined && contentEncoding !== "identity") {
      request.resume();
      response.writeHead(400, { "content-type": "application/json", "connection": "close" });
      response.end(JSON.stringify({ error: {
        type: "provider_model_request_invalid",
        code: "provider_model_request_invalid",
        message: "模型请求不支持压缩正文。",
      } }));
      return;
    }
    const pathname = new URL(route.path, "http://127.0.0.1").pathname;
    const imageOperation = route.kind === "openai-http"
      ? pathname === "/images/generations" ? "imageGeneration"
        : pathname === "/images/edits" ? "imageEdit" : undefined
      : undefined;
    let upstreamTarget: ProviderProxyUpstream;
    const onPendingError = () => response.destroy();
    request.on("error", onPendingError);
    request.once("close", () => request.removeListener("error", onPendingError));
    try {
      upstreamTarget = await this.upstreamFor(request.headers, signal);
    } catch (error) {
      const failedAtMonotonicMs = performance.now();
      if (this.stopped || response.destroyed) return;
      request.resume();
      const metadata = parseTurnMetadata(request.headers["x-codex-turn-metadata"]);
      const metrics = createMetricsState(metadata, startedAtMs, "http",
        imageOperation ?? metadata.operation,
        effectiveUpstreamUserAgent(request.headers, this.upstreamUserAgent));
      metrics.httpStatus = error instanceof ModelRequestTimeoutError ? error.status : 502;
      markMetricsFailed(metrics, error instanceof ModelRequestTimeoutError ? error.code : "provider_proxy_route_error", Date.now(), error, failedAtMonotonicMs);
      const exchange = this.trafficDump?.beginHttpExchange({
        ...(route.accountId === undefined ? {} : { accountId: route.accountId }),
        headers: request.headers, method: request.method ?? "GET",
        path: request.url ?? "", startedAtMs, startedAtMonotonicMs,
      });
      exchange?.responseHead(metrics.httpStatus, {});
      exchange?.observeRequestMetrics(metrics);
      exchange?.failure("upstream_route", undefined, failedAtMonotonicMs);
      if (route.kind === "response" || imageOperation !== undefined) {
        await this.deliverMetrics(metrics, route.accountId, signal);
      }
      if (signal.aborted || response.destroyed) return;
      response.writeHead(metrics.httpStatus, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof ModelRequestTimeoutError
        ? { type: error.code, code: error.code, message: error.message, timeout_stage: error.stage }
        : { type: "provider_proxy_route_error" } }));
      this.onError?.(asError(error));
      return;
    }
    request.removeListener("error", onPendingError);
    if (this.stopped || response.destroyed) return;
    // Resolve the route before the final catalogue check so a slow resolver
    // cannot retain an authorization for a model disabled while it was waiting.
    // 第三方 Responses 上游必须缓冲正文才能归一化私有输入项；有目录守卫时缓冲同时用于模型复核。
    const buffersResponsesBody = route.kind === "response"
      && (this.isModelEnabled !== undefined || this.readModelCapabilities !== undefined || this.normalizeResponsesInput || this.ollamaFreeform || this.ollamaWebSearch);
    const bufferedRequest = buffersResponsesBody
      ? await this.bufferResponsesBody(request, response)
      : undefined;
    if (bufferedRequest === null || this.stopped || response.destroyed) return;
    const bufferedBody = bufferedRequest?.body;
    // 转储与指标记录客户端原始报文；只有发往第三方上游的正文经过归一化。
    const upstreamBody = bufferedRequest !== undefined
      ? this.prepareResponsesBody(bufferedRequest, response)
      : bufferedBody;
    if (upstreamBody === null) return;
    const turnMetadata = parseTurnMetadata(
      request.headers["x-codex-turn-metadata"],
    );
    const metrics = createMetricsState(
      turnMetadata,
      startedAtMs,
      "http",
      imageOperation ?? turnMetadata.operation,
      effectiveUpstreamUserAgent(request.headers, this.upstreamUserAgent),
    );
    const exchange = bufferedRequest?.search ? undefined : this.trafficDump?.beginHttpExchange({
      ...(route.accountId === undefined ? {} : { accountId: route.accountId }),
      headers: request.headers,
      method: request.method ?? "GET",
      path: request.url ?? "",
      startedAtMs,
      startedAtMonotonicMs,
    });
    exchange?.observeRequestMetrics(metrics);
    const requestModelScanner = createJsonStringFieldScanner("model");
    const requestTierScanner = createJsonStringFieldScanner("service_tier");
    const requestEffortScanner = createJsonStringFieldScanner("effort", "reasoning");
    const requestModelDecoder = new StringDecoder("utf8");
    const activityChunks: Buffer[] = [];
    let activityBytes = 0;
    let activityOverflow = false;
    if (bufferedRequest) observeRequestActivity(metrics, bufferedRequest.parsed);
    const recordsResponseMetrics = route.kind === "response";
    const recordsMetrics = recordsResponseMetrics || imageOperation !== undefined;
    const scansRequestMetadata = imageOperation === undefined
      || String(request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() === "application/json";
    let metricsDelivery: Promise<void> | undefined;
    const emitMetrics = (): Promise<void> => {
      if (!recordsMetrics) return Promise.resolve();
      metricsDelivery ??= this.deliverMetrics(metrics, route.accountId, signal);
      return metricsDelivery;
    };
    const upstreamRequest = upstreamTarget.protocol === "http"
      ? httpRequest
      : httpsRequest;
    const diagnosticObserver = this.chatDiagnostics?.subscribe(snapshot => {
      if (snapshot.upstreamUrl !== undefined) metrics.upstreamUrl = snapshot.upstreamUrl;
      if (snapshot.timing) {
        observeChatTiming(metrics, snapshot.timing);
        exchange?.callTiming?.submitted(snapshot.timing.submittedAt);
      }
      Object.assign(metrics, modelRequestDiagnostics(snapshot));
      exchange?.write({ kind: "chat_diagnostics", fields: snapshot.fields, truncated: snapshot.truncated });
    });
    response.once("close", () => diagnosticObserver?.close());
    const upstreamHeaders = forwardedRequestHeaders(request.headers, upstreamTarget.host, upstreamTarget.port, this.upstreamUserAgent);
    if (bufferedRequest?.search && upstreamBody) {
      if (this.normalizationOperations.size >= maximumBufferedModelRequests) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { type: "olc_search_capacity", message: "Ollama Cloud 搜索请求并发已满。" } }));
        diagnosticObserver?.close(); return;
      }
      const search = bufferedRequest.search;
      const body = JSON.parse(upstreamBody.toString("utf8")) as DirectResponsesRequest;
      metrics.requestModel = boundedString(body.model);
      metrics.requestServiceTier = requestServiceTier(body);
      metrics.reasoningEffort = boundedString(asRecord(body.reasoning)?.effort);
      metrics.responseFormat = body.stream ? "sse" : "json";
      const observer = new DirectResponsesObserver();
      const searchController = new AbortController();
      const searchSignal = AbortSignal.any([signal, searchController.signal]);
      let submitted = false;
      let roundExchange: ReturnType<ModelTrafficDump["beginHttpExchange"]> | undefined;
      let roundMetrics: MetricsState | undefined;
      let delivering = false;
      let terminalAttempted = false;
      const searchAgent = upstreamTarget.agent ?? this.upstreamAgent;
      const authorization = String(request.headers.authorization ?? "");
      let materialCheck: (() => void) | undefined;
      const syncMetrics = (): void => {
        Object.assign(metrics, observer.timing);
        if (observer.firstTokenMs !== undefined) metrics.firstTokenMs = observer.firstTokenMs;
        for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningOutputTokens"] as const) metrics[key] = observer.usage[key] ?? null;
        invalidateGenerationTiming(metrics);
      };
      const recheck = (): void => {
        searchSignal.throwIfAborted();
        if (this.stopped || !this.authorizeOllamaSearch) throw new ModelConversionError("Ollama Cloud 搜索材料复核不可用。");
        materialCheck ??= this.authorizeOllamaSearch(authorization);
        materialCheck();
      };
      const operation = sendOllamaSearchResponses({ search, request: body, target: { ...upstreamTarget,
        ...(searchAgent ? { agent: searchAgent } : {}),
        authorization }, signal: searchSignal, deadlineAt: startedAtMonotonicMs + 10 * 60_000,
        cancel: reason => searchController.abort(reason), clientHeaders: request.headers, observer, recheck,
        refresh: async operationSignal => {
          recheck();
          const capability = this.readModelCapabilities ? await this.readModelCapabilities(body.model, operationSignal) : undefined;
          operationSignal.throwIfAborted();
          if (this.readModelCapabilities && (!capability || JSON.stringify(capability.sampling) !== JSON.stringify(bufferedRequest.sampling))
            || !this.readModelCapabilities && this.isModelEnabled && !await this.isModelEnabled(body.model, operationSignal)) throw new ModelConversionError("Ollama Cloud 模型目录已变化。");
          operationSignal.throwIfAborted();
          const current = await this.upstreamFor(request.headers, operationSignal);
          operationSignal.throwIfAborted();
          if (current.host !== upstreamTarget.host || current.port !== upstreamTarget.port || current.protocol !== upstreamTarget.protocol
            || current.basePath !== upstreamTarget.basePath || current.agent !== upstreamTarget.agent) throw new ModelConversionError("Ollama Cloud 出站材料已变化。");
          recheck();
        },
        capture: {
          submitted: (outbound, headers, path) => {
            roundExchange = this.trafficDump?.beginHttpExchange({ headers: headers as IncomingHttpHeaders, method: "POST", path, startedAtMs: Date.now(), startedAtMonotonicMs: performance.now(),
              ...(route.accountId === undefined ? {} : { accountId: route.accountId }) });
            roundExchange?.requestChunk(Buffer.from(JSON.stringify(outbound))); roundExchange?.requestEnd();
            roundMetrics = createMetricsState(turnMetadata, Date.now(), "http", "response", metrics.userAgent);
            observeRequestSubmitted(roundMetrics, performance.now());
            roundExchange?.callTiming?.submitted(performance.now());
            roundExchange?.observeRequestMetrics(roundMetrics);
            if (roundMetrics.traffic) metrics.traffic = roundMetrics.traffic;
          },
          head: (status, headers) => roundExchange?.responseHead(status, headers as IncomingHttpHeaders),
          value: () => {},
          invalid: () => {}, done: () => { roundExchange?.responseEnd(); roundExchange = undefined; }, finish: () => undefined,
        },
        observeChunk: chunk => roundExchange?.responseChunk(chunk),
        observeValue: (value, stream, receivedAt) => {
          if (roundMetrics) {
            if (stream) observeResponseEvent(roundMetrics, String(value.type), value, Date.now(), receivedAt);
            else observeJsonResponse(roundMetrics, value, Date.now(), receivedAt);
          }
          syncMetrics();
        },
        diagnostics: summary => Object.assign(metrics, summary),
        submitted: (ua, bytes, url) => {
          if (!submitted) { submitted = true; observeRequestSubmitted(metrics, performance.now()); }
          metrics.requestBytes = (metrics.requestBytes ?? 0) + bytes; metrics.upstreamUrl = url; metrics.userAgent = ua;
        },
        headers: status => { metrics.httpStatus = status; }, content: () => {},
        emit: async (value, terminal) => {
          if (terminal) terminalAttempted = true;
          if (terminal) { const final = body.stream ? asRecord(value.response)! : value; observeJsonResponse(metrics, final, Date.now(), performance.now()); syncMetrics(); await emitMetrics(); }
          delivering = true;
          if (!response.headersSent) response.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json", "cache-control": "no-store" });
          await writeResponseChunk(response, Buffer.from(body.stream ? `event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n` : JSON.stringify(value)), searchSignal,
            terminal ? modelRequestPolicy.terminalDeliveryTimeoutMs : modelRequestPolicy.deliveryTimeoutMs, () => invalidateGenerationTiming(metrics), terminal ? "terminal" : "delivery");
          delivering = false;
        },
      }).then(async () => { await finishProxyResponse(response, searchSignal, modelRequestPolicy.terminalDeliveryTimeoutMs); exchange?.responseEnd(); await emitMetrics(); })
        .catch(async (error: unknown) => {
          const failureType = signal.aborted && response.destroyed && !this.stopped ? "client_disconnected"
            : error instanceof ModelRequestTimeoutError ? error.code : delivering ? "client_delivery_error" : "olc_search_failed";
          if (metrics.status === "unknown") markMetricsFailed(metrics, failureType, Date.now(), error);
          if (error instanceof ChatUpstreamError) metrics.errorCode = error.code;
          roundExchange?.failure(delivering ? "client_delivery" : "olc_search_failed", error); roundExchange = undefined;
          syncMetrics(); exchange?.failure(delivering ? "client_delivery" : "olc_search_failed", error); await emitMetrics();
          if (!response.destroyed && !signal.aborted && response.headersSent && body.stream && !delivering && !terminalAttempted) {
            // Upstream work is already stopped. Local deadlines/material revocation
            // still get the existing bounded failure-delivery budget; a disconnected
            // client or a partially delivered terminal must not receive a second one.
            const failureController = new AbortController();
            const failureTimer = setTimeout(() => failureController.abort(), modelRequestPolicy.terminalDeliveryTimeoutMs);
            const failureSignal = AbortSignal.any([signal, failureController.signal]);
            const failure = search.forDelivery(search.failure(error instanceof ChatUpstreamError ? error.code : "olc_search_failed",
              error instanceof ChatUpstreamError ? error.message : "Ollama Cloud 网页搜索请求失败。"));
            try {
              await writeResponseChunk(response, Buffer.from(`event: response.failed\ndata: ${JSON.stringify(failure)}\n\n`), failureSignal,
                modelRequestPolicy.terminalDeliveryTimeoutMs, () => invalidateGenerationTiming(metrics), "terminal");
              await finishProxyResponse(response, failureSignal, modelRequestPolicy.terminalDeliveryTimeoutMs);
            } catch { response.destroy(); }
            finally { clearTimeout(failureTimer); }
          } else if (!response.destroyed && !signal.aborted && !response.headersSent) {
            const controlled = error instanceof ChatUpstreamError ? error : undefined;
            const status = controlled?.upstreamStatus;
            response.writeHead(status !== undefined && [429, 503, 504].includes(status) ? status
              : controlled && ["olc_search_timeout", "olc_search_deadline", "upstream_timeout"].includes(controlled.code) ? 504 : 502, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { type: controlled?.code ?? "olc_search_failed", message: controlled?.message ?? "Ollama Cloud 网页搜索请求失败。" } }));
          } else response.destroy();
        }).finally(() => diagnosticObserver?.close());
      this.normalizationOperations.add(operation); void operation.finally(() => this.normalizationOperations.delete(operation)).catch(() => undefined);
      return;
    }
    delete upstreamHeaders[chatDiagnosticsHeader];
    if (diagnosticObserver) upstreamHeaders[chatDiagnosticsHeader] = diagnosticObserver.id;
    if (this.localChatBridgeToken !== undefined) upstreamHeaders[chatBridgeAuthorizationHeader] = this.localChatBridgeToken;
    // 归一化会改变正文长度；按实际提交字节重写，避免沿用客户端长度造成上游等待或截断。
    if (upstreamBody !== undefined) upstreamHeaders["content-length"] = String(upstreamBody.length);
    let streamingWriter: Writable | undefined;
    let closingRejectedUpload = false;
    let headersTimer: NodeJS.Timeout | undefined;
    let bodyTimer: NodeJS.Timeout | undefined;
    let uploadTimer: NodeJS.Timeout | undefined;
    let upstreamIncoming: IncomingMessage | undefined;
    let deliveryFailed = false;
    const clearDeadlines = (): void => {
      clearTimeout(headersTimer); clearTimeout(bodyTimer); clearTimeout(uploadTimer);
    };
    const cancelled = (): void => { clearDeadlines(); upstreamIncoming?.destroy(); upstream.destroy(); };
    const failDelivery = (error: unknown): void => {
      // ServerResponse may emit close before the finish waiter's promise settles.
      // A completed write is successful even when that close cancels other work.
      if (deliveryFailed || response.writableFinished || signal.aborted) return;
      deliveryFailed = true;
      const failedAtMonotonicMs = performance.now();
      markMetricsFailed(metrics, error instanceof ModelRequestTimeoutError ? error.code : "client_delivery_error", Date.now(), error, failedAtMonotonicMs);
      exchange?.failure("client_delivery", error, failedAtMonotonicMs);
      void emitMetrics();
      this.onError?.(asError(error));
      upstreamIncoming?.destroy();
      upstream.destroy();
      response.destroy();
    };
    const upstream = upstreamRequest({
      agent: upstreamTarget.agent ?? this.upstreamAgent,
      hostname: upstreamTarget.host.replace(/^\[(.*)\]$/u, "$1"),
      ...(upstreamTarget.port === undefined ? {} : { port: upstreamTarget.port }),
      path: upstreamPath(upstreamTarget.basePath, route.path),
      method: request.method,
      headers: upstreamHeaders,
    }, (upstreamResponse) => {
      clearTimeout(headersTimer);
      upstreamIncoming = upstreamResponse;
      // Local Chat forwarding delegates upstream progress clocks to the bridge.
      // Native Responses SSE/WS idle belongs to Codex's complete-event reader.
      if (!this.chatDiagnostics) {
        const isError = (upstreamResponse.statusCode ?? 502) >= 400;
        const contentType = String(upstreamResponse.headers["content-type"] ?? "").toLowerCase();
        const isStream = contentType.includes("text/event-stream")
          || (recordsResponseMetrics && !contentType.includes("json") && !isError);
        if (isError || !isStream) {
          bodyTimer = setTimeout(() => upstreamResponse.destroy(new ModelRequestTimeoutError("body")),
            isError ? modelRequestPolicy.errorBodyTimeoutMs : modelRequestPolicy.bodyReadTimeoutMs);
        }
      }
      const receivedAtMs = Date.now();
      metrics.httpStatus = upstreamResponse.statusCode ?? null;
      metrics.responseFormat = httpResponseFormat(upstreamResponse.headers["content-type"]);
      metrics.weeklyQuota = weeklyQuotaFromHeaders(upstreamResponse.headers);
      metrics.quotaObservedAtMs = metrics.weeklyQuota === null ? null : receivedAtMs;
      exchange?.responseHead(
        upstreamResponse.statusCode ?? null,
        upstreamResponse.headers,
      );
      if ((upstreamResponse.statusCode ?? 0) >= 400
        && (!request.complete || (streamingWriter !== undefined && !streamingWriter.writableFinished))) {
        // 上游提前拒绝上传：保留错误响应，响应发送完成后关闭本跳连接。
        if (streamingWriter) {
          request.unpipe(streamingWriter);
          streamingWriter.destroy();
        }
        request.pause();
        clearTimeout(uploadTimer);
        response.setHeader("connection", "close");
        response.once("finish", () => {
          closingRejectedUpload = true;
          upstream.destroy();
          request.destroy();
        });
      }
      const metricsObserver = new HttpResponseMetricsObserver(metrics);
      if (bufferedRequest?.adapter && upstreamBody && (upstreamResponse.statusCode ?? 502) === 200) {
        clearTimeout(bodyTimer);
        const observer = new DirectResponsesObserver();
        let delivering = false;
        const normalization = consumeDirectResponses(upstreamResponse, {
          request: JSON.parse(upstreamBody.toString("utf8")) as DirectResponsesRequest,
          signal, observer, adapter: bufferedRequest.adapter,
          headers: () => {}, content: () => {},
          observeChunk: chunk => exchange?.responseChunk(chunk),
          observeValue: (value, stream, receivedAt) => {
            if (stream) observeResponseEvent(metrics, String(value.type), value, Date.now(), receivedAt);
            else observeJsonResponse(metrics, value, Date.now(), receivedAt);
          },
          emit: async (value, terminal) => {
            delivering = true;
            if (terminal) await emitMetrics();
            if (!response.headersSent) {
              const headers = endToEndHeaders(upstreamResponse.headers); delete headers["content-length"];
              response.writeHead(upstreamResponse.statusCode ?? 200, headers);
            }
            const stream = bufferedRequest.parsed && typeof bufferedRequest.parsed === "object" && "stream" in bufferedRequest.parsed && bufferedRequest.parsed.stream === true;
            const chunk = Buffer.from(stream ? `event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n` : JSON.stringify(value));
            await writeResponseChunk(response, chunk, signal, terminal ? modelRequestPolicy.terminalDeliveryTimeoutMs : modelRequestPolicy.deliveryTimeoutMs,
              () => invalidateGenerationTiming(metrics), terminal ? "terminal" : "delivery");
            delivering = false;
          },
        }).then(async () => {
          delivering = true;
          await finishProxyResponse(response, signal, modelRequestPolicy.terminalDeliveryTimeoutMs);
          delivering = false;
          exchange?.responseEnd(); await emitMetrics();
        }).catch((error: unknown) => {
          if (deliveryFailed) return;
          deliveryFailed = true;
          if (signal.aborted) { upstreamResponse.destroy(); upstream.destroy(); return; }
          const scope = delivering ? "client_delivery" : "response_normalization";
          if (metrics.status === "unknown") markMetricsFailed(metrics, scope, Date.now(), error);
          // A model terminal is preserved while the separate error classification records failed delivery.
          metrics.errorType = scope; exchange?.failure(scope, error); void emitMetrics();
          upstreamResponse.destroy(); upstream.destroy();
          if (!response.headersSent && !response.destroyed && !signal.aborted) {
            response.writeHead(502, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { type: "provider_response_invalid", message: "Ollama Cloud 响应无法安全转换" } }));
          } else response.destroy();
          this.onError?.(asError(error));
        });
        this.normalizationOperations.add(normalization);
        void normalization.finally(() => this.normalizationOperations.delete(normalization)).catch(() => undefined);
        return;
      }
      writeUpstreamHead(response, upstreamResponse);
      let forwarding = Promise.resolve();
      upstreamResponse.on("data", (chunk: Buffer) => {
        const receivedAtMonotonicMs = performance.now();
        const receivedAtMs = Date.now();
        exchange?.responseChunk(chunk);
        const completed = metricsObserver.observeChunk(chunk, receivedAtMs, receivedAtMonotonicMs);
        upstreamResponse.pause();
        const timeoutMs = completed ? modelRequestPolicy.terminalDeliveryTimeoutMs : modelRequestPolicy.deliveryTimeoutMs;
        const next = forwarding.then(async () => {
          signal.throwIfAborted();
          if (completed) await emitMetrics();
          await writeResponseChunk(response, chunk, signal, timeoutMs, () => invalidateGenerationTiming(metrics), completed ? "terminal" : "delivery");
          upstreamResponse.resume();
        });
        forwarding = waitForProxyOperation(next, signal, timeoutMs, completed ? "terminal" : "delivery").catch(failDelivery);
      });
      upstreamResponse.on("end", () => {
        clearTimeout(bodyTimer);
        const endedAtMonotonicMs = performance.now();
        const endedAtMs = Date.now();
        const completed = metricsObserver.finish(endedAtMs, endedAtMonotonicMs);
        exchange?.responseEnd(endedAtMonotonicMs);
        const ending = forwarding.then(async () => {
          signal.throwIfAborted();
          if (completed || recordsMetrics) await emitMetrics();
          await finishProxyResponse(response, signal, modelRequestPolicy.terminalDeliveryTimeoutMs);
        });
        forwarding = waitForProxyOperation(ending, signal, modelRequestPolicy.terminalDeliveryTimeoutMs, "terminal").catch(failDelivery);
      });
      upstreamResponse.on("error", (error) => {
        clearTimeout(bodyTimer);
        if (closingRejectedUpload || deliveryFailed || signal.aborted) return;
        const failedAtMonotonicMs = performance.now();
        if (metrics.status === "completed" && isExpectedStreamAbort(error)) {
          response.destroy();
          return;
        }
        markMetricsFailed(metrics, error instanceof ModelRequestTimeoutError ? error.code : "upstream_response_error", Date.now(), error, failedAtMonotonicMs);
        exchange?.failure("upstream_response", error, failedAtMonotonicMs);
        void emitMetrics();
        response.destroy();
        this.onError?.(asError(error));
      });
    });
    signal.addEventListener("abort", cancelled, { once: true });
    response.once("close", () => { clearDeadlines(); signal.removeEventListener("abort", cancelled); });
    upstream.on("error", (error) => {
      clearDeadlines();
      if (closingRejectedUpload || deliveryFailed || signal.aborted) return;
      const failedAtMonotonicMs = performance.now();
      if (error instanceof ModelRequestTimeoutError && metrics.httpStatus === null) metrics.httpStatus = error.status;
      markMetricsFailed(metrics, error instanceof ModelRequestTimeoutError ? error.code : "upstream_request_error", Date.now(), error, failedAtMonotonicMs);
      exchange?.failure("upstream_request", error, failedAtMonotonicMs);
      void emitMetrics();
      if (!response.headersSent) {
        response.writeHead(error instanceof ModelRequestTimeoutError ? error.status : 502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof ModelRequestTimeoutError
          ? { type: error.code, code: error.code, message: error.message, timeout_stage: error.stage }
          : { type: "provider_proxy_upstream_error" } }));
      } else {
        response.destroy();
      }
      this.onError?.(asError(error));
    });
    request.on("error", (error) => {
      if (closingRejectedUpload || deliveryFailed) return;
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
        if (!deliveryFailed && metrics.status !== "completed") {
          markMetricsFailed(metrics, "client_disconnected", Date.now(), undefined, closedAtMonotonicMs);
          exchange?.failure("client_disconnected", undefined, closedAtMonotonicMs);
          void emitMetrics();
        } else if (!deliveryFailed) {
          exchange?.failure("client_disconnected", undefined, closedAtMonotonicMs);
        }
        upstream.destroy();
      }
    });
    const observeRequestChunk = (chunk: Buffer): void => {
      if (recordsResponseMetrics && !bufferedRequest && !activityOverflow) {
        activityBytes += chunk.length;
        if (activityBytes <= 1_048_576) activityChunks.push(chunk);
        else { activityOverflow = true; activityChunks.length = 0; incompleteRequestActivity(metrics); }
      }
      if (scansRequestMetadata) {
        const text = requestModelDecoder.write(chunk);
        scanJsonStringField(requestModelScanner, text);
        metrics.requestModel = boundedString(requestModelScanner.value);
        if (imageOperation !== undefined) metrics.model = metrics.requestModel;
        else {
          scanJsonStringField(requestTierScanner, text);
          scanJsonStringField(requestEffortScanner, text);
          metrics.requestServiceTier = boundedString(requestTierScanner.value);
          metrics.reasoningEffort = boundedString(requestEffortScanner.value);
        }
      }
      exchange?.requestChunk(chunk);
    };
    const observeRequestEnd = (): void => {
      let parsedRequest = bufferedRequest?.parsed;
      if (recordsResponseMetrics && !bufferedRequest && !activityOverflow) {
        parsedRequest = parseJsonPayload(Buffer.concat(activityChunks).toString("utf8"));
        observeRequestActivity(metrics, parsedRequest);
        activityChunks.length = 0;
      }
      if (scansRequestMetadata) {
        const text = requestModelDecoder.end();
        scanJsonStringField(requestModelScanner, text);
        metrics.requestModel = boundedString(requestModelScanner.value);
        if (imageOperation !== undefined) metrics.model = metrics.requestModel;
        else {
          scanJsonStringField(requestTierScanner, text);
          scanJsonStringField(requestEffortScanner, text);
          metrics.requestServiceTier = boundedString(requestTierScanner.value);
          metrics.reasoningEffort = boundedString(requestEffortScanner.value);
        }
      }
      if (recordsResponseMetrics && parsedRequest !== undefined) {
        metrics.requestServiceTier = requestServiceTier(asRecord(parsedRequest));
      }
      exchange?.requestEnd();
    };
    if (bufferedBody === undefined) {
      request.on("data", observeRequestChunk);
      request.on("end", observeRequestEnd);
    } else {
      observeRequestChunk(bufferedBody);
      observeRequestEnd();
    }
    if (!request.complete) {
      uploadTimer = setTimeout(() => upstream.destroy(new ModelRequestTimeoutError("upload")), modelRequestPolicy.preparationTimeoutMs);
      request.once("end", () => clearTimeout(uploadTimer));
    }
    if (upstreamBody === undefined) {
      const declared = Number(request.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maximumModelRequestBytes) {
        clearDeadlines();
        closingRejectedUpload = true;
        request.resume();
        await drainRejectedRequest(request);
        upstream.destroy();
        const failedAtMonotonicMs = performance.now();
        markMetricsFailed(metrics, "provider_model_request_invalid", Date.now(), undefined, failedAtMonotonicMs);
        exchange?.failure("client_request", undefined, failedAtMonotonicMs);
        void emitMetrics();
        deliveryFailed = true;
        if (!response.destroyed && !response.headersSent) {
          response.writeHead(413, { "content-type": "application/json", "connection": "close" });
          response.end(JSON.stringify({ error: {
            type: "provider_model_request_invalid",
            code: "provider_model_request_invalid",
            message: "模型请求正文超过 48 MiB。",
          } }));
        }
        return;
      }
      const writer = createModelRequestBodyWriter(upstream, this.chatDiagnostics === undefined
        ? bytes => { metrics.requestBytes = (metrics.requestBytes ?? 0) + bytes; }
        : undefined);
      streamingWriter = writer;
      writer.once("error", (error) => {
        if (closingRejectedUpload || deliveryFailed || signal.aborted) return;
        if (!(error instanceof ChatBodyTooLargeError)) {
          upstream.destroy(error);
          return;
        }
        clearDeadlines();
        closingRejectedUpload = true;
        request.unpipe(writer);
        upstream.destroy();
        void drainRejectedRequest(request).then(() => {
          const failedAtMonotonicMs = performance.now();
          markMetricsFailed(metrics, "provider_model_request_invalid", Date.now(), error, failedAtMonotonicMs);
          exchange?.failure("client_request", error, failedAtMonotonicMs);
          void emitMetrics();
          deliveryFailed = true;
          if (!response.destroyed && !response.headersSent) {
            response.writeHead(413, { "content-type": "application/json", "connection": "close" });
            response.end(JSON.stringify({ error: {
              type: "provider_model_request_invalid",
              code: "provider_model_request_invalid",
              message: "模型请求正文超过 48 MiB。",
            } }));
          } else {
            response.destroy();
          }
          this.onError?.(asError(error));
        });
      });
    }
    const submittedAt = performance.now();
    upstream.flushHeaders();
    if (!this.chatDiagnostics) {
      metrics.upstreamUrl = sanitizeModelRequestUrl(/^https?:\/\//u.test(upstream.path)
        ? upstream.path : `${upstream.protocol}//${String(upstream.getHeader("host"))}${upstream.path}`);
      observeRequestSubmitted(metrics, submittedAt);
      exchange?.callTiming?.submitted(submittedAt);
      headersTimer = setTimeout(() => upstream.destroy(new ModelRequestTimeoutError("headers")), modelRequestPolicy.headersTimeoutMs);
    }
    if (upstreamBody === undefined) {
      if (this.chatDiagnostics === undefined) metrics.requestBytes = 0;
      request.pipe(streamingWriter!);
    } else {
      upstream.end(upstreamBody);
      if (this.chatDiagnostics === undefined) metrics.requestBytes = upstreamBody.length;
    }
  }

  /**
   * 归一化第三方 Responses 正文并补齐当前模型的默认采样。未发生改写时沿用原始字节，
   * 避免无意义的重新序列化；`agent_message` 内容非法时按请求错误失败关闭。
   */
  private prepareResponsesBody(buffered: BufferedResponsesBody, response: ServerResponse): Buffer | null {
    const { body, parsed, sampling } = buffered;
    try {
      const normalized = this.normalizeResponsesInput
        ? normalizeResponsesRequest(parsed) : { body: parsed, changed: false };
      const sampled = applySamplingDefaults(normalized.body, sampling);
      const search = this.ollamaWebSearch ? new OllamaWebSearch(sampled.body as Record<string, unknown>, randomUUID().replaceAll("-", "")) : undefined;
      if (search?.active) {
        // Validate all choices and histories before either network service is invoked.
        prepareOllamaFreeform(search.body).adapter.close();
        buffered.search = search; return Buffer.from(JSON.stringify(search.body));
      }
      const prepared = search?.body ?? sampled.body;
      const adapted = this.ollamaFreeform ? prepareOllamaFreeform(prepared as Record<string, unknown>) : undefined;
      if (adapted?.adapter.active) buffered.adapter = adapted.adapter;
      else adapted?.adapter.close();
      return normalized.changed || sampled.changed || search !== undefined && search.body !== sampled.body || adapted !== undefined && adapted.body !== prepared
        ? Buffer.from(JSON.stringify(adapted?.body ?? prepared)) : body;
    } catch (error) {
      const message = error instanceof ModelConversionError
        ? error.message
        : "第三方上游不接受该请求报文";
      if (!response.destroyed && !response.headersSent) {
        response.writeHead(400, { "content-type": "application/json", "connection": "close" });
        response.end(JSON.stringify({ error: { type: "provider_model_request_invalid", message } }));
      }
      return null;
    }
  }

  /**
   * 有界读取并解析发往 Responses 上游的正文。配置了目录守卫时在读取后复核模型；
   * 归一化复用同一次解析，原始字节保留给转储、指标及未改写请求。
   */
  private async bufferResponsesBody(request: IncomingMessage, response: ServerResponse): Promise<BufferedResponsesBody | null> {
    const reject = (status: number, type: string, message: string, stage?: ModelRequestStage): null => {
      if (!response.destroyed && !response.headersSent) {
        response.writeHead(status, { "content-type": "application/json", "connection": "close" });
        response.end(JSON.stringify({ error: { type, message, ...(stage === undefined ? {} : { code: type, timeout_stage: stage }) } }));
      }
      return null;
    };
    if (this.stopped || this.modelAuthorizations.size >= maximumBufferedModelRequests) {
      return reject(503, "provider_catalog_unavailable", "模型请求暂不可用，请稍后重试。");
    }
    if (request.headers["content-encoding"] !== undefined && request.headers["content-encoding"] !== "identity") {
      return reject(400, "provider_model_request_invalid", "模型请求不支持压缩正文。");
    }
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maximumModelRequestBytes) {
      request.resume();
      await drainRejectedRequest(request);
      return reject(413, "provider_model_request_invalid", "模型请求正文超过 48 MiB。");
    }
    const isModelEnabled = this.isModelEnabled;
    const readModelCapabilities = this.readModelCapabilities;
    const controller = new AbortController();
    this.modelAuthorizations.add(controller);
    const disconnected = (): void => controller.abort();
    response.once("close", disconnected);
    let timer = setTimeout(() => controller.abort(new ModelRequestTimeoutError("upload")), modelRequestPolicy.preparationTimeoutMs);
    let checkingCatalog = false;
    try {
      const body = await readModelBody(request, controller.signal, maximumModelRequestBytes);
      clearTimeout(timer);
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      let sampling: SamplingParameters | undefined;
      if (isModelEnabled !== undefined || readModelCapabilities !== undefined) {
        const model = asRecord(parsed)?.model;
        if (typeof model !== "string" || !model.length) {
          return reject(400, "provider_model_request_invalid", "模型请求必须包含明确的 model ID。");
        }
        checkingCatalog = true;
        timer = setTimeout(() => controller.abort(new ModelRequestTimeoutError("prepare")), modelRequestPolicy.preparationTimeoutMs);
        const capabilities = readModelCapabilities === undefined ? undefined
          : await waitForChatOperation(readModelCapabilities(model, controller.signal), controller.signal);
        const enabled = readModelCapabilities !== undefined ? capabilities !== undefined
          : await waitForChatOperation(isModelEnabled!(model, controller.signal), controller.signal);
        controller.signal.throwIfAborted();
        if (!enabled) return reject(409, "provider_model_disabled", "该模型已停用或不在当前目录中，请重新选择已启用的模型。");
        sampling = capabilities?.sampling;
      }
      return { body, parsed, ...(sampling === undefined ? {} : { sampling }) };
    } catch (error) {
      if (response.destroyed || this.stopped) return null;
      const reason: unknown = controller.signal.reason;
      if (reason instanceof ModelRequestTimeoutError) return reject(reason.status, reason.code, reason.message, reason.stage);
      if (checkingCatalog) return reject(503, "provider_catalog_unavailable", "模型目录暂时无法安全读取，请检查目录后重试。");
      if (error instanceof ChatBodyTooLargeError) {
        request.resume();
        await drainRejectedRequest(request);
        return reject(413, "provider_model_request_invalid", "模型请求正文超过 48 MiB。");
      }
      return reject(controller.signal.aborted ? 408 : 400,
        "provider_model_request_invalid", "模型请求正文无效、超过 48 MiB 或上传超时。");
    } finally {
      clearTimeout(timer);
      response.off("close", disconnected);
      this.modelAuthorizations.delete(controller);
    }
  }

  private async handleWebSocketUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const signal = this.requestSignal(socket);
    if (this.ollamaFreeform) { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
    const startedAtMs = Date.now();
    const route = resolveProxyRoute(
      request.url,
      this.accountIds,
      this.defaultAccountId,
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
      target = await this.upstreamFor(request.headers, signal);
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
          effectiveUpstreamUserAgent(request.headers, this.upstreamUserAgent),
        );
        metrics.httpStatus = error instanceof ModelRequestTimeoutError ? error.status : 502;
        markMetricsFailed(metrics, error instanceof ModelRequestTimeoutError ? error.code : "provider_proxy_route_error", Date.now(), error);
        await this.deliverMetrics(metrics, route.accountId, signal);
      }
      if (signal.aborted || socket.destroyed) return;
      socket.end(`HTTP/1.1 ${error instanceof ModelRequestTimeoutError ? "504 Gateway Timeout" : "502 Bad Gateway"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
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
      ),
      handshakeTimeout: modelRequestPolicy.websocketConnectTimeoutMs,
    });
    const pending: Array<{ data: RawData | string; isBinary: boolean; timing: TrafficCallTiming | undefined; metrics: MetricsState | undefined }> = [];
    let activeMetrics: MetricsState | undefined;
    let forwarding: Promise<void> | undefined;
    let sending = Promise.resolve();
    let queuedUpstreamBytes = 0;
    let queuedUpstreamFrames = 0;
    let queuedClientBytes = 0;
    let queuedClientFrames = 0;
    const deliveryController = new AbortController();
    const deliverySignal = AbortSignal.any([deliveryController.signal, this.shutdownController.signal]);
    const stopWebSockets = (): void => { client.terminate(); upstream.terminate(); };
    this.shutdownController.signal.addEventListener("abort", stopWebSockets, { once: true });
    let forwardingFailed = false;
    const failActiveMetrics = (errorType: string, error: unknown, at: number): void => {
      const metrics = activeMetrics;
      if (!metrics) return;
      activeMetrics = undefined;
      markMetricsFailed(metrics, errorType, Date.now(), error, at);
      void this.deliverMetrics(metrics, route.accountId);
    };
    const failForwarding = (error: unknown, stage: "client_delivery" | "upstream_delivery" = "client_delivery"): void => {
      if (forwardingFailed || deliverySignal.aborted) return;
      forwardingFailed = true;
      const failedAtMonotonicMs = performance.now();
      failActiveMetrics(error instanceof ModelRequestTimeoutError ? error.code
        : stage === "upstream_delivery" ? "upstream_delivery_error" : "client_delivery_error", error, failedAtMonotonicMs);
      exchange?.failure(stage, error, failedAtMonotonicMs);
      deliveryController.abort(error);
      this.onError?.(asError(error));
      client.terminate();
      upstream.terminate();
    };
    const queueUpstream = (data: RawData | string, isBinary: boolean, timing: TrafficCallTiming | undefined, metrics: MetricsState | undefined): void => {
      const bytes = rawDataBytes(data);
      queuedUpstreamBytes += bytes;
      queuedUpstreamFrames += 1;
      if (queuedUpstreamBytes > maximumModelWebSocketQueueBytes || queuedUpstreamFrames > 16) {
        failForwarding(new Error("模型 WebSocket 上游交付队列已满"), "upstream_delivery");
        return;
      }
      client.pause();
      const next = sending.then(async () => {
        deliverySignal.throwIfAborted();
        await sendProxyWebSocket(upstream, data, isBinary, deliverySignal, modelRequestPolicy.deliveryTimeoutMs,
          undefined, "delivery", () => {
            const submittedAt = performance.now();
            timing?.submitted(submittedAt);
            if (metrics) observeRequestSubmitted(metrics, submittedAt);
            if (metrics) metrics.upstreamUrl = sanitizeModelRequestUrl(upstream.url);
            if (metrics) metrics.requestBytes = (metrics.requestBytes ?? 0) + bytes;
          });
      });
      sending = waitForProxyOperation(next, deliverySignal, modelRequestPolicy.deliveryTimeoutMs, "delivery")
        .catch(error => failForwarding(error, "upstream_delivery")).finally(() => {
          queuedUpstreamBytes -= bytes;
          queuedUpstreamFrames -= 1;
          if (queuedUpstreamFrames === 0 && client.readyState === WebSocket.OPEN && !deliverySignal.aborted) client.resume();
        });
    };

    // `data` 是发往上游的字节，`recorded` 始终是客户端原始帧；改写私有输入项时两者不同，转储与指标只记录客户端报文。
    const forwardClientMessage = (
      data: RawData | string,
      isBinary: boolean,
      receivedAtMonotonicMs: number,
      recorded: RawData | string = data,
    ): void => {
      if (upstream.readyState === WebSocket.CONNECTING
        && (pending.length >= 16 || pending.reduce((bytes, message) => bytes + rawDataBytes(message.data), rawDataBytes(data)) > maximumModelWebSocketQueueBytes)) {
        rejectModelFrame(503, "provider_catalog_unavailable", "模型上游连接等待队列已满，请稍后重试。");
        return;
      }
      const frameData = typeof recorded === "string" ? Buffer.from(recorded, "utf8") : recorded;
      exchange?.webSocketFrame("client", frameData, isBinary, receivedAtMonotonicMs);
      const inspected = recordsResponseMetrics
        ? inspectClientWebSocketMessage(frameData, isBinary)
        : undefined;
      const callTiming = inspected?.metadata ? exchange?.callTiming : undefined;
      if (inspected?.metadata) {
        activeMetrics = inspected.recordsMetrics === false
          ? undefined
          : createMetricsState(
              inspected.metadata,
              inspected.requestStartedAtMs ?? Date.now(),
              "websocket",
              inspected.metadata.operation,
              effectiveUpstreamUserAgent(request.headers, this.upstreamUserAgent),
            );
        if (activeMetrics) {
          observeRequestActivity(activeMetrics, inspected.requestBody);
          activeMetrics.model = inspected.model ?? null;
          activeMetrics.requestModel = inspected.model ?? null;
          exchange?.observeRequestMetrics(activeMetrics);
          activeMetrics.requestServiceTier = inspected.serviceTier ?? null;
          activeMetrics.reasoningEffort = inspected.reasoningEffort ?? null;
        }
      }
      if (upstream.readyState === WebSocket.OPEN) {
        queueUpstream(data, isBinary, callTiming, activeMetrics);
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        pending.push({ data, isBinary, timing: callTiming, metrics: activeMetrics });
      }
    };
    let authorizing = Promise.resolve();
    let queuedAuthorizationBytes = 0;
    let queuedAuthorizationFrames = 0;
    let authorizationRejected = false;
    const authorizationController = new AbortController();
    client.once("close", () => authorizationController.abort());
    upstream.once("close", () => authorizationController.abort());
    const rejectModelFrame = (status: number, type: string, message: string): void => {
      if (authorizationRejected) return;
      authorizationRejected = true;
      authorizationController.abort();
      upstream.terminate();
      if (client.readyState === WebSocket.OPEN) {
        forwarding = sendProxyWebSocket(client, JSON.stringify({ type: "error", status, error: { type, message } }), false,
          deliverySignal, modelRequestPolicy.terminalDeliveryTimeoutMs, undefined, "terminal")
          .then(() => closePeer(client, 1008, Buffer.from("Model authorization failed")), failForwarding);
      }
    };
    client.on("message", (data, isBinary) => {
      if (authorizationRejected || authorizationController.signal.aborted || deliverySignal.aborted) return;
      const receivedAtMonotonicMs = performance.now();
      // 目录复核与私有项归一化都需要读取帧内容；两者都没有时保持原样转发。
      if (!recordsResponseMetrics || (this.isModelEnabled === undefined && this.readModelCapabilities === undefined && !this.normalizeResponsesInput)) {
        forwardClientMessage(data, isBinary, receivedAtMonotonicMs);
        return;
      }
      const bytes = rawDataBytes(data);
      if (isBinary || bytes > maximumModelRequestBytes) {
        rejectModelFrame(400, "provider_model_request_invalid", "模型请求必须为不超过 48 MiB 的 JSON 文本帧。");
        return;
      }
      queuedAuthorizationBytes += bytes;
      queuedAuthorizationFrames += 1;
      if (queuedAuthorizationBytes > maximumModelWebSocketQueueBytes || queuedAuthorizationFrames > 16) {
        rejectModelFrame(503, "provider_catalog_unavailable", "模型目录复核队列已满，请稍后重试。");
        return;
      }
      authorizing = authorizing.then(async () => {
        if (authorizationRejected || authorizationController.signal.aborted) return;
        let parsed: unknown;
        try { parsed = JSON.parse(rawDataText(data)); }
        catch {
          rejectModelFrame(400, "provider_model_request_invalid", "模型请求不是有效 JSON。");
          return;
        }
        const source = asRecord(parsed);
        if (source?.type !== "response.create") {
          rejectModelFrame(400, "provider_model_request_invalid", "模型请求必须包含明确的 response.create 和 model ID。");
          return;
        }
        const isModelEnabled = this.isModelEnabled;
        const readModelCapabilities = this.readModelCapabilities;
        let sampling: SamplingParameters | undefined;
        if (isModelEnabled !== undefined || readModelCapabilities !== undefined) {
          if (typeof source.model !== "string" || !source.model.length) {
            rejectModelFrame(400, "provider_model_request_invalid", "模型请求必须包含明确的 response.create 和 model ID。");
            return;
          }
          if (this.modelAuthorizations.size >= maximumBufferedModelRequests) {
            rejectModelFrame(503, "provider_catalog_unavailable", "模型目录复核暂时不可用，请稍后重试。");
            return;
          }
          const controller = new AbortController();
          this.modelAuthorizations.add(controller);
          const signal = AbortSignal.any([controller.signal, authorizationController.signal, AbortSignal.timeout(modelRequestPolicy.preparationTimeoutMs)]);
          try {
            // A queued frame must be authorized after the connection is usable,
            // not before a potentially slow upstream handshake.
            if (upstream.readyState === WebSocket.CONNECTING) await once(upstream, "open", { signal });
            if (upstream.readyState !== WebSocket.OPEN) throw new Error("Model upstream is closed");
            const capabilities = readModelCapabilities === undefined ? undefined
              : await waitForChatOperation(readModelCapabilities(source.model, signal), signal);
            const enabled = readModelCapabilities !== undefined ? capabilities !== undefined
              : await waitForChatOperation(isModelEnabled!(source.model, signal), signal);
            signal.throwIfAborted();
            if (!enabled) {
              rejectModelFrame(409, "provider_model_disabled", "该模型已停用或不在当前目录中，请重新选择已启用的模型。");
              return;
            }
            sampling = capabilities?.sampling;
          } finally {
            this.modelAuthorizations.delete(controller);
          }
        }
        let payload: RawData | string = data;
        if (this.normalizeResponsesInput || sampling !== undefined) {
          try {
            const normalized = this.normalizeResponsesInput
              ? normalizeResponsesRequest(parsed) : { body: parsed, changed: false };
            const sampled = applySamplingDefaults(normalized.body, sampling);
            if (normalized.changed || sampled.changed) payload = JSON.stringify(sampled.body);
          } catch (error) {
            rejectModelFrame(400, "provider_model_request_invalid", error instanceof ModelConversionError
              ? error.message
              : "第三方上游不接受该请求报文");
            return;
          }
        }
        forwardClientMessage(payload, isBinary, receivedAtMonotonicMs, data);
      }).catch(() => {
        if (!authorizationController.signal.aborted) {
          rejectModelFrame(503, "provider_catalog_unavailable", "模型目录暂时无法安全读取，请检查目录后重试。");
        }
      }).finally(() => {
        queuedAuthorizationBytes -= bytes;
        queuedAuthorizationFrames -= 1;
      });
    });
    upstream.on("open", () => {
      for (const message of pending.splice(0)) {
        queueUpstream(message.data, message.isBinary, message.timing, message.metrics);
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
        );
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
      if (deliverySignal.aborted) return;
      // Keep the request identity after a terminal frame clears activeMetrics.
      const frameMetrics = activeMetrics;
      const receivedAtMonotonicMs = performance.now();
      const receivedAtMs = Date.now();
      let completedMetrics: MetricsState | undefined;
      // A peer failure already ended the call; late frames remain trace-only.
      if (!isBinary && activeMetrics && failureType === undefined) {
        const currentMetrics = activeMetrics;
        const text = rawDataText(data);
        const observed = inspectResponseEvent(text, "", currentMetrics.firstTokenMs === undefined);
        const { type, event: parsed } = observed;
        if (type === "codex.rate_limits") {
          const weeklyQuota = weeklyQuotaFromEvent(parsed);
          if (weeklyQuota !== null) {
            currentMetrics.weeklyQuota = weeklyQuota;
            currentMetrics.quotaObservedAtMs = receivedAtMs;
          }
        }
        if (observeResponseEvent(currentMetrics, type, parsed, receivedAtMs, receivedAtMonotonicMs)) {
          activeMetrics = undefined;
          completedMetrics = currentMetrics;
        }
      }
      exchange?.webSocketFrame("upstream", data, isBinary, receivedAtMonotonicMs);
      const bytes = rawDataBytes(data);
      queuedClientBytes += bytes;
      queuedClientFrames += 1;
      if (frameMetrics && queuedClientFrames > 1) invalidateGenerationTiming(frameMetrics);
      if (queuedClientBytes > maximumModelWebSocketQueueBytes || queuedClientFrames > 4096) {
        if (completedMetrics) void this.deliverMetrics(completedMetrics, route.accountId, deliverySignal);
        failForwarding(new Error("模型 WebSocket 客户端交付队列已满"));
        return;
      }
      upstream.pause();
      const timeoutMs = completedMetrics ? modelRequestPolicy.terminalDeliveryTimeoutMs : modelRequestPolicy.deliveryTimeoutMs;
      const queued = (forwarding ?? Promise.resolve()).then(async () => {
        deliverySignal.throwIfAborted();
        if (completedMetrics) {
          await this.deliverMetrics(completedMetrics, route.accountId, deliverySignal);
        }
        await sendProxyWebSocket(client, data, isBinary, deliverySignal, timeoutMs, () => {
          if (frameMetrics && !completedMetrics) invalidateGenerationTiming(frameMetrics);
        }, completedMetrics ? "terminal" : "delivery");
      });
      const delivered = waitForProxyOperation(queued, deliverySignal, timeoutMs, completedMetrics ? "terminal" : "delivery")
        .catch(failForwarding).finally(() => {
          queuedClientBytes -= bytes;
          queuedClientFrames -= 1;
          if (forwarding === delivered) {
            forwarding = undefined;
            if (upstream.readyState === WebSocket.OPEN && !deliverySignal.aborted) upstream.resume();
          }
        });
      forwarding = delivered;
    });
    const closePeer = (peer: WebSocket, code: number, reason: Buffer): void => {
      if (peer.readyState === WebSocket.OPEN) {
        const timer = setTimeout(() => peer.terminate(), modelRequestPolicy.terminalDeliveryTimeoutMs);
        peer.once("close", () => clearTimeout(timer));
        if (code === 1_005 || code === 1_006) peer.close();
        else peer.close(code, reason);
      }
      else if (peer.readyState === WebSocket.CONNECTING) peer.terminate();
    };
    let failureType: "websocket_closed" | "client_disconnected" | undefined;
    let failureAtMs: number;
    let failureAtMonotonicMs: number;
    const noteFailureType = (
      type: "websocket_closed" | "client_disconnected",
      at: number,
    ): void => {
      if (failureType !== undefined) return;
      failureType = type;
      failureAtMs = Date.now();
      failureAtMonotonicMs = at;
    };
    client.on("close", (code, reason) => {
      deliveryController.abort(new Error("模型 WebSocket 客户端已断开"));
      this.shutdownController.signal.removeEventListener("abort", stopWebSockets);
      pending.length = 0;
      const closedAtMonotonicMs = performance.now();
      noteFailureType("client_disconnected", closedAtMonotonicMs);
      exchange?.webSocketClose("client", code, reason, closedAtMonotonicMs);
      closePeer(upstream, code, reason);
    });
    upstream.on("close", (code, reason) => {
      const closedAtMonotonicMs = performance.now();
      noteFailureType("websocket_closed", closedAtMonotonicMs);
      exchange?.webSocketClose("upstream", code, reason, closedAtMonotonicMs);
      if (forwarding && client.readyState === WebSocket.OPEN && !this.stopped) {
        // The final frame may still be waiting for its metrics acknowledgement.
        // Keep upstream close ordered after every frame already accepted for delivery.
        const timer = setTimeout(() => {
          this.onError?.(new ModelRequestTimeoutError("terminal"));
          client.terminate();
        }, modelRequestPolicy.terminalDeliveryTimeoutMs);
        const cancelDrain = (): void => clearTimeout(timer);
        client.once("close", cancelDrain);
        void forwarding.then(() => {
          clearTimeout(timer);
          client.removeListener("close", cancelDrain);
          closePeer(client, code, reason);
        });
      } else {
        closePeer(client, code, reason);
      }
      if (!activeMetrics) return;
      const reasonType = failureType === "websocket_closed" ? websocketCloseErrorType(reason) : null;
      if (reasonType) {
        markMetricsFailed(activeMetrics, reasonType, failureAtMs, undefined, failureAtMonotonicMs);
      } else {
        markMetricsFailed(
          activeMetrics,
          failureType ?? "websocket_closed",
          failureAtMs,
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
      failActiveMetrics("client_request_error", error, failedAtMonotonicMs);
      exchange?.failure("client_error", error, failureAtMonotonicMs);
      this.onError?.(asError(error));
      upstream.terminate();
    });
    upstream.on("error", (error) => {
      if (deliverySignal.aborted) return;
      const failedAtMonotonicMs = performance.now();
      noteFailureType("websocket_closed", failedAtMonotonicMs);
      failActiveMetrics("upstream_response_error", error, failedAtMonotonicMs);
      exchange?.failure("upstream_error", error, failureAtMonotonicMs);
      this.onError?.(asError(error));
      client.terminate();
    });
  }

  private requestSignal(peer: ServerResponse | Duplex): AbortSignal {
    const controller = new AbortController();
    if (this.stopped || peer.destroyed) { controller.abort(); return controller.signal; }
    this.pendingRequests.add(controller);
    peer.once("close", () => {
      controller.abort(new Error("模型客户端已断开"));
      this.pendingRequests.delete(controller);
    });
    return controller.signal;
  }

  private async upstreamFor(headers: IncomingHttpHeaders, requestSignal: AbortSignal): Promise<ProviderProxyUpstream> {
    const controller = new AbortController();
    const signal = AbortSignal.any([requestSignal, controller.signal]);
    const timer = setTimeout(() => controller.abort(new ModelRequestTimeoutError("prepare")), modelRequestPolicy.preparationTimeoutMs);
    try {
      signal.throwIfAborted();
      return await waitForChatOperation(Promise.resolve(this.resolveUpstream?.(headers, signal) ?? this.defaultUpstream), signal);
    } finally { clearTimeout(timer); }
  }

  private async deliverMetrics(
    metrics: MetricsState,
    accountId?: string,
    requestSignal: AbortSignal = this.shutdownController.signal,
  ): Promise<void> {
    const cachedQuota = this.quotaWindowsByAccount.get(
      quotaAccountKey(accountId),
    );
    const quotaWindows = cachedQuota?.windows ?? null;
    const quotaObservedAtMs = metrics.weeklyQuota === null
      ? quotaWindows !== null && quotaWindows.length > 0 ? cachedQuota?.observedAtMs ?? null : null
      : quotaWindows !== null && quotaWindows.length > 0 ? null : metrics.quotaObservedAtMs ?? null;
    this.refreshQuotaWindows(accountId);
    const signal = AbortSignal.any([requestSignal, this.shutdownController.signal]);
    try {
      await waitForProxyOperation(Promise.resolve(this.onMetrics?.({ ...metrics, quotaWindows, quotaObservedAtMs }, accountId)),
        signal, modelRequestPolicy.metricsDeliveryTimeoutMs, "terminal");
    } catch (error) {
      if (!signal.aborted) this.onError?.(error instanceof ModelRequestTimeoutError
        ? new Error("模型请求指标确认超时，已跳过等待并继续交付", { cause: error }) : asError(error));
    }
  }

  private refreshQuotaWindows(accountId?: string): void {
    if (!this.quotaWindowsProvider || this.stopped) return;
    const key = quotaAccountKey(accountId);
    if (this.quotaRefreshByAccount.has(key)) return;
    const controller = new AbortController();
    const refresh = Promise.resolve()
      .then(() => this.quotaWindowsProvider!(accountId, controller.signal))
      .then((snapshot) => {
        if (!this.stopped) this.quotaWindowsByAccount.set(key, snapshot);
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
      new Promise<void>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("模型代理额度刷新关闭超时")), timeoutMs);
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
  requestBody?: Record<string, unknown>;
} {
  if (isBinary) return {};
  const parsed = parseJsonPayload(rawDataText(data));
  if (parsed?.type !== "response.create") return {};
  const clientMetadata = asRecord(parsed.client_metadata);
  const rawMetadata = clientMetadata?.["x-codex-turn-metadata"];
  const requestStartedAtMs = requestStartTimestamp(clientMetadata);
  const model = boundedString(parsed.model) ?? undefined;
  const serviceTier = requestServiceTier(parsed) ?? undefined;
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
    requestBody: parsed,
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

function rawDataText(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}

function rawDataBytes(data: RawData | string): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((size, chunk) => size + chunk.length, 0);
  return data.length;
}

/** Explicit request values, including zero and null, always win over catalogue defaults. */
function applySamplingDefaults(value: unknown, sampling?: SamplingParameters): { body: unknown; changed: boolean } {
  const source = asRecord(value);
  if (!sampling || !source || !Object.keys(sampling).some(key => !Object.hasOwn(source, key))) {
    return { body: value, changed: false };
  }
  return { body: { ...sampling, ...source }, changed: true };
}

function createModelRequestBodyWriter(
  upstream: ClientRequest,
  submitted?: (bytes: number) => void,
): Writable {
  let bytes = 0;
  const writer = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maximumModelRequestBytes) {
        callback(new ChatBodyTooLargeError("Model request exceeds size limit"));
        return;
      }
      if (upstream.destroyed || upstream.writableEnded) {
        callback(new Error("模型请求出站连接已关闭"));
        return;
      }
      // Count only chunks submitted to ClientRequest, not this writer's queue.
      // Its write callback bounds buffering without delaying submission accounting.
      upstream.write(chunk, callback);
      submitted?.(chunk.length);
    },
    final(callback) { upstream.end(callback); },
  });
  const closed = (): void => { writer.destroy(); };
  upstream.once("close", closed);
  writer.once("close", () => upstream.off("close", closed));
  return writer;
}

function writeUpstreamHead(response: ServerResponse, upstream: IncomingMessage): void {
  const headers = endToEndHeaders(upstream.headers);
  if (upstream.statusMessage) {
    response.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, headers);
  } else {
    response.writeHead(upstream.statusCode ?? 502, headers);
  }
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
  const review = autoReviewMetadata(parsed);
  return {
    threadId: nonEmptyString(parsed?.thread_id),
    turnId: nonEmptyString(parsed?.turn_id),
    operation: parsed?.request_kind === "compaction" ? "compact" : "response",
    ...review,
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
