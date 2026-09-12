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
