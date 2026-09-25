import type {
  StoredCacheUsage,
  StoredCompactRequestMetricsSummary,
  StoredModelRequestMetric,
  StoredModelRequestMetricsAggregate,
  StoredModelRequestMetricsGroup,
  StoredThreadRequestMetricsAggregate,
  StoredTurnRequestMetricsSummary,
} from "./request-metrics.js";

export interface MetricRow {
  id: number;
  provider: string;
  transport: "http" | "websocket";
  response_format: "sse" | "json" | "websocket" | "unknown";
  operation: "response" | "compact";
  thread_id: string | null;
  turn_id: string | null;
  model: string | null;
  service_tier: string | null;
  request_service_tier: string | null;
  reasoning_effort: string | null;
  status: "completed" | "failed" | "incomplete" | "unknown";
  http_status: number | null;
  error_type: string | null;
  error_code: string | null;
  error_message: string | null;
  incomplete_reason: string | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_tokens: number | null;
  request_started_at_ms: number;
  response_completed_at_ms: number;
  recorded_at_ms: number;
  weekly_quota_limit_id: "codex" | null;
  weekly_used_percent_millionths: number | null;
  weekly_resets_at: number | null;
  weekly_quota_plan_type: string | null;
  quota_windows: string | null;
  user_agent: string | null;
  upstream_ttft_ms: number | null;
  first_content_ms: number | null;
  total_duration_ms: number | null;
  request_model: string | null;
  response_model: string | null;
  traffic_label: string | null;
  traffic_session: string | null;
  traffic_interaction: number | null;
}

export interface CompactSummaryRow {
  compact_request_count: number;
  compact_unsuccessful_request_count: number;
  compact_model: string | null;
  compact_model_count: number;
  compact_input_tokens: number | null;
  compact_cached_input_tokens: number | null;
  compact_input_token_count: number;
  compact_cached_input_token_count: number;
  compact_output_tokens: number | null;
}

export interface TurnSummaryRow extends CompactSummaryRow {
  tokens_per_second: number | null;
  upstream_ttft_ms?: number | null;
  provider?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  turn_id: string | null;
  turn_count: number;
  request_count: number;
  unsuccessful_request_count: number;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  input_token_count: number;
  cached_input_token_count: number;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
}

export interface CacheUsageRow {
  known_cached_input_tokens: number | null;
  cache_observed_input_tokens: number | null;
  cache_missing_request_count: number;
}

export function toStoredCacheUsage(row: CacheUsageRow): StoredCacheUsage {
  return {
    cachedInputTokens: row.known_cached_input_tokens,
    inputTokens: row.cache_observed_input_tokens ?? 0,
    missingRequestCount: row.cache_missing_request_count,
  };
}

export interface AggregateRow extends Omit<TurnSummaryRow, "turn_id" | "turn_count">, CacheUsageRow {
  provider: string | null;
  model: string | null;
  total_group_count: number;
}

export interface ErrorSummaryRow {
  request_count: number;
  unsuccessful_request_count: number;
}

export interface ErrorGroupRow {
  provider: string;
  model: string | null;
  status: "failed" | "incomplete" | "unknown";
  http_status: number | null;
  error_type: string | null;
  last_error_message: string | null;
  request_count: number;
  last_occurred_at_ms: number;
  total_group_count: number;
}

export function toStoredMetric(row: MetricRow): StoredModelRequestMetric {
  const responseNotObserved = row.operation === "response"
    && row.status === "completed"
    && row.response_format === "unknown"
    && row.model === null
    && row.input_tokens === null
    && row.output_tokens === null
    && row.total_tokens === null;
  return {
    id: row.id,
    provider: row.provider,
    transport: row.transport,
    responseFormat: row.response_format,
    operation: row.operation,
    threadId: row.thread_id,
    turnId: row.turn_id,
    userAgent: row.user_agent,
    upstreamTtftMs: row.upstream_ttft_ms,
    firstContentMs: row.first_content_ms,
    totalDurationMs: row.total_duration_ms,
    tokensPerSecond: row.total_duration_ms !== null && row.total_duration_ms > 0 && row.output_tokens !== null && row.output_tokens > 0
      ? row.output_tokens * 1000 / row.total_duration_ms : null,
    requestModel: row.request_model,
    responseModel: row.response_model,
    traffic: row.traffic_label === null ? null : {
      label: row.traffic_label,
      session: row.traffic_session!,
      interaction: row.traffic_interaction!,
    },
    model: row.model,
    serviceTier: row.service_tier,
    requestServiceTier: row.request_service_tier,
    reasoningEffort: row.reasoning_effort,
    status: responseNotObserved ? "incomplete" : row.status,
    httpStatus: row.http_status,
    errorType: row.error_type,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    incompleteReason: responseNotObserved
      ? "response_not_observed"
      : row.incomplete_reason,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    totalTokens: row.total_tokens,
    requestStartedAtMs: row.request_started_at_ms,
    responseCompletedAtMs: row.response_completed_at_ms,
    weeklyQuota: row.weekly_quota_limit_id === null
      || row.weekly_used_percent_millionths === null
      || row.weekly_resets_at === null
      ? null
      : {
          limitId: row.weekly_quota_limit_id,
          usedPercentMillionths: row.weekly_used_percent_millionths,
          resetsAt: row.weekly_resets_at,
          planType: row.weekly_quota_plan_type,
        },
    quotaWindows: parseQuotaWindows(row.quota_windows),
    recordedAtMs: row.recorded_at_ms,
    uncachedInputTokens: row.input_tokens !== null
      && row.cached_input_tokens !== null
      && row.input_tokens >= row.cached_input_tokens
      ? row.input_tokens - row.cached_input_tokens
      : null,
    cacheHitRate: row.input_tokens !== null
      && row.input_tokens > 0
      && row.cached_input_tokens !== null
      ? row.cached_input_tokens / row.input_tokens
      : null,
  };
}

export function toStoredTurnSummary(row: TurnSummaryRow): StoredTurnRequestMetricsSummary {
  return {
    tokensPerSecond: row.tokens_per_second,
    ...(row.upstream_ttft_ms === undefined ? {} : { upstreamTtftMs: row.upstream_ttft_ms }),
    provider: row.provider ?? null,
    model: row.model ?? null,
    reasoningEffort: row.reasoning_effort ?? null,
    turnId: row.turn_id!,
    requestCount: row.request_count,
    unsuccessfulRequestCount: row.unsuccessful_request_count,
    inputTokens: row.input_tokens ?? 0,
    cachedInputTokens: row.input_token_count > 0
      && row.cached_input_token_count === row.input_token_count
      ? row.cached_input_tokens ?? 0
      : null,
    outputTokens: row.output_tokens ?? 0,
    reasoningOutputTokens: row.reasoning_output_tokens ?? 0,
    compact: toStoredCompactSummary(row),
  };
}

export function toStoredThreadAggregate(
  row: TurnSummaryRow,
): StoredThreadRequestMetricsAggregate {
  const summary = toStoredTurnSummary({
    ...row,
    turn_id: "aggregate",
  });
  return {
    provider: summary.provider,
    tokensPerSecond: row.tokens_per_second,
    turnCount: row.turn_count,
    requestCount: summary.requestCount,
    unsuccessfulRequestCount: summary.unsuccessfulRequestCount,
    inputTokens: summary.inputTokens,
    cachedInputTokens: summary.cachedInputTokens,
    outputTokens: summary.outputTokens,
    reasoningOutputTokens: summary.reasoningOutputTokens,
    compact: summary.compact,
  };
}

export function toStoredMetricsGroup(row: AggregateRow): StoredModelRequestMetricsGroup {
  return {
    provider: row.provider,
    model: row.model,
    aggregate: toStoredMetricsAggregate(row),
  };
}

export function toStoredMetricsAggregate(row: AggregateRow): StoredModelRequestMetricsAggregate {
  return {
    cacheUsage: toStoredCacheUsage(row),
    tokensPerSecond: row.tokens_per_second,
    requestCount: row.request_count,
    unsuccessfulRequestCount: row.unsuccessful_request_count,
    inputTokens: row.input_tokens ?? 0,
    cachedInputTokens: row.input_token_count > 0
      && row.cached_input_token_count === row.input_token_count
      ? row.cached_input_tokens ?? 0
      : null,
    outputTokens: row.output_tokens ?? 0,
    reasoningOutputTokens: row.reasoning_output_tokens ?? 0,
    compact: toStoredCompactSummary(row),
  };
}

export function toStoredCompactSummary(
  row: CompactSummaryRow,
): StoredCompactRequestMetricsSummary | null {
  if (row.compact_request_count === 0) return null;
  return {
    model: row.compact_model_count === 1 ? row.compact_model : null,
    hasMixedModels: row.compact_model_count > 1,
    requestCount: row.compact_request_count,
    unsuccessfulRequestCount: row.compact_unsuccessful_request_count,
    inputTokens: row.compact_input_tokens ?? 0,
    cachedInputTokens: row.compact_input_token_count > 0
      && row.compact_cached_input_token_count === row.compact_input_token_count
      ? row.compact_cached_input_tokens ?? 0
      : null,
    outputTokens: row.compact_output_tokens ?? 0,
  };
}

export function parseQuotaWindows(
  value: string | null,
): ReadonlyArray<{
  windowId: string;
  resetsAt: number | null;
  usedPercentMillionths: number | null;
  status: string | null;
}> | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const window = entry as Record<string, unknown>;
    if (typeof window.windowId !== "string" || window.windowId.length === 0) {
      return [];
    }
    const resetsAt = window.resetsAt;
    if (
      resetsAt !== null
      && !(
        typeof resetsAt === "number"
        && Number.isSafeInteger(resetsAt)
        && resetsAt >= 0
      )
    ) {
      return [];
    }
    return [{
      windowId: window.windowId,
      resetsAt,
      usedPercentMillionths: typeof window.usedPercentMillionths === "number"
        && Number.isSafeInteger(window.usedPercentMillionths)
        && window.usedPercentMillionths >= 0
        && window.usedPercentMillionths <= 100_000_000
        ? window.usedPercentMillionths
        : null,
      status: typeof window.status === "string" && window.status.length > 0
        ? window.status
        : null,
    }];
  });
}
