import type { ReferenceCostSummary } from "../conversation-core/index.js";
import type { StoredThreadRequestMetricsSummary } from "../observability/index.js";

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

function toReferenceCost(value: {
  requestCount: number;
  inputTokens: number;
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
}): ReferenceCostSummary {
  return {
    currency: value.pricingCurrency,
    totalCostNanos: value.totalCostNanos,
    inputTokens: value.inputTokens,
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
    return {
      ...aggregate,
      requestCount,
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
  };
}
