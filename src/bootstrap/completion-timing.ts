import type { TurnOutputTiming } from "../conversation-core/index.js";
import type { StoredTurnRequestMetricsSummary } from "../observability/index.js";

export function mergeCompletionTiming(
  latestTurn: StoredTurnRequestMetricsSummary | null,
  turnId: string,
  current: TurnOutputTiming | undefined,
): TurnOutputTiming | undefined {
  if (latestTurn?.turnId !== turnId) return current;
  const timing: TurnOutputTiming = {
    ...current,
    modelRequestCount: latestTurn.requestCount,
    requestInputTokens: latestTurn.inputTokens,
    requestOutputTokens: latestTurn.outputTokens,
  };
  reconcileModelRequestStatuses(timing, latestTurn);
  assignOptionalMetric(timing, "responseUsage", latestTurn.responseUsage ?? null);
  assignOptionalMetric(timing, "upstreamTtftMs", latestTurn.upstreamTtftMs ?? null);
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
  assignOptionalMetric(timing, "compact", latestTurn.compact);
  return timing;
}

function reconcileModelRequestStatuses(
  timing: TurnOutputTiming,
  latestTurn: StoredTurnRequestMetricsSummary,
): void {
  const { completed, interrupted, failed, incomplete } = latestTurn.requestOutcomes;
  timing.completedModelRequestCount = completed;
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
