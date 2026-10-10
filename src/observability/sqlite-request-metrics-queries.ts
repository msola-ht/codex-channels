import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import type { RequestTimingSummary } from "../../runtime/request-timing.mjs";
import { validateModelDisplayAliases } from "../../runtime/model-display-name.mjs";
import { summarizeResponseUsage } from "./response-usage-summary.js";
import type {
  RequestInterruptionSummary,
  ResponseUsageSummary,
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
  toStoredCompactSummary,
  toStoredMetric,
  toStoredRequestOutcomes,
  toStoredMetricsAggregate,
  toStoredMetricsGroup,
  toStoredThreadAggregate,
  toStoredTurnSummary,
  type AggregateRow,
  type CacheUsageRow,
  type ErrorGroupRow,
  type ErrorSummaryRow,
  type MetricRow,
  type TurnSummaryRow,
  type RequestOutcomeRow,
} from "./sqlite-request-metrics-row-codec.js";

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
const observableCompletionSql = "status = 'completed'";
const compactAggregateSql = `
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
const cacheUsageSql = `
  SUM(CASE WHEN input_tokens IS NOT NULL THEN cached_input_tokens END) AS known_cached_input_tokens,
  SUM(CASE WHEN cached_input_tokens IS NOT NULL THEN input_tokens END) AS cache_observed_input_tokens,
  SUM(CASE WHEN input_tokens IS NULL OR cached_input_tokens IS NULL THEN 1 ELSE 0 END) AS cache_missing_request_count
`;
const metricsAggregateSql = `
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

function requestOutcomeSql(condition = "1", prefix = ""): string {
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

interface MetricsQueryReader {
  prepare: DatabaseSync["prepare"];
  iterateRows(sql: string, ...parameters: SQLInputValue[]): Iterable<Record<string, SQLOutputValue>>;
  requireOpen(): void;
}

/** 只读查询共用 Store 的连接和生命周期，不持有事务、写入口或独立连接。 */
export class SqliteRequestMetricsQueries {
  constructor(private readonly reader: MetricsQueryReader) {}

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
    const displayModelSql = "COALESCE(model_aliases.display_name, model_request_metrics.model)";
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
    this.reader.requireOpen();
    if (!threadId.trim() || threadId.length > 128) {
      throw new Error("Thread ID 无效");
    }
    const latestTurn = this.reader.prepare(`
      SELECT turn_id
      FROM model_request_metrics
      WHERE thread_id = ? AND turn_id IS NOT NULL AND operation = 'response'
      ORDER BY id DESC
      LIMIT 1
    `).get(threadId) as { turn_id: string } | undefined;
    const turn = latestTurn === undefined
      ? undefined
      : this.queryThreadTurnSummary(threadId, latestTurn.turn_id);
    const scopeSql = `
      WITH RECURSIVE thread_tree(thread_id) AS (
        SELECT ?
        UNION
        SELECT child.thread_id
        FROM subagent_threads AS child
        JOIN thread_tree AS parent
          ON child.parent_thread_id = parent.thread_id
      ), scoped AS (
        SELECT metric.*
        FROM model_request_metrics AS metric
        WHERE metric.thread_id IN (SELECT thread_id FROM thread_tree)
          AND metric.turn_id IS NOT NULL
      )
    `;
    const threadAggregate = this.reader.prepare(`${scopeSql}
      SELECT
        ${requestOutcomeSql()},
        (SELECT provider FROM scoped ORDER BY id DESC LIMIT 1) AS provider,
        NULL AS turn_id,
        COUNT(DISTINCT thread_id || char(0) || turn_id) AS turn_count,
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
        ${compactAggregateSql}
      FROM scoped
    `).get(threadId) as unknown as TurnSummaryRow;
    const sessionTiming = this.sessionExecutionTiming(threadId);
    return {
      threadId,
      sessionTiming,
      latestExecution: this.reader.prepare(`SELECT turn_id AS turnId, duration_ms AS durationMs
        FROM turn_execution_metrics WHERE thread_id = ? ORDER BY ordinal DESC LIMIT 1`).get(threadId) as
        { turnId: string; durationMs: number | null } | undefined ?? null,
      sessionDurationMs: sessionTiming.historyComplete && sessionTiming.missingTurnCount === 0 ? sessionTiming.knownDurationMs : null,
      latestTurn: turn === undefined ? null : {
        ...toStoredTurnSummary(turn),
        interruptionSummary: this.turnInterruptionSummary(threadId, latestTurn!.turn_id),
        durationMs: this.turnExecutionDuration(threadId, latestTurn!.turn_id),
        responseUsage: this.turnResponseUsage(threadId, latestTurn!.turn_id),
        performance: this.turnPerformance(threadId, latestTurn!.turn_id),
      },
      threadAggregate: threadAggregate.request_count === 0
        ? null
        : {
          ...toStoredThreadAggregate(threadAggregate),
          performance: this.scopedPerformance(scopeSql, [threadId]),
          interruptionSummary: this.queryInterruptionSummary(scopeSql, [threadId]),
          responseUsage: this.scopedResponseUsage(scopeSql, [threadId]),
        },
    };
  }

  threadTurnTaskSummary(
    threadId: string,
    turnId: string,
  ): StoredTurnRequestMetricsSummary | null {
    this.reader.requireOpen();
    validateThreadId(threadId, "Thread ID");
    validateThreadId(turnId, "Turn ID");
    const child = this.reader.prepare(`
      SELECT 1
      FROM subagent_turns
      WHERE parent_thread_id = ?
        AND parent_turn_id = ?
      LIMIT 1
    `).get(threadId, turnId);
    if (child === undefined) return null;
    const scopeSql = `
      WITH RECURSIVE task_threads(thread_id, turn_id) AS (
        SELECT child.thread_id, child.turn_id
        FROM subagent_turns AS child
        WHERE child.parent_thread_id = ?
          AND child.parent_turn_id = ?
        UNION
        SELECT child.thread_id, child.turn_id
        FROM subagent_turns AS child
        JOIN task_threads AS parent
          ON child.parent_thread_id = parent.thread_id
          AND child.parent_turn_id = parent.turn_id
      ), scoped AS (
        SELECT metric.*
        FROM model_request_metrics AS metric
        WHERE (
          metric.thread_id = ? AND metric.turn_id = ?
        ) OR (
          EXISTS (
            SELECT 1
            FROM task_threads AS task
            WHERE task.thread_id = metric.thread_id
              AND task.turn_id = metric.turn_id
          )
        )
      )
    `;
    const row = this.reader.prepare(`${scopeSql}
      SELECT
        ${requestOutcomeSql()},
        (SELECT provider FROM scoped ORDER BY id DESC LIMIT 1) AS provider,
        (SELECT model FROM scoped ORDER BY id DESC LIMIT 1) AS model,
        (SELECT reasoning_effort FROM scoped ORDER BY id DESC LIMIT 1)
          AS reasoning_effort,
        ? AS turn_id,
        COUNT(DISTINCT thread_id || char(0) || turn_id) AS turn_count,
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
        ${compactAggregateSql}
      FROM scoped
    `).get(threadId, turnId, threadId, turnId, turnId) as TurnSummaryRow | undefined;
    // The direct-child probe above is the display gate. Keep a zero summary
    // when a child has not produced any model rows yet so the parent card can
    // distinguish an observed child from an absent task aggregate.
    return row === undefined ? null : {
      ...toStoredTurnSummary(row),
      interruptionSummary: this.queryInterruptionSummary(scopeSql, [threadId, turnId, threadId, turnId]),
      responseUsage: this.scopedResponseUsage(scopeSql, [threadId, turnId, threadId, turnId]),
    };
  }

  threadTurnSummary(
    threadId: string,
    turnId: string,
  ): StoredTurnRequestMetricsSummary | null {
    this.reader.requireOpen();
    validateThreadId(threadId, "Thread ID");
    validateThreadId(turnId, "Turn ID");
    const row = this.queryThreadTurnSummary(threadId, turnId);
    return row === undefined ? null : {
      ...toStoredTurnSummary(row),
      interruptionSummary: this.turnInterruptionSummary(threadId, turnId),
      durationMs: this.turnExecutionDuration(threadId, turnId),
      responseUsage: this.turnResponseUsage(threadId, turnId),
      performance: this.turnPerformance(threadId, turnId),
    };
  }

  private turnPerformance(threadId: string, turnId: string): RequestTimingSummary {
    return this.scopedPerformance(`WITH scoped AS (
      SELECT * FROM model_request_metrics WHERE thread_id = ? AND turn_id = ?
    )`, [threadId, turnId]);
  }

  private scopedPerformance(scopeSql: string, parameters: SQLInputValue[]): RequestTimingSummary {
    return this.reader.prepare(`${scopeSql}, performance_samples AS (
      SELECT first_token_ms, output_tokens,
        total_duration_ms AS request_duration_ms,
        status = 'completed' AND output_tokens > 0
          AND total_duration_ms > 0 AS valid_speed
      FROM scoped WHERE source = 'owned' AND operation = 'response'
    )
      SELECT COUNT(*) AS requestCount, COUNT(first_token_ms) AS firstTokenSampleCount,
        AVG(first_token_ms) AS averageFirstTokenMs,
        1000.0 * SUM(output_tokens) FILTER (WHERE valid_speed)
          / SUM(request_duration_ms) FILTER (WHERE valid_speed) AS generationTokensPerSecond
      FROM performance_samples
    `).get(...parameters) as unknown as RequestTimingSummary;
  }

  private scopedResponseUsage(scopeSql: string, parameters: SQLInputValue[]): ResponseUsageSummary | null {
    return summarizeResponseUsage(this.reader.iterateRows(`${scopeSql}
      SELECT response_usage_amount FROM scoped WHERE provider = 'openai'
    `, ...parameters) as Iterable<{ response_usage_amount: string | null }>);
  }

  turnExecutionDuration(threadId: string, turnId: string): number | null {
    this.reader.requireOpen();
    validateThreadId(threadId, "Thread ID");
    validateThreadId(turnId, "Turn ID");
    const row = this.reader.prepare("SELECT duration_ms FROM turn_execution_metrics WHERE thread_id = ? AND turn_id = ?")
      .get(threadId, turnId) as { duration_ms: number | null } | undefined;
    return row?.duration_ms ?? null;
  }

  sessionExecutionDuration(threadId: string, throughTurnId?: string): number | null {
    const timing = this.sessionExecutionTiming(threadId, throughTurnId);
    return timing.historyComplete && timing.missingTurnCount === 0 ? timing.knownDurationMs : null;
  }

  sessionExecutionTiming(threadId: string, throughTurnId?: string): SessionExecutionTiming {
    this.reader.requireOpen();
    validateThreadId(threadId, "Thread ID");
    if (throughTurnId !== undefined) validateThreadId(throughTurnId, "Turn ID");
    const row = this.reader.prepare(`SELECT TOTAL(duration_ms) AS duration_ms,
      (SELECT history_complete FROM thread_execution_state WHERE thread_id = ?) AS history_complete,
      COUNT(*) AS total, COUNT(duration_ms) AS known FROM turn_execution_metrics
      WHERE thread_id = ?
      ${throughTurnId === undefined ? "" : "AND ordinal <= (SELECT ordinal FROM turn_execution_metrics WHERE thread_id = ? AND turn_id = ?)"}`)
      .get(threadId, threadId, ...(throughTurnId === undefined ? [] : [threadId, throughTurnId])) as {
        duration_ms: number | null; total: number; known: number; history_complete: number | null;
      };
    return {
      knownDurationMs: row.known > 0 && Number.isSafeInteger(row.duration_ms) ? row.duration_ms : null,
      missingTurnCount: row.total - row.known,
      historyComplete: row.history_complete === 1 && row.total > 0,
    };
  }

  private turnResponseUsage(threadId: string, turnId: string): ResponseUsageSummary | null {
    return this.scopedResponseUsage(`WITH scoped AS (
      SELECT provider, response_usage_amount FROM model_request_metrics WHERE thread_id = ? AND turn_id = ?
    )`, [threadId, turnId]);
  }

  private turnInterruptionSummary(threadId: string, turnId: string): RequestInterruptionSummary {
    return this.queryInterruptionSummary(`WITH scoped AS (
      SELECT * FROM model_request_metrics WHERE thread_id = ? AND turn_id = ?
    )`, [threadId, turnId]);
  }

  private queryInterruptionSummary(scopeSql: string, parameters: SQLInputValue[]): RequestInterruptionSummary {
    return interruptionFromRow(this.queryInterruptionRows(scopeSql, parameters)[0]!);
  }

  private queryInterruptionRows(scopeSql: string, parameters: SQLInputValue[], byTurn = false): InterruptionRow[] {
    // Rows may be persisted out of completion order. The window observes only
    // the selected scope and compares real response completion times.
    return this.reader.prepare(`${scopeSql}, observed AS (
      SELECT *, MAX(CASE WHEN ${observableCompletionSql} THEN response_completed_at_ms END)
        OVER (PARTITION BY thread_id, turn_id) AS latest_completion_at_ms
      FROM scoped
    )
    SELECT ${byTurn ? "turn_id," : ""}
      COUNT(CASE WHEN thread_id IS NOT NULL AND turn_id IS NOT NULL AND TRIM(turn_id) <> ''
        AND latest_completion_at_ms > response_completed_at_ms THEN 1 END) AS followed_by_completion,
      COUNT(*) - COUNT(CASE WHEN thread_id IS NOT NULL AND turn_id IS NOT NULL AND TRIM(turn_id) <> ''
        AND latest_completion_at_ms > response_completed_at_ms THEN 1 END) AS no_observed_completion,
      COUNT(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 END) AS usage_unobserved
    FROM observed
    WHERE NOT (${observableCompletionSql}) AND error_type = 'client_disconnected'
    ${byTurn ? "GROUP BY turn_id" : ""}
    `).all(...parameters) as unknown as InterruptionRow[];
  }

  private queryThreadTurnSummary(
    threadId: string,
    turnId: string,
  ): TurnSummaryRow | undefined {
    return this.reader.prepare(`
      SELECT
        ${requestOutcomeSql()},
        (
          SELECT upstream_ttft_ms FROM model_request_metrics AS first_timing
          WHERE first_timing.thread_id = model_request_metrics.thread_id
            AND first_timing.turn_id = model_request_metrics.turn_id
            AND first_timing.provider = 'openai'
            AND first_timing.operation = 'response'
            AND first_timing.upstream_ttft_ms IS NOT NULL
          ORDER BY first_timing.id LIMIT 1
        ) AS upstream_ttft_ms,
        (
          SELECT provider
          FROM model_request_metrics AS latest_provider
          WHERE latest_provider.thread_id
              = model_request_metrics.thread_id
            AND latest_provider.turn_id
              = model_request_metrics.turn_id
            AND latest_provider.operation = 'response'
          ORDER BY latest_provider.id DESC
          LIMIT 1
        ) AS provider,
        (
          SELECT model
          FROM model_request_metrics AS latest_model
          WHERE latest_model.thread_id
              = model_request_metrics.thread_id
            AND latest_model.turn_id
              = model_request_metrics.turn_id
            AND latest_model.operation = 'response'
          ORDER BY latest_model.id DESC
          LIMIT 1
        ) AS model,
        (
          SELECT reasoning_effort
          FROM model_request_metrics AS latest_effort
          WHERE latest_effort.thread_id
              = model_request_metrics.thread_id
            AND latest_effort.turn_id
              = model_request_metrics.turn_id
            AND latest_effort.operation = 'response'
          ORDER BY latest_effort.id DESC
          LIMIT 1
        ) AS reasoning_effort,
        turn_id,
        COUNT(DISTINCT turn_id) AS turn_count,
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
        ${compactAggregateSql}
      FROM model_request_metrics
      WHERE thread_id = ? AND turn_id = ?
      GROUP BY turn_id
    `).get(threadId, turnId) as TurnSummaryRow | undefined;
  }

  threadTurnSummaries(threadId: string, query: ModelRequestMetricsThreadQuery): StoredThreadTurnsPage {
    validateThreadId(threadId, "Thread ID");
    if (query.threadId !== undefined && query.threadId !== threadId) {
      throw new Error("Thread ID 与查询范围不一致");
    }
    const { rows, ...page } = this.queryThreadTurnPage({ ...query, threadId });
    const subagentCounts = this.turnDirectSubagentCounts(threadId, rows.map((row) => row.turn_id!));
    const scope = metricsScopeSql({ ...query, threadId });
    const interruptions = rows.length === 0 ? [] : this.queryInterruptionRows(`WITH scoped AS (
      SELECT * FROM model_request_metrics WHERE ${scope.sql}
        AND turn_id IN (${rows.map(() => "?").join(", ")})
    )`, [...scope.params, ...rows.map((row) => row.turn_id!)], true);
    const interruptionByTurn = new Map(interruptions.map((row) => [row.turn_id, interruptionFromRow(row)]));
    return {
      ...page,
      ...this.threadTreeAggregates(threadId, query),
      turns: rows.map((row) => ({
        ...toStoredTurnSummary(row),
        interruptionSummary: interruptionByTurn.get(row.turn_id!) ?? emptyInterruptionSummary(),
        durationMs: row.duration_ms,
        recordedAtMs: row.recorded_at_ms,
        directSubagentCount: subagentCounts.get(row.turn_id!) ?? 0,
      })),
    };
  }

  private threadTreeAggregates(
    threadId: string,
    query: ModelRequestMetricsThreadQuery,
  ): Pick<StoredThreadTurnsPage, "subagentTurnCount" | "subagentAggregate" | "treeAggregate"> {
    // An own Turn filter does not establish which descendant Turns belong to it.
    if (query.turnId !== undefined) return { subagentTurnCount: null, subagentAggregate: null, treeAggregate: null };
    const scope = metricsScopeSql({ ...query, threadId }, true);
    const cte = `WITH RECURSIVE tree(thread_id) AS (
      SELECT ?
      UNION
      SELECT child.thread_id FROM tree
      JOIN subagent_threads AS child ON child.parent_thread_id = tree.thread_id
    ), scoped AS (
      SELECT * FROM model_request_metrics
      WHERE ${scope.sql} AND turn_id IS NOT NULL
        AND thread_id IN (SELECT thread_id FROM tree)
    )`;
    const parameters = [threadId, ...scope.params];
    const treeSummary = this.reader.prepare(`
      ${cte} SELECT ${metricsAggregateSql} FROM scoped
    `).get(...parameters) as unknown as AggregateRow;
    const subagentSummary = this.reader.prepare(`
      ${cte}, descendants AS (SELECT * FROM scoped WHERE thread_id != ?)
      SELECT ${metricsAggregateSql},
        (SELECT COUNT(*) FROM (SELECT DISTINCT thread_id, turn_id FROM descendants)) AS turn_count
      FROM descendants
    `).get(...parameters, threadId) as unknown as AggregateRow & { turn_count: number };
    return {
      subagentTurnCount: subagentSummary.turn_count,
      subagentAggregate: subagentSummary.request_count === 0 ? null : toStoredMetricsAggregate(subagentSummary),
      treeAggregate: treeSummary.request_count === 0 ? null : toStoredMetricsAggregate(treeSummary),
    };
  }

  threadTurnCount(threadId: string): number | null {
    this.reader.requireOpen();
    if (!threadId.trim() || threadId.length > 128) {
      throw new Error("Thread ID 无效");
    }
    const row = this.reader.prepare(`
      SELECT COUNT(DISTINCT turn_id) AS turn_count, COUNT(*) AS request_count
      FROM model_request_metrics
      WHERE thread_id = ? AND turn_id IS NOT NULL
    `).get(threadId) as { turn_count: number; request_count: number };
    return row.request_count === 0 ? null : row.turn_count;
  }

  threadCounts(query: ModelRequestMetricsScope): { threadCount: number; turnCount: number } {
    this.reader.requireOpen();
    const scope = metricsScopeSql(query);
    return this.reader.prepare(`
      SELECT COUNT(DISTINCT thread_id) AS threadCount, COUNT(*) AS turnCount
      FROM (
        SELECT DISTINCT thread_id, turn_id FROM model_request_metrics
        WHERE ${scope.sql} AND thread_id IS NOT NULL AND turn_id IS NOT NULL
      )
    `).get(...scope.params) as { threadCount: number; turnCount: number };
  }

  threadList(query: ModelRequestMetricsThreadQuery): StoredThreadListPage {
    const { rows, ...page } = this.queryThreadListPage(query);
    const threadIds = rows.map((row) => row.root_thread_id);
    const subagentCounts = this.directSubagentCounts(threadIds);
    const timings = this.threadSessionTimings(threadIds);
    return {
      ...page,
      threads: rows.map((row) => ({
        cacheUsage: row.request_count === null
          ? { inputTokens: 0, cachedInputTokens: null, missingRequestCount: 0 }
          : toStoredCacheUsage(row),
        sessionTiming: timings.get(row.root_thread_id) ?? { knownDurationMs: null, missingTurnCount: 0, historyComplete: false },
        threadId: row.root_thread_id,
        provider: row.provider ?? null,
        model: row.model ?? null,
        reasoningEffort: row.reasoning_effort ?? null,
        agentPath: row.agent_path,
        parentThreadId: row.parent_thread_id,
        parentTurnId: row.parent_turn_id,
        directSubagentCount: subagentCounts.get(row.root_thread_id) ?? 0,
        turnCount: row.turn_count ?? 0,
        requestCount: row.request_count ?? 0,
        requestOutcomes: toStoredRequestOutcomes(row),
        inputTokens: row.input_tokens ?? 0,
        outputTokens: row.output_tokens ?? 0,
        cachedInputTokens: row.request_count === null ? 0
          : row.cache_missing_request_count === 0 ? row.cached_input_tokens ?? 0 : null,
        subagentUsage: {
          inputTokens: row.subagent_input_tokens ?? 0,
          cachedInputTokens: row.subagent_cache_missing_request_count === 0
            ? row.subagent_cached_input_tokens ?? 0 : null,
          outputTokens: row.subagent_output_tokens ?? 0,
          cacheUsage: toStoredCacheUsage({
            known_cached_input_tokens: row.subagent_known_cached_input_tokens,
            cache_observed_input_tokens: row.subagent_cache_observed_input_tokens,
            cache_missing_request_count: row.subagent_cache_missing_request_count,
          }),
        },
        totalTokens: row.total_tokens,
        compact: row.request_count === null ? null : toStoredCompactSummary(row),
        firstRequestStartedAtMs: row.first_request_started_at_ms ?? row.tree_first_request_started_at_ms,
        lastRecordedAtMs: row.recorded_at_ms ?? row.tree_recorded_at_ms,
      })),
    };
  }

  private queryThreadListPage(query: ModelRequestMetricsThreadQuery) {
    this.reader.requireOpen();
    // Thread ID selects the root unless an exact own Turn is requested. Other
    // filters (including keyword searches) apply to descendant requests as well.
    const scope = metricsScopeSql(query, true);
    const offset = metricsPageOffset(query);
    const sortColumns = {
      time: "COALESCE(grouped.first_request_started_at_ms, tree_grouped.tree_first_request_started_at_ms)",
      last: "COALESCE(grouped.recorded_at_ms, tree_grouped.tree_recorded_at_ms)",
      thread: "tree_grouped.root_thread_id", turn: "grouped.turn_id",
      provider: "latest.provider", model: "latest.model", turns: "COALESCE(grouped.turn_count, 0)",
      requests: "COALESCE(grouped.request_count, 0)", failures: "COALESCE(grouped.failed_request_count, 0)",
      input: "COALESCE(grouped.input_tokens, 0)", output: "COALESCE(grouped.output_tokens, 0)",
      compact: "COALESCE(grouped.compact_request_count, 0)",
      totalTokens: "tree_grouped.total_tokens",
    };
    const sortColumn = sortColumns[query.sortKey ?? "last"];
    const direction = query.sortDirection ?? "desc";
    if (sortColumn === undefined || !["asc", "desc"].includes(direction)) {
      throw new Error("会话指标排序无效");
    }
    const parameters = [...scope.params, ...(query.threadId === undefined ? [] : [query.threadId])];
    // Unfiltered Thread lists retain their own-request membership. Main lists also
    // include registered parents whose only matching activity belongs to children.
    const cte = `WITH RECURSIVE scoped AS (
        SELECT * FROM model_request_metrics
        WHERE ${scope.sql} AND thread_id IS NOT NULL AND turn_id IS NOT NULL
      ), ancestors(thread_id) AS (
        SELECT DISTINCT thread_id FROM scoped
        UNION
        SELECT relation.parent_thread_id
        FROM ancestors JOIN subagent_threads AS relation ON relation.thread_id = ancestors.thread_id
      ), candidates AS (
        SELECT DISTINCT candidate.thread_id FROM ${query.mainThreadsOnly ? "ancestors" : "scoped"} AS candidate
        WHERE ${query.threadId === undefined ? "1 = 1" : "thread_id = ?"}
          ${query.mainThreadsOnly ? "AND NOT EXISTS (SELECT 1 FROM subagent_threads WHERE subagent_threads.thread_id = candidate.thread_id)" : ""}
      ), tree(root_thread_id, thread_id) AS (
        SELECT thread_id, thread_id FROM candidates
        UNION
        SELECT tree.root_thread_id, child.thread_id
        FROM tree JOIN subagent_threads AS child ON child.parent_thread_id = tree.thread_id
      ), tree_scoped AS (
        SELECT tree.root_thread_id, scoped.*
        FROM tree JOIN scoped ON scoped.thread_id = tree.thread_id
      ), tree_grouped AS (
        SELECT root_thread_id,
          SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS total_tokens,
          SUM(CASE WHEN thread_id != root_thread_id THEN input_tokens END) AS subagent_input_tokens,
          SUM(CASE WHEN thread_id != root_thread_id THEN cached_input_tokens END) AS subagent_cached_input_tokens,
          SUM(CASE WHEN thread_id != root_thread_id THEN output_tokens END) AS subagent_output_tokens,
          SUM(CASE WHEN thread_id != root_thread_id AND input_tokens IS NOT NULL
            THEN cached_input_tokens END) AS subagent_known_cached_input_tokens,
          SUM(CASE WHEN thread_id != root_thread_id AND cached_input_tokens IS NOT NULL
            THEN input_tokens END) AS subagent_cache_observed_input_tokens,
          SUM(CASE WHEN thread_id != root_thread_id AND (input_tokens IS NULL OR cached_input_tokens IS NULL)
            THEN 1 ELSE 0 END) AS subagent_cache_missing_request_count,
          MIN(request_started_at_ms) AS tree_first_request_started_at_ms,
          MAX(recorded_at_ms) AS tree_recorded_at_ms
        FROM tree_scoped GROUP BY root_thread_id
      )`;
    const summary = this.reader.prepare(`
      ${cte}
      SELECT ${metricsAggregateSql},
        (SELECT COUNT(*) FROM tree_grouped) AS thread_count,
        COUNT(DISTINCT thread_id || char(0) || turn_id) AS turn_count
      FROM scoped WHERE thread_id IN (SELECT root_thread_id FROM tree_grouped)
    `).get(...parameters) as unknown as AggregateRow & { thread_count: number; turn_count: number };
    const treeSummary = this.reader.prepare(`
      ${cte}
      SELECT ${metricsAggregateSql}
      FROM scoped WHERE id IN (SELECT id FROM tree_scoped)
    `).get(...parameters) as unknown as AggregateRow;
    const rows = this.reader.prepare(`
      ${cte}, grouped AS (
        SELECT thread_id, turn_id, COUNT(DISTINCT turn_id) AS turn_count,
          ${metricsAggregateSql},
          MIN(request_started_at_ms) AS first_request_started_at_ms,
          MAX(recorded_at_ms) AS recorded_at_ms, MAX(id) AS latest_id
        FROM scoped WHERE thread_id IN (SELECT root_thread_id FROM tree_grouped)
        GROUP BY thread_id
      )
      SELECT grouped.*, tree_grouped.*, latest.provider, latest.model, latest.reasoning_effort,
        subagent.agent_path, subagent.parent_thread_id, subagent.parent_turn_id
      FROM tree_grouped
      LEFT JOIN grouped ON grouped.thread_id = tree_grouped.root_thread_id
      LEFT JOIN model_request_metrics AS latest ON latest.id = grouped.latest_id
      LEFT JOIN subagent_threads AS subagent ON subagent.thread_id = tree_grouped.root_thread_id
      ORDER BY ${sortColumn} ${direction}, tree_grouped.root_thread_id ${direction}
      LIMIT ? OFFSET ?
    `).all(...parameters, query.limit, offset) as unknown as Array<TurnSummaryRow & CacheUsageRow & {
      root_thread_id: string;
      first_request_started_at_ms: number | null;
      recorded_at_ms: number | null;
      total_tokens: number;
      subagent_input_tokens: number | null;
      subagent_cached_input_tokens: number | null;
      subagent_output_tokens: number | null;
      subagent_known_cached_input_tokens: number | null;
      subagent_cache_observed_input_tokens: number | null;
      subagent_cache_missing_request_count: number;
      tree_first_request_started_at_ms: number;
      tree_recorded_at_ms: number;
      agent_path: string | null;
      parent_thread_id: string | null;
      parent_turn_id: string | null;
    }>;
    return {
      rows,
      matchedTotal: summary.thread_count,
      nextOffset: offset + rows.length < summary.thread_count ? offset + rows.length : null,
      aggregate: summary.request_count === 0 ? null : toStoredMetricsAggregate(summary),
      treeAggregate: treeSummary.request_count === 0 ? null : toStoredMetricsAggregate(treeSummary),
      turnCount: summary.turn_count,
    };
  }

  private threadSessionTimings(threadIds: string[]): Map<string, SessionExecutionTiming> {
    if (threadIds.length === 0) return new Map();
    const rows = this.reader.prepare(`
      SELECT timing.thread_id, TOTAL(timing.duration_ms) AS duration_ms,
        COUNT(*) AS total, COUNT(timing.duration_ms) AS known, state.history_complete
      FROM turn_execution_metrics AS timing
      LEFT JOIN thread_execution_state AS state ON state.thread_id = timing.thread_id
      WHERE timing.thread_id IN (${threadIds.map(() => "?").join(", ")})
      GROUP BY timing.thread_id
    `).all(...threadIds) as unknown as Array<{
      thread_id: string; duration_ms: number; total: number; known: number; history_complete: number | null;
    }>;
    return new Map(rows.map((row) => [row.thread_id, {
      knownDurationMs: row.known > 0 && Number.isSafeInteger(row.duration_ms) ? row.duration_ms : null,
      missingTurnCount: row.total - row.known,
      historyComplete: row.history_complete === 1 && row.total > 0,
    }]));
  }

  threadSubagents(threadId: string, query: SubagentThreadsQuery): StoredThreadSubagentsPage {
    validateThreadId(threadId, "Thread ID");
    return this.subagentPage(query, threadId);
  }

  subagents(query: SubagentThreadsQuery): StoredThreadSubagentsPage {
    return this.subagentPage(query);
  }

  private subagentPage(query: SubagentThreadsQuery, parentThreadId?: string): StoredThreadSubagentsPage {
    this.reader.requireOpen();
    if (query.parentTurnId !== undefined) {
      if (parentThreadId === undefined) throw new Error("父 Turn ID 必须同时指定父 Thread ID");
      validateThreadId(query.parentTurnId, "父 Turn ID");
    }
    const offset = metricsPageOffset(query);
    if (query.limit > 100) throw new Error("子代理查询数量必须在 1 到 100 之间");
    const sortKey = query.sortKey ?? "last";
    const direction = query.sortDirection ?? "desc";
    if (!["time", "last"].includes(sortKey) || !["asc", "desc"].includes(direction)) {
      throw new Error("子代理排序无效");
    }
    const sortColumn = sortKey === "time" ? "first_request_started_at_ms" : "last_recorded_at_ms";
    const relationFilter = parentThreadId === undefined ? "" : `WHERE relation.parent_thread_id = ?${
      query.parentTurnId === undefined ? "" : ` AND relation.thread_id IN (
        SELECT child.thread_id FROM subagent_turns AS child
        WHERE child.parent_thread_id = ?
          AND child.parent_turn_id = ?
      )`
    }`;
    const parameters = parentThreadId === undefined ? [] : [parentThreadId];
    if (query.parentTurnId !== undefined) parameters.push(parentThreadId!, query.parentTurnId);
    const { total } = this.reader.prepare(`
      SELECT COUNT(*) AS total FROM subagent_threads AS relation ${relationFilter}
    `).get(...parameters) as { total: number };
    const summary = this.reader.prepare(`
      SELECT COUNT(*) AS request_count,
        ${requestOutcomeSql()},
        COUNT(DISTINCT json_array(thread_id, turn_id)) FILTER (WHERE turn_id IS NOT NULL) AS turn_count,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, ${cacheUsageSql}
      FROM model_request_metrics
      WHERE thread_id IN (SELECT relation.thread_id FROM subagent_threads AS relation ${relationFilter})
    `).get(...parameters) as unknown as CacheUsageRow & RequestOutcomeRow & {
      request_count: number;
      turn_count: number;
      input_tokens: number | null;
      output_tokens: number | null;
    };
    const modelUsageRows = this.reader.prepare(`
      SELECT model, COUNT(*) AS request_count,
        COUNT(DISTINCT json_array(thread_id, turn_id)) FILTER (WHERE turn_id IS NOT NULL) AS turn_count,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens, ${cacheUsageSql}
      FROM model_request_metrics
      WHERE thread_id IN (SELECT relation.thread_id FROM subagent_threads AS relation ${relationFilter})
      GROUP BY model
      ORDER BY model IS NULL ASC, model ASC
    `).all(...parameters) as unknown as Array<CacheUsageRow & {
      model: string | null;
      request_count: number;
      turn_count: number;
      input_tokens: number | null;
      output_tokens: number | null;
    }>;
    const rows = this.reader.prepare(`
      WITH grouped AS (
        SELECT thread_id, COUNT(DISTINCT turn_id) AS turn_count,
          ${requestOutcomeSql()},
          COUNT(*) AS request_count, SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens, ${cacheUsageSql}, MAX(id) AS latest_id,
          MIN(request_started_at_ms) AS first_request_started_at_ms,
          MAX(recorded_at_ms) AS last_recorded_at_ms
        FROM model_request_metrics
        WHERE thread_id IN (SELECT relation.thread_id FROM subagent_threads AS relation ${relationFilter})
        GROUP BY thread_id
      )
      SELECT relation.*, grouped.turn_count, grouped.request_count,
        grouped.completed_request_count, grouped.interrupted_request_count,
        grouped.failed_request_count, grouped.incomplete_request_count,
        grouped.input_tokens, grouped.output_tokens, grouped.known_cached_input_tokens,
        grouped.cache_observed_input_tokens, grouped.cache_missing_request_count,
        grouped.first_request_started_at_ms, grouped.last_recorded_at_ms,
        latest.provider, latest.model, latest.reasoning_effort
      FROM subagent_threads AS relation
      LEFT JOIN grouped ON grouped.thread_id = relation.thread_id
      LEFT JOIN model_request_metrics AS latest ON latest.id = grouped.latest_id
      ${relationFilter}
      ORDER BY grouped.${sortColumn} IS NULL ASC, grouped.${sortColumn} ${direction}, relation.thread_id ASC
      LIMIT ? OFFSET ?
    `).all(...parameters, ...parameters, query.limit, offset) as unknown as Array<CacheUsageRow & RequestOutcomeRow & {
      thread_id: string;
      parent_thread_id: string;
      parent_turn_id: string | null;
      agent_path: string;
      recorded_at_ms: number;
      provider: string | null;
      model: string | null;
      reasoning_effort: string | null;
      turn_count: number | null;
      request_count: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      first_request_started_at_ms: number | null;
      last_recorded_at_ms: number | null;
    }>;
    const counts = this.directSubagentCounts(rows.map((row) => row.thread_id));
    return {
      subagents: rows.map((row) => ({
          threadId: row.thread_id,
          parentThreadId: row.parent_thread_id,
          parentTurnId: row.parent_turn_id,
          agentPath: row.agent_path,
          recordedAtMs: row.recorded_at_ms,
          directSubagentCount: counts.get(row.thread_id) ?? 0,
          provider: row.provider,
          model: row.model,
          reasoningEffort: row.reasoning_effort,
          turnCount: row.turn_count ?? 0,
          requestCount: row.request_count ?? 0,
          requestOutcomes: toStoredRequestOutcomes(row),
          inputTokens: row.input_tokens ?? 0,
          outputTokens: row.output_tokens ?? 0,
          firstRequestStartedAtMs: row.first_request_started_at_ms,
          lastRecordedAtMs: row.last_recorded_at_ms,
          cacheUsage: row.request_count === null
            ? { inputTokens: 0, cachedInputTokens: null, missingRequestCount: 0 }
            : toStoredCacheUsage(row),
      })),
      summary: {
        requestCount: summary.request_count,
        requestOutcomes: toStoredRequestOutcomes(summary),
        turnCount: summary.turn_count,
        inputTokens: summary.input_tokens ?? 0,
        outputTokens: summary.output_tokens ?? 0,
        cacheUsage: summary.request_count === 0
          ? { inputTokens: 0, cachedInputTokens: null, missingRequestCount: 0 }
          : toStoredCacheUsage(summary),
      },
      modelUsage: modelUsageRows.map((row) => ({
        model: row.model,
        requestCount: row.request_count,
        turnCount: row.turn_count,
        inputTokens: row.input_tokens ?? 0,
        outputTokens: row.output_tokens ?? 0,
        cacheUsage: toStoredCacheUsage(row),
      })),
      total,
      offset,
      limit: query.limit,
      nextOffset: offset + rows.length < total ? offset + rows.length : null,
    };
  }

  private directSubagentCounts(threadIds: string[]): Map<string, number> {
    if (threadIds.length === 0) return new Map();
    const rows = this.reader.prepare(`
      SELECT parent_thread_id, COUNT(*) AS total FROM subagent_threads
      WHERE parent_thread_id IN (${threadIds.map(() => "?").join(", ")})
      GROUP BY parent_thread_id
    `).all(...threadIds) as Array<{ parent_thread_id: string; total: number }>;
    return new Map(rows.map((row) => [row.parent_thread_id, row.total]));
  }

  private turnDirectSubagentCounts(threadId: string, turnIds: string[]): Map<string, number> {
    if (turnIds.length === 0) return new Map();
    const rows = this.reader.prepare(`
      SELECT child.parent_turn_id, COUNT(DISTINCT child.thread_id) AS total
      FROM subagent_turns AS child
      JOIN subagent_threads AS relation
        ON relation.thread_id = child.thread_id AND relation.parent_thread_id = child.parent_thread_id
      WHERE child.parent_thread_id = ?
        AND child.parent_turn_id IN (${turnIds.map(() => "?").join(", ")})
      GROUP BY child.parent_turn_id
    `).all(threadId, ...turnIds) as Array<{ parent_turn_id: string; total: number }>;
    return new Map(rows.map((row) => [row.parent_turn_id, row.total]));
  }

  private queryThreadTurnPage(query: ModelRequestMetricsThreadQuery) {
    this.reader.requireOpen();
    const scope = metricsScopeSql(query);
    const offset = metricsPageOffset(query);
    const sortKey = query.sortKey ?? "last";
    const sortColumns = {
      time: "recorded_at_ms",
      last: "recorded_at_ms", thread: "grouped.thread_id", turn: "grouped.turn_id",
      provider: "latest.provider", model: "latest.model", turns: "turn_count",
      requests: "request_count", failures: "failed_request_count",
      input: "input_tokens", output: "output_tokens", compact: "compact_request_count",
      totalTokens: undefined,
    };
    const sortColumn = sortColumns[sortKey];
    const direction = query.sortDirection ?? "desc";
    if (sortColumn === undefined || !["asc", "desc"].includes(direction)) {
      throw new Error("会话指标排序无效");
    }
    const scoped = `SELECT * FROM model_request_metrics
      WHERE ${scope.sql} AND thread_id IS NOT NULL AND turn_id IS NOT NULL`;
    const summary = this.reader.prepare(`
      SELECT ${metricsAggregateSql},
        COUNT(DISTINCT thread_id || char(0) || turn_id) AS turn_count
      FROM (${scoped})
    `).get(...scope.params) as unknown as AggregateRow & { turn_count: number };
    const matchedTotal = summary.turn_count;
    const rows = this.reader.prepare(`
      WITH scoped AS (${scoped}), grouped AS (
        SELECT thread_id, turn_id, COUNT(DISTINCT turn_id) AS turn_count,
          ${metricsAggregateSql},
          MIN(request_started_at_ms) AS first_request_started_at_ms,
          MAX(recorded_at_ms) AS recorded_at_ms,
          MAX(id) AS latest_id
        FROM scoped
        GROUP BY turn_id
      )
      SELECT grouped.*, latest.provider, latest.model, latest.reasoning_effort,
        timing.duration_ms,
        subagent.agent_path, subagent.parent_thread_id, subagent.parent_turn_id
      FROM grouped
      JOIN model_request_metrics AS latest ON latest.id = grouped.latest_id
      LEFT JOIN turn_execution_metrics AS timing ON timing.thread_id = grouped.thread_id AND timing.turn_id = grouped.turn_id
      LEFT JOIN subagent_threads AS subagent ON subagent.thread_id = grouped.thread_id
      ORDER BY ${sortColumn} ${direction}, grouped.turn_id ${direction}
      LIMIT ? OFFSET ?
    `).all(...scope.params, query.limit, offset) as unknown as Array<TurnSummaryRow & CacheUsageRow & {
      thread_id: string;
      duration_ms: number | null;
      first_request_started_at_ms: number;
      recorded_at_ms: number;
      agent_path: string | null;
      parent_thread_id: string | null;
      parent_turn_id: string | null;
    }>;
    return {
      rows,
      matchedTotal,
      nextOffset: offset + rows.length < matchedTotal ? offset + rows.length : null,
      aggregate: summary.request_count === 0 ? null : toStoredMetricsAggregate(summary),
      turnCount: summary.turn_count,
    };
  }

  subagentThread(threadId: string): {
    agentPath: string | null;
    parentThreadId: string | null;
    parentTurnId: string | null;
  } {
    this.reader.requireOpen();
    if (!threadId.trim() || threadId.length > 128) {
      throw new Error("Thread ID 无效");
    }
    const row = this.reader.prepare(`
      SELECT agent_path, parent_thread_id, parent_turn_id
      FROM subagent_threads
      WHERE thread_id = ?
    `).get(threadId) as {
      agent_path: string;
      parent_thread_id: string;
      parent_turn_id: string | null;
    } | undefined;
    return {
      agentPath: row?.agent_path ?? null,
      parentThreadId: row?.parent_thread_id ?? null,
      parentTurnId: row?.parent_turn_id ?? null,
    };
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
    this.reader.requireOpen();
    if (!Number.isInteger(recordedAtMs) || recordedAtMs < 0) {
      throw new Error("子代理同步水位必须是大于等于 0 的整数");
    }
    if (afterThreadId !== undefined && afterThreadId.length === 0) {
      throw new Error("子代理同步游标 Thread ID 不能为空");
    }
    const rows = this.reader.prepare(`
      SELECT thread_id, parent_thread_id, parent_turn_id, agent_path, recorded_at_ms
      FROM subagent_threads
      WHERE recorded_at_ms > ? OR (recorded_at_ms = ? AND thread_id > ?)
      ORDER BY recorded_at_ms ASC, thread_id ASC
      LIMIT 1000
    `).all(recordedAtMs, recordedAtMs, afterThreadId ?? "") as unknown as Array<{
      thread_id: string;
      parent_thread_id: string;
      parent_turn_id: string | null;
      agent_path: string;
      recorded_at_ms: number;
    }>;
    return rows.map((row) => ({
      threadId: row.thread_id,
      parentThreadId: row.parent_thread_id,
      parentTurnId: row.parent_turn_id,
      agentPath: row.agent_path,
      recordedAtMs: row.recorded_at_ms,
    }));
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

interface InterruptionRow {
  turn_id?: string;
  followed_by_completion: number;
  no_observed_completion: number;
  usage_unobserved: number;
}

function emptyInterruptionSummary(): RequestInterruptionSummary {
  return { followedByCompletion: 0, noObservedCompletion: 0, usageUnobserved: 0 };
}

function interruptionFromRow(row: InterruptionRow): RequestInterruptionSummary {
  return {
    followedByCompletion: row.followed_by_completion,
    noObservedCompletion: row.no_observed_completion,
    usageUnobserved: row.usage_unobserved,
  };
}

function validateAggregationQuery(query: ModelRequestMetricsAggregationQuery): void {
  validateMetricsTimeRange(query);
  if (!(["global", "provider", "model"] as const).includes(query.dimension)) {
    throw new Error("模型请求指标聚合维度无效");
  }
}

function metricsPageOffset(query: { offset?: number; limit: number }): number {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 500) {
    throw new Error("模型请求指标分页数量必须在 1 到 500 之间");
  }
  const offset = query.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("模型请求指标分页偏移无效");
  return offset;
}

function metricsScopeSql(query: ModelRequestMetricsScope, selectThreadRoot = false): { sql: string; params: Array<string | number> } {
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
