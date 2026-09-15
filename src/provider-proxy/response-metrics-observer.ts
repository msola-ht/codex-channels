import type { IncomingHttpHeaders } from "node:http";

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

export function createMetricsState(
  metadata: ResponseMetricsMetadata,
  startedAtMs: number,
  transport: ProviderProxyMetrics["transport"],
  operation: ProviderProxyMetrics["operation"],
  userAgent: string | null,
): MetricsState {
  return {
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
): boolean {
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
    markMetricsFailed(metrics, errorType, receivedAtMs);
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
): void {
  if (metrics.status === "completed") return;
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
): { type: string; event: Record<string, unknown> | undefined } {
  const scannedType = responseEventType(payload);
  const candidateType = fallbackType || scannedType;
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

const responseEventBodyTypeNames = [
  "response.completed",
  "response.failed",
  "response.incomplete",
  "codex.rate_limits",
  "error",
] as const;

function requiresResponseEventBody(type: string): boolean {
  return type === "response.completed"
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
