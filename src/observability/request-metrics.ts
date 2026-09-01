export type ModelRequestTransport = "http" | "websocket";
export type ModelResponseFormat = "sse" | "json" | "websocket" | "unknown";
export type ModelRequestOperation = "response" | "compact";
export type ModelRequestStatus = "completed" | "failed" | "incomplete" | "unknown";
export type ModelBillingMode = "api" | "subscription" | "unknown";
export type ModelPricingBucket = "peak" | "off-peak";

export interface ModelRequestPricingSnapshot {
  billingMode: ModelBillingMode;
  currency: string | null;
  source: string;
  effectiveAtMs: number;
  /** 请求开始时段对应的峰谷档位；无峰谷定价或全时段定价为 null，旧快照可为 undefined */
  bucket?: ModelPricingBucket | null;
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
}

export interface ModelPricingLookup {
  provider: string;
  model: string | null;
  serviceTier: string | null;
  inputTokens: number | null;
  atMs: number;
}

export interface ModelPricingResolver {
  resolve(lookup: ModelPricingLookup): ModelRequestPricingSnapshot | null;
}

export function calculateModelRequestCostNanos(
  usage: Pick<
    ModelRequestMetricSample,
    "inputTokens" | "cachedInputTokens" | "outputTokens"
  >,
  pricing: ModelRequestPricingSnapshot | null,
): number | null {
  return calculateModelRequestCostComponents(usage, pricing)?.totalCostNanos ?? null;
}

export function calculateModelRequestCostComponents(
  usage: Pick<
    ModelRequestMetricSample,
    "inputTokens" | "cachedInputTokens" | "outputTokens"
  >,
  pricing: ModelRequestPricingSnapshot | null,
): {
  uncachedInputCostNanos: number;
  cachedInputCostNanos: number;
  outputCostNanos: number;
  totalCostNanos: number;
} | null {
  if (!pricing || pricing.currency === null) return null;
  const uncachedInputTokens = usage.inputTokens !== null
    && usage.cachedInputTokens !== null
    && usage.inputTokens >= usage.cachedInputTokens
    ? usage.inputTokens - usage.cachedInputTokens
    : null;
  const uncachedInputCost = componentCost(
    uncachedInputTokens,
    pricing.uncachedInputPricePerMillionNanos,
  );
  const cachedInputCost = componentCost(
    usage.cachedInputTokens,
    pricing.cachedInputPricePerMillionNanos,
  );
  const outputCost = componentCost(
    usage.outputTokens,
    pricing.outputPricePerMillionNanos,
  );
  if (
    uncachedInputCost === null
    || cachedInputCost === null
    || outputCost === null
  ) {
    return null;
  }
  const total = uncachedInputCost + cachedInputCost + outputCost;
  if (!Number.isSafeInteger(total)) return null;
  return {
    uncachedInputCostNanos: uncachedInputCost,
    cachedInputCostNanos: cachedInputCost,
    outputCostNanos: outputCost,
    totalCostNanos: total,
  };
}

function componentCost(
  tokens: number | null,
  pricePerMillionNanos: number | null,
): number | null {
  if (tokens === 0) return 0;
  if (tokens === null || pricePerMillionNanos === null) return null;
  const cost = Math.round(tokens * pricePerMillionNanos / 1_000_000);
  return Number.isSafeInteger(cost) ? cost : null;
}

export interface ModelRequestMetricSample {
  provider: string;
  pricing: ModelRequestPricingSnapshot | null;
  transport: ModelRequestTransport;
  responseFormat: ModelResponseFormat;
  operation: ModelRequestOperation;
  threadId: string | null;
  turnId: string | null;
  model: string | null;
  serviceTier: string | null;
  reasoningEffort: string | null;
  status: ModelRequestStatus;
  httpStatus: number | null;
  errorType: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  incompleteReason: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  upstreamCreatedAt: number | null;
  upstreamCompletedAt: number | null;
  requestStartedAtMs: number;
  firstTokenAtMs: number | null;
  firstReasoningDeltaAtMs: number | null;
  lastReasoningDeltaAtMs: number | null;
  firstOutputDeltaAtMs: number | null;
  lastOutputDeltaAtMs: number | null;
  responseCompletedAtMs: number;
  /** 记录入库时刻（毫秒）；缺省为写入时的 Date.now()，测试可显式指定以保证窗口确定性。 */
  recordedAtMs?: number;
  weeklyQuota: {
    limitId: "codex";
    usedPercentMillionths: number;
    resetsAt: number;
    planType: string | null;
  } | null;
  /** 请求发生时对应的官方配额窗口快照（如 OpenCode Go 5h/7d/月），缺省为 null。 */
  quotaWindows?: ReadonlyArray<{
    windowId: string;
    resetsAt: number | null;
  }> | null;
}

export interface WeeklyQuotaEstimateQuery {
  provider: string;
  limitId: string;
  resetsAt: number;
  nowMs: number;
}

export interface StoredWeeklyQuotaEstimate {
  limitId: string;
  resetsAt: number;
  firstObservedAtMs: number;
  lastObservedAtMs: number;
  latestUsedPercentMillionths: number;
  observedDeltaPercentMillionths: number;
  intervalCount: number;
  requestCount: number;
  unsuccessfulRequestCount: number;
  pricedRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  pricingCurrency: string | null;
  totalCostNanos: number | null;
  periodRequestCount?: number;
  periodInputTokens?: number;
  periodOutputTokens?: number;
  periodTotalTokens?: number;
  periodTotalCostNanos?: number | null;
}

export interface StoredWeeklyQuotaWindow {
  limitId: string;
  usedPercentMillionths: number;
  resetsAt: number;
  observedAtMs: number;
  planType: string | null;
}

export interface QuotaHistoryQuery {
  startAtMs: number;
  endAtMs: number;
}

export interface StoredQuotaPeriod {
  provider: string;
  windowId: string;
  resetsAt: number;
  periodStartAtMs: number | null;
  periodEndAtMs: number;
  firstObservedAtMs: number;
  lastObservedAtMs: number;
  snapshotCount: number;
  requestCount: number;
  unsuccessfulRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  pricedRequestCount: number;
  totalCostNanos: number | null;
  latestUsedPercentMillionths: number | null;
  planType: string | null;
}

export interface StoredModelRequestMetric extends ModelRequestMetricSample {
  id: number;
  recordedAtMs: number;
  requestDurationMs: number | null;
  ttftMs: number | null;
  thinkingDurationMs: number | null;
  outputDurationMs: number | null;
  generationDurationMs: number | null;
  completionGapMs: number | null;
  upstreamDurationMs: number | null;
  uncachedInputTokens: number | null;
  nonReasoningOutputTokens: number | null;
  cacheHitRate: number | null;
  thinkingTokensPerSecond: number | null;
  outputTokensPerSecond: number | null;
  generationTokensPerSecond: number | null;
  uncachedInputCostNanos: number | null;
  cachedInputCostNanos: number | null;
  outputCostNanos: number | null;
  totalCostNanos: number | null;
}

export interface StoredCompactRequestMetricsSummary {
  model: string | null;
  hasMixedModels: boolean;
  requestCount: number;
  unsuccessfulRequestCount: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  pricingCurrency: string | null;
  pricedRequestCount: number;
  totalCostNanos: number | null;
}

export interface StoredTurnRequestMetricsSummary {
  provider: string | null;
  model: string | null;
  reasoningEffort: string | null;
  turnId: string;
  requestCount: number;
  unsuccessfulRequestCount: number;
  requestDurationMs: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number;
  outputTokensPerSecond: number | null;
  outputSpeedSampleCount: number;
  outputSpeedTimedCount: number;
  pricingCurrency: string | null;
  pricedRequestCount: number;
  pricedInputTokens: number;
  pricedOutputTokens: number;
  totalCostNanos: number | null;
  inputCostNanos: number | null;
  cachedInputCostNanos: number | null;
  outputCostNanos: number | null;
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
  hasMixedPrices: boolean;
  pricingBuckets: ModelPricingBucket[];
  compact: StoredCompactRequestMetricsSummary | null;
}

export interface StoredThreadRequestMetricsAggregate {
  provider: string | null;
  turnCount: number;
  requestCount: number;
  unsuccessfulRequestCount: number;
  requestDurationMs: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number;
  outputTokensPerSecond: number | null;
  outputSpeedSampleCount: number;
  outputSpeedTimedCount: number;
  pricingCurrency: string | null;
  pricedRequestCount: number;
  pricedInputTokens: number;
  pricedOutputTokens: number;
  totalCostNanos: number | null;
  inputCostNanos: number | null;
  cachedInputCostNanos: number | null;
  outputCostNanos: number | null;
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
  hasMixedPrices: boolean;
  pricingBuckets: ModelPricingBucket[];
  compact: StoredCompactRequestMetricsSummary | null;
}

export interface StoredThreadRequestMetricsSummary {
  threadId: string;
  latestTurn: StoredTurnRequestMetricsSummary | null;
  threadAggregate: StoredThreadRequestMetricsAggregate | null;
  latestDirectApi: StoredModelRequestMetric | null;
}

export interface StoredThreadTurnSummary extends StoredTurnRequestMetricsSummary {
  recordedAtMs: number;
}

export interface StoredThreadListItem {
  threadId: string;
  provider: string | null;
  model: string | null;
  reasoningEffort: string | null;
  agentPath: string | null;
  parentThreadId: string | null;
  parentTurnId: string | null;
  turnCount: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  pricingCurrency: string | null;
  pricedRequestCount: number;
  totalCostNanos: number | null;
  compact: StoredCompactRequestMetricsSummary | null;
  firstRequestStartedAtMs: number;
  lastRecordedAtMs: number;
}

export interface StoredSubagentThreadRecord {
  threadId: string;
  parentThreadId: string;
  parentTurnId: string | null;
  agentPath: string;
  recordedAtMs: number;
}

export type ModelRequestMetricsAggregationDimension =
  | "global"
  | "provider"
  | "model";

export interface ModelRequestMetricsAggregationQuery {
  dimension: ModelRequestMetricsAggregationDimension;
  startAtMs: number;
  endAtMs: number;
}

export interface StoredModelRequestMetricsAggregate {
  requestCount: number;
  unsuccessfulRequestCount: number;
  requestDurationMs: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number;
  outputTokensPerSecond: number | null;
  outputSpeedSampleCount: number;
  outputSpeedTimedCount: number;
  ttftAverageMs: number | null;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  ttftSampleCount: number;
  pricingCurrency: string | null;
  pricedRequestCount: number;
  totalCostNanos: number | null;
  inputCostNanos: number | null;
  cachedInputCostNanos: number | null;
  outputCostNanos: number | null;
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
  hasMixedPrices: boolean;
  pricingBuckets: ModelPricingBucket[];
  compact: StoredCompactRequestMetricsSummary | null;
}

export interface StoredModelRequestMetricsGroup {
  provider: string | null;
  model: string | null;
  aggregate: StoredModelRequestMetricsAggregate;
}

export interface StoredModelRequestMetricsReport {
  dimension: ModelRequestMetricsAggregationDimension;
  startAtMs: number;
  endAtMs: number;
  aggregate: StoredModelRequestMetricsAggregate | null;
  groups: StoredModelRequestMetricsGroup[];
  totalGroupCount: number;
}

export interface ModelRequestMetricsErrorQuery {
  startAtMs: number;
  endAtMs: number;
}

export interface ModelRequestMetricsPageQuery {
  startAtMs: number;
  endAtMs: number;
  offset?: number;
  limit: number;
  sortKey?: ModelRequestMetricsSortKey;
  sortDirection?: "asc" | "desc";
  filter?: string;
  /** 只返回未成功完成的请求，用于错误明细页。 */
  onlyFailures?: boolean;
}

export type ModelRequestMetricsSortKey =
  | "recordedAtMs"
  | "provider"
  | "model"
  | "operation"
  | "status"
  | "httpStatus"
  | "error"
  | "inputTokens"
  | "outputTokens"
  | "reasoningOutputTokens"
  | "outputTokensPerSecond"
  | "ttftMs"
  | "requestDurationMs"
  | "totalCostNanos";

export interface StoredModelRequestMetricsPage {
  startAtMs: number;
  endAtMs: number;
  records: StoredModelRequestMetric[];
  nextOffset: number | null;
  matchedTotal: number;
}

export interface StoredModelRequestMetricsErrorGroup {
  provider: string;
  model: string | null;
  status: Exclude<ModelRequestStatus, "completed">;
  httpStatus: number | null;
  errorType: string | null;
  lastErrorMessage: string | null;
  requestCount: number;
  lastOccurredAtMs: number;
}

export interface StoredModelRequestMetricsErrorReport {
  startAtMs: number;
  endAtMs: number;
  requestCount: number;
  unsuccessfulRequestCount: number;
  groups: StoredModelRequestMetricsErrorGroup[];
  totalGroupCount: number;
}

export interface ModelRequestMetricsStore {
  record(sample: ModelRequestMetricSample): void;
  recordSubagentThread(details: {
    agentThreadId: string;
    parentThreadId: string;
    parentTurnId: string;
    agentPath: string;
  }): void;
  recordSubagentTurn(details: {
    agentThreadId: string;
    agentTurnId: string;
    parentThreadId: string;
    parentTurnId: string;
    agentPath: string;
  }): void;
  requestRowsAfter(afterLocalId: number, limit: number): StoredModelRequestMetric[];
  subagentThreadsAfter(
    recordedAtMs: number,
    afterThreadId?: string,
  ): StoredSubagentThreadRecord[];
  recent(limit: number): StoredModelRequestMetric[];
  aggregate(
    query: ModelRequestMetricsAggregationQuery,
  ): StoredModelRequestMetricsReport;
  errors(
    query: ModelRequestMetricsErrorQuery,
  ): StoredModelRequestMetricsErrorReport;
  quotaHistory?(query: QuotaHistoryQuery): StoredQuotaPeriod[];
  threadTurnTaskSummary(
    threadId: string,
    turnId: string,
  ): StoredTurnRequestMetricsSummary | null;
  count(): number;
  close(): void;
}

export interface ModelRequestMetricsWriter {
  enqueue(sample: ModelRequestMetricSample): void;
  close(): Promise<void>;
}
