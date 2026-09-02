import type {
  RequestMetricsAggregateReport,
  RequestMetricsAggregateView,
  RequestMetricsErrorReport,
  RequestMetricsQueryPort,
  RequestMetricsTimeRange,
  ThreadRequestMetricsSummary,
  WeeklyQuotaMetricsObservation,
} from "../application/index.js";
import type { SqliteModelRequestMetricsStore } from "../observability/index.js";
import type { SessionRouter } from "../session-routing/index.js";

export class RequestMetricsQueryAdapter implements RequestMetricsQueryPort {
  private readonly providerNames: ReadonlyMap<string, string>;

  constructor(
    private readonly store: SqliteModelRequestMetricsStore,
    private readonly router: Pick<SessionRouter, "modelSettingsForThread">,
    providers: ReadonlyArray<{ id: string; name: string }>,
    private readonly now: () => number = Date.now,
  ) {
    this.providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
  }

  forThread(threadId: string): ThreadRequestMetricsSummary {
    const summary = this.store.threadSummary(threadId);
    const direct = summary.latestDirectApi;
    const providerName = direct === null
      ? undefined
      : this.providerNames.get(direct.provider);
    return {
      threadId: summary.threadId,
      modelProvider: this.router.modelSettingsForThread(threadId)
        ?.modelProvider ?? "openai",
      latestTurn: summary.latestTurn,
      threadAggregate: summary.threadAggregate,
      latestDirectApi: direct === null
        ? null
        : {
            provider: direct.provider,
            ...(providerName === undefined ? {} : { providerName }),
            model: direct.model,
            status: direct.status,
            httpStatus: direct.httpStatus,
            requestDurationMs: direct.requestDurationMs,
            inputTokens: direct.inputTokens,
            cachedInputTokens: direct.cachedInputTokens,
            outputTokens: direct.outputTokens,
            reasoningOutputTokens: direct.reasoningOutputTokens,
            totalTokens: direct.totalTokens,
            pricingCurrency: direct.pricing?.currency ?? null,
            totalCostNanos: direct.totalCostNanos,
            inputCostNanos: direct.uncachedInputCostNanos,
            cachedInputCostNanos: direct.cachedInputCostNanos,
            outputCostNanos: direct.outputCostNanos,
            uncachedInputPricePerMillionNanos:
              direct.pricing?.uncachedInputPricePerMillionNanos ?? null,
            cachedInputPricePerMillionNanos:
              direct.pricing?.cachedInputPricePerMillionNanos ?? null,
            outputPricePerMillionNanos:
              direct.pricing?.outputPricePerMillionNanos ?? null,
            ...(direct.pricing?.bucket === undefined || direct.pricing.bucket === null
              ? {}
              : { pricingBucket: direct.pricing.bucket }),
          },
    };
  }

  threadTurnCount(threadId: string): number | null {
    return this.store.threadTurnCount(threadId);
  }

  aggregate(
    view: RequestMetricsAggregateView,
    range: RequestMetricsTimeRange,
  ): RequestMetricsAggregateReport {
    const resolvedRange = resolveRequestMetricsRange(range, this.now());
    const report = this.store.aggregate({
      dimension: view === "providers"
        ? "provider"
        : view === "models"
          ? "model"
          : "global",
      startAtMs: resolvedRange.startAtMs,
      endAtMs: resolvedRange.endAtMs,
    });
    return {
      view,
      range,
      startAtMs: report.startAtMs,
      endAtMs: report.endAtMs,
      aggregate: report.aggregate,
      groups: report.groups.map((group) => {
        const providerName = group.provider === null
          ? undefined
          : this.providerNames.get(group.provider);
        return {
          provider: group.provider,
          ...(providerName === undefined ? {} : { providerName }),
          model: group.model,
          aggregate: group.aggregate,
        };
      }),
      totalGroupCount: report.totalGroupCount,
    };
  }

  errors(range: RequestMetricsTimeRange): RequestMetricsErrorReport {
    const resolvedRange = resolveRequestMetricsRange(range, this.now());
    const report = this.store.errors({
      startAtMs: resolvedRange.startAtMs,
      endAtMs: resolvedRange.endAtMs,
    });
    return {
      view: "errors",
      range,
      startAtMs: report.startAtMs,
      endAtMs: report.endAtMs,
      requestCount: report.requestCount,
      unsuccessfulRequestCount: report.unsuccessfulRequestCount,
      groups: report.groups.map((group) => {
        const providerName = this.providerNames.get(group.provider);
        return {
          provider: group.provider,
          ...(providerName === undefined ? {} : { providerName }),
          model: group.model,
          status: group.status,
          httpStatus: group.httpStatus,
          errorType: group.errorType,
          lastErrorMessage: group.lastErrorMessage,
          requestCount: group.requestCount,
          lastOccurredAtMs: group.lastOccurredAtMs,
        };
      }),
      totalGroupCount: report.totalGroupCount,
    };
  }

  weeklyQuotaEstimate(
    provider: string,
    limitId: string,
    resetsAt: number,
    nowMs: number,
  ): WeeklyQuotaMetricsObservation | null {
    return this.store.weeklyQuotaEstimate({ provider, limitId, resetsAt, nowMs });
  }
}

export function resolveRequestMetricsRange(
  range: RequestMetricsTimeRange,
  nowMs: number,
): { startAtMs: number; endAtMs: number } {
  const durations: Partial<Record<RequestMetricsTimeRange, number>> = {
    "24h": 24 * 60 * 60 * 1_000,
    "7d": 7 * 24 * 60 * 60 * 1_000,
    "30d": 30 * 24 * 60 * 60 * 1_000,
    "90d": 90 * 24 * 60 * 60 * 1_000,
    "365d": 365 * 24 * 60 * 60 * 1_000,
  };
  const duration = durations[range];
  if (duration !== undefined) {
    return { startAtMs: Math.max(0, nowMs - duration), endAtMs: nowMs };
  }
  if (range === "all") return { startAtMs: 0, endAtMs: nowMs };
  const day = new Date(nowMs);
  day.setHours(0, 0, 0, 0);
  const today = day.getTime();
  if (range === "today") return { startAtMs: today, endAtMs: nowMs };
  if (range === "yesterday") {
    day.setDate(day.getDate() - 1);
    return { startAtMs: day.getTime(), endAtMs: today };
  }
  const month = new Date(day.getFullYear(), day.getMonth(), 1);
  if (range === "this-month") return { startAtMs: month.getTime(), endAtMs: nowMs };
  if (range === "last-month") {
    return {
      startAtMs: new Date(day.getFullYear(), day.getMonth() - 1, 1).getTime(),
      endAtMs: month.getTime(),
    };
  }
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  const week = day.getTime();
  if (range === "this-week") return { startAtMs: week, endAtMs: nowMs };
  day.setDate(day.getDate() - 7);
  return { startAtMs: day.getTime(), endAtMs: week };
}
