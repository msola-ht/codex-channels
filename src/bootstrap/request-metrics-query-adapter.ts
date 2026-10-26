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
  AsyncGatewayMetricsStore,
} from "../observability/index.js";
import {
  requestMetricsAggregationDimension,
  resolveRequestMetricsRange as resolveSharedRequestMetricsRange,
} from "../observability/index.js";
import type { SessionRouter } from "../session-routing/index.js";

type RequestMetricsQueryStore = Pick<AsyncGatewayMetricsStore,
  "aggregate" | "errors" | "threadSummary" | "threadTurnCount" | "weeklyQuotaEstimate">;

export class RequestMetricsQueryAdapter implements RequestMetricsQueryPort {
  constructor(
    private readonly store: RequestMetricsQueryStore,
    private readonly router: Pick<SessionRouter, "modelSettingsForThread">,
    private readonly now: () => number = Date.now,
  ) {}

  async forThread(threadId: string): Promise<ThreadRequestMetricsSummary> {
    const summary = await this.store.threadSummary(threadId);
    return {
      threadId: summary.threadId,
      modelProvider: this.router.modelSettingsForThread(threadId)
        ?.modelProvider ?? "openai",
      latestTurn: summary.latestTurn,
      threadAggregate: summary.threadAggregate,
      ...(summary.sessionTiming === undefined ? {} : { sessionTiming: summary.sessionTiming }),
      ...(summary.sessionDurationMs === undefined ? {} : { sessionDurationMs: summary.sessionDurationMs }),
    };
  }

  threadTurnCount(threadId: string): Promise<number | null> {
    return this.store.threadTurnCount(threadId);
  }

  async aggregate(
    view: RequestMetricsAggregateView,
    range: RequestMetricsTimeRange,
  ): Promise<RequestMetricsAggregateReport> {
    const resolvedRange = resolveRequestMetricsRange(range, this.now());
    const report = await this.store.aggregate({ dimension: requestMetricsAggregationDimension(view), ...resolvedRange });
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

  async errors(range: RequestMetricsTimeRange): Promise<RequestMetricsErrorReport> {
    const resolvedRange = resolveRequestMetricsRange(range, this.now());
    const report = await this.store.errors(resolvedRange);
    return {
      view: "errors",
      range,
      startAtMs: report.startAtMs,
      endAtMs: report.endAtMs,
      requestCount: report.requestCount,
      requestOutcomes: report.requestOutcomes,
      unsuccessfulRequestCount: report.unsuccessfulRequestCount,
      groups: report.groups.map((group) => ({
        source: group.source,
        errorCode: group.errorCode,
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
  ): Promise<WeeklyQuotaMetricsObservation | null> {
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
