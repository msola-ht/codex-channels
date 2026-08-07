import {
  turnErrorCode,
  turnErrorMessage,
  turnErrorType,
} from "../application/index.js";
import type {
  ModelRequestMetricSample,
} from "../observability/index.js";

export interface TurnErrorMetricWriter {
  enqueue(metric: ModelRequestMetricSample): void;
}

export function enqueueTurnErrorMetric(
  writer: TurnErrorMetricWriter,
  provider: string,
  threadId: string | null,
  turnId: string | null,
  phase: Parameters<typeof turnErrorType>[1],
  error: unknown,
): void {
  const recordedAtMs = Date.now();
  writer.enqueue({
    provider,
    pricing: null,
    transport: "http",
    responseFormat: "unknown",
    operation: "response",
    threadId,
    turnId,
    model: null,
    serviceTier: null,
    reasoningEffort: null,
    status: "failed",
    httpStatus: null,
    errorType: turnErrorType(error, phase),
    errorCode: turnErrorCode(error),
    errorMessage: turnErrorMessage(error),
    incompleteReason: null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    totalTokens: null,
    upstreamCreatedAt: null,
    upstreamCompletedAt: null,
    requestStartedAtMs: recordedAtMs,
    firstTokenAtMs: null,
    firstReasoningDeltaAtMs: null,
    lastReasoningDeltaAtMs: null,
    firstOutputDeltaAtMs: null,
    lastOutputDeltaAtMs: null,
    responseCompletedAtMs: recordedAtMs,
    weeklyQuota: null,
  });
}
