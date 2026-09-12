import type {
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
  upstream_created_at: number | null;
  upstream_completed_at: number | null;
  request_started_at_ms: number;
  first_token_at_ms: number | null;
  first_reasoning_delta_at_ms: number | null;
  last_reasoning_delta_at_ms: number | null;
  first_output_delta_at_ms: number | null;
  last_output_delta_at_ms: number | null;
  response_completed_at_ms: number;
  recorded_at_ms: number;
  weekly_quota_limit_id: "codex" | null;
  weekly_used_percent_millionths: number | null;
  weekly_resets_at: number | null;
  weekly_quota_plan_type: string | null;
  quota_windows: string | null;
  request_duration_ms: number | null;
  ttft_ms: number | null;
  thinking_duration_ms: number | null;
  output_duration_ms: number | null;
  generation_duration_ms: number | null;
  completion_gap_ms: number | null;
  upstream_duration_ms: number | null;
  uncached_input_tokens: number | null;
  non_reasoning_output_tokens: number | null;
  cache_hit_rate: number | null;
  thinking_tokens_per_second: number | null;
  output_tokens_per_second: number | null;
  generation_tokens_per_second: number | null;
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
  provider?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  turn_id: string | null;
  turn_count: number;
  request_count: number;
  unsuccessful_request_count: number;
  request_duration_ms: number | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  input_token_count: number;
  cached_input_token_count: number;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  non_reasoning_output_tokens: number | null;
  output_duration_ms: number | null;
  output_speed_sample_count: number;
  output_speed_timed_count: number;
}

export interface AggregateRow extends Omit<TurnSummaryRow, "turn_id" | "turn_count"> {
  provider: string | null;
  model: string | null;
  ttft_average_ms: number | null;
  ttft_p50_ms: number | null;
  ttft_p95_ms: number | null;
  ttft_sample_count: number;
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
    model: row.model,
    serviceTier: row.service_tier,
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
    upstreamCreatedAt: row.upstream_created_at,
    upstreamCompletedAt: row.upstream_completed_at,
    requestStartedAtMs: row.request_started_at_ms,
    firstTokenAtMs: row.first_token_at_ms,
    firstReasoningDeltaAtMs: row.first_reasoning_delta_at_ms,
    lastReasoningDeltaAtMs: row.last_reasoning_delta_at_ms,
    firstOutputDeltaAtMs: row.first_output_delta_at_ms,
    lastOutputDeltaAtMs: row.last_output_delta_at_ms,
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
    requestDurationMs: row.request_duration_ms,
    ttftMs: row.ttft_ms,
    thinkingDurationMs: row.thinking_duration_ms,
    outputDurationMs: row.output_duration_ms,
    generationDurationMs: row.generation_duration_ms,
    completionGapMs: row.completion_gap_ms,
    upstreamDurationMs: row.upstream_duration_ms,
    uncachedInputTokens: row.uncached_input_tokens,
    nonReasoningOutputTokens: row.non_reasoning_output_tokens,
    cacheHitRate: row.cache_hit_rate,
    thinkingTokensPerSecond: row.thinking_tokens_per_second,
    outputTokensPerSecond: row.output_tokens_per_second,
    generationTokensPerSecond: row.generation_tokens_per_second,
  };
}

export function toStoredTurnSummary(row: TurnSummaryRow): StoredTurnRequestMetricsSummary {
  const outputDurationMs = row.output_duration_ms ?? 0;
  const nonReasoningOutputTokens = row.non_reasoning_output_tokens ?? 0;
  return {
    provider: row.provider ?? null,
    model: row.model ?? null,
    reasoningEffort: row.reasoning_effort ?? null,
    turnId: row.turn_id!,
    requestCount: row.request_count,
    unsuccessfulRequestCount: row.unsuccessful_request_count,
    requestDurationMs: row.request_duration_ms ?? 0,
    inputTokens: row.input_tokens ?? 0,
    cachedInputTokens: row.input_token_count > 0
      && row.cached_input_token_count === row.input_token_count
      ? row.cached_input_tokens ?? 0
      : null,
    outputTokens: row.output_tokens ?? 0,
    reasoningOutputTokens: row.reasoning_output_tokens ?? 0,
    outputTokensPerSecond: outputDurationMs > 0 && nonReasoningOutputTokens > 0
      ? nonReasoningOutputTokens / (outputDurationMs / 1_000)
      : null,
    outputSpeedSampleCount: row.output_speed_sample_count,
    outputSpeedTimedCount: row.output_speed_timed_count,
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
    turnCount: row.turn_count,
    requestCount: summary.requestCount,
    unsuccessfulRequestCount: summary.unsuccessfulRequestCount,
    requestDurationMs: summary.requestDurationMs,
    inputTokens: summary.inputTokens,
    cachedInputTokens: summary.cachedInputTokens,
    outputTokens: summary.outputTokens,
    reasoningOutputTokens: summary.reasoningOutputTokens,
    outputTokensPerSecond: summary.outputTokensPerSecond,
    outputSpeedSampleCount: summary.outputSpeedSampleCount,
    outputSpeedTimedCount: summary.outputSpeedTimedCount,
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
  const outputDurationMs = row.output_duration_ms ?? 0;
  const nonReasoningOutputTokens = row.non_reasoning_output_tokens ?? 0;
  return {
    requestCount: row.request_count,
    unsuccessfulRequestCount: row.unsuccessful_request_count,
    requestDurationMs: row.request_duration_ms ?? 0,
    inputTokens: row.input_tokens ?? 0,
    cachedInputTokens: row.input_token_count > 0
      && row.cached_input_token_count === row.input_token_count
      ? row.cached_input_tokens ?? 0
      : null,
    outputTokens: row.output_tokens ?? 0,
    reasoningOutputTokens: row.reasoning_output_tokens ?? 0,
    outputTokensPerSecond: outputDurationMs > 0 && nonReasoningOutputTokens > 0
      ? nonReasoningOutputTokens / (outputDurationMs / 1_000)
      : null,
    outputSpeedSampleCount: row.output_speed_sample_count,
    outputSpeedTimedCount: row.output_speed_timed_count,
    ttftAverageMs: row.ttft_average_ms,
    ttftP50Ms: row.ttft_p50_ms,
    ttftP95Ms: row.ttft_p95_ms,
    ttftSampleCount: row.ttft_sample_count,
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
