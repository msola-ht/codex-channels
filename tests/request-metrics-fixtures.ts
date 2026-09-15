import type { ModelRequestMetricSample } from "../src/observability/index.js";

export function sample(): ModelRequestMetricSample {
  return {
    provider: "deepseek",
    transport: "http",
    responseFormat: "sse",
    operation: "response",
    threadId: "thread-1",
    turnId: "turn-1",
    model: "deepseek-v4-flash",
    serviceTier: "default",
    reasoningEffort: "max",
    status: "completed",
    httpStatus: 200,
    errorType: null,
    errorCode: null,
    errorMessage: null,
    incompleteReason: null,
    inputTokens: 1_000,
    cachedInputTokens: 900,
    outputTokens: 100,
    reasoningOutputTokens: 40,
    totalTokens: 1_100,
    requestStartedAtMs: 1_000,
    responseCompletedAtMs: 1_650,
    weeklyQuota: null,
    quotaWindows: null,
  };
}
