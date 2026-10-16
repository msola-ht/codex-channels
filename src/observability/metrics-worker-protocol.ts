import type {
  AutoApprovalReviewStore, ModelRequestMetricsQuotaAccountStore,
  ModelRequestMetricsRequestQueryStore, ModelRequestMetricsThreadQueryStore,
  ModelRequestMetricsWriteStore, TurnExecutionStore,
} from "./request-metrics.js";

export type MetricsWriteScopeQuery = { type: "task"; turnId: string } | { type: "session" } | { type: "sessionReview" };

/** Gateway's connection stays inside one Worker; CLI/WebUI retain their sync ports. */
export type GatewayMetricsStore =
  & Pick<ModelRequestMetricsWriteStore, "recordBatch" | "recordSubagentThread" | "recordSubagentTurn">
  & Pick<ModelRequestMetricsRequestQueryStore, "aggregate" | "errors">
  & Pick<ModelRequestMetricsThreadQueryStore, "threadSummary" | "threadTurnSummary" | "threadTurnTaskSummary" | "threadTurnCount">
  & Pick<ModelRequestMetricsQuotaAccountStore, "weeklyQuotaEstimate" | "latestAccountSnapshots" | "upsertAccountSnapshot">
  & TurnExecutionStore & AutoApprovalReviewStore & {
    observeTurnExecution(threadId: string, provider: string,
      observation: { type: "reverted" } | { type: "completed"; first: boolean; turn: import("./request-metrics.js").TurnExecutionMetric }): boolean;
    invalidateAllThreadExecutions(): void;
    providerQuotaTokens(ranges: readonly import("./provider-quota-tokens.js").ProviderQuotaTokenRange[], provider: string): Map<string, number>;
    completionExecutionTiming(threadId: string, turnId: string): {
      durationMs: number | null; sessionTiming: import("./request-metrics.js").SessionExecutionTiming;
    };
    subagentCompletionSummary(threadId: string, turnId?: string): {
      latestTurn: import("./request-metrics.js").StoredTurnRequestMetricsSummary | null;
      threadAggregate: import("./request-metrics.js").StoredThreadRequestMetricsAggregate | import("./request-metrics.js").StoredTurnRequestMetricsSummary | null;
    };
    metricsWriteScopes(threadId: string, scope: MetricsWriteScopeQuery): { threadId: string; turnId?: string }[];
  };

export const gatewayMetricsMethods = [
  "recordBatch", "recordSubagentThread", "recordSubagentTurn", "aggregate", "errors",
  "threadSummary", "threadTurnSummary", "threadTurnTaskSummary", "threadTurnCount",
  "weeklyQuotaEstimate", "latestAccountSnapshots", "upsertAccountSnapshot",
  "sessionExecutionTiming", "isExecutionHistoryComplete", "recordTurnExecution",
  "replaceThreadExecutions", "invalidateThreadExecutions", "turnExecutionDuration", "sessionExecutionDuration",
  "observeAutoApprovalTurn", "recordAutoApprovalReview", "invalidateAutoApprovalCoverage",
  "taskAutoApprovalReviewSummary", "sessionAutoApprovalReviewSummary",
  "observeTurnExecution", "invalidateAllThreadExecutions",
  "providerQuotaTokens",
  "completionExecutionTiming", "subagentCompletionSummary", "metricsWriteScopes",
] as const satisfies readonly (keyof GatewayMetricsStore)[];

export type MetricsMethod = typeof gatewayMetricsMethods[number];
export type MetricsArguments<K extends MetricsMethod> = Parameters<NonNullable<GatewayMetricsStore[K]>>;
export type MetricsResult<K extends MetricsMethod> = ReturnType<NonNullable<GatewayMetricsStore[K]>>;
export type AsyncGatewayMetricsStore = {
  [K in MetricsMethod]: (...args: MetricsArguments<K>) => Promise<MetricsResult<K>>;
};
export type AsyncTurnExecutionStore = Pick<AsyncGatewayMetricsStore, keyof TurnExecutionStore | "observeTurnExecution" | "invalidateAllThreadExecutions">;
export type AsyncAutoApprovalReviewStore = Pick<AsyncGatewayMetricsStore, keyof AutoApprovalReviewStore>;

export type MetricsWorkerRequest = {
  [K in MetricsMethod]: { type: "request"; id: number; method: K; args: MetricsArguments<K>; deadline: number };
}[MetricsMethod] | { type: "close" };

export type MetricsWorkerFailure = "locked" | "schema" | "capacity" | "expired" | "operation";
export type MetricsWorkerResponse =
  | { type: "ready" }
  | { type: "failed"; reason: MetricsWorkerFailure }
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; reason: MetricsWorkerFailure }
  | { type: "closed"; ok: boolean };
