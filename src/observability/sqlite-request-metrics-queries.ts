import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import { validateModelDisplayAliases } from "../../runtime/model-display-name.mjs";
import type {
  SessionExecutionTiming,
  ModelRequestMetricsAggregationDimension,
  ModelRequestMetricsAggregationQuery,
  ModelRequestMetricsErrorQuery,
  ModelRequestMetricsPageQuery,
  ModelRequestMetricsScope,
  ModelRequestMetricsThreadQuery,
  StoredModelRequestMetric,
  StoredModelUsage,
  StoredModelRequestMetricsDailyRow,
  StoredModelRequestMetricsErrorReport,
  StoredModelRequestMetricsHourlyRow,
  StoredModelRequestMetricsPage,
  StoredModelRequestMetricsReport,
  StoredSubagentThreadRecord,
  SubagentThreadsQuery,
  StoredThreadSubagentsPage,
  StoredThreadListPage,
  StoredThreadRequestMetricsSummary,
  StoredThreadTurnsPage,
  StoredTurnRequestMetricsSummary,
} from "./request-metrics.js";
import {
  parseQuotaWindows,
  toStoredCacheUsage,
  toStoredMetric,
  toStoredRequestOutcomes,
  toStoredMetricsAggregate,
  toStoredMetricsGroup,
  type AggregateRow,
  type CacheUsageRow,
  type ErrorGroupRow,
  type ErrorSummaryRow,
  type MetricRow,
} from "./sqlite-request-metrics-row-codec.js";
import { SqliteRequestMetricsSubagentQueries } from "./sqlite-request-metrics-subagent-queries.js";
import { SqliteRequestMetricsThreadQueries } from "./sqlite-request-metrics-thread-queries.js";

const maximumAggregationGroups = 20;
const pageSortSql = {
  recordedAtMs: "recorded_at_ms",
  provider: "provider",
  model: "model",
  operation: "operation",
  status: "status",
  httpStatus: "http_status",
  error: "COALESCE(error_type, error_code, '')",
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  reasoningOutputTokens: "reasoning_output_tokens",
  totalDurationMs: "total_duration_ms",
} as const;
export const observableCompletionSql = "status = 'completed'";
export const compactAggregateSql = `
  ${requestOutcomeSql("operation = 'compact'", "compact_")},
  COUNT(CASE WHEN operation = 'compact' THEN 1 END) AS compact_request_count,
  SUM(CASE WHEN operation = 'compact' AND NOT (${observableCompletionSql})
    THEN 1 ELSE 0 END) AS compact_unsuccessful_request_count,
  MIN(CASE WHEN operation = 'compact' THEN model END) AS compact_model,
  COUNT(DISTINCT CASE WHEN operation = 'compact' THEN model END)
    AS compact_model_count,
  SUM(CASE WHEN operation = 'compact' THEN input_tokens END)
    AS compact_input_tokens,
  SUM(CASE WHEN operation = 'compact' THEN cached_input_tokens END)
    AS compact_cached_input_tokens,
  COUNT(CASE WHEN operation = 'compact' THEN input_tokens END)
    AS compact_input_token_count,
  COUNT(CASE WHEN operation = 'compact' THEN cached_input_tokens END)
    AS compact_cached_input_token_count,
  SUM(CASE WHEN operation = 'compact' THEN output_tokens END)
    AS compact_output_tokens
`;
const normalizedStatusSql = "status";
export const cacheUsageSql = `
  SUM(CASE WHEN input_tokens IS NOT NULL THEN cached_input_tokens END) AS known_cached_input_tokens,
  SUM(CASE WHEN cached_input_tokens IS NOT NULL THEN input_tokens END) AS cache_observed_input_tokens,
  SUM(CASE WHEN input_tokens IS NULL OR cached_input_tokens IS NULL THEN 1 ELSE 0 END) AS cache_missing_request_count
`;
export const metricsAggregateSql = `
  ${requestOutcomeSql()},
  ${cacheUsageSql},
  COUNT(*) AS request_count,
  SUM(CASE WHEN ${observableCompletionSql} THEN 0 ELSE 1 END) AS unsuccessful_request_count,
  SUM(input_tokens) AS input_tokens,
  SUM(cached_input_tokens) AS cached_input_tokens,
  COUNT(input_tokens) AS input_token_count,
  COUNT(cached_input_tokens) AS cached_input_token_count,
  COUNT(CASE WHEN input_tokens IS NOT NULL THEN cached_input_tokens END) AS cache_observed_request_count,
  SUM(output_tokens) AS output_tokens,
  SUM(reasoning_output_tokens) AS reasoning_output_tokens,
  ${compactAggregateSql}
`;

export function requestOutcomeSql(condition = "1", prefix = ""): string {
  const interrupted = `NOT (${observableCompletionSql}) AND error_type = 'client_disconnected'`;
  const failed = `NOT (${observableCompletionSql}) AND status = 'failed'
    AND (error_type IS NULL OR error_type <> 'client_disconnected')`;
  const incomplete = `NOT (${observableCompletionSql}) AND status <> 'failed'
    AND (error_type IS NULL OR error_type <> 'client_disconnected')`;
  return [
    ["completed", observableCompletionSql], ["interrupted", interrupted],
    ["failed", failed], ["incomplete", incomplete],
  ].map(([name, predicate]) => `COUNT(CASE WHEN (${condition}) AND (${predicate}) THEN 1 END)
    AS ${prefix}${name}_request_count`).join(", ");
}

export interface MetricsQueryReader {
  prepare: DatabaseSync["prepare"];
  iterateRows(sql: string, ...parameters: SQLInputValue[]): Iterable<Record<string, SQLOutputValue>>;
  requireOpen(): void;
}

/** 只读查询共用 Store 的连接和生命周期，不持有事务、写入口或独立连接。 */
export class SqliteRequestMetricsQueries {
  private readonly subagentQueries: SqliteRequestMetricsSubagentQueries;
  private readonly threadQueries: SqliteRequestMetricsThreadQueries;

  constructor(private readonly reader: MetricsQueryReader) {
    this.subagentQueries = new SqliteRequestMetricsSubagentQueries(reader);
    this.threadQueries = new SqliteRequestMetricsThreadQueries(reader, this.subagentQueries);
  }

  relayCallerUsage(callers: readonly { callerId: string; keyId: string }[], startAtMs: number, endAtMs: number): Array<{
    callerId: string; keyId: string; lastRequestAtMs: number | null; requestCount: number; unsuccessfulRequestCount: number;
  }> {
    this.reader.requireOpen();
    if (callers.length === 0) return [];
    return this.reader.prepare(`
      WITH callers(caller_id, key_id) AS (VALUES ${callers.map(() => "(?, ?)").join(",")})
      SELECT c.caller_id AS callerId, c.key_id AS keyId,
        MAX(m.request_started_at_ms) AS lastRequestAtMs,
        COUNT(CASE WHEN m.request_started_at_ms >= ? THEN 1 END) AS requestCount,
        COUNT(CASE WHEN m.request_started_at_ms >= ? AND (${normalizedStatusSql}) != 'completed' THEN 1 END) AS unsuccessfulRequestCount
      FROM callers c LEFT JOIN model_request_metrics m
        ON m.source = 'relay' AND m.caller_id = c.caller_id AND m.key_id = c.key_id
        AND m.request_started_at_ms <= ?
      GROUP BY c.caller_id, c.key_id
    `).all(...callers.flatMap(caller => [caller.callerId, caller.keyId]), startAtMs, startAtMs, endAtMs) as Array<{
      callerId: string; keyId: string; lastRequestAtMs: number | null; requestCount: number; unsuccessfulRequestCount: number;
    }>;
  }

  recent(limit: number): StoredModelRequestMetric[] {
    this.reader.requireOpen();
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("模型请求指标查询数量必须在 1 到 500 之间");
    }
    const rows = this.reader.prepare(`
      SELECT * FROM model_request_metrics ORDER BY id DESC LIMIT ?
    `).all(limit) as unknown as MetricRow[];
    return rows.map(toStoredMetric);
  }

  forEachProviderTokenMetric(
    query: { provider: string; startAtMs: number; endAtMs: number },
    visit: (metric: {
      requestStartedAtMs: number;
      recordedAtMs: number;
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
      quotaWindows: ReturnType<typeof parseQuotaWindows>;
    }) => void,
  ): void {
    this.reader.requireOpen();
    validateMetricsTimeRange(query);
    if (!query.provider || query.provider.length > 128) {
      throw new Error("模型请求指标 Provider 无效");
    }
    const rows = this.reader.iterateRows(`
      SELECT request_started_at_ms, recorded_at_ms, input_tokens,
        output_tokens, total_tokens, quota_windows
      FROM model_request_metrics
      WHERE provider = ?
        AND recorded_at_ms >= ?
        AND recorded_at_ms < ?
      ORDER BY recorded_at_ms ASC, id ASC
    `, query.provider, query.startAtMs, query.endAtMs);
    for (const rawRow of rows) {
      const row = rawRow as {
        request_started_at_ms: number;
        recorded_at_ms: number;
        input_tokens: number | null;
        output_tokens: number | null;
        total_tokens: number | null;
        quota_windows: string | null;
      };
      visit({
        requestStartedAtMs: row.request_started_at_ms,
        recordedAtMs: row.recorded_at_ms,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        totalTokens: row.total_tokens,
        quotaWindows: parseQuotaWindows(row.quota_windows),
      });
    }
  }

  page(query: ModelRequestMetricsPageQuery): StoredModelRequestMetricsPage {
    this.reader.requireOpen();
    const scope = metricsScopeSql(query);
    const offset = metricsPageOffset(query);
    const sortKey = query.sortKey ?? "recordedAtMs";
    const sortDirection = query.sortDirection ?? "desc";
    const sortExpression = pageSortSql[sortKey];
    if (sortExpression === undefined || !["asc", "desc"].includes(sortDirection)) {
      throw new Error("模型请求指标排序无效");
    }
    const order = sortDirection.toUpperCase();
    const aggregateRow = this.queryAggregationRows("global", { ...query, dimension: "global" })[0];
    const aggregate = aggregateRow === undefined ? null : toStoredMetricsAggregate(aggregateRow);
    const matchedTotal = aggregate?.requestCount ?? 0;
    const rows = this.reader.prepare(`
      SELECT model_request_metrics.*, EXISTS (
        SELECT 1 FROM subagent_threads AS relation
        WHERE relation.thread_id = model_request_metrics.thread_id
          AND model_request_metrics.source = 'owned'
          AND model_request_metrics.request_purpose IS NULL
      ) AS is_subagent
      FROM model_request_metrics
      WHERE ${scope.sql}
      ORDER BY ${sortExpression} ${order}, id ${order}
      LIMIT ? OFFSET ?
    `).all(
      ...scope.params,
      query.limit + 1,
      offset,
    ) as unknown as Array<MetricRow & { is_subagent: number }>;
    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      startAtMs: query.startAtMs,
      endAtMs: query.endAtMs,
      records: pageRows.map((row) => ({ ...toStoredMetric(row), isSubagent: row.is_subagent === 1 })),
      nextOffset: hasMore ? offset + query.limit : null,
      matchedTotal,
      aggregate,
    };
  }

  modelUsage(query: ModelRequestMetricsScope, modelAliases?: Readonly<Record<string, string>>): StoredModelUsage[] {
    this.reader.requireOpen();
    const scope = metricsScopeSql(query);
    const aliases = validateModelDisplayAliases(modelAliases === undefined ? {} : modelAliases);
    const parameters = [JSON.stringify(aliases), ...scope.params];
    // 一次物化让 SQLite 为精确匹配建立索引，避免每条请求都扫描完整 json_each。
    const aliasesSql = `WITH model_aliases AS MATERIALIZED (
      SELECT key AS original_model, value AS display_name FROM json_each(?)
    )`;
    const displayModelSql = `CASE
      WHEN model_request_metrics.request_purpose = 'autoApprovalReview' THEN 'auto-review'
      ELSE COALESCE(model_aliases.display_name, model_request_metrics.model)
    END`;
    const rows = this.reader.prepare(`
      ${aliasesSql}
      SELECT ${displayModelSql} AS model, ${metricsAggregateSql},
        COUNT(DISTINCT json_array(thread_id, turn_id))
          FILTER (WHERE thread_id IS NOT NULL AND turn_id IS NOT NULL) AS turn_count
      FROM model_request_metrics
      LEFT JOIN model_aliases ON model_request_metrics.model = model_aliases.original_model
      WHERE ${scope.sql}
      GROUP BY ${displayModelSql}
      ORDER BY request_count DESC, model IS NULL ASC, model ASC
    `).all(...parameters) as unknown as Array<AggregateRow & { turn_count: number }>;
    const memberRows = this.reader.prepare(`
      ${aliasesSql}
      SELECT ${displayModelSql} AS display_model, provider, model_request_metrics.model AS model,
        ${metricsAggregateSql},
        COUNT(DISTINCT json_array(thread_id, turn_id))
          FILTER (WHERE thread_id IS NOT NULL AND turn_id IS NOT NULL) AS turn_count
      FROM model_request_metrics
      LEFT JOIN model_aliases ON model_request_metrics.model = model_aliases.original_model
      WHERE ${scope.sql}
      GROUP BY provider, model_request_metrics.model, ${displayModelSql}
      ORDER BY request_count DESC, provider ASC, model IS NULL ASC, model ASC
    `).all(...parameters) as unknown as Array<AggregateRow & {
      provider: string;
      display_model: string | null;
      turn_count: number;
    }>;
    const members = new Map<string | null, StoredModelUsage["members"]>();
    for (const row of memberRows) {
      const groupMembers = members.get(row.display_model) ?? [];
      groupMembers.push({
        ...toStoredMetricsAggregate(row), provider: row.provider, model: row.model, turnCount: row.turn_count,
      });
      members.set(row.display_model, groupMembers);
    }
    return rows.map((row) => ({
      ...toStoredMetricsAggregate(row), model: row.model, turnCount: row.turn_count,
      members: members.get(row.model) ?? [],
    }));
  }

  providers(): string[] {
    this.reader.requireOpen();
    const rows = this.reader.prepare("SELECT DISTINCT provider FROM model_request_metrics ORDER BY provider").all() as Array<{ provider: string }>;
    return rows.map((row) => row.provider);
  }

  aggregate(
    query: ModelRequestMetricsAggregationQuery,
  ): StoredModelRequestMetricsReport {
    this.reader.requireOpen();
    validateAggregationQuery(query);
    const globalRows = this.queryAggregationRows("global", query);
    const aggregate = globalRows[0] === undefined
      ? null
      : toStoredMetricsAggregate(globalRows[0]);
    if (query.dimension === "global") {
      return {
        ...query,
        aggregate,
        groups: [],
        totalGroupCount: aggregate === null ? 0 : 1,
      };
    }
    const rows = this.queryAggregationRows(query.dimension, query);
    return {
      ...query,
      aggregate,
      groups: rows.map(toStoredMetricsGroup),
      totalGroupCount: rows[0]?.total_group_count ?? 0,
    };
  }

  daily(
    query: { startAtMs: number; endAtMs: number },
  ): StoredModelRequestMetricsDailyRow[] {
    return this.usageBuckets(query, "%Y-%m-%d").map(({ period, ...usage }) => ({ day: period, ...usage }));
  }

  hourly(
    query: { startAtMs: number; endAtMs: number },
  ): StoredModelRequestMetricsHourlyRow[] {
    return this.usageBuckets(query, "%Y-%m-%d %H:00").map(({ period, ...usage }) => ({ hour: period, ...usage }));
  }

  private usageBuckets(
    query: { startAtMs: number; endAtMs: number },
    format: "%Y-%m-%d" | "%Y-%m-%d %H:00",
  ) {
    this.reader.requireOpen();
    validateMetricsTimeRange(query);
    const rows = this.reader.prepare(`
      SELECT
        strftime(?, recorded_at_ms / 1000, 'unixepoch', 'localtime') AS period,
        ${cacheUsageSql},
        COUNT(*) AS request_count,
        SUM(input_tokens) AS input_tokens,
        SUM(cached_input_tokens) AS cached_input_tokens,
        COUNT(input_tokens) AS input_token_count,
        COUNT(cached_input_tokens) AS cached_input_token_count,
        SUM(output_tokens) AS output_tokens
      FROM model_request_metrics
      WHERE recorded_at_ms >= ?
        AND recorded_at_ms < ?
      GROUP BY period
      ORDER BY period ASC
    `).all(format, query.startAtMs, query.endAtMs) as unknown as Array<CacheUsageRow & {
      period: string;
      request_count: number;
      input_tokens: number | null;
      cached_input_tokens: number | null;
      input_token_count: number;
      cached_input_token_count: number;
      output_tokens: number | null;
    }>;
    return rows.map((row) => ({
      period: row.period,
      cacheUsage: toStoredCacheUsage(row),
      requestCount: row.request_count,
      inputTokens: row.input_tokens ?? 0,
      cachedInputTokens: row.input_token_count === row.request_count
        && row.cached_input_token_count === row.request_count
        ? row.cached_input_tokens ?? 0
        : null,
      outputTokens: row.output_tokens ?? 0,
    }));
  }

  errors(
    query: ModelRequestMetricsErrorQuery,
  ): StoredModelRequestMetricsErrorReport {
    this.reader.requireOpen();
    const scope = metricsScopeSql(query);
    const summary = this.reader.prepare(`
      SELECT
        ${requestOutcomeSql()},
        COUNT(*) AS request_count,
        SUM(CASE WHEN ${observableCompletionSql} THEN 0 ELSE 1 END)
          AS unsuccessful_request_count
      FROM model_request_metrics
      WHERE ${scope.sql}
    `).get(...scope.params) as unknown as ErrorSummaryRow;
    const rows = this.reader.prepare(`
      WITH normalized AS (
        SELECT
          *,
          ${normalizedStatusSql} AS normalized_status,
          CASE
            WHEN incomplete_reason = 'response_not_observed'
              AND error_type IS NULL
              THEN 'response_not_observed'
            ELSE error_type
          END AS normalized_error_type
        FROM model_request_metrics
        WHERE ${scope.sql}
      ),
      ranked AS (
        SELECT
          *,
          ROW_NUMBER() OVER (
            PARTITION BY provider, model, normalized_status, http_status,
              normalized_error_type
            ORDER BY recorded_at_ms DESC
          ) AS last_row
        FROM normalized
        WHERE normalized_status <> 'completed'
      )
      SELECT
        provider,
        model,
        normalized_status AS status,
        http_status,
        normalized_error_type AS error_type,
        MAX(error_message) FILTER (WHERE last_row = 1) AS last_error_message,
        COUNT(*) AS request_count,
        MAX(recorded_at_ms) AS last_occurred_at_ms,
        COUNT(*) OVER () AS total_group_count
      FROM ranked
      GROUP BY provider, model, normalized_status, http_status, normalized_error_type
      ORDER BY last_occurred_at_ms DESC, request_count DESC,
        provider ASC, model ASC
      LIMIT ?
    `).all(
      ...scope.params,
      maximumAggregationGroups,
    ) as unknown as ErrorGroupRow[];
    return {
      ...query,
      requestCount: summary.request_count,
      requestOutcomes: toStoredRequestOutcomes(summary),
      unsuccessfulRequestCount: summary.unsuccessful_request_count ?? 0,
      groups: rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        status: row.status,
        httpStatus: row.http_status,
        errorType: row.error_type,
        lastErrorMessage: row.last_error_message,
        requestCount: row.request_count,
        lastOccurredAtMs: row.last_occurred_at_ms,
      })),
      totalGroupCount: rows[0]?.total_group_count ?? 0,
    };
  }

  threadSummary(threadId: string): StoredThreadRequestMetricsSummary {
    return this.threadQueries.threadSummary(threadId);
  }

  threadTurnTaskSummary(
    threadId: string,
    turnId: string,
  ): StoredTurnRequestMetricsSummary | null {
    return this.threadQueries.threadTurnTaskSummary(threadId, turnId);
  }

  threadTurnSummary(
    threadId: string,
    turnId: string,
  ): StoredTurnRequestMetricsSummary | null {
    return this.threadQueries.threadTurnSummary(threadId, turnId);
  }

  turnExecutionDuration(threadId: string, turnId: string): number | null {
    return this.threadQueries.turnExecutionDuration(threadId, turnId);
  }

  sessionExecutionDuration(threadId: string, throughTurnId?: string): number | null {
    return this.threadQueries.sessionExecutionDuration(threadId, throughTurnId);
  }

  sessionExecutionTiming(threadId: string, throughTurnId?: string): SessionExecutionTiming {
    return this.threadQueries.sessionExecutionTiming(threadId, throughTurnId);
  }

  threadTurnSummaries(threadId: string, query: ModelRequestMetricsThreadQuery): StoredThreadTurnsPage {
    return this.threadQueries.threadTurnSummaries(threadId, query);
  }

  threadTurnCount(threadId: string): number | null {
    return this.threadQueries.threadTurnCount(threadId);
  }

  threadCounts(query: ModelRequestMetricsScope): { threadCount: number; turnCount: number } {
    return this.threadQueries.threadCounts(query);
  }

  threadList(query: ModelRequestMetricsThreadQuery): StoredThreadListPage {
    return this.threadQueries.threadList(query);
  }

  threadSubagents(threadId: string, query: SubagentThreadsQuery): StoredThreadSubagentsPage {
    return this.subagentQueries.threadSubagents(threadId, query);
  }

  subagents(query: SubagentThreadsQuery): StoredThreadSubagentsPage {
    return this.subagentQueries.subagents(query);
  }

  subagentThread(threadId: string): {
    agentPath: string | null;
    parentThreadId: string | null;
    parentTurnId: string | null;
  } {
    return this.subagentQueries.subagentThread(threadId);
  }

  requestRowsAfter(
    afterLocalId: number,
    limit: number,
  ): StoredModelRequestMetric[] {
    this.reader.requireOpen();
    if (!Number.isInteger(afterLocalId) || afterLocalId < 0) {
      throw new Error("同步水位必须是大于等于 0 的整数");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("同步批量大小必须在 1 到 500 之间");
    }
    const rows = this.reader.prepare(`
      SELECT * FROM model_request_metrics
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(afterLocalId, limit) as unknown as MetricRow[];
    return rows.map(toStoredMetric);
  }

  subagentThreadsAfter(
    recordedAtMs: number,
    afterThreadId?: string,
  ): StoredSubagentThreadRecord[] {
    return this.subagentQueries.subagentThreadsAfter(recordedAtMs, afterThreadId);
  }

  count(): number {
    this.reader.requireOpen();
    const row = this.reader.prepare(`
      SELECT COUNT(*) AS count FROM model_request_metrics
    `).get() as { count: number };
    return row.count;
  }

  private queryAggregationRows(
    dimension: ModelRequestMetricsAggregationDimension,
    query: ModelRequestMetricsAggregationQuery,
  ): AggregateRow[] {
    const grouping = aggregationGrouping(dimension);
    const scope = metricsScopeSql(query);
    const limit = dimension === "global" ? 1 : maximumAggregationGroups;
    return this.reader.prepare(`
      WITH filtered AS (
        SELECT
          metric.*,
          ${grouping.provider} AS group_provider,
          ${grouping.model} AS group_model
        FROM model_request_metrics AS metric
        WHERE ${scope.sql}
      )
      SELECT
        group_provider AS provider,
        group_model AS model,
        ${requestOutcomeSql()},
        ${cacheUsageSql},
        COUNT(*) AS request_count,
        SUM(CASE WHEN ${observableCompletionSql} THEN 0 ELSE 1 END)
          AS unsuccessful_request_count,
        SUM(input_tokens) AS input_tokens,
        SUM(cached_input_tokens) AS cached_input_tokens,
        COUNT(input_tokens) AS input_token_count,
        COUNT(cached_input_tokens) AS cached_input_token_count,
        SUM(output_tokens) AS output_tokens,
        SUM(reasoning_output_tokens) AS reasoning_output_tokens,
        COUNT(CASE WHEN input_tokens IS NOT NULL THEN cached_input_tokens END) AS cache_observed_request_count,
        ${compactAggregateSql},
        COUNT(*) OVER () AS total_group_count
      FROM filtered
      GROUP BY group_provider, group_model
      ORDER BY request_count DESC, provider ASC, model ASC
      LIMIT ?
    `).all(...scope.params, limit) as unknown as AggregateRow[];
  }
}

function validateAggregationQuery(query: ModelRequestMetricsAggregationQuery): void {
  validateMetricsTimeRange(query);
  if (!(["global", "provider", "model"] as const).includes(query.dimension)) {
    throw new Error("模型请求指标聚合维度无效");
  }
}

export function metricsPageOffset(query: { offset?: number; limit: number }): number {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 500) {
    throw new Error("模型请求指标分页数量必须在 1 到 500 之间");
  }
  const offset = query.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("模型请求指标分页偏移无效");
  return offset;
}

export function metricsScopeSql(query: ModelRequestMetricsScope, selectThreadRoot = false): { sql: string; params: Array<string | number> } {
  validateMetricsTimeRange(query);
  const conditions = ["recorded_at_ms >= ?", "recorded_at_ms < ?"];
  const params: Array<string | number> = [query.startAtMs, query.endAtMs];
  if (query.requestPurpose !== undefined) {
    if (query.requestPurpose !== "autoApprovalReview") throw new Error("requestPurpose 筛选值无效");
    conditions.push("request_purpose = ?");
    params.push(query.requestPurpose);
  }
  for (const [key, column] of [
    ["threadId", "thread_id"], ["turnId", "turn_id"],
    ["model", "model"], ["source", "source"], ["callerId", "caller_id"],
    ["operation", "operation"], ["status", `(${normalizedStatusSql})`],
  ] as const) {
    const value = query[key];
    if (value === undefined) continue;
    if (!value.trim() || value.length > 128) throw new Error(`${key} 筛选值无效`);
    if (selectThreadRoot && key === "threadId" && query.turnId === undefined) continue;
    conditions.push(`${column} = ?`);
    params.push(value);
  }
  if (query.provider !== undefined) {
    const providers = Array.isArray(query.provider) ? query.provider : [query.provider];
    if (providers.length === 0 || providers.some((value) => !value.trim() || value.length > 128)) throw new Error("provider 筛选值无效");
    conditions.push(`provider IN (${providers.map(() => "?").join(", ")})`);
    params.push(...providers);
  }
  if (query.turnId !== undefined && query.threadId === undefined) throw new Error("查询 Turn 必须同时指定 Thread ID");
  if (query.operation !== undefined && !["response", "compact"].includes(query.operation)) throw new Error("operation 筛选值无效");
  if (query.status !== undefined && !["completed", "failed", "incomplete", "unknown"].includes(query.status)) throw new Error("status 筛选值无效");
  if (query.source !== undefined && !["owned", "relay"].includes(query.source)) throw new Error("source 筛选值无效");
  if (query.onlyFailures) conditions.push(`NOT (${observableCompletionSql})`);
  const filter = query.filter?.trim() ?? "";
  if (filter.length > 128) throw new Error("模型请求指标筛选关键字最多 128 个字符");
  if (filter !== "") {
    const columns = ["thread_id", "turn_id", "provider", "model", "operation", "status", "error_type", "error_code", "error_message"];
    conditions.push(`(${columns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    const pattern = `%${filter.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`;
    params.push(...columns.map(() => pattern));
  }
  return { sql: conditions.join(" AND "), params };
}

export function validateThreadId(value: string, label: string): void {
  if (!value.trim() || value.length > 128) {
    throw new Error(`${label}无效`);
  }
}

function validateMetricsTimeRange(
  query: { startAtMs: number; endAtMs: number },
): void {
  if (
    !Number.isSafeInteger(query.startAtMs)
    || !Number.isSafeInteger(query.endAtMs)
    || query.startAtMs < 0
    || query.endAtMs <= query.startAtMs
  ) {
    throw new Error("模型请求指标时间范围无效");
  }
}

function aggregationGrouping(
  dimension: ModelRequestMetricsAggregationDimension,
): { provider: string; model: string } {
  switch (dimension) {
    case "global":
      return { provider: "NULL", model: "NULL" };
    case "provider":
      return { provider: "provider", model: "NULL" };
    case "model":
      return { provider: "provider", model: "model" };
  }
}
