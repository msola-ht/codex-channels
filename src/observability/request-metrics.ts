export type ModelRequestTransport = "http" | "websocket";
export type ModelResponseFormat = "sse" | "json" | "websocket" | "unknown";
export type ModelRequestOperation = "response" | "compact";
export type ModelRequestStatus = "completed" | "failed" | "incomplete" | "unknown";
export interface ModelRequestMetricSample {
  provider: string;
  transport: ModelRequestTransport;
  responseFormat: ModelResponseFormat;
  operation: ModelRequestOperation;
  threadId: string | null;
  turnId: string | null;
  model: string | null;
  serviceTier: string | null;
  /** 出站请求层级；历史未采集时为空，不从响应推断。 */
  requestServiceTier?: string | null;
  reasoningEffort: string | null;
  status: ModelRequestStatus;
  httpStatus: number | null;
  /** 本次请求实际发往模型上游的完整 User-Agent；未采集时为 null。 */
  userAgent?: string | null;
  errorType: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  incompleteReason: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  requestStartedAtMs: number;
  responseCompletedAtMs: number;
  upstreamTtftMs?: number | null;
  firstContentMs?: number | null;
  totalDurationMs?: number | null;
  requestModel?: string | null;
  responseModel?: string | null;
  /** 本地转储定位符；缺失不按时间或 Thread/Turn 推断。 */
  traffic?: { label: string; session: string; interaction: number } | null;
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
    usedPercentMillionths?: number | null;
    status?: string | null;
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
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  periodRequestCount?: number;
  periodInputTokens?: number;
  periodOutputTokens?: number;
  periodTotalTokens?: number;
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
  latestUsedPercentMillionths: number | null;
  planType: string | null;
}

export interface StoredModelRequestMetric extends ModelRequestMetricSample {
  tokensPerSecond?: number | null;
  id: number;
  recordedAtMs: number;
  uncachedInputTokens: number | null;
  cacheHitRate: number | null;
}

export interface StoredCompactRequestMetricsSummary {
  model: string | null;
  hasMixedModels: boolean;
  requestCount: number;
  unsuccessfulRequestCount: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
}

export interface StoredTurnRequestMetricsSummary {
  /** 有效请求输出速率的算术平均，不是会话墙钟吞吐量。 */
  tokensPerSecond?: number | null;
  /** 当前 Thread/Turn 首个有效 OpenAI 样本，不含压缩和子代理。 */
  upstreamTtftMs?: number | null;
  provider: string | null;
  model: string | null;
  reasoningEffort: string | null;
  turnId: string;
  requestCount: number;
  unsuccessfulRequestCount: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number;
  compact: StoredCompactRequestMetricsSummary | null;
}

export interface StoredThreadRequestMetricsAggregate {
  tokensPerSecond?: number | null;
  provider: string | null;
  turnCount: number;
  requestCount: number;
  unsuccessfulRequestCount: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number;
  compact: StoredCompactRequestMetricsSummary | null;
}

export interface StoredThreadRequestMetricsSummary {
  threadId: string;
  latestTurn: StoredTurnRequestMetricsSummary | null;
  threadAggregate: StoredThreadRequestMetricsAggregate | null;
}

export interface StoredThreadTurnSummary extends StoredTurnRequestMetricsSummary {
  recordedAtMs: number;
}

/** 已观测缓存样本；不把缺失字段视为零。 */
export interface StoredCacheUsage {
  cachedInputTokens: number | null;
  inputTokens: number;
  missingRequestCount: number;
}

export interface StoredThreadListItem {
  cacheUsage: StoredCacheUsage;
  tokensPerSecond?: number | null;
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

export interface ModelRequestMetricsFilters {
  threadId?: string;
  turnId?: string;
  provider?: string | string[];
  model?: string;
  operation?: ModelRequestOperation;
  status?: ModelRequestStatus;
  filter?: string;
  /** 只返回未成功完成的请求，用于错误明细页。 */
  onlyFailures?: boolean;
}

export interface ModelRequestMetricsScope extends ModelRequestMetricsFilters {
  startAtMs: number;
  endAtMs: number;
}

export interface ModelRequestMetricsAggregationQuery extends ModelRequestMetricsScope {
  dimension: ModelRequestMetricsAggregationDimension;
}

export interface StoredModelRequestMetricsAggregate {
  cacheUsage: StoredCacheUsage;
  tokensPerSecond?: number | null;
  requestCount: number;
  unsuccessfulRequestCount: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number;
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

export interface StoredModelRequestMetricsDailyRow {
  day: string;
  requestCount: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
}

export interface StoredModelRequestMetricsHourlyRow extends Omit<StoredModelRequestMetricsDailyRow, "day"> {
  hour: string;
}

export type ModelRequestMetricsErrorQuery = ModelRequestMetricsScope;

export interface ModelRequestMetricsPageQuery extends ModelRequestMetricsScope {
  offset?: number;
  limit: number;
  sortKey?: ModelRequestMetricsSortKey;
  sortDirection?: "asc" | "desc";
}

export type ModelRequestMetricsSortKey =
  | "tokensPerSecond"
  | "totalDurationMs"
  | "recordedAtMs"
  | "provider"
  | "model"
  | "operation"
  | "status"
  | "httpStatus"
  | "error"
  | "inputTokens"
  | "outputTokens"
  | "reasoningOutputTokens";

export interface StoredModelRequestMetricsPage {
  startAtMs: number;
  endAtMs: number;
  records: StoredModelRequestMetric[];
  nextOffset: number | null;
  matchedTotal: number;
  aggregate: StoredModelRequestMetricsAggregate | null;
}

export type ModelRequestMetricsThreadSortKey =
  | "tokensPerSecond"
  | "time" | "last" | "thread" | "turn" | "provider" | "model"
  | "turns" | "requests" | "failures" | "input" | "output" | "compact";

export interface ModelRequestMetricsThreadQuery extends ModelRequestMetricsScope {
  offset?: number;
  limit: number;
  sortKey?: ModelRequestMetricsThreadSortKey;
  sortDirection?: "asc" | "desc";
}

export interface StoredThreadMetricsPage {
  nextOffset: number | null;
  matchedTotal: number;
  aggregate: StoredModelRequestMetricsAggregate | null;
  turnCount: number;
}

export interface StoredThreadListPage extends StoredThreadMetricsPage {
  threads: StoredThreadListItem[];
}

export interface StoredThreadTurnsPage extends StoredThreadMetricsPage {
  turns: StoredThreadTurnSummary[];
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

export interface ModelRequestMetricsWriteStore {
  record(sample: ModelRequestMetricSample): void;
  recordBatch?(samples: readonly ModelRequestMetricSample[]): void;
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
  close(): void;
}

export interface ProviderTokenMetricQuery {
  provider: string;
  startAtMs: number;
  endAtMs: number;
}

export interface StoredProviderTokenMetric {
  requestStartedAtMs: number;
  recordedAtMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  quotaWindows: ReadonlyArray<{
    windowId: string;
    resetsAt: number | null;
    usedPercentMillionths: number | null;
    status: string | null;
  }> | null;
}

export interface ModelRequestMetricsRequestQueryStore {
  requestRowsAfter(afterLocalId: number, limit: number): StoredModelRequestMetric[];
  recent(limit: number): StoredModelRequestMetric[];
  page(query: ModelRequestMetricsPageQuery): StoredModelRequestMetricsPage;
  aggregate(
    query: ModelRequestMetricsAggregationQuery,
  ): StoredModelRequestMetricsReport;
  daily(query: {
    startAtMs: number;
    endAtMs: number;
  }): StoredModelRequestMetricsDailyRow[];
  hourly(query: {
    startAtMs: number;
    endAtMs: number;
  }): StoredModelRequestMetricsHourlyRow[];
  errors(
    query: ModelRequestMetricsErrorQuery,
  ): StoredModelRequestMetricsErrorReport;
  forEachProviderTokenMetric(
    query: ProviderTokenMetricQuery,
    visit: (metric: StoredProviderTokenMetric) => void,
  ): void;
  count(): number;
}

export interface ModelRequestMetricsThreadQueryStore {
  subagentThreadsAfter(
    recordedAtMs: number,
    afterThreadId?: string,
  ): StoredSubagentThreadRecord[];
  threadSummary(threadId: string): StoredThreadRequestMetricsSummary;
  threadTurnTaskSummary(
    threadId: string,
    turnId: string,
  ): StoredTurnRequestMetricsSummary | null;
  threadTurnSummary(
    threadId: string,
    turnId: string,
  ): StoredTurnRequestMetricsSummary | null;
  threadTurnSummaries(threadId: string, query: ModelRequestMetricsThreadQuery): StoredThreadTurnsPage;
  threadTurnCount(threadId: string): number | null;
  threadList(query: ModelRequestMetricsThreadQuery): StoredThreadListPage;
  subagentThread(threadId: string): {
    agentPath: string | null;
    parentThreadId: string | null;
    parentTurnId: string | null;
  };
}

export interface ModelRequestAccountSnapshotInput {
  sourceId: string;
  provider: string;
  accountId: string | null;
  displayName: string;
  enabled: boolean;
  observedAtMs: number;
  available: boolean;
  usage: unknown;
  limits: unknown;
}

export interface StoredModelRequestAccountSnapshot {
  provider: string;
  accountId: string | null;
  observedAtMs: number;
  available: boolean;
  usage: unknown;
  limits: unknown;
}

export interface ModelRequestMetricsQuotaAccountStore {
  weeklyQuotaEstimate(
    query: WeeklyQuotaEstimateQuery,
  ): StoredWeeklyQuotaEstimate | null;
  latestWeeklyQuota(
    provider: string,
    nowMs?: number,
  ): StoredWeeklyQuotaWindow | null;
  quotaHistory(query: QuotaHistoryQuery): StoredQuotaPeriod[];
  upsertAccountSnapshot(snapshot: ModelRequestAccountSnapshotInput): void;
  latestAccountSnapshot(
    provider: string,
    accountId?: string,
  ): StoredModelRequestAccountSnapshot | null;
  latestAccountSnapshots(): StoredModelRequestAccountSnapshot[];
}

export interface ModelRequestMetricsStore
  extends ModelRequestMetricsWriteStore,
    ModelRequestMetricsRequestQueryStore,
    ModelRequestMetricsThreadQueryStore,
    ModelRequestMetricsQuotaAccountStore {
}

export interface ModelRequestMetricsWriter {
  enqueue(sample: ModelRequestMetricSample): void;
  close(): Promise<void>;
}
