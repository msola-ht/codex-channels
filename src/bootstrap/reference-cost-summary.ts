import type {
  ReferenceCostSummary,
  TurnOutputTiming,
} from "../conversation-core/index.js";
import type {
  StoredThreadRequestMetricsSummary,
  StoredTurnRequestMetricsSummary,
} from "../observability/index.js";
import { pricingBucketOrder } from "./pricing-bucket.js";

export function mergeSessionReferenceCost(
  summary: StoredThreadRequestMetricsSummary,
  turnId: string,
  current: ReferenceCostSummary | undefined,
): ReferenceCostSummary | undefined {
  const aggregate = summary.threadAggregate === null
    ? undefined
    : toReferenceCost(summary.threadAggregate);
  if (!current) return aggregate;
  const historical = summary.latestTurn?.turnId === turnId && aggregate
    ? subtractReferenceCost(aggregate, toReferenceCost(summary.latestTurn))
    : aggregate;
  return combineReferenceCosts(historical, current);
}

export function mergeCompletionTiming(
  latestTurn: StoredTurnRequestMetricsSummary | null,
  turnId: string,
  current: TurnOutputTiming | undefined,
): TurnOutputTiming | undefined {
  if (latestTurn?.turnId !== turnId) return current;
  const timing: TurnOutputTiming = {
    ...current,
    modelRequestCount: latestTurn.requestCount,
    modelRequestDurationMs: latestTurn.requestDurationMs,
    requestInputTokens: latestTurn.inputTokens,
    requestOutputTokens: latestTurn.outputTokens,
    outputSpeedSampleCount: latestTurn.outputSpeedSampleCount,
    outputSpeedTimedCount: latestTurn.outputSpeedTimedCount,
    referenceCost: toReferenceCost(latestTurn),
  };
  reconcileModelRequestStatuses(timing, latestTurn);
  assignOptionalMetric(
    timing,
    "requestCachedInputTokens",
    latestTurn.cachedInputTokens,
  );
  assignOptionalMetric(
    timing,
    "reasoningTokens",
    latestTurn.reasoningOutputTokens > 0
      ? latestTurn.reasoningOutputTokens
      : null,
  );
  assignOptionalMetric(
    timing,
    "outputTokensPerSecond",
    latestTurn.outputTokensPerSecond,
  );
  assignOptionalMetric(timing, "compact", latestTurn.compact);
  return timing;
}

function reconcileModelRequestStatuses(
  timing: TurnOutputTiming,
  latestTurn: StoredTurnRequestMetricsSummary,
): void {
  const hasLiveBreakdown = [
    timing.completedModelRequestCount,
    timing.interruptedModelRequestCount,
    timing.incompleteModelRequestCount,
    timing.failedModelRequestCount,
  ].some((value) => value !== undefined);
  if (!hasLiveBreakdown) return;

  const unsuccessful = Math.min(
    latestTurn.requestCount,
    Math.max(0, latestTurn.unsuccessfulRequestCount),
  );
  const interrupted = Math.min(
    unsuccessful,
    Math.max(0, timing.interruptedModelRequestCount ?? 0),
  );
  const afterInterrupted = unsuccessful - interrupted;
  const failed = Math.min(
    afterInterrupted,
    Math.max(0, timing.failedModelRequestCount ?? 0),
  );
  const incomplete = afterInterrupted - failed;
  timing.completedModelRequestCount = latestTurn.requestCount - unsuccessful;
  timing.interruptedModelRequestCount = interrupted;
  timing.incompleteModelRequestCount = incomplete;
  timing.failedModelRequestCount = failed;
  if (timing.retryableFailureModelRequestCount !== undefined) {
    timing.retryableFailureModelRequestCount = Math.min(
      failed,
      Math.max(0, timing.retryableFailureModelRequestCount),
    );
  }
}

function assignOptionalMetric<K extends keyof TurnOutputTiming>(
  timing: TurnOutputTiming,
  key: K,
  value: TurnOutputTiming[K] | null,
): void {
  if (value === null) {
    delete timing[key];
    return;
  }
  timing[key] = value;
}

function toReferenceCost(value: {
  requestCount: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  pricingCurrency: string | null;
  pricedRequestCount: number;
  totalCostNanos: number | null;
  inputCostNanos: number | null;
  cachedInputCostNanos: number | null;
  outputCostNanos: number | null;
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
  hasMixedPrices: boolean;
  pricingBuckets: Array<"peak" | "off-peak">;
}): ReferenceCostSummary {
  return {
    currency: value.pricingCurrency,
    totalCostNanos: value.totalCostNanos,
    inputTokens: value.inputTokens,
    ...(value.cachedInputTokens === null
      ? {}
      : { cachedInputTokens: value.cachedInputTokens }),
    outputTokens: value.outputTokens,
    inputCostNanos: value.inputCostNanos,
    cachedInputCostNanos: value.cachedInputCostNanos,
    outputCostNanos: value.outputCostNanos,
    pricedRequestCount: value.pricedRequestCount,
    requestCount: value.requestCount,
    uncachedInputPricePerMillionNanos:
      value.uncachedInputPricePerMillionNanos,
    cachedInputPricePerMillionNanos:
      value.cachedInputPricePerMillionNanos,
    outputPricePerMillionNanos: value.outputPricePerMillionNanos,
    hasMixedPrices: value.hasMixedPrices,
    pricingBuckets: value.pricingBuckets,
  };
}

function subtractReferenceCost(
  aggregate: ReferenceCostSummary,
  currentStored: ReferenceCostSummary,
): ReferenceCostSummary | undefined {
  const requestCount = Math.max(0, aggregate.requestCount - currentStored.requestCount);
  if (requestCount === 0) return undefined;
  const pricedRequestCount = Math.max(
    0,
    aggregate.pricedRequestCount - currentStored.pricedRequestCount,
  );
  if (currentStored.pricedRequestCount === 0) {
    const { pricingBuckets, ...remaining } = aggregate;
    return {
      ...remaining,
      requestCount,
      ...(pricingBuckets === undefined ? {} : { pricingBuckets }),
    };
  }
  const compatibleCurrency = aggregate.currency !== null
    && aggregate.currency === currentStored.currency;
  const totalCostNanos = compatibleCurrency
    && aggregate.totalCostNanos !== null
    && currentStored.totalCostNanos !== null
    ? Math.max(0, aggregate.totalCostNanos - currentStored.totalCostNanos)
    : null;
  const inputCostNanos = compatibleCurrency
    && aggregate.inputCostNanos !== null
    && currentStored.inputCostNanos !== null
    ? Math.max(0, aggregate.inputCostNanos - currentStored.inputCostNanos)
    : null;
  const cachedInputCostNanos = compatibleCurrency
    && aggregate.cachedInputCostNanos !== null
    && currentStored.cachedInputCostNanos !== null
    ? Math.max(
        0,
        aggregate.cachedInputCostNanos - currentStored.cachedInputCostNanos,
      )
    : null;
  const outputCostNanos = compatibleCurrency
    && aggregate.outputCostNanos !== null
    && currentStored.outputCostNanos !== null
    ? Math.max(0, aggregate.outputCostNanos - currentStored.outputCostNanos)
    : null;
  return {
    currency: pricedRequestCount > 0 && compatibleCurrency
      ? aggregate.currency
      : null,
    totalCostNanos: pricedRequestCount > 0 ? totalCostNanos : null,
    inputTokens: Math.max(0, (aggregate.inputTokens ?? 0) - (currentStored.inputTokens ?? 0)),
    ...(aggregate.cachedInputTokens !== undefined
      && currentStored.cachedInputTokens !== undefined
      ? {
          cachedInputTokens: Math.max(
            0,
            aggregate.cachedInputTokens - currentStored.cachedInputTokens,
          ),
        }
      : {}),
    outputTokens: Math.max(0, (aggregate.outputTokens ?? 0) - (currentStored.outputTokens ?? 0)),
    inputCostNanos: pricedRequestCount > 0 ? inputCostNanos : null,
    cachedInputCostNanos: pricedRequestCount > 0 ? cachedInputCostNanos : null,
    outputCostNanos: pricedRequestCount > 0 ? outputCostNanos : null,
    pricedRequestCount,
    requestCount,
    uncachedInputPricePerMillionNanos: pricedRequestCount > 0
      ? aggregate.uncachedInputPricePerMillionNanos
      : null,
    cachedInputPricePerMillionNanos: pricedRequestCount > 0
      ? aggregate.cachedInputPricePerMillionNanos
      : null,
    outputPricePerMillionNanos: pricedRequestCount > 0
      ? aggregate.outputPricePerMillionNanos
      : null,
    hasMixedPrices: pricedRequestCount > 0 && aggregate.hasMixedPrices,
    pricingBuckets: pricedRequestCount > 0
      ? (aggregate.pricingBuckets ?? [])
      : [],
  };
}

function combineReferenceCosts(
  left: ReferenceCostSummary | undefined,
  right: ReferenceCostSummary,
): ReferenceCostSummary {
  if (!left) return right;
  if (left.pricedRequestCount === 0) {
    return {
      ...right,
      requestCount: left.requestCount + right.requestCount,
    };
  }
  if (right.pricedRequestCount === 0) {
    return {
      ...left,
      requestCount: left.requestCount + right.requestCount,
    };
  }
  const sameCurrency = left.currency !== null && left.currency === right.currency;
  const sameRates = !left.hasMixedPrices
    && !right.hasMixedPrices
    && left.uncachedInputPricePerMillionNanos
      === right.uncachedInputPricePerMillionNanos
    && left.cachedInputPricePerMillionNanos
      === right.cachedInputPricePerMillionNanos
    && left.outputPricePerMillionNanos === right.outputPricePerMillionNanos;
  return {
    currency: sameCurrency ? left.currency : null,
    totalCostNanos: sameCurrency
      && left.totalCostNanos !== null
      && right.totalCostNanos !== null
      ? left.totalCostNanos + right.totalCostNanos
      : null,
    inputTokens: (left.inputTokens ?? 0) + (right.inputTokens ?? 0),
    ...(left.cachedInputTokens !== undefined
      && right.cachedInputTokens !== undefined
      ? {
          cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
        }
      : {}),
    outputTokens: (left.outputTokens ?? 0) + (right.outputTokens ?? 0),
    inputCostNanos: sameCurrency
      && left.inputCostNanos !== null
      && right.inputCostNanos !== null
      ? left.inputCostNanos + right.inputCostNanos
      : null,
    cachedInputCostNanos: sameCurrency
      && left.cachedInputCostNanos !== null
      && right.cachedInputCostNanos !== null
      ? left.cachedInputCostNanos + right.cachedInputCostNanos
      : null,
    outputCostNanos: sameCurrency
      && left.outputCostNanos !== null
      && right.outputCostNanos !== null
      ? left.outputCostNanos + right.outputCostNanos
      : null,
    pricedRequestCount: left.pricedRequestCount + right.pricedRequestCount,
    requestCount: left.requestCount + right.requestCount,
    uncachedInputPricePerMillionNanos: sameRates
      ? left.uncachedInputPricePerMillionNanos
      : null,
    cachedInputPricePerMillionNanos: sameRates
      ? left.cachedInputPricePerMillionNanos
      : null,
    outputPricePerMillionNanos: sameRates
      ? left.outputPricePerMillionNanos
      : null,
    hasMixedPrices: !sameRates || !sameCurrency,
    pricingBuckets: mergePricingBuckets(
      left.pricingBuckets,
      right.pricingBuckets,
    ),
  };
}

function mergePricingBuckets(
  left: ReadonlyArray<"peak" | "off-peak"> | undefined,
  right: ReadonlyArray<"peak" | "off-peak"> | undefined,
): Array<"peak" | "off-peak"> {
  const buckets = new Set<"peak" | "off-peak">([
    ...(left ?? []),
    ...(right ?? []),
  ]);
  return pricingBucketOrder.filter((bucket) => buckets.has(bucket));
}
