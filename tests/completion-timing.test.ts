import { describe, expect, it } from "vitest";

import { mergeCompletionTiming } from "../src/bootstrap/completion-timing.js";
import type { StoredTurnRequestMetricsSummary } from "../src/observability/index.js";

describe("mergeCompletionTiming", () => {
  it("rebuilds a recovered Turn from the persisted local proxy summary", () => {
    const latestTurn = turnSummary({
      requestCount: 2,
      requestDurationMs: 12_000,
      inputTokens: 1_000,
      cachedInputTokens: 800,
      outputTokens: 100,
      reasoningOutputTokens: 40,
      outputTokensPerSecond: 25,
      outputSpeedSampleCount: 2,
      outputSpeedTimedCount: 2,
      compact: {
        model: "gpt-5.6-sol",
        hasMixedModels: false,
        requestCount: 1,
        unsuccessfulRequestCount: 0,
        inputTokens: 400,
        cachedInputTokens: 320,
        outputTokens: 20,
      },
    });

    expect(mergeCompletionTiming(latestTurn, "turn-1", undefined)).toEqual({
      modelRequestCount: 2,
      modelRequestDurationMs: 12_000,
      requestInputTokens: 1_000,
      requestCachedInputTokens: 800,
      requestOutputTokens: 100,
      reasoningTokens: 40,
      outputTokensPerSecond: 25,
      outputSpeedSampleCount: 2,
      outputSpeedTimedCount: 2,
      compact: {
        model: "gpt-5.6-sol",
        hasMixedModels: false,
        requestCount: 1,
        unsuccessfulRequestCount: 0,
        inputTokens: 400,
        cachedInputTokens: 320,
        outputTokens: 20,
      },
    });
  });

  it("clears incomplete persisted fields without dropping live response latency", () => {
    const latestTurn = turnSummary({
      requestCount: 2,
      cachedInputTokens: null,
      reasoningOutputTokens: 0,
      outputTokensPerSecond: null,
      outputSpeedSampleCount: 2,
      outputSpeedTimedCount: 1,
      compact: null,
    });

    const timing = mergeCompletionTiming(latestTurn, "turn-1", {
      firstResponseLatencyMs: 500,
      requestCachedInputTokens: 400,
      reasoningTokens: 20,
      outputTokensPerSecond: 50,
      compact: {
        model: "stale-model",
        hasMixedModels: false,
        requestCount: 1,
        unsuccessfulRequestCount: 0,
        inputTokens: 10,
        cachedInputTokens: 10,
        outputTokens: 1,
      },
    });

    expect(timing).toMatchObject({
      firstResponseLatencyMs: 500,
      modelRequestCount: 2,
      outputSpeedSampleCount: 2,
      outputSpeedTimedCount: 1,
    });
    expect(timing).not.toHaveProperty("requestCachedInputTokens");
    expect(timing).not.toHaveProperty("reasoningTokens");
    expect(timing).not.toHaveProperty("outputTokensPerSecond");
    expect(timing).not.toHaveProperty("compact");
  });

  it("reconciles persisted request totals with the live request status breakdown", () => {
    const latestTurn = turnSummary({
      requestCount: 22,
      unsuccessfulRequestCount: 14,
    });

    expect(mergeCompletionTiming(latestTurn, "turn-1", {
      modelRequestCount: 21,
      completedModelRequestCount: 8,
      interruptedModelRequestCount: 2,
      incompleteModelRequestCount: 0,
      failedModelRequestCount: 11,
      retryableFailureModelRequestCount: 0,
    })).toMatchObject({
      modelRequestCount: 22,
      completedModelRequestCount: 8,
      interruptedModelRequestCount: 2,
      incompleteModelRequestCount: 1,
      failedModelRequestCount: 11,
      retryableFailureModelRequestCount: 0,
    });
  });

  it("bounds a stale live status breakdown to the persisted request totals", () => {
    const latestTurn = turnSummary({
      requestCount: 5,
      unsuccessfulRequestCount: 2,
    });

    expect(mergeCompletionTiming(latestTurn, "turn-1", {
      modelRequestCount: 17,
      completedModelRequestCount: 8,
      interruptedModelRequestCount: 1,
      incompleteModelRequestCount: 0,
      failedModelRequestCount: 8,
      retryableFailureModelRequestCount: 7,
    })).toMatchObject({
      modelRequestCount: 5,
      completedModelRequestCount: 3,
      interruptedModelRequestCount: 1,
      incompleteModelRequestCount: 0,
      failedModelRequestCount: 1,
      retryableFailureModelRequestCount: 1,
    });
  });
});

function turnSummary(
  overrides: Partial<StoredTurnRequestMetricsSummary>,
): StoredTurnRequestMetricsSummary {
  return {
    provider: null,
    model: null,
    reasoningEffort: null,
    turnId: "turn-1",
    requestCount: 0,
    unsuccessfulRequestCount: 0,
    requestDurationMs: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    outputTokensPerSecond: null,
    outputSpeedSampleCount: 0,
    outputSpeedTimedCount: 0,
    ...overrides,
    compact: overrides.compact ?? null,
  };
}
