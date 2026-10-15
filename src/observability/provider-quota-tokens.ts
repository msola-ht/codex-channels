import type { ModelRequestMetricsRequestQueryStore } from "./request-metrics.js";

export type ProviderQuotaTokenRange = readonly [windowId: string, resetsAt: number | null, startAtMs: number, endAtMs: number];

/** Stream once on the connection owner and return only the bounded window totals. */
export function sumProviderQuotaTokens(
  store: Pick<ModelRequestMetricsRequestQueryStore, "forEachProviderTokenMetric">,
  ranges: readonly ProviderQuotaTokenRange[],
  provider: string,
): Map<string, number> {
  if (!provider.trim() || provider.length > 128 || ranges.length > 3
    || ranges.some(([windowId, resetsAt, start, end]) => !["rolling", "weekly", "monthly"].includes(windowId)
      || (resetsAt !== null && (!Number.isFinite(resetsAt) || resetsAt < 0))
      || !Number.isFinite(start) || !Number.isFinite(end) || start >= end)) {
    throw new Error("本地额度用量查询参数无效");
  }
  const totals = new Map(ranges.map(([windowId]) => [windowId, 0]));
  if (ranges.length === 0) return totals;
  const startAtMs = Math.min(...ranges.map(([, , start]) => start));
  const endAtMs = Math.max(...ranges.map(([, , , end]) => end));
  store.forEachProviderTokenMetric({ provider, startAtMs, endAtMs }, record => {
    const tokens = record.totalTokens !== null && Number.isSafeInteger(record.totalTokens) && record.totalTokens >= 0
      ? record.totalTokens : record.inputTokens !== null && record.outputTokens !== null
        ? record.inputTokens + record.outputTokens : null;
    if (tokens === null) return;
    const requestAtMs = record.requestStartedAtMs ?? record.recordedAtMs;
    for (const [windowId, resetsAt, start, end] of ranges) {
      const snapshot = record.quotaWindows?.find(window => window.windowId === windowId);
      const inWindow = windowId !== "rolling" && snapshot?.resetsAt !== null && snapshot?.resetsAt !== undefined
        && resetsAt !== null && snapshot.resetsAt * 1_000 > requestAtMs
        ? snapshot.resetsAt === resetsAt : requestAtMs >= start && requestAtMs < end;
      if (inWindow) totals.set(windowId, (totals.get(windowId) ?? 0) + tokens);
    }
  });
  return totals;
}
