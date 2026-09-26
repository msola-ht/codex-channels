import type { IncomingHttpHeaders } from "node:http";
import { StringDecoder } from "node:string_decoder";

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
  usedPercentMillionths?: number | null;
  status?: string | null;
}

export interface ProviderProxyMetrics {
  transport: "http" | "websocket";
  responseFormat: "sse" | "json" | "websocket" | "unknown";
  operation: "response" | "compact";
  threadId: string | null;
  turnId: string | null;
  model: string | null;
  serviceTier: string | null;
  /** 出站请求层级；响应不得覆盖。 */
  requestServiceTier?: string | null;
  reasoningEffort: string | null;
  status: "completed" | "failed" | "incomplete" | "unknown";
  httpStatus: number | null;
  /** 本次请求实际发往模型上游的完整 User-Agent；无法确定时为 null。 */
  userAgent: string | null;
  errorType: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  incompleteReason: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  /** 上游 logical_turn 首 Token 耗时；仅在响应 ID 匹配时提供。 */
  upstreamTtftMs?: number;
  /** 本次请求提交上游发送至首个符合传输协议口径的事件；不是客户端显示时间。 */
  firstContentMs?: number;
  /** 本次请求提交上游发送至首个终态或结束/失败；未发送时缺失。 */
  totalDurationMs?: number;
  requestModel?: string | null;
  responseModel?: string | null;
  /** 精确定位本次调用的 V2 转储；未开启转储时不提供。 */
  traffic?: { label: string; session: string; interaction: number };
  requestStartedAtMs: number;
  responseCompletedAtMs: number;
  weeklyQuota: ProviderWeeklyQuotaSnapshot | null;
  /** 请求完成时对应的官方配额窗口快照（如 OpenCode Go 5h/7d/月），缺省为 null。 */
  quotaWindows: readonly ProviderQuotaWindowSnapshot[] | null;
}

export interface ResponseMetricsMetadata {
  threadId: string | null;
  turnId: string | null;
  operation: ProviderProxyMetrics["operation"];
}

export interface MetricsState extends ProviderProxyMetrics {
  responseCompletedAtMs: number;
}

const timingByMetrics = new WeakMap<MetricsState, { responseId: string; ttftMs?: number }>();
const requestClocks = new WeakMap<MetricsState, number>();

export function createMetricsState(
  metadata: ResponseMetricsMetadata,
  startedAtMs: number,
  transport: ProviderProxyMetrics["transport"],
  operation: ProviderProxyMetrics["operation"],
  userAgent: string | null,
  startedAtMonotonicMs?: number,
): MetricsState {
  const metrics: MetricsState = {
    ...metadata,
    transport,
    responseFormat: transport === "websocket" ? "websocket" : "unknown",
    operation,
    userAgent,
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
    requestStartedAtMs: startedAtMs,
    responseCompletedAtMs: startedAtMs,
    weeklyQuota: null,
    quotaWindows: null,
  };
  if (startedAtMonotonicMs !== undefined) startMetricsRequest(metrics, startedAtMonotonicMs);
  return metrics;
}

/** HTTP 提交请求、WS 提交当前逻辑请求帧时启动同一个时钟，排除本地准备和连接等待队列。 */
export function startMetricsRequest(metrics: MetricsState, at: number): void {
  if (!requestClocks.has(metrics)) requestClocks.set(metrics, at);
}

function observeTotalDuration(metrics: MetricsState, at: number): void {
  const started = requestClocks.get(metrics);
  if (started !== undefined) metrics.totalDurationMs ??= at - started;
}

/** 实际发往上游的 UA：配置覆盖优先，否则用 App Server 发来的原始 UA。 */
export function effectiveUpstreamUserAgent(
  headers: IncomingHttpHeaders,
  override: string | undefined,
): string | null {
  const value = override ?? headers["user-agent"];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, 512);
}

export function weeklyQuotaFromHeaders(
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

export function weeklyQuotaFromEvent(
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

export function observeResponseEvent(
  metrics: MetricsState,
  type: string,
  event: Record<string, unknown> | undefined,
  receivedAtMs: number,
  receivedAtMonotonicMs: number,
): boolean {
  if (metrics.firstContentMs === undefined && startsFirstToken(metrics.transport, type, event)) {
    const started = requestClocks.get(metrics);
    if (started !== undefined) metrics.firstContentMs = receivedAtMonotonicMs - started;
  }
  if (metrics.transport === "websocket" && type === "response.created") {
    const responseId = boundedString(asRecord(event?.response)?.id);
    if (responseId !== null) timingByMetrics.set(metrics, { responseId });
  }
  if (metrics.transport === "websocket" && type === "responsesapi.websocket_timing") {
    const timing = asRecord(event?.timing_metrics);
    const pending = timingByMetrics.get(metrics);
    const ttftMs = finiteNonNegativeNumber(timing?.first_sampled_message_ttft_ms);
    if (pending && timing?.timing_scope === "logical_turn"
      && timing.response_id === pending.responseId && ttftMs !== null) {
      pending.ttftMs = ttftMs;
    }
  }
  if (
    type === "response.completed"
    || type === "response.failed"
    || type === "response.incomplete"
  ) {
    const pending = timingByMetrics.get(metrics);
    if (pending?.ttftMs !== undefined
      && asRecord(event?.response)?.id === pending.responseId) {
      metrics.upstreamTtftMs = pending.ttftMs;
    }
    timingByMetrics.delete(metrics);
    observeResponseCompletion(metrics, type, event);
    metrics.responseCompletedAtMs = receivedAtMs;
    observeTotalDuration(metrics, receivedAtMonotonicMs);
    return true;
  }
  if (type === "error") {
    const error = asRecord(event?.error);
    const errorType = boundedString(error?.type) ?? "upstream_error";
    metrics.httpStatus = finiteNonNegativeNumber(event?.status);
    markMetricsFailed(metrics, errorType, receivedAtMs, undefined, receivedAtMonotonicMs);
    metrics.errorType = errorType;
    metrics.errorCode = boundedString(error?.code);
    metrics.errorMessage = boundedMessage(error?.message);
    metrics.responseCompletedAtMs = receivedAtMs;
    return true;
  }
  return false;
}

export function websocketCloseErrorType(reason: Buffer | string): string | null {
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
  metrics.responseModel = metrics.model;
  metrics.serviceTier = boundedString(response?.service_tier);
  const usage = asRecord(response?.usage);
  const inputDetails = asRecord(usage?.input_tokens_details);
  const outputDetails = asRecord(usage?.output_tokens_details);
  metrics.inputTokens = tokenCount(usage?.input_tokens);
  metrics.cachedInputTokens = tokenCount(inputDetails?.cached_tokens);
  metrics.outputTokens = tokenCount(usage?.output_tokens);
  metrics.reasoningOutputTokens = tokenCount(outputDetails?.reasoning_tokens);
  metrics.totalTokens = tokenCount(usage?.total_tokens);
  const error = asRecord(response?.error) ?? asRecord(event?.error);
  metrics.errorType = boundedString(error?.type);
  metrics.errorCode = boundedString(error?.code);
  metrics.errorMessage = boundedMessage(error?.message);
  metrics.incompleteReason = boundedString(
    asRecord(response?.incomplete_details)?.reason,
  );
}

export function observeJsonResponse(
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

export class HttpResponseMetricsObserver {
  private readonly decoder = new StringDecoder("utf8");
  private readonly jsonChunks: Buffer[] = [];
  private currentEvent = "";
  private jsonBytes = 0;
  private jsonOverflow = false;
  private pending = "";
  private sseMetadataOverflow = false;

  constructor(private readonly metrics: MetricsState) {}

  observeChunk(chunk: Buffer, receivedAtMs: number, receivedAtMonotonicMs: number): boolean {
    const completed = this.metrics.responseFormat === "sse"
      || this.metrics.responseFormat === "unknown"
      ? this.processText(this.decoder.write(chunk), receivedAtMs, receivedAtMonotonicMs)
      : false;
    if (this.metrics.responseFormat === "json" && !this.jsonOverflow) {
      this.jsonBytes += chunk.length;
      if (this.jsonBytes <= maximumJsonMetadataBytes) this.jsonChunks.push(chunk);
      else {
        this.jsonOverflow = true;
        this.jsonChunks.length = 0;
      }
    }
    return completed;
  }

  finish(receivedAtMs: number, receivedAtMonotonicMs: number): boolean {
    const completed = this.metrics.responseFormat === "sse"
      || this.metrics.responseFormat === "unknown"
      ? this.processText(this.decoder.end(), receivedAtMs, receivedAtMonotonicMs)
        || (this.pending
          ? this.processLine(this.pending.trimEnd(), receivedAtMs, receivedAtMonotonicMs)
          : false)
      : this.metrics.responseFormat === "json" && !this.jsonOverflow
        ? observeJsonResponse(
            this.metrics,
            parseJsonPayload(Buffer.concat(this.jsonChunks).toString("utf8")),
            receivedAtMs,
          )
        : false;
    finalizeHttpStatus(this.metrics, receivedAtMs);
    observeTotalDuration(this.metrics, receivedAtMonotonicMs);
    return completed;
  }

  private processLine(line: string, receivedAtMs: number, receivedAtMonotonicMs: number): boolean {
    if (line === "") {
      this.currentEvent = "";
      return false;
    }
    if (line.startsWith("event:")) {
      this.currentEvent = line.slice(6).trim();
      return false;
    }
    if (!line.startsWith("data:")) return false;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return false;
    const observed = inspectResponseEvent(payload, this.currentEvent, this.metrics.firstContentMs === undefined);
    if (
      this.metrics.responseFormat === "unknown"
      && observed.type.startsWith("response.")
    ) {
      this.metrics.responseFormat = "sse";
    }
    return observeResponseEvent(
      this.metrics,
      observed.type,
      observed.event,
      receivedAtMs,
      receivedAtMonotonicMs,
    );
  }

  private processText(text: string, receivedAtMs: number, receivedAtMonotonicMs: number): boolean {
    if (this.sseMetadataOverflow) return false;
    this.pending += text;
    const lines = this.pending.split(/\r?\n/u);
    this.pending = lines.pop() ?? "";
    if (
      this.pending.length > maximumSseMetadataLineCharacters
      || lines.some((line) => line.length > maximumSseMetadataLineCharacters)
    ) {
      this.sseMetadataOverflow = true;
      this.pending = "";
      this.currentEvent = "";
      return false;
    }
    return lines.some((line) => this.processLine(line, receivedAtMs, receivedAtMonotonicMs));
  }
}

export function finalizeHttpStatus(
  metrics: MetricsState,
  completedAtMs: number,
): void {
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

export function markMetricsFailed(
  metrics: MetricsState,
  errorType: string,
  receivedAtMs: number,
  error?: unknown,
  receivedAtMonotonicMs = performance.now(),
): void {
  if (metrics.status === "completed") return;
  observeTotalDuration(metrics, receivedAtMonotonicMs);
  metrics.status = "failed";
  metrics.errorType = errorType;
  metrics.errorCode = nodeErrorCode(error);
  metrics.responseCompletedAtMs = Math.max(
    metrics.responseCompletedAtMs,
    receivedAtMs,
  );
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

export function httpResponseFormat(
  contentType: string | string[] | undefined,
): ProviderProxyMetrics["responseFormat"] {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  if (typeof value !== "string") return "unknown";
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "text/event-stream") return "sse";
  if (mediaType === "application/json") return "json";
  return "unknown";
}

export function boundedString(value: unknown): string | null {
  return typeof value === "string"
    && value.length <= 128
    && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(value)
    ? value
    : null;
}

export function boundedMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const message = value
    .replace(/\p{Cc}/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (message.length === 0) return null;
  return message.length <= 500 ? message : `${message.slice(0, 500)}…`;
}

function responseEventType(payload: string): string {
  const match = /"type"\s*:\s*"([a-zA-Z0-9._:/-]{1,128})"/u.exec(payload);
  return match?.[1] ?? "";
}

export function inspectResponseEvent(
  payload: string,
  fallbackType = "",
  collectFirstContent = false,
): { type: string; event: Record<string, unknown> | undefined } {
  const scannedType = responseEventType(payload);
  const candidateType = fallbackType || scannedType;
  if (collectFirstContent) {
    const event = parseJsonPayload(payload);
    return { type: boundedString(event?.type) ?? fallbackType, event };
  }
  if (
    !requiresResponseEventBody(candidateType)
    && !responseEventBodyTypeNames.some((type) => payload.includes(`"${type}"`))
  ) {
    return { type: candidateType, event: undefined };
  }
  const event = parseJsonPayload(payload);
  const type = boundedString(event?.type) ?? candidateType;
  return {
    type,
    event: requiresResponseEventBody(type) ? event : undefined,
  };
}

function startsFirstToken(
  transport: ProviderProxyMetrics["transport"],
  type: string,
  event: Record<string, unknown> | undefined,
): boolean {
  // 参考 sub2api 的 HTTP semantic / WS token-event 口径；不把旁路元数据或纯错误计为首字。
  if (!event || !type.startsWith("response.")) return false;
  if (transport === "websocket") {
    return type.endsWith(".delta") || type === "response.output_text.done"
      || type === "response.function_call_arguments.done";
  }
  return type !== "response.created" && type !== "response.in_progress"
    && type !== "response.failed" && type !== "response.metadata";
}

const responseEventBodyTypeNames = [
  "response.created",
  "responsesapi.websocket_timing",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "codex.rate_limits",
  "error",
] as const;

function requiresResponseEventBody(type: string): boolean {
  return type === "response.created"
    || type === "responsesapi.websocket_timing"
    || type === "response.completed"
    || type === "response.failed"
    || type === "response.incomplete"
    || type === "codex.rate_limits"
    || type === "error";
}

export function parseJsonPayload(
  payload: string,
): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(payload) as unknown);
  } catch {
    return undefined;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
