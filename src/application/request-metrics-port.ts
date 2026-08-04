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
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
  hasMixedPrices: boolean;
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
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
  hasMixedPrices: boolean;
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
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
}

export interface ThreadRequestMetricsSummary {
  threadId: string;
  latestTurn: TurnRequestMetricsSummary | null;
  threadAggregate: ThreadRequestMetricsAggregate | null;
  latestDirectApi: DirectApiRequestMetricsSummary | null;
}

export type RequestMetricsTimeRange = "24h" | "7d" | "30d";
export type RequestMetricsAggregateView = "global" | "providers" | "models";
export type RequestMetricsView = RequestMetricsAggregateView | "errors";

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
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
  hasMixedPrices: boolean;
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
}
