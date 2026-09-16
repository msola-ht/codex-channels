import type {
  ModelRequestMetricsAggregationDimension,
  ModelRequestMetricsPageQuery,
  ModelRequestMetricsQuotaAccountStore,
  ModelRequestMetricsRequestQueryStore,
  ModelRequestMetricsThreadQueryStore,
} from "./request-metrics.js";

export const requestMetricsRangeNames = [
  "24h",
  "7d",
  "30d",
  "90d",
  "all",
] as const;

export type RequestMetricsRangeName = typeof requestMetricsRangeNames[number];

export interface ResolvedRequestMetricsRange {
  name: string;
  startAtMs: number;
  endAtMs: number;
}

export type RequestMetricsQueryStore =
  & Pick<
    ModelRequestMetricsRequestQueryStore,
    "aggregate" | "daily" | "errors" | "page"
  >
  & Pick<
    ModelRequestMetricsThreadQueryStore,
    | "subagentThread"
    | "threadList"
    | "threadSummary"
    | "threadTurnCount"
    | "threadTurnSummaries"
  >
  & Pick<
    ModelRequestMetricsQuotaAccountStore,
    "latestWeeklyQuota" | "quotaHistory" | "weeklyQuotaEstimate"
  >;

export function isRequestMetricsRangeName(
  value: string,
): value is RequestMetricsRangeName {
  return (requestMetricsRangeNames as readonly string[]).includes(value);
}

export function resolveRequestMetricsRange(
  name: string,
  nowMs: number,
): ResolvedRequestMetricsRange {
  if (!isRequestMetricsRangeName(name)) {
    throw new Error(`不支持的指标时间范围：${name}`);
  }
  if (name === "all") return { name, startAtMs: 0, endAtMs: nowMs };
  const durations: Record<Exclude<RequestMetricsRangeName, "all">, number> = {
    "24h": 24 * 60 * 60 * 1_000,
    "7d": 7 * 24 * 60 * 60 * 1_000,
    "30d": 30 * 24 * 60 * 60 * 1_000,
    "90d": 90 * 24 * 60 * 60 * 1_000,
  };
  const duration = durations[name];
  return {
    name,
    startAtMs: Math.max(0, nowMs - duration),
    endAtMs: nowMs,
  };
}

export function requestMetricsAggregationDimension(
  view: "global" | "providers" | "models",
): ModelRequestMetricsAggregationDimension {
  if (view === "providers") return "provider";
  if (view === "models") return "model";
  return "global";
}

export function queryRequestMetricsAggregate(
  store: Pick<ModelRequestMetricsRequestQueryStore, "aggregate">,
  dimension: ModelRequestMetricsAggregationDimension,
  range: ResolvedRequestMetricsRange,
) {
  return store.aggregate({
    dimension,
    startAtMs: range.startAtMs,
    endAtMs: range.endAtMs,
  });
}

export function queryRequestMetricsErrors(
  store: Pick<ModelRequestMetricsRequestQueryStore, "errors">,
  range: ResolvedRequestMetricsRange,
) {
  return store.errors({
    startAtMs: range.startAtMs,
    endAtMs: range.endAtMs,
  });
}

export class RequestMetricsQueryService {
  constructor(private readonly store: RequestMetricsQueryStore) {}

  aggregate(
    dimension: ModelRequestMetricsAggregationDimension,
    range: ResolvedRequestMetricsRange,
  ) {
    return queryRequestMetricsAggregate(this.store, dimension, range);
  }

  overview(range: ResolvedRequestMetricsRange) {
    const global = this.aggregate("global", range);
    const providers = this.aggregate("provider", range);
    return {
      global: global.aggregate,
      providers: providers.groups,
      errors: this.errors(range),
    };
  }

  errors(range: ResolvedRequestMetricsRange) {
    return queryRequestMetricsErrors(this.store, range);
  }

  daily(range: ResolvedRequestMetricsRange) {
    return this.store.daily({
      startAtMs: range.startAtMs,
      endAtMs: range.endAtMs,
    });
  }

  page(
    range: ResolvedRequestMetricsRange,
    query: Omit<ModelRequestMetricsPageQuery, "startAtMs" | "endAtMs">,
  ) {
    return this.store.page({
      ...query,
      startAtMs: range.startAtMs,
      endAtMs: range.endAtMs,
    });
  }

  threadSummary(threadId: string) {
    return this.store.threadSummary(threadId);
  }

  threadTurnCount(threadId: string) {
    return this.store.threadTurnCount(threadId);
  }

  threadTurnSummaries(threadId: string) {
    return this.store.threadTurnSummaries(threadId);
  }

  threadList() {
    return this.store.threadList();
  }

  subagentThread(threadId: string) {
    return this.store.subagentThread(threadId);
  }

  latestWeeklyQuota(provider: string, nowMs: number) {
    return this.store.latestWeeklyQuota(provider, nowMs);
  }

  weeklyQuotaEstimate(
    provider: string,
    limitId: string,
    resetsAt: number,
    nowMs: number,
  ) {
    return this.store.weeklyQuotaEstimate({
      provider,
      limitId,
      resetsAt,
      nowMs,
    });
  }

  quotaHistory(range: ResolvedRequestMetricsRange) {
    return this.store.quotaHistory({
      startAtMs: range.startAtMs,
      endAtMs: range.endAtMs,
    });
  }
}
