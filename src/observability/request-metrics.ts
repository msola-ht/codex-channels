export type ModelRequestTransport = "http" | "websocket";
export type ModelResponseFormat = "sse" | "json" | "websocket" | "unknown";
export type ModelRequestOperation = "response" | "compact";
export type ModelRequestStatus = "completed" | "failed" | "incomplete" | "unknown";
export type ModelBillingMode = "api" | "subscription" | "unknown";

export interface ModelRequestPricingSnapshot {
  billingMode: ModelBillingMode;
  currency: string | null;
  source: string;
  effectiveAtMs: number;
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
}

export interface ModelPricingLookup {
  provider: string;
  model: string | null;
  serviceTier: string | null;
  atMs: number;
}

export interface ModelPricingResolver {
  resolve(lookup: ModelPricingLookup): ModelRequestPricingSnapshot | null;
}

export interface ModelRequestMetricSample {
  provider: string;
  pricing: ModelRequestPricingSnapshot | null;
  transport: ModelRequestTransport;
  responseFormat: ModelResponseFormat;
  operation: ModelRequestOperation;
  threadId: string | null;
  turnId: string | null;
  model: string | null;
  serviceTier: string | null;
  status: ModelRequestStatus;
  httpStatus: number | null;
  errorType: string | null;
  errorCode: string | null;
  incompleteReason: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  upstreamCreatedAt: number | null;
  upstreamCompletedAt: number | null;
  requestStartedAtMs: number;
  firstTokenAtMs: number | null;
  firstReasoningDeltaAtMs: number | null;
  lastReasoningDeltaAtMs: number | null;
  firstOutputDeltaAtMs: number | null;
  lastOutputDeltaAtMs: number | null;
  responseCompletedAtMs: number;
}

export interface StoredModelRequestMetric extends ModelRequestMetricSample {
  id: number;
  recordedAtMs: number;
  requestDurationMs: number | null;
  ttftMs: number | null;
  thinkingDurationMs: number | null;
  outputDurationMs: number | null;
  generationDurationMs: number | null;
  completionGapMs: number | null;
  upstreamDurationMs: number | null;
  uncachedInputTokens: number | null;
  nonReasoningOutputTokens: number | null;
  cacheHitRate: number | null;
  thinkingTokensPerSecond: number | null;
  outputTokensPerSecond: number | null;
  generationTokensPerSecond: number | null;
  uncachedInputCostNanos: number | null;
  cachedInputCostNanos: number | null;
  outputCostNanos: number | null;
  totalCostNanos: number | null;
}

export interface StoredTurnRequestMetricsSummary {
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

export interface StoredThreadRequestMetricsSummary {
  threadId: string;
  latestTurn: StoredTurnRequestMetricsSummary | null;
  latestDirectApi: StoredModelRequestMetric | null;
}

export interface ModelRequestMetricsStore {
  record(sample: ModelRequestMetricSample): void;
  recent(limit: number): StoredModelRequestMetric[];
  count(): number;
  close(): void;
}

export interface ModelRequestMetricsWriter {
  enqueue(sample: ModelRequestMetricSample): void;
  close(): Promise<void>;
}
