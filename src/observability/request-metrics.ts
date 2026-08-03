export type ModelRequestTransport = "http" | "websocket";
export type ModelResponseFormat = "sse" | "json" | "websocket" | "unknown";
export type ModelRequestOperation = "response" | "compact";
export type ModelRequestStatus = "completed" | "failed" | "incomplete" | "unknown";

export interface ModelRequestMetricSample {
  provider: string;
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
