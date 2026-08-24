import { describe, expect, it } from "vitest";

import {
  mergeCompletionTiming,
  mergeSessionReferenceCost,
} from "../src/bootstrap/reference-cost-summary.js";
import type {
  StoredThreadRequestMetricsAggregate,
  StoredTurnRequestMetricsSummary,
} from "../src/observability/index.js";

describe("mergeSessionReferenceCost", () => {
  it("replaces a partially persisted current Turn with its complete live cost", () => {
    const latestTurn = turnSummary({
      requestCount: 1,
      pricedRequestCount: 1,
      totalCostNanos: 100_000,
      inputCostNanos: 40_000,
      cachedInputCostNanos: 20_000,
      outputCostNanos: 40_000,
    });
    const threadAggregate = threadSummary({
      requestCount: 5,
      pricedRequestCount: 4,
      totalCostNanos: 500_000,
      inputCostNanos: 200_000,
      cachedInputCostNanos: 100_000,
      outputCostNanos: 200_000,
    });

    expect(mergeSessionReferenceCost({
      threadId: "thread-1",
      latestTurn,
      threadAggregate,
      latestDirectApi: null,
    }, "turn-1", {
      currency: "USD",
      requestCount: 2,
      pricedRequestCount: 2,
      totalCostNanos: 250_000,
      inputCostNanos: 100_000,
      cachedInputCostNanos: 50_000,
      outputCostNanos: 100_000,
      ...rates,
      hasMixedPrices: false,
    })).toEqual({
      currency: "USD",
      requestCount: 6,
      pricedRequestCount: 5,
      totalCostNanos: 650_000,
      inputTokens: 0,
      outputTokens: 0,
      inputCostNanos: 260_000,
      cachedInputCostNanos: 130_000,
      outputCostNanos: 260_000,
      ...rates,
      hasMixedPrices: false,
      pricingBuckets: [],
    });
  });

  it("marks the session unit price as mixed when the current Turn rate changed", () => {
    const threadAggregate = threadSummary({
      requestCount: 4,
      pricedRequestCount: 4,
      totalCostNanos: 400_000,
      inputCostNanos: 160_000,
      cachedInputCostNanos: 80_000,
      outputCostNanos: 160_000,
    });
    expect(mergeSessionReferenceCost({
      threadId: "thread-1",
      latestTurn: null,
      threadAggregate,
      latestDirectApi: null,
    }, "turn-2", {
      currency: "USD",
      requestCount: 1,
      pricedRequestCount: 1,
      totalCostNanos: 200_000,
      inputCostNanos: 80_000,
      cachedInputCostNanos: 40_000,
      outputCostNanos: 80_000,
      ...rates,
      outputPricePerMillionNanos: 300_000_000,
      hasMixedPrices: false,
    })).toMatchObject({
      currency: "USD",
      requestCount: 5,
      pricedRequestCount: 5,
      totalCostNanos: 600_000,
      inputCostNanos: 240_000,
      cachedInputCostNanos: 120_000,
      outputCostNanos: 240_000,
      uncachedInputPricePerMillionNanos: null,
      cachedInputPricePerMillionNanos: null,
      outputPricePerMillionNanos: null,
      hasMixedPrices: true,
    });
  });

  it("keeps historical cost when a partially persisted current request was unpriced", () => {
    const latestTurn = turnSummary({
      requestCount: 1,
      pricedRequestCount: 0,
      pricingCurrency: null,
      totalCostNanos: null,
      inputCostNanos: null,
      cachedInputCostNanos: null,
      outputCostNanos: null,
      uncachedInputPricePerMillionNanos: null,
      cachedInputPricePerMillionNanos: null,
      outputPricePerMillionNanos: null,
    });
    const threadAggregate = threadSummary({
      requestCount: 5,
      pricedRequestCount: 4,
      totalCostNanos: 500_000,
      inputCostNanos: 200_000,
      cachedInputCostNanos: 100_000,
      outputCostNanos: 200_000,
    });

    expect(mergeSessionReferenceCost({
      threadId: "thread-1",
      latestTurn,
      threadAggregate,
      latestDirectApi: null,
    }, "turn-1", {
      currency: "USD",
      requestCount: 1,
      pricedRequestCount: 1,
      totalCostNanos: 150_000,
      inputCostNanos: 60_000,
      cachedInputCostNanos: 30_000,
      outputCostNanos: 60_000,
      ...rates,
      hasMixedPrices: false,
    })).toEqual({
      currency: "USD",
      requestCount: 5,
      pricedRequestCount: 5,
      totalCostNanos: 650_000,
      inputTokens: 0,
      outputTokens: 0,
      inputCostNanos: 260_000,
      cachedInputCostNanos: 130_000,
      outputCostNanos: 260_000,
      ...rates,
      hasMixedPrices: false,
      pricingBuckets: [],
    });
  });
});

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
      pricedRequestCount: 2,
      pricedInputTokens: 1_000,
      pricedOutputTokens: 100,
      totalCostNanos: 12_000,
      inputCostNanos: 8_000,
      cachedInputCostNanos: 1_000,
      outputCostNanos: 3_000,
      compact: {
        model: "gpt-5.6-sol",
        hasMixedModels: false,
        requestCount: 1,
        unsuccessfulRequestCount: 0,
        inputTokens: 400,
        cachedInputTokens: 320,
        outputTokens: 20,
        pricingCurrency: "USD",
        pricedRequestCount: 1,
        totalCostNanos: 2_000,
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
      referenceCost: {
        currency: "USD",
        totalCostNanos: 12_000,
        inputTokens: 1_000,
        outputTokens: 100,
        inputCostNanos: 8_000,
        cachedInputCostNanos: 1_000,
        outputCostNanos: 3_000,
        pricedRequestCount: 2,
        requestCount: 2,
        ...rates,
        hasMixedPrices: false,
        pricingBuckets: [],
      },
      compact: {
        model: "gpt-5.6-sol",
        hasMixedModels: false,
        requestCount: 1,
        unsuccessfulRequestCount: 0,
        inputTokens: 400,
        cachedInputTokens: 320,
        outputTokens: 20,
        pricingCurrency: "USD",
        pricedRequestCount: 1,
        totalCostNanos: 2_000,
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
        pricingCurrency: null,
        pricedRequestCount: 0,
        totalCostNanos: null,
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
});

const rates = {
  uncachedInputPricePerMillionNanos: 140_000_000,
  cachedInputPricePerMillionNanos: 2_800_000,
  outputPricePerMillionNanos: 280_000_000,
};

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
    pricingCurrency: "USD",
    pricedRequestCount: 0,
    pricedInputTokens: 0,
    pricedOutputTokens: 0,
    totalCostNanos: null,
    inputCostNanos: null,
    cachedInputCostNanos: null,
    outputCostNanos: null,
    ...rates,
    hasMixedPrices: false,
    pricingBuckets: [],
    ...overrides,
    compact: overrides.compact ?? null,
  };
}

function threadSummary(
  overrides: Partial<StoredThreadRequestMetricsAggregate>,
): StoredThreadRequestMetricsAggregate {
  return {
    turnCount: 1,
    ...turnSummary(overrides),
    ...overrides,
  };
}
