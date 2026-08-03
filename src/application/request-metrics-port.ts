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
}

export interface ThreadRequestMetricsSummary {
  threadId: string;
  latestTurn: TurnRequestMetricsSummary | null;
  threadAggregate: ThreadRequestMetricsAggregate | null;
  latestDirectApi: DirectApiRequestMetricsSummary | null;
}

export type RequestMetricsTimeRange = "24h" | "7d" | "30d";
export type RequestMetricsAggregateView = "global" | "providers" | "models";

export interface RequestMetricsCommandQuery {
  view: "session" | RequestMetricsAggregateView;
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

export type RequestMetricsResult =
  | ThreadRequestMetricsSummary
  | RequestMetricsAggregateReport;

export interface RequestMetricsQueryPort {
  forThread(threadId: string): ThreadRequestMetricsSummary;
  aggregate(
    view: RequestMetricsAggregateView,
    range: RequestMetricsTimeRange,
  ): RequestMetricsAggregateReport;
}
