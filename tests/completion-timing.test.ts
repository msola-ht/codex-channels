import { describe, expect, it } from "vitest";

import { mergeCompletionTiming } from "../src/bootstrap/completion-timing.js";
import type { StoredTurnRequestMetricsSummary } from "../src/observability/index.js";

describe("mergeCompletionTiming", () => {
  it("restores persisted exact response usage after restart and clears stale totals", () => {
    const responseUsage = { amount: "0.30000000000000000001", observedRequestCount: 2, missingRequestCount: 1 };
    expect(mergeCompletionTiming(turnSummary({ responseUsage }), "turn-1", undefined)?.responseUsage).toEqual(responseUsage);
    expect(mergeCompletionTiming(turnSummary({ responseUsage: null }), "turn-1", { responseUsage })).not.toHaveProperty("responseUsage");
  });
  it("restores persisted TTFT instead of a later live sample after restart", () => {
    expect(mergeCompletionTiming(turnSummary({ upstreamTtftMs: 569 }), "turn-1",
      { upstreamTtftMs: 720 })?.upstreamTtftMs).toBe(569);
    expect(mergeCompletionTiming(turnSummary({ upstreamTtftMs: 0 }), "turn-1",
      undefined)?.upstreamTtftMs).toBe(0);
    expect(mergeCompletionTiming(turnSummary({ upstreamTtftMs: null }), "turn-1",
      undefined)).not.toHaveProperty("upstreamTtftMs");
  });
  it("rebuilds a recovered Turn from the persisted local proxy summary", () => {
    const latestTurn = turnSummary({
      requestCount: 2,
      inputTokens: 1_000,
      cachedInputTokens: 800,
      outputTokens: 100,
      reasoningOutputTokens: 40,
      compact: {
        requestOutcomes: { completed: 1, interrupted: 0, failed: 0, incomplete: 0 },
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
      completedModelRequestCount: 2,
      interruptedModelRequestCount: 0,
      failedModelRequestCount: 0,
      incompleteModelRequestCount: 0,
      requestInputTokens: 1_000,
      requestCachedInputTokens: 800,
      requestOutputTokens: 100,
      reasoningTokens: 40,
      compact: {
        requestOutcomes: { completed: 1, interrupted: 0, failed: 0, incomplete: 0 },
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

  it("clears incomplete persisted fields without dropping live request facts", () => {
    const latestTurn = turnSummary({
      requestCount: 2,
      cachedInputTokens: null,
      reasoningOutputTokens: 0,
      compact: null,
    });

    const timing = mergeCompletionTiming(latestTurn, "turn-1", {
      reasoningRequestCount: 2,
      requestCachedInputTokens: 400,
      reasoningTokens: 20,
      compact: {
        requestOutcomes: { completed: 1, interrupted: 0, failed: 0, incomplete: 0 },
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
      reasoningRequestCount: 2,
      modelRequestCount: 2,
    });
    expect(timing).not.toHaveProperty("requestCachedInputTokens");
    expect(timing).not.toHaveProperty("reasoningTokens");
    expect(timing).not.toHaveProperty("outputTokensPerSecond");
    expect(timing).not.toHaveProperty("compact");
  });

  it("restores persisted outcomes even when live status events were missed", () => {
    const latestTurn = turnSummary({
      requestCount: 22,
      unsuccessfulRequestCount: 14,
      requestOutcomes: { completed: 8, interrupted: 2, failed: 11, incomplete: 1 },
    });

    expect(mergeCompletionTiming(latestTurn, "turn-1", undefined)).toMatchObject({
      modelRequestCount: 22,
      completedModelRequestCount: 8,
      interruptedModelRequestCount: 2,
      incompleteModelRequestCount: 1,
      failedModelRequestCount: 11,
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
      requestOutcomes: { completed: 3, interrupted: 1, failed: 1, incomplete: 0 },
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
    requestOutcomes: { completed: overrides.requestCount ?? 0, interrupted: 0, failed: 0, incomplete: 0 },
    interruptionSummary: { followedByCompletion: 0, noObservedCompletion: 0, usageUnobserved: 0 },
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    ...overrides,
    compact: overrides.compact ?? null,
  };
}
