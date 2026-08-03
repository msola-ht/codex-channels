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
  latestDirectApi: DirectApiRequestMetricsSummary | null;
}

export interface RequestMetricsQueryPort {
  forThread(threadId: string): ThreadRequestMetricsSummary;
}
