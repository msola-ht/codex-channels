import type {
  ModelRequestMetricsAggregationDimension,
  ModelRequestMetricsPageQuery,
  ModelRequestMetricsFilters,
  ModelRequestMetricsThreadQuery,
  ModelRequestMetricsQuotaAccountStore,
  ModelRequestMetricsRequestQueryStore,
  ModelRequestMetricsThreadQueryStore,
} from "./request-metrics.js";

export const requestMetricsRangeNames = [
  "today",
  "yesterday",
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
  if (name === "today" || name === "yesterday") {
    const midnight = new Date(nowMs);
    midnight.setHours(0, 0, 0, 0);
    const endAtMs = name === "today" ? nowMs : midnight.getTime();
    if (name === "yesterday") midnight.setDate(midnight.getDate() - 1);
    return { name, startAtMs: midnight.getTime(), endAtMs };
  }
  const durations: Record<Exclude<RequestMetricsRangeName, "all" | "today" | "yesterday">, number> = {
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

export function resolveRequestMetricsDates(from: string, to: string, nowMs: number): ResolvedRequestMetricsRange {
  const startAtMs = parseRequestMetricsDate(from);
  const end = new Date(parseRequestMetricsDate(to));
  end.setDate(end.getDate() + 1);
  const endAtMs = Math.min(end.getTime(), nowMs);
  if (startAtMs < 0 || startAtMs >= endAtMs) throw new Error("自定义日期范围无效");
  return { name: `${from}..${to}`, startAtMs, endAtMs };
}

export function parseRequestMetricsDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new Error("日期必须使用 YYYY-MM-DD 格式");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error("日期无效");
  }
  return date.getTime();
}

export function parseRequestMetricsFilters(input: Record<string, unknown>): ModelRequestMetricsFilters {
  const filters: ModelRequestMetricsFilters = {};
  for (const key of ["threadId", "turnId", "model", "filter"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
      throw new Error(`${key} 筛选值必须为 1–128 个字符`);
    }
    filters[key] = value.trim();
  }
  if (input.provider !== undefined) {
    const providers = Array.isArray(input.provider) ? input.provider : [input.provider];
    if (providers.length === 0 || providers.some((value) => typeof value !== "string" || !value.trim() || value.length > 128)) {
      throw new Error("provider 筛选值必须为 1–128 个字符");
    }
    const values = [...new Set(providers.map((value: string) => value.trim()))];
    filters.provider = values.length === 1 ? values[0]! : values;
  }
  if (filters.turnId !== undefined && filters.threadId === undefined) throw new Error("查询 Turn 必须同时指定 Thread ID");
  if (input.operation !== undefined) {
    if (input.operation !== "response" && input.operation !== "compact") throw new Error("operation 只支持 response、compact");
    filters.operation = input.operation;
  }
  if (input.status !== undefined) {
    if (input.status !== "completed" && input.status !== "failed" && input.status !== "incomplete" && input.status !== "unknown") throw new Error("status 不支持该请求状态");
    filters.status = input.status;
  }
  return filters;
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
    filters: ModelRequestMetricsFilters = {},
  ) {
    return this.store.aggregate({ ...filters, dimension, startAtMs: range.startAtMs, endAtMs: range.endAtMs });
  }

  overview(range: ResolvedRequestMetricsRange) {
    const global = this.aggregate("global", range);
    const providers = this.aggregate("provider", range);
    const threads = this.threadList(range, { limit: 1 });
    return {
      global: global.aggregate,
      threadCount: threads.matchedTotal,
      turnCount: threads.turnCount,
      providers: providers.groups.map((group) => {
        // Provider 维度直接按非空 provider 列分组；仅 global 维度会返回 null。
        const scopedThreads = this.threadList(range, { provider: group.provider!, limit: 1 });
        return { ...group, threadCount: scopedThreads.matchedTotal, turnCount: scopedThreads.turnCount };
      }),
      errors: this.errors(range),
    };
  }

  errors(range: ResolvedRequestMetricsRange, filters: ModelRequestMetricsFilters = {}) {
    return this.store.errors({ ...filters, startAtMs: range.startAtMs, endAtMs: range.endAtMs });
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

  threadTurnSummaries(threadId: string, range: ResolvedRequestMetricsRange, query: Omit<ModelRequestMetricsThreadQuery, "startAtMs" | "endAtMs">) {
    return this.store.threadTurnSummaries(threadId, { ...query, startAtMs: range.startAtMs, endAtMs: range.endAtMs });
  }

  threadList(range: ResolvedRequestMetricsRange, query: Omit<ModelRequestMetricsThreadQuery, "startAtMs" | "endAtMs">) {
    return this.store.threadList({ ...query, startAtMs: range.startAtMs, endAtMs: range.endAtMs });
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
