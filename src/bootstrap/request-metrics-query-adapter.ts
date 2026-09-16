import type {
  RequestMetricsAggregateReport,
  RequestMetricsAggregateView,
  RequestMetricsErrorReport,
  RequestMetricsQueryPort,
  RequestMetricsTimeRange,
  ThreadRequestMetricsSummary,
  WeeklyQuotaMetricsObservation,
} from "../application/index.js";
import type {
  ModelRequestMetricsQuotaAccountStore,
  ModelRequestMetricsRequestQueryStore,
  ModelRequestMetricsThreadQueryStore,
} from "../observability/index.js";
import {
  queryRequestMetricsAggregate,
  queryRequestMetricsErrors,
  requestMetricsAggregationDimension,
  resolveRequestMetricsRange as resolveSharedRequestMetricsRange,
} from "../observability/index.js";
import type { SessionRouter } from "../session-routing/index.js";

type RequestMetricsQueryStore =
  & Pick<ModelRequestMetricsRequestQueryStore, "aggregate" | "errors">
  & Pick<
    ModelRequestMetricsThreadQueryStore,
    "threadSummary" | "threadTurnCount"
  >
  & Pick<ModelRequestMetricsQuotaAccountStore, "weeklyQuotaEstimate">;

export class RequestMetricsQueryAdapter implements RequestMetricsQueryPort {
  constructor(
    private readonly store: RequestMetricsQueryStore,
    private readonly router: Pick<SessionRouter, "modelSettingsForThread">,
    private readonly now: () => number = Date.now,
  ) {}

  forThread(threadId: string): ThreadRequestMetricsSummary {
    const summary = this.store.threadSummary(threadId);
    return {
      threadId: summary.threadId,
      modelProvider: this.router.modelSettingsForThread(threadId)
        ?.modelProvider ?? "openai",
      latestTurn: summary.latestTurn,
      threadAggregate: summary.threadAggregate,
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
    const report = queryRequestMetricsAggregate(
      this.store,
      requestMetricsAggregationDimension(view),
      { name: range, ...resolvedRange },
    );
    return {
      view,
      range,
      startAtMs: report.startAtMs,
      endAtMs: report.endAtMs,
      aggregate: report.aggregate,
      groups: report.groups.map((group) => ({
        provider: group.provider,
        model: group.model,
        aggregate: group.aggregate,
      })),
      totalGroupCount: report.totalGroupCount,
    };
  }

  errors(range: RequestMetricsTimeRange): RequestMetricsErrorReport {
    const resolvedRange = resolveRequestMetricsRange(range, this.now());
    const report = queryRequestMetricsErrors(
      this.store,
      { name: range, ...resolvedRange },
    );
    return {
      view: "errors",
      range,
      startAtMs: report.startAtMs,
      endAtMs: report.endAtMs,
      requestCount: report.requestCount,
      unsuccessfulRequestCount: report.unsuccessfulRequestCount,
      groups: report.groups.map((group) => ({
        provider: group.provider,
        model: group.model,
        status: group.status,
        httpStatus: group.httpStatus,
        errorType: group.errorType,
        lastErrorMessage: group.lastErrorMessage,
        requestCount: group.requestCount,
        lastOccurredAtMs: group.lastOccurredAtMs,
      })),
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
  const resolved = resolveSharedRequestMetricsRange(range, nowMs);
  return { startAtMs: resolved.startAtMs, endAtMs: resolved.endAtMs };
}
