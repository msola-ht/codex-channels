import { describe, expect, it } from "vitest";

import { mergeSessionReferenceCost } from "../src/bootstrap/reference-cost-summary.js";
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
    });
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
