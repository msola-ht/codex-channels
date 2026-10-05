import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import { toStoredMetric, type MetricRow } from "./sqlite-request-metrics-row-codec.js";
import type {
  WeeklyQuotaEstimateQuery, StoredWeeklyQuotaEstimate, StoredWeeklyQuotaWindow,
  QuotaHistoryQuery, StoredQuotaPeriod,
} from "./request-metrics.js";

interface QuotaQueryReader {
  prepare: DatabaseSync["prepare"];
  iterateRows(sql: string, ...parameters: SQLInputValue[]): Iterable<Record<string, SQLOutputValue>>;
}

const weeklyWindowMs = 7 * 24 * 60 * 60 * 1_000;
// 上游额度接口的 resetsAt 可能在相邻快照间有数秒抖动；仅在很小范围内归并，
// 避免把真实的不定期重置误合并。
const quotaResetJitterSeconds = 5 * 60;

/** Uses the Store's connection and tracked iterators; owns no transaction or connection. */
export class SqliteQuotaQueries {
  constructor(private readonly reader: QuotaQueryReader) {}

  weeklyQuotaEstimate(
    query: WeeklyQuotaEstimateQuery,
  ): StoredWeeklyQuotaEstimate | null {
    validateWeeklyQuotaEstimateQuery(query);
    const startAtMs = query.resetsAt * 1_000 - weeklyWindowMs;
    const rows = this.reader.iterateRows(`
      SELECT status, input_tokens, output_tokens, recorded_at_ms, quota_observed_at_ms,
        weekly_quota_limit_id, weekly_resets_at, weekly_used_percent_millionths
      FROM model_request_metrics
      WHERE provider = ?
        AND recorded_at_ms >= ?
        AND recorded_at_ms <= ?
      ORDER BY COALESCE(quota_observed_at_ms, recorded_at_ms) ASC, id ASC
    `, query.provider, startAtMs, query.nowMs) as unknown as Iterable<WeeklyQuotaRow>;
    return estimateWeeklyQuotaRows(rows, query);
  }

  latestWeeklyQuota(
    provider: string,
    nowMs: number = Date.now(),
  ): StoredWeeklyQuotaWindow | null {
    if (
      provider.length === 0
      || provider.length > 128
      || !Number.isSafeInteger(nowMs)
      || nowMs < 0
    ) throw new Error("最新周额度查询无效");
    const row = this.reader.prepare(`
      SELECT weekly_quota_limit_id, weekly_used_percent_millionths,
        weekly_resets_at, weekly_quota_plan_type,
        COALESCE(quota_observed_at_ms, recorded_at_ms) AS observed_at_ms
      FROM model_request_metrics
      WHERE provider = ?
        AND weekly_quota_limit_id IS NOT NULL
        AND weekly_resets_at * 1000 > ?
        AND recorded_at_ms <= ?
      ORDER BY COALESCE(quota_observed_at_ms, recorded_at_ms) DESC, id DESC
      LIMIT 1
    `).get(provider, nowMs, nowMs) as {
      weekly_quota_limit_id: string;
      weekly_used_percent_millionths: number;
      weekly_resets_at: number;
      weekly_quota_plan_type: string | null;
      observed_at_ms: number;
    } | undefined;
    return row
      ? {
          limitId: row.weekly_quota_limit_id,
          usedPercentMillionths: row.weekly_used_percent_millionths,
          resetsAt: row.weekly_resets_at,
          observedAtMs: row.observed_at_ms,
          planType: row.weekly_quota_plan_type,
        }
      : null;
  }

  quotaHistory(query: QuotaHistoryQuery): StoredQuotaPeriod[] {
    if (!Number.isSafeInteger(query.startAtMs) || !Number.isSafeInteger(query.endAtMs)
      || query.startAtMs < 0 || query.startAtMs >= query.endAtMs) {
      throw new Error("额度历史查询时间范围无效");
    }
    const rows = this.reader.iterateRows(`
      SELECT * FROM model_request_metrics
      WHERE recorded_at_ms >= ? AND recorded_at_ms < ?
      ORDER BY COALESCE(quota_observed_at_ms, recorded_at_ms) ASC, id ASC
    `, query.startAtMs, query.endAtMs) as unknown as Iterable<MetricRow>;
    const groups = new Map<string, StoredQuotaPeriod>();
    for (const row of rows) {
      const metric = toStoredMetric(row);
      const observedAtMs = metric.quotaObservedAtMs ?? metric.recordedAtMs;
      const snapshots: Array<{
        windowId: string;
        resetsAt: number | null;
        usedPercentMillionths: number | null;
        planType: string | null;
      }> = [];
      if (metric.weeklyQuota) snapshots.push({
        windowId: metric.weeklyQuota.limitId,
        resetsAt: metric.weeklyQuota.resetsAt,
        usedPercentMillionths: metric.weeklyQuota.usedPercentMillionths,
        planType: metric.weeklyQuota.planType,
      });
      for (const window of metric.quotaWindows ?? []) snapshots.push({
        windowId: window.windowId,
        resetsAt: window.resetsAt,
        usedPercentMillionths: window.usedPercentMillionths ?? null,
        planType: null,
      });
      for (const snapshot of snapshots) {
        if (snapshot.resetsAt === null) continue;
        const exactKey = `${metric.provider}\u0000${snapshot.windowId}\u0000${snapshot.resetsAt}`;
        let key = exactKey;
        let existing = groups.get(key);
        if (!existing) {
          for (const [candidateKey, candidate] of groups) {
            if (candidate.provider === metric.provider
              && candidate.windowId === snapshot.windowId
              && Math.abs(candidate.resetsAt - snapshot.resetsAt) <= quotaResetJitterSeconds) {
              key = candidateKey;
              existing = candidate;
              break;
            }
          }
        }
        const successful = metric.status === "completed" ? 1 : 0;
        const inputTokens = metric.inputTokens ?? 0;
        const outputTokens = metric.outputTokens ?? 0;
        const totalTokens = metric.totalTokens ?? inputTokens + outputTokens;
        if (!existing) {
          groups.set(key, {
            provider: metric.provider,
            windowId: snapshot.windowId,
            resetsAt: snapshot.resetsAt,
            periodStartAtMs: quotaPeriodStartAtMs(snapshot.windowId, snapshot.resetsAt),
            periodEndAtMs: snapshot.resetsAt * 1_000,
            firstObservedAtMs: observedAtMs,
            lastObservedAtMs: observedAtMs,
            snapshotCount: 1,
            requestCount: 1,
            unsuccessfulRequestCount: 1 - successful,
            inputTokens,
            outputTokens,
            totalTokens,
            latestUsedPercentMillionths: snapshot.usedPercentMillionths,
            planType: snapshot.planType,
          });
        } else {
          existing.lastObservedAtMs = observedAtMs;
          existing.snapshotCount += 1;
          existing.requestCount += 1;
          existing.unsuccessfulRequestCount += 1 - successful;
          existing.inputTokens += inputTokens;
          existing.outputTokens += outputTokens;
          existing.totalTokens += totalTokens;
          if (snapshot.usedPercentMillionths !== null) {
            existing.latestUsedPercentMillionths = snapshot.usedPercentMillionths;
          }
          if (snapshot.planType !== null) existing.planType = snapshot.planType;
        }
      }
    }
    const periods = [...groups.values()];
    applyObservedQuotaResetBoundaries(periods);
    return periods.sort((a, b) => b.lastObservedAtMs - a.lastObservedAtMs);
  }

}

function applyObservedQuotaResetBoundaries(periods: StoredQuotaPeriod[]): void {
  const groups = new Map<string, StoredQuotaPeriod[]>();
  for (const period of periods) {
    if (period.periodStartAtMs === null) continue;
    const key = `${period.provider}\u0000${period.windowId}`;
    const group = groups.get(key) ?? [];
    group.push(period);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.periodStartAtMs! - right.periodStartAtMs!);
    for (let index = 0; index < group.length - 1; index += 1) {
      const period = group[index]!;
      const nextPeriod = group[index + 1]!;
      const nominalDurationMs = period.periodEndAtMs - period.periodStartAtMs!;
      const resetOffsetMs = Math.abs(nextPeriod.periodStartAtMs! - period.periodEndAtMs);
      if (nextPeriod.periodStartAtMs! > period.periodStartAtMs!
        && resetOffsetMs < nominalDurationMs) {
        period.periodEndAtMs = nextPeriod.periodStartAtMs!;
      }
    }
  }
}

function quotaPeriodStartAtMs(windowId: string, resetsAt: number): number | null {
  const endAtMs = resetsAt * 1_000;
  if (windowId === "codex" || windowId === "weekly") return endAtMs - weeklyWindowMs;
  if (windowId === "rolling") return endAtMs - 5 * 60 * 60 * 1_000;
  if (windowId !== "monthly") return null;
  const date = new Date(endAtMs);
  const previousMonth = date.getUTCMonth() - 1;
  const year = date.getUTCFullYear();
  const lastDay = new Date(Date.UTC(year, previousMonth + 1, 0)).getUTCDate();
  return Date.UTC(year, previousMonth, Math.min(date.getUTCDate(), lastDay), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds());
}

function validateWeeklyQuotaEstimateQuery(query: WeeklyQuotaEstimateQuery): void {
  if (
    query.provider.length === 0
    || query.provider.length > 128
    || query.limitId !== "codex"
    || !Number.isSafeInteger(query.resetsAt)
    || query.resetsAt < 0
    || !Number.isSafeInteger(query.nowMs)
    || query.nowMs < 0
  ) throw new Error("周额度估算查询无效");
}

type WeeklyQuotaRow = Pick<MetricRow,
  "status" | "input_tokens" | "output_tokens" | "recorded_at_ms" | "quota_observed_at_ms"
  | "weekly_quota_limit_id" | "weekly_resets_at" | "weekly_used_percent_millionths">;

function estimateWeeklyQuotaRows(
  rows: Iterable<WeeklyQuotaRow>,
  query: WeeklyQuotaEstimateQuery,
): StoredWeeklyQuotaEstimate | null {
  let baseline: number | null = null;
  let highestUsedPercentMillionths: number | null = null;
  let firstObservedAtMs: number | null = null;
  let lastObservedAtMs: number | null = null;
  let latestUsedPercentMillionths: number | null = null;
  let pending = emptyWeeklyInterval();
  let observedDeltaPercentMillionths = 0;
  let intervalCount = 0;
  const total = emptyWeeklyInterval();
  const periodTotal = emptyWeeklyInterval();

  for (const row of rows) {
    addWeeklyIntervalRow(periodTotal, row);
    const observedAtMs = row.quota_observed_at_ms ?? row.recorded_at_ms;
    if (observedAtMs < query.resetsAt * 1_000 - weeklyWindowMs) continue;
    const matching = row.weekly_quota_limit_id === query.limitId
      && row.weekly_resets_at !== null
      && Math.abs(row.weekly_resets_at - query.resetsAt) <= quotaResetJitterSeconds
      && row.weekly_used_percent_millionths !== null;
    const hasOtherSnapshot = row.weekly_quota_limit_id !== null && !matching;
    if (hasOtherSnapshot) {
      baseline = null;
      pending = emptyWeeklyInterval();
      continue;
    }
    if (baseline === null) {
      if (!matching) continue;
      const current = row.weekly_used_percent_millionths!;
      // 其他周期的快照会断开采样，但不能让目标周期已经计过的增长再次计数。
      baseline = Math.max(highestUsedPercentMillionths ?? current, current);
      highestUsedPercentMillionths = baseline;
      latestUsedPercentMillionths = current;
      firstObservedAtMs ??= observedAtMs;
      lastObservedAtMs = observedAtMs;
      continue;
    }

    addWeeklyIntervalRow(pending, row);
    if (!matching) continue;
    const current = row.weekly_used_percent_millionths!;
    latestUsedPercentMillionths = current;
    lastObservedAtMs = observedAtMs;
    const delta = current - baseline;
    // 请求完成/入库顺序不保证额度快照单调。同周期回退不证明发生重置；
    // 保持高水位，回退期间的请求只在超越该水位时进入闭合样本。
    if (delta <= 0) continue;
    observedDeltaPercentMillionths += delta;
    intervalCount += 1;
    mergeWeeklyInterval(total, pending);
    baseline = current;
    highestUsedPercentMillionths = current;
    pending = emptyWeeklyInterval();
  }

  // 未闭合的尾部请求只进入 periodTotal；没有对应的额度增长，不能用于每 1% 估算。

  if (
    observedDeltaPercentMillionths <= 0
    || firstObservedAtMs === null
    || lastObservedAtMs === null
    || latestUsedPercentMillionths === null
  ) return null;
  return {
    limitId: query.limitId,
    resetsAt: query.resetsAt,
    firstObservedAtMs,
    lastObservedAtMs,
    latestUsedPercentMillionths,
    observedDeltaPercentMillionths,
    intervalCount,
    requestCount: total.requestCount,
    unsuccessfulRequestCount: total.unsuccessfulRequestCount,
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    totalTokens: total.inputTokens + total.outputTokens,
    periodRequestCount: periodTotal.requestCount,
    periodInputTokens: periodTotal.inputTokens,
    periodOutputTokens: periodTotal.outputTokens,
    periodTotalTokens: periodTotal.inputTokens + periodTotal.outputTokens,
  };
}

interface WeeklyIntervalAccumulator {
  requestCount: number;
  unsuccessfulRequestCount: number;
  inputTokens: number;
  outputTokens: number;
}

function emptyWeeklyInterval(): WeeklyIntervalAccumulator {
  return {
    requestCount: 0,
    unsuccessfulRequestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function addWeeklyIntervalRow(target: WeeklyIntervalAccumulator, row: WeeklyQuotaRow): void {
  target.requestCount += 1;
  if (row.status !== "completed") target.unsuccessfulRequestCount += 1;
  target.inputTokens += row.input_tokens ?? 0;
  target.outputTokens += row.output_tokens ?? 0;
}

function mergeWeeklyInterval(
  target: WeeklyIntervalAccumulator,
  source: WeeklyIntervalAccumulator,
): void {
  target.requestCount += source.requestCount;
  target.unsuccessfulRequestCount += source.unsuccessfulRequestCount;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
}
