import type {
  AccountRateLimit,
  AccountWeeklyLimitEstimate,
} from "./account-port.js";

export interface CompactRequestMetricsSummary {
  model: string | null;
  hasMixedModels: boolean;
  requestCount: number;
  unsuccessfulRequestCount: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  pricingCurrency: string | null;
  pricedRequestCount: number;
  totalCostNanos: number | null;
}

export interface TurnRequestMetricsSummary {
  turnId: string;
  requestCount: number;
  unsuccessfulRequestCount: number;
  requestDurationMs: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number;
  outputTokensPerSecond: number | null;
  outputSpeedSampleCount: number;
  outputSpeedTimedCount: number;
  pricingCurrency: string | null;
  pricedRequestCount: number;
  totalCostNanos: number | null;
  inputCostNanos: number | null;
  cachedInputCostNanos: number | null;
  outputCostNanos: number | null;
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
  hasMixedPrices: boolean;
  pricingBuckets?: Array<"peak" | "off-peak">;
  compact?: CompactRequestMetricsSummary | null;
}

export interface ThreadRequestMetricsAggregate {
  turnCount: number;
  requestCount: number;
  unsuccessfulRequestCount: number;
  requestDurationMs: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number;
  outputTokensPerSecond: number | null;
  outputSpeedSampleCount: number;
  outputSpeedTimedCount: number;
  pricingCurrency: string | null;
  pricedRequestCount: number;
  totalCostNanos: number | null;
  inputCostNanos: number | null;
  cachedInputCostNanos: number | null;
  outputCostNanos: number | null;
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
  hasMixedPrices: boolean;
  pricingBuckets?: Array<"peak" | "off-peak">;
  compact?: CompactRequestMetricsSummary | null;
}

export interface DirectApiRequestMetricsSummary {
  provider: string;
  providerName?: string;
  model: string | null;
  status: "completed" | "failed" | "incomplete" | "unknown";
  httpStatus: number | null;
  requestDurationMs: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  pricingCurrency: string | null;
  totalCostNanos: number | null;
  inputCostNanos: number | null;
  cachedInputCostNanos: number | null;
  outputCostNanos: number | null;
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
  pricingBucket?: "peak" | "off-peak";
}

export interface ThreadRequestMetricsSummary {
  threadId: string;
  modelProvider: string;
  latestTurn: TurnRequestMetricsSummary | null;
  threadAggregate: ThreadRequestMetricsAggregate | null;
  latestDirectApi: DirectApiRequestMetricsSummary | null;
}

export type RequestMetricsTimeRange =
  | "today" | "yesterday"
  | "this-week" | "last-week"
  | "this-month" | "last-month"
  | "24h" | "7d" | "30d" | "90d" | "365d" | "all";
export type RequestMetricsAggregateView = "global" | "providers" | "models";
export type RequestMetricsView = RequestMetricsAggregateView | "errors";
export type TurnErrorPhase = "start" | "steer" | "notification";

export interface TurnErrorRecord {
  provider: string;
  model: string | null;
  threadId: string | null;
  turnId: string | null;
  phase: TurnErrorPhase;
  errorType: string;
  errorCode: string | null;
  message: string | null;
  recordedAtMs: number;
}

export interface TurnErrorRecorder {
  recordTurnError(record: TurnErrorRecord): void;
}

export interface RequestMetricsCommandQuery {
  view: "session" | RequestMetricsView;
  range?: RequestMetricsTimeRange;
}

export interface RequestMetricsAggregate {
  requestCount: number;
  unsuccessfulRequestCount: number;
  requestDurationMs: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number;
  outputTokensPerSecond: number | null;
  outputSpeedSampleCount: number;
  outputSpeedTimedCount: number;
  ttftAverageMs: number | null;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  ttftSampleCount: number;
  pricingCurrency: string | null;
  pricedRequestCount: number;
  totalCostNanos: number | null;
  inputCostNanos: number | null;
  cachedInputCostNanos: number | null;
  outputCostNanos: number | null;
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
  hasMixedPrices: boolean;
  pricingBuckets?: Array<"peak" | "off-peak">;
  compact?: CompactRequestMetricsSummary | null;
}

export interface RequestMetricsGroup {
  provider: string | null;
  providerName?: string;
  model: string | null;
  aggregate: RequestMetricsAggregate;
}

export interface RequestMetricsAggregateReport {
  view: RequestMetricsAggregateView;
  range: RequestMetricsTimeRange;
  startAtMs: number;
  endAtMs: number;
  aggregate: RequestMetricsAggregate | null;
  groups: RequestMetricsGroup[];
  totalGroupCount: number;
}

export interface RequestMetricsErrorGroup {
  provider: string;
  providerName?: string;
  model: string | null;
  status: "failed" | "incomplete" | "unknown";
  httpStatus: number | null;
  errorType: string | null;
  lastErrorMessage: string | null;
  requestCount: number;
  lastOccurredAtMs: number;
}

export interface RequestMetricsErrorReport {
  view: "errors";
  range: RequestMetricsTimeRange;
  startAtMs: number;
  endAtMs: number;
  requestCount: number;
  unsuccessfulRequestCount: number;
  groups: RequestMetricsErrorGroup[];
  totalGroupCount: number;
}

export type RequestMetricsResult =
  | ThreadRequestMetricsSummary
  | RequestMetricsAggregateReport
  | RequestMetricsErrorReport;

export interface RequestMetricsQueryPort {
  forThread(threadId: string): ThreadRequestMetricsSummary;
  aggregate(
    view: RequestMetricsAggregateView,
    range: RequestMetricsTimeRange,
  ): RequestMetricsAggregateReport;
  errors(range: RequestMetricsTimeRange): RequestMetricsErrorReport;
  weeklyQuotaEstimate(
    provider: string,
    limitId: string,
    resetsAt: number,
    nowMs: number,
  ): WeeklyQuotaMetricsObservation | null;
}

const weeklyWindowDurationMins = 7 * 24 * 60;

export interface WeeklyQuotaMetricsObservation {
  limitId: string;
  resetsAt: number;
  firstObservedAtMs: number;
  lastObservedAtMs: number;
  latestUsedPercentMillionths: number;
  observedDeltaPercentMillionths: number;
  intervalCount: number;
  requestCount: number;
  unsuccessfulRequestCount: number;
  pricedRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  pricingCurrency: string | null;
  totalCostNanos: number | null;
}

export function estimateWeeklyLimit(
  limit: AccountRateLimit,
  observation: WeeklyQuotaMetricsObservation | null,
): AccountWeeklyLimitEstimate | null {
  const window = [limit.primary, limit.secondary].find(
    (candidate) => candidate?.windowDurationMins === weeklyWindowDurationMins,
  );
  if (
    !window
    || window.resetsAt === null
    || observation === null
    || observation.limitId !== limit.limitId
    || observation.resetsAt !== window.resetsAt
    || observation.observedDeltaPercentMillionths <= 0
    || observation.requestCount === 0
  ) {
    return null;
  }
  const deltaPercent = observation.observedDeltaPercentMillionths / 1_000_000;
  const remainingPercent = Math.max(0, 100 - window.usedPercent);
  const perPercent = (value: number): number => Math.round(value / deltaPercent);
  const remaining = (value: number): number => Math.round(
    value / deltaPercent * remainingPercent,
  );
  return {
    limitId: limit.limitId,
    startAtMs: observation.firstObservedAtMs,
    endAtMs: observation.lastObservedAtMs,
    usedPercent: window.usedPercent,
    remainingPercent,
    observedDeltaPercent: deltaPercent,
    intervalCount: observation.intervalCount,
    requestCount: observation.requestCount,
    unsuccessfulRequestCount: observation.unsuccessfulRequestCount,
    pricedRequestCount: observation.pricedRequestCount,
    inputTokensPerPercent: perPercent(observation.inputTokens),
    outputTokensPerPercent: perPercent(observation.outputTokens),
    totalTokensPerPercent: perPercent(observation.totalTokens),
    remainingTokens: remaining(observation.totalTokens),
    pricingCurrency: observation.pricingCurrency,
    costPerPercentNanos: observation.totalCostNanos === null
      ? null
      : perPercent(observation.totalCostNanos),
    remainingCostNanos: observation.totalCostNanos === null
      ? null
      : remaining(observation.totalCostNanos),
  };
}
