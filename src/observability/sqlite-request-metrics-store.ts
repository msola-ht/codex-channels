import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import {
  acquireRequestMetricsDatabaseLock,
  modelRequestMetricsSchemaVersion,
  requestMetricsDatabasePath,
  type RequestMetricsDatabaseLock,
} from "./request-metrics-database.js";

import type {
  ModelRequestMetricSample,
  ModelRequestMetricsAggregationDimension,
  ModelRequestMetricsAggregationQuery,
  ModelRequestMetricsErrorQuery,
  ModelRequestMetricsPageQuery,
  ModelRequestMetricsStore,
  ModelRequestPricingSnapshot,
  StoredCompactRequestMetricsSummary,
  StoredModelRequestMetric,
  StoredModelRequestMetricsAggregate,
  StoredModelRequestMetricsErrorReport,
  StoredModelRequestMetricsGroup,
  StoredModelRequestMetricsPage,
  StoredModelRequestMetricsReport,
  StoredThreadRequestMetricsSummary,
  StoredThreadRequestMetricsAggregate,
  StoredThreadListItem,
  StoredThreadTurnSummary,
  StoredSubagentThreadRecord,
  StoredTurnRequestMetricsSummary,
  StoredWeeklyQuotaEstimate,
  StoredWeeklyQuotaWindow,
  WeeklyQuotaEstimateQuery,
} from "./request-metrics.js";

const schemaVersion = modelRequestMetricsSchemaVersion;
const dayMs = 24 * 60 * 60 * 1_000;
const defaultRetentionDays = 365;
const defaultMaximumRows = 1_000_000;
const weeklyWindowMs = 7 * 24 * 60 * 60 * 1_000;
const cleanupInterval = 100;
const maximumAggregationGroups = 20;
const metricStorageColumnsSql = `
  provider, billing_mode, pricing_currency, pricing_source, pricing_effective_at_ms,
  pricing_bucket,
  uncached_input_price_per_million_nanos,
  cached_input_price_per_million_nanos, output_price_per_million_nanos,
  transport, response_format, operation, thread_id, turn_id, model, service_tier,
  reasoning_effort, status, http_status, error_type, error_code, error_message,
  incomplete_reason,
  input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens,
  total_tokens, upstream_created_at, upstream_completed_at,
  request_started_at_ms, first_token_at_ms,
  first_reasoning_delta_at_ms, last_reasoning_delta_at_ms,
  first_output_delta_at_ms, last_output_delta_at_ms,
  response_completed_at_ms, recorded_at_ms,
  weekly_quota_limit_id, weekly_used_percent_millionths, weekly_resets_at,
  weekly_quota_plan_type, quota_windows
`;
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
  outputTokensPerSecond: "output_tokens_per_second",
  ttftMs: "ttft_ms",
  requestDurationMs: "request_duration_ms",
  totalCostNanos: "total_cost_nanos",
} as const;
const observableCompletionSql = `
  status = 'completed'
  AND NOT (
    response_format = 'unknown'
    AND model IS NULL
    AND input_tokens IS NULL
    AND output_tokens IS NULL
    AND total_tokens IS NULL
  )
`;
const successfulCostAggregateSql = `
  MIN(CASE WHEN ${observableCompletionSql} AND total_cost_nanos IS NOT NULL
    THEN pricing_currency END) AS pricing_currency,
  COUNT(DISTINCT CASE WHEN ${observableCompletionSql}
      AND total_cost_nanos IS NOT NULL
    THEN pricing_currency END) AS pricing_currency_count,
  COUNT(DISTINCT CASE WHEN ${observableCompletionSql}
      AND total_cost_nanos IS NOT NULL
    THEN COALESCE(pricing_bucket, '') END) AS pricing_bucket_count,
  MIN(CASE WHEN ${observableCompletionSql} AND total_cost_nanos IS NOT NULL
    THEN pricing_bucket END) AS pricing_bucket,
  COUNT(CASE WHEN ${observableCompletionSql} THEN total_cost_nanos END)
    AS priced_request_count,
  SUM(CASE WHEN ${observableCompletionSql} AND total_cost_nanos IS NOT NULL
    THEN input_tokens END) AS priced_input_tokens,
  SUM(CASE WHEN ${observableCompletionSql} AND total_cost_nanos IS NOT NULL
    THEN output_tokens END) AS priced_output_tokens,
  SUM(CASE WHEN ${observableCompletionSql} THEN total_cost_nanos END)
    AS total_cost_nanos,
  SUM(CASE WHEN ${observableCompletionSql} THEN uncached_input_cost_nanos END)
    AS uncached_input_cost_nanos,
  SUM(CASE WHEN ${observableCompletionSql} THEN cached_input_cost_nanos END)
    AS cached_input_cost_nanos,
  SUM(CASE WHEN ${observableCompletionSql} THEN output_cost_nanos END)
    AS output_cost_nanos,
  MIN(CASE WHEN ${observableCompletionSql} AND total_cost_nanos IS NOT NULL
    THEN uncached_input_price_per_million_nanos END)
    AS uncached_input_price_per_million_nanos,
  COUNT(DISTINCT CASE WHEN ${observableCompletionSql}
      AND total_cost_nanos IS NOT NULL
    THEN COALESCE(uncached_input_price_per_million_nanos, -1) END)
    AS uncached_input_price_count,
  MIN(CASE WHEN ${observableCompletionSql} AND total_cost_nanos IS NOT NULL
    THEN cached_input_price_per_million_nanos END)
    AS cached_input_price_per_million_nanos,
  COUNT(DISTINCT CASE WHEN ${observableCompletionSql}
      AND total_cost_nanos IS NOT NULL
    THEN COALESCE(cached_input_price_per_million_nanos, -1) END)
    AS cached_input_price_count,
  MIN(CASE WHEN ${observableCompletionSql} AND total_cost_nanos IS NOT NULL
    THEN output_price_per_million_nanos END)
    AS output_price_per_million_nanos,
  COUNT(DISTINCT CASE WHEN ${observableCompletionSql}
      AND total_cost_nanos IS NOT NULL
    THEN COALESCE(output_price_per_million_nanos, -1) END)
    AS output_price_count
`;
const compactAggregateSql = `
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
    AS compact_output_tokens,
  MIN(CASE WHEN operation = 'compact' AND ${observableCompletionSql}
      AND total_cost_nanos IS NOT NULL THEN pricing_currency END)
    AS compact_pricing_currency,
  COUNT(DISTINCT CASE WHEN operation = 'compact' AND ${observableCompletionSql}
      AND total_cost_nanos IS NOT NULL THEN pricing_currency END)
    AS compact_pricing_currency_count,
  COUNT(CASE WHEN operation = 'compact' AND ${observableCompletionSql}
    THEN total_cost_nanos END) AS compact_priced_request_count,
  SUM(CASE WHEN operation = 'compact' AND ${observableCompletionSql}
    THEN total_cost_nanos END) AS compact_total_cost_nanos
`;
const normalizedStatusSql = `
  CASE
    WHEN status = 'completed'
      AND response_format = 'unknown'
      AND model IS NULL
      AND input_tokens IS NULL
      AND output_tokens IS NULL
      AND total_tokens IS NULL
      THEN 'incomplete'
    ELSE status
  END
`;

interface MetricRow {
  id: number;
  provider: string;
  billing_mode: "api" | "subscription" | "unknown" | null;
  pricing_currency: string | null;
  pricing_source: string | null;
  pricing_effective_at_ms: number | null;
  pricing_bucket: "peak" | "off-peak" | null;
  uncached_input_price_per_million_nanos: number | null;
  cached_input_price_per_million_nanos: number | null;
  output_price_per_million_nanos: number | null;
  transport: "http" | "websocket";
  response_format: "sse" | "json" | "websocket" | "unknown";
  operation: "response" | "compact";
  thread_id: string | null;
  turn_id: string | null;
  model: string | null;
  service_tier: string | null;
  reasoning_effort: string | null;
  status: "completed" | "failed" | "incomplete" | "unknown";
  http_status: number | null;
  error_type: string | null;
  error_code: string | null;
  error_message: string | null;
  incomplete_reason: string | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_tokens: number | null;
  upstream_created_at: number | null;
  upstream_completed_at: number | null;
  request_started_at_ms: number;
  first_token_at_ms: number | null;
  first_reasoning_delta_at_ms: number | null;
  last_reasoning_delta_at_ms: number | null;
  first_output_delta_at_ms: number | null;
  last_output_delta_at_ms: number | null;
  response_completed_at_ms: number;
  recorded_at_ms: number;
  weekly_quota_limit_id: "codex" | null;
  weekly_used_percent_millionths: number | null;
  weekly_resets_at: number | null;
  weekly_quota_plan_type: string | null;
  quota_windows: string | null;
  request_duration_ms: number | null;
  ttft_ms: number | null;
  thinking_duration_ms: number | null;
  output_duration_ms: number | null;
  generation_duration_ms: number | null;
  completion_gap_ms: number | null;
  upstream_duration_ms: number | null;
  uncached_input_tokens: number | null;
  non_reasoning_output_tokens: number | null;
  cache_hit_rate: number | null;
  thinking_tokens_per_second: number | null;
  output_tokens_per_second: number | null;
  generation_tokens_per_second: number | null;
  uncached_input_cost_nanos: number | null;
  cached_input_cost_nanos: number | null;
  output_cost_nanos: number | null;
  total_cost_nanos: number | null;
}

interface CompactSummaryRow {
  compact_request_count: number;
  compact_unsuccessful_request_count: number;
  compact_model: string | null;
  compact_model_count: number;
  compact_input_tokens: number | null;
  compact_cached_input_tokens: number | null;
  compact_input_token_count: number;
  compact_cached_input_token_count: number;
  compact_output_tokens: number | null;
  compact_pricing_currency: string | null;
  compact_pricing_currency_count: number;
  compact_priced_request_count: number;
  compact_total_cost_nanos: number | null;
}

interface TurnSummaryRow extends CompactSummaryRow {
  provider?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  turn_id: string | null;
  turn_count: number;
  request_count: number;
  unsuccessful_request_count: number;
  request_duration_ms: number | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  input_token_count: number;
  cached_input_token_count: number;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  non_reasoning_output_tokens: number | null;
  output_duration_ms: number | null;
  output_speed_sample_count: number;
  output_speed_timed_count: number;
  pricing_currency: string | null;
  pricing_currency_count: number;
  pricing_bucket: "peak" | "off-peak" | null;
  pricing_bucket_count: number;
  priced_request_count: number;
  priced_input_tokens: number | null;
  priced_output_tokens: number | null;
  total_cost_nanos: number | null;
  uncached_input_cost_nanos: number | null;
  cached_input_cost_nanos: number | null;
  output_cost_nanos: number | null;
  uncached_input_price_per_million_nanos: number | null;
  uncached_input_price_count: number;
  cached_input_price_per_million_nanos: number | null;
  cached_input_price_count: number;
  output_price_per_million_nanos: number | null;
  output_price_count: number;
}

interface AggregateRow extends Omit<TurnSummaryRow, "turn_id" | "turn_count"> {
  provider: string | null;
  model: string | null;
  ttft_average_ms: number | null;
  ttft_p50_ms: number | null;
  ttft_p95_ms: number | null;
  ttft_sample_count: number;
  total_group_count: number;
}

interface ErrorSummaryRow {
  request_count: number;
  unsuccessful_request_count: number;
}

interface ErrorGroupRow {
  provider: string;
  model: string | null;
  status: "failed" | "incomplete" | "unknown";
  http_status: number | null;
  error_type: string | null;
  last_error_message: string | null;
  request_count: number;
  last_occurred_at_ms: number;
  total_group_count: number;
}

export class SqliteModelRequestMetricsStore implements ModelRequestMetricsStore {
  private readonly database: DatabaseSync;
  private readonly insert?: StatementSync;
  private readonly insertSubagentThread?: StatementSync;
  private readonly lock?: RequestMetricsDatabaseLock;
  private closed = false;
  private rowCount = 0;
  private recordsSinceCleanup = 0;
  private readonly retentionMs: number;
  private readonly maximumRows: number;

  constructor(
    readonly path: string,
    nowMs: number = Date.now(),
    options: {
      readOnly?: boolean;
      retentionDays?: number;
      maximumRows?: number;
    } = {},
  ) {
    this.retentionMs = positiveInteger(
      options.retentionDays ?? defaultRetentionDays,
      "指标保留天数",
    ) * dayMs;
    this.maximumRows = positiveInteger(
      options.maximumRows ?? defaultMaximumRows,
      "指标最大行数",
    );
    if (options.readOnly) {
      const database = new DatabaseSync(path, { readOnly: true });
      this.database = database;
      try {
        this.database.exec("PRAGMA busy_timeout = 1000; PRAGMA query_only = ON;");
        this.requireCurrentSchema();
        this.rowCount = this.currentCount();
      } catch (error) {
        database.close();
        throw error;
      }
      return;
    }
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
    this.lock = acquireRequestMetricsDatabaseLock(path);
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(path);
      this.database = database;
      chmodSync(path, 0o600);
      this.database.exec(`
        PRAGMA busy_timeout = 10;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
      `);
      this.initializeSchema();
      this.insert = this.database.prepare(`
        INSERT INTO model_request_metrics (
          ${metricStorageColumnsSql}
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `);
      this.insertSubagentThread = this.database.prepare(`
        INSERT INTO subagent_threads (
          thread_id, parent_thread_id, parent_turn_id, agent_path, recorded_at_ms
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          parent_thread_id = excluded.parent_thread_id,
          parent_turn_id = excluded.parent_turn_id,
          agent_path = excluded.agent_path,
          recorded_at_ms = excluded.recorded_at_ms
      `);
      this.cleanup(nowMs);
    } catch (error) {
      try {
        database?.close();
      } finally {
        this.lock.release();
      }
      throw error;
    }
  }

  record(sample: ModelRequestMetricSample): void {
    this.requireOpen();
    if (!this.insert) throw new Error("只读模型请求指标数据库不能写入");
    const recordedAtMs = sample.recordedAtMs ?? Date.now();
    this.insert.run(
      sample.provider,
      sample.pricing?.billingMode ?? null,
      sample.pricing?.currency ?? null,
      sample.pricing?.source ?? null,
      sample.pricing?.effectiveAtMs ?? null,
      sample.pricing?.bucket ?? null,
      sample.pricing?.uncachedInputPricePerMillionNanos ?? null,
      sample.pricing?.cachedInputPricePerMillionNanos ?? null,
      sample.pricing?.outputPricePerMillionNanos ?? null,
      sample.transport,
      sample.responseFormat,
      sample.operation,
      sample.threadId,
      sample.turnId,
      sample.model,
      sample.serviceTier,
      sample.reasoningEffort,
      sample.status,
      sample.httpStatus,
      sample.errorType,
      sample.errorCode,
      sample.errorMessage,
      sample.incompleteReason,
      sample.inputTokens,
      sample.cachedInputTokens,
      sample.outputTokens,
      sample.reasoningOutputTokens,
      sample.totalTokens,
      sample.upstreamCreatedAt,
      sample.upstreamCompletedAt,
      sample.requestStartedAtMs,
      sample.firstTokenAtMs,
      sample.firstReasoningDeltaAtMs,
      sample.lastReasoningDeltaAtMs,
      sample.firstOutputDeltaAtMs,
      sample.lastOutputDeltaAtMs,
      sample.responseCompletedAtMs,
      recordedAtMs,
      sample.weeklyQuota?.limitId ?? null,
      sample.weeklyQuota?.usedPercentMillionths ?? null,
      sample.weeklyQuota?.resetsAt ?? null,
      sample.weeklyQuota?.planType ?? null,
      sample.quotaWindows === undefined || sample.quotaWindows === null
        ? null
        : JSON.stringify(sample.quotaWindows),
    );
    this.rowCount += 1;
    this.recordsSinceCleanup += 1;
    if (this.recordsSinceCleanup >= cleanupInterval) {
      this.cleanup(recordedAtMs);
    }
  }

  recordSubagentThread(details: {
    agentThreadId: string;
    parentThreadId: string;
    parentTurnId: string;
    agentPath: string;
  }): void {
    const {
      agentThreadId,
      parentThreadId,
      parentTurnId,
      agentPath,
    } = details;
    this.requireOpen();
    if (!this.insertSubagentThread) {
      throw new Error("只读模型请求指标数据库不能写入");
    }
    if (!agentThreadId.trim() || agentThreadId.length > 128) {
      throw new Error("子代理 Thread ID 无效");
    }
    if (!parentThreadId.trim() || parentThreadId.length > 128) {
      throw new Error("子代理父 Thread ID 无效");
    }
    if (!parentTurnId.trim() || parentTurnId.length > 128) {
      throw new Error("子代理父 Turn ID 无效");
    }
    if (!agentPath.trim() || agentPath.length > 512) {
      throw new Error("子代理路径无效");
    }
    this.insertSubagentThread.run(
      agentThreadId,
      parentThreadId,
      parentTurnId,
      agentPath,
      Date.now(),
    );
  }

  recent(limit: number): StoredModelRequestMetric[] {
    this.requireOpen();
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("模型请求指标查询数量必须在 1 到 500 之间");
    }
    const rows = this.database.prepare(`
      SELECT * FROM model_request_metrics_enriched ORDER BY id DESC LIMIT ?
    `).all(limit) as unknown as MetricRow[];
    return rows.map(toStoredMetric);
  }

  weeklyQuotaEstimate(
    query: WeeklyQuotaEstimateQuery,
  ): StoredWeeklyQuotaEstimate | null {
    this.requireOpen();
    validateWeeklyQuotaEstimateQuery(query);
    const startAtMs = query.resetsAt * 1_000 - weeklyWindowMs;
    const rows = this.database.prepare(`
      SELECT * FROM model_request_metrics_enriched
      WHERE provider = ?
        AND recorded_at_ms >= ?
        AND recorded_at_ms <= ?
      ORDER BY id ASC
    `).all(query.provider, startAtMs, query.nowMs) as unknown as MetricRow[];
    return estimateWeeklyQuotaRows(rows, query);
  }

  latestWeeklyQuota(
    provider: string,
    nowMs: number = Date.now(),
  ): StoredWeeklyQuotaWindow | null {
    this.requireOpen();
    if (
      provider.length === 0
      || provider.length > 128
      || !Number.isSafeInteger(nowMs)
      || nowMs < 0
    ) throw new Error("最新周额度查询无效");
    const row = this.database.prepare(`
      SELECT weekly_quota_limit_id, weekly_used_percent_millionths,
        weekly_resets_at, weekly_quota_plan_type, recorded_at_ms
      FROM model_request_metrics
      WHERE provider = ?
        AND weekly_quota_limit_id IS NOT NULL
        AND weekly_resets_at * 1000 > ?
        AND recorded_at_ms <= ?
      ORDER BY id DESC
      LIMIT 1
    `).get(provider, nowMs, nowMs) as {
      weekly_quota_limit_id: string;
      weekly_used_percent_millionths: number;
      weekly_resets_at: number;
      weekly_quota_plan_type: string | null;
      recorded_at_ms: number;
    } | undefined;
    return row
      ? {
          limitId: row.weekly_quota_limit_id,
          usedPercentMillionths: row.weekly_used_percent_millionths,
          resetsAt: row.weekly_resets_at,
          observedAtMs: row.recorded_at_ms,
          planType: row.weekly_quota_plan_type,
        }
      : null;
  }

  page(query: ModelRequestMetricsPageQuery): StoredModelRequestMetricsPage {
    this.requireOpen();
    validateMetricsTimeRange(query);
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 500) {
      throw new Error("模型请求指标分页数量必须在 1 到 500 之间");
    }
    const offset = query.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("模型请求指标分页偏移无效");
    }
    const sortKey = query.sortKey ?? "recordedAtMs";
    const sortDirection = query.sortDirection ?? "desc";
    const sortExpression = pageSortSql[sortKey];
    if (sortExpression === undefined || !["asc", "desc"].includes(sortDirection)) {
      throw new Error("模型请求指标排序无效");
    }
    const order = sortDirection.toUpperCase();
    const filter = query.filter?.trim() ?? "";
    if (filter.length > 128) {
      throw new Error("模型请求指标筛选关键字最多 128 个字符");
    }
    const pattern = filter.length === 0
      ? ""
      : `%${filter.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`;
    const filterSql = pattern.length === 0
      ? ""
      : ` AND (
          provider LIKE ? ESCAPE '\\'
          OR model LIKE ? ESCAPE '\\'
          OR operation LIKE ? ESCAPE '\\'
          OR status LIKE ? ESCAPE '\\'
          OR error_type LIKE ? ESCAPE '\\'
          OR error_code LIKE ? ESCAPE '\\'
          OR error_message LIKE ? ESCAPE '\\'
        )`;
    const filterParams = pattern.length === 0
      ? []
      : Array.from({ length: 7 }, () => pattern);
    const matchedTotal = (this.database.prepare(`
      SELECT COUNT(*) AS n
      FROM model_request_metrics_enriched
      WHERE recorded_at_ms >= ?
        AND recorded_at_ms < ?${filterSql}
    `).get(
      query.startAtMs,
      query.endAtMs,
      ...filterParams,
    ) as { n: number }).n;
    const rows = this.database.prepare(`
      SELECT *
      FROM model_request_metrics_enriched
      WHERE recorded_at_ms >= ?
        AND recorded_at_ms < ?
        ${filterSql}
      ORDER BY ${sortExpression} ${order}, id ${order}
      LIMIT ? OFFSET ?
    `).all(
      query.startAtMs,
      query.endAtMs,
      ...filterParams,
      query.limit + 1,
      offset,
    ) as unknown as MetricRow[];
    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      startAtMs: query.startAtMs,
      endAtMs: query.endAtMs,
      records: pageRows.map(toStoredMetric),
      nextOffset: hasMore ? offset + query.limit : null,
      matchedTotal,
    };
  }

  aggregate(
    query: ModelRequestMetricsAggregationQuery,
  ): StoredModelRequestMetricsReport {
    this.requireOpen();
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

  errors(
    query: ModelRequestMetricsErrorQuery,
  ): StoredModelRequestMetricsErrorReport {
    this.requireOpen();
    validateMetricsTimeRange(query);
    const summary = this.database.prepare(`
      SELECT
        COUNT(*) AS request_count,
        SUM(CASE WHEN ${observableCompletionSql} THEN 0 ELSE 1 END)
          AS unsuccessful_request_count
      FROM model_request_metrics
      WHERE recorded_at_ms >= ?
        AND recorded_at_ms < ?
    `).get(query.startAtMs, query.endAtMs) as unknown as ErrorSummaryRow;
    const rows = this.database.prepare(`
      WITH normalized AS (
        SELECT
          *,
          ${normalizedStatusSql} AS normalized_status,
          CASE
            WHEN ${normalizedStatusSql} = 'incomplete'
              AND error_type IS NULL
              AND incomplete_reason IS NULL
              THEN 'response_not_observed'
            WHEN incomplete_reason = 'response_not_observed'
              AND error_type IS NULL
              THEN 'response_not_observed'
            ELSE error_type
          END AS normalized_error_type
        FROM model_request_metrics
        WHERE recorded_at_ms >= ?
          AND recorded_at_ms < ?
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
      query.startAtMs,
      query.endAtMs,
      maximumAggregationGroups,
    ) as unknown as ErrorGroupRow[];
    return {
      ...query,
      requestCount: summary.request_count,
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
    this.requireOpen();
    if (!threadId.trim() || threadId.length > 128) {
      throw new Error("Thread ID 无效");
    }
    const latestTurn = this.database.prepare(`
      SELECT turn_id
      FROM model_request_metrics
      WHERE thread_id = ? AND turn_id IS NOT NULL AND operation = 'response'
      ORDER BY id DESC
      LIMIT 1
    `).get(threadId) as { turn_id: string } | undefined;
    const turn = latestTurn === undefined
      ? undefined
      : this.database.prepare(`
          SELECT
            (
              SELECT provider
              FROM model_request_metrics_enriched AS latest_provider
              WHERE latest_provider.thread_id
                  = model_request_metrics_enriched.thread_id
                AND latest_provider.turn_id
                  = model_request_metrics_enriched.turn_id
                AND latest_provider.operation = 'response'
              ORDER BY latest_provider.id DESC
              LIMIT 1
            ) AS provider,
            (
              SELECT model
              FROM model_request_metrics_enriched AS latest_model
              WHERE latest_model.thread_id
                  = model_request_metrics_enriched.thread_id
                AND latest_model.turn_id
                  = model_request_metrics_enriched.turn_id
                AND latest_model.operation = 'response'
              ORDER BY latest_model.id DESC
              LIMIT 1
            ) AS model,
            (
              SELECT reasoning_effort
              FROM model_request_metrics_enriched AS latest_effort
              WHERE latest_effort.thread_id
                  = model_request_metrics_enriched.thread_id
                AND latest_effort.turn_id
                  = model_request_metrics_enriched.turn_id
                AND latest_effort.operation = 'response'
              ORDER BY latest_effort.id DESC
              LIMIT 1
            ) AS reasoning_effort,
            turn_id,
            COUNT(DISTINCT turn_id) AS turn_count,
            COUNT(*) AS request_count,
            SUM(CASE WHEN ${observableCompletionSql} THEN 0 ELSE 1 END)
              AS unsuccessful_request_count,
            SUM(request_duration_ms) AS request_duration_ms,
            SUM(input_tokens) AS input_tokens,
            SUM(cached_input_tokens) AS cached_input_tokens,
            COUNT(input_tokens) AS input_token_count,
            COUNT(cached_input_tokens) AS cached_input_token_count,
            SUM(output_tokens) AS output_tokens,
            SUM(reasoning_output_tokens) AS reasoning_output_tokens,
            SUM(CASE WHEN non_reasoning_output_tokens > 0
                  AND output_duration_ms > 0
                THEN non_reasoning_output_tokens ELSE 0 END)
              AS non_reasoning_output_tokens,
            SUM(CASE WHEN non_reasoning_output_tokens > 0
                  AND output_duration_ms > 0
                THEN output_duration_ms ELSE 0 END)
              AS output_duration_ms,
            SUM(CASE WHEN non_reasoning_output_tokens > 0 THEN 1 ELSE 0 END)
              AS output_speed_sample_count,
            SUM(CASE WHEN non_reasoning_output_tokens > 0
                  AND output_duration_ms > 0 THEN 1 ELSE 0 END)
              AS output_speed_timed_count,
            ${successfulCostAggregateSql},
            ${compactAggregateSql}
          FROM model_request_metrics_enriched
          WHERE thread_id = ? AND turn_id = ?
          GROUP BY turn_id
        `).get(threadId, latestTurn.turn_id) as TurnSummaryRow | undefined;
    const threadAggregate = this.database.prepare(`
      WITH RECURSIVE thread_tree(thread_id) AS (
        SELECT ?
        UNION
        SELECT child.thread_id
        FROM subagent_threads AS child
        JOIN thread_tree AS parent
          ON child.parent_thread_id = parent.thread_id
      ), scoped AS (
        SELECT metric.*
        FROM model_request_metrics_enriched AS metric
        WHERE metric.thread_id IN (SELECT thread_id FROM thread_tree)
          AND metric.turn_id IS NOT NULL
      )
      SELECT
        (SELECT provider FROM scoped ORDER BY id DESC LIMIT 1) AS provider,
        NULL AS turn_id,
        COUNT(DISTINCT thread_id || char(0) || turn_id) AS turn_count,
        COUNT(*) AS request_count,
        SUM(CASE WHEN ${observableCompletionSql} THEN 0 ELSE 1 END)
          AS unsuccessful_request_count,
        SUM(request_duration_ms) AS request_duration_ms,
        SUM(input_tokens) AS input_tokens,
        SUM(cached_input_tokens) AS cached_input_tokens,
        COUNT(input_tokens) AS input_token_count,
        COUNT(cached_input_tokens) AS cached_input_token_count,
        SUM(output_tokens) AS output_tokens,
        SUM(reasoning_output_tokens) AS reasoning_output_tokens,
        SUM(CASE WHEN non_reasoning_output_tokens > 0
              AND output_duration_ms > 0
            THEN non_reasoning_output_tokens ELSE 0 END)
          AS non_reasoning_output_tokens,
        SUM(CASE WHEN non_reasoning_output_tokens > 0
              AND output_duration_ms > 0
            THEN output_duration_ms ELSE 0 END)
          AS output_duration_ms,
        SUM(CASE WHEN non_reasoning_output_tokens > 0 THEN 1 ELSE 0 END)
          AS output_speed_sample_count,
        SUM(CASE WHEN non_reasoning_output_tokens > 0
              AND output_duration_ms > 0 THEN 1 ELSE 0 END)
          AS output_speed_timed_count,
        ${successfulCostAggregateSql},
        ${compactAggregateSql}
      FROM scoped
    `).get(threadId) as unknown as TurnSummaryRow;
    const latestDirectApi = this.database.prepare(`
      SELECT *
      FROM model_request_metrics_enriched
      WHERE thread_id = ?
        AND turn_id IS NULL
        AND operation = 'response'
        AND transport = 'http'
        AND response_format = 'json'
      ORDER BY id DESC
      LIMIT 1
    `).get(threadId) as MetricRow | undefined;
    return {
      threadId,
      latestTurn: turn === undefined ? null : toStoredTurnSummary(turn),
      threadAggregate: threadAggregate.request_count === 0
        ? null
        : toStoredThreadAggregate(threadAggregate),
      latestDirectApi: latestDirectApi === undefined
        ? null
        : toStoredMetric(latestDirectApi),
    };
  }

  threadTurnTaskSummary(
    threadId: string,
    turnId: string,
  ): StoredTurnRequestMetricsSummary | null {
    this.requireOpen();
    validateThreadId(threadId, "Thread ID");
    validateThreadId(turnId, "Turn ID");
    const child = this.database.prepare(`
      SELECT 1
      FROM subagent_threads
      WHERE parent_thread_id = ?
        AND parent_turn_id = ?
      LIMIT 1
    `).get(threadId, turnId);
    if (child === undefined) return null;
    const row = this.database.prepare(`
      WITH RECURSIVE task_threads(thread_id) AS (
        SELECT child.thread_id
        FROM subagent_threads AS child
        WHERE child.parent_thread_id = ?
          AND child.parent_turn_id = ?
        UNION
        SELECT child.thread_id
        FROM subagent_threads AS child
        JOIN task_threads AS parent
          ON child.parent_thread_id = parent.thread_id
      ), scoped AS (
        SELECT metric.*
        FROM model_request_metrics_enriched AS metric
        WHERE (
          metric.thread_id = ? AND metric.turn_id = ?
        ) OR (
          metric.thread_id IN (SELECT thread_id FROM task_threads)
          AND metric.turn_id IS NOT NULL
        )
      )
      SELECT
        (SELECT provider FROM scoped ORDER BY id DESC LIMIT 1) AS provider,
        (SELECT model FROM scoped ORDER BY id DESC LIMIT 1) AS model,
        (SELECT reasoning_effort FROM scoped ORDER BY id DESC LIMIT 1)
          AS reasoning_effort,
        ? AS turn_id,
        COUNT(DISTINCT thread_id || char(0) || turn_id) AS turn_count,
        COUNT(*) AS request_count,
        SUM(CASE WHEN ${observableCompletionSql} THEN 0 ELSE 1 END)
          AS unsuccessful_request_count,
        SUM(request_duration_ms) AS request_duration_ms,
        SUM(input_tokens) AS input_tokens,
        SUM(cached_input_tokens) AS cached_input_tokens,
        COUNT(input_tokens) AS input_token_count,
        COUNT(cached_input_tokens) AS cached_input_token_count,
        SUM(output_tokens) AS output_tokens,
        SUM(reasoning_output_tokens) AS reasoning_output_tokens,
        SUM(CASE WHEN non_reasoning_output_tokens > 0
              AND output_duration_ms > 0
            THEN non_reasoning_output_tokens ELSE 0 END)
          AS non_reasoning_output_tokens,
        SUM(CASE WHEN non_reasoning_output_tokens > 0
              AND output_duration_ms > 0
            THEN output_duration_ms ELSE 0 END)
          AS output_duration_ms,
        SUM(CASE WHEN non_reasoning_output_tokens > 0 THEN 1 ELSE 0 END)
          AS output_speed_sample_count,
        SUM(CASE WHEN non_reasoning_output_tokens > 0
              AND output_duration_ms > 0 THEN 1 ELSE 0 END)
          AS output_speed_timed_count,
        ${successfulCostAggregateSql},
        ${compactAggregateSql}
      FROM scoped
    `).get(threadId, turnId, threadId, turnId, turnId) as TurnSummaryRow | undefined;
    // The direct-child probe above is the display gate. Keep a zero summary
    // when a child has not produced any model rows yet so the parent card can
    // distinguish an observed child from an absent task aggregate.
    return row === undefined ? null : toStoredTurnSummary(row);
  }

  threadTurnSummaries(threadId: string): StoredThreadTurnSummary[] {
    this.requireOpen();
    if (!threadId.trim() || threadId.length > 128) {
      throw new Error("Thread ID 无效");
    }
    const rows = this.database.prepare(`
      SELECT
        (
          SELECT provider
          FROM model_request_metrics_enriched AS latest_provider
          WHERE latest_provider.thread_id
              = model_request_metrics_enriched.thread_id
            AND latest_provider.turn_id
              = model_request_metrics_enriched.turn_id
          ORDER BY latest_provider.id DESC
          LIMIT 1
        ) AS provider,
        (
          SELECT model
          FROM model_request_metrics_enriched AS latest_model
          WHERE latest_model.thread_id
              = model_request_metrics_enriched.thread_id
            AND latest_model.turn_id
              = model_request_metrics_enriched.turn_id
          ORDER BY latest_model.id DESC
          LIMIT 1
        ) AS model,
        (
          SELECT reasoning_effort
          FROM model_request_metrics_enriched AS latest_effort
          WHERE latest_effort.thread_id
              = model_request_metrics_enriched.thread_id
            AND latest_effort.turn_id
              = model_request_metrics_enriched.turn_id
          ORDER BY latest_effort.id DESC
          LIMIT 1
        ) AS reasoning_effort,
        turn_id,
        COUNT(DISTINCT turn_id) AS turn_count,
        COUNT(*) AS request_count,
        SUM(CASE WHEN ${observableCompletionSql} THEN 0 ELSE 1 END)
          AS unsuccessful_request_count,
        SUM(request_duration_ms) AS request_duration_ms,
        SUM(input_tokens) AS input_tokens,
        SUM(cached_input_tokens) AS cached_input_tokens,
        COUNT(input_tokens) AS input_token_count,
        COUNT(cached_input_tokens) AS cached_input_token_count,
        SUM(output_tokens) AS output_tokens,
        SUM(reasoning_output_tokens) AS reasoning_output_tokens,
        SUM(CASE WHEN non_reasoning_output_tokens > 0
              AND output_duration_ms > 0
            THEN non_reasoning_output_tokens ELSE 0 END)
          AS non_reasoning_output_tokens,
        SUM(CASE WHEN non_reasoning_output_tokens > 0
              AND output_duration_ms > 0
            THEN output_duration_ms ELSE 0 END)
          AS output_duration_ms,
        SUM(CASE WHEN non_reasoning_output_tokens > 0 THEN 1 ELSE 0 END)
          AS output_speed_sample_count,
        SUM(CASE WHEN non_reasoning_output_tokens > 0
              AND output_duration_ms > 0 THEN 1 ELSE 0 END)
          AS output_speed_timed_count,
        ${successfulCostAggregateSql},
        ${compactAggregateSql},
        MAX(recorded_at_ms) AS recorded_at_ms
      FROM model_request_metrics_enriched
      WHERE thread_id = ? AND turn_id IS NOT NULL
      GROUP BY turn_id
      ORDER BY MAX(id) DESC
    `).all(threadId) as unknown as Array<
      TurnSummaryRow & { recorded_at_ms: number }
    >;
    return rows.map((row) => ({
      ...toStoredTurnSummary(row),
      recordedAtMs: row.recorded_at_ms,
    }));
  }

  threadList(): StoredThreadListItem[] {
    this.requireOpen();
    const rows = this.database.prepare(`
      SELECT
        model_request_metrics_enriched.thread_id AS thread_id,
        (
          SELECT provider
          FROM model_request_metrics_enriched AS latest_provider
          WHERE latest_provider.thread_id
              = model_request_metrics_enriched.thread_id
            AND latest_provider.turn_id IS NOT NULL
          ORDER BY latest_provider.id DESC
          LIMIT 1
        ) AS provider,
        (
          SELECT model
          FROM model_request_metrics_enriched AS latest_model
          WHERE latest_model.thread_id
              = model_request_metrics_enriched.thread_id
            AND latest_model.turn_id IS NOT NULL
          ORDER BY latest_model.id DESC
          LIMIT 1
        ) AS model,
        (
          SELECT reasoning_effort
          FROM model_request_metrics_enriched AS latest_effort
          WHERE latest_effort.thread_id
              = model_request_metrics_enriched.thread_id
            AND latest_effort.turn_id IS NOT NULL
          ORDER BY latest_effort.id DESC
          LIMIT 1
        ) AS reasoning_effort,
        COUNT(DISTINCT turn_id) AS turn_count,
        COUNT(*) AS request_count,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        MIN(CASE WHEN ${observableCompletionSql}
            AND total_cost_nanos IS NOT NULL
          THEN pricing_currency END) AS pricing_currency,
        COUNT(DISTINCT CASE WHEN ${observableCompletionSql}
            AND total_cost_nanos IS NOT NULL
          THEN pricing_currency END) AS pricing_currency_count,
        COUNT(CASE WHEN ${observableCompletionSql} THEN total_cost_nanos END)
          AS priced_request_count,
        SUM(CASE WHEN ${observableCompletionSql} THEN total_cost_nanos END)
          AS total_cost_nanos,
        ${compactAggregateSql},
        MIN(request_started_at_ms) AS first_request_started_at_ms,
        MAX(model_request_metrics_enriched.recorded_at_ms) AS recorded_at_ms,
        subagent.agent_path AS agent_path,
        subagent.parent_thread_id AS parent_thread_id,
        subagent.parent_turn_id AS parent_turn_id
      FROM model_request_metrics_enriched
      LEFT JOIN subagent_threads AS subagent
        ON subagent.thread_id = model_request_metrics_enriched.thread_id
      WHERE model_request_metrics_enriched.thread_id IS NOT NULL
        AND turn_id IS NOT NULL
      GROUP BY model_request_metrics_enriched.thread_id
      ORDER BY MAX(id) DESC
    `).all() as unknown as Array<CompactSummaryRow & {
      thread_id: string;
      provider: string | null;
      model: string | null;
      reasoning_effort: string | null;
      turn_count: number;
      request_count: number;
      input_tokens: number | null;
      output_tokens: number | null;
      pricing_currency: string | null;
      pricing_currency_count: number;
      priced_request_count: number;
      total_cost_nanos: number | null;
      first_request_started_at_ms: number;
      recorded_at_ms: number;
      agent_path: string | null;
      parent_thread_id: string | null;
      parent_turn_id: string | null;
    }>;
    return rows.map((row) => ({
      threadId: row.thread_id,
      provider: row.provider ?? null,
      model: row.model ?? null,
      reasoningEffort: row.reasoning_effort ?? null,
      agentPath: row.agent_path ?? null,
      parentThreadId: row.parent_thread_id ?? null,
      parentTurnId: row.parent_turn_id ?? null,
      turnCount: row.turn_count,
      requestCount: row.request_count,
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      pricingCurrency: row.pricing_currency_count === 1
        ? row.pricing_currency
        : null,
      pricedRequestCount: row.priced_request_count,
      totalCostNanos: row.total_cost_nanos ?? null,
      compact: toStoredCompactSummary(row),
      firstRequestStartedAtMs: row.first_request_started_at_ms,
      lastRecordedAtMs: row.recorded_at_ms,
    }));
  }

  subagentThread(threadId: string): {
    agentPath: string | null;
    parentThreadId: string | null;
    parentTurnId: string | null;
  } {
    this.requireOpen();
    if (!threadId.trim() || threadId.length > 128) {
      throw new Error("Thread ID 无效");
    }
    const row = this.database.prepare(`
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
    this.requireOpen();
    if (!Number.isInteger(afterLocalId) || afterLocalId < 0) {
      throw new Error("同步水位必须是大于等于 0 的整数");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("同步批量大小必须在 1 到 500 之间");
    }
    const rows = this.database.prepare(`
      SELECT * FROM model_request_metrics_enriched
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
    this.requireOpen();
    if (!Number.isInteger(recordedAtMs) || recordedAtMs < 0) {
      throw new Error("子代理同步水位必须是大于等于 0 的整数");
    }
    if (afterThreadId !== undefined && afterThreadId.length === 0) {
      throw new Error("子代理同步游标 Thread ID 不能为空");
    }
    const rows = this.database.prepare(`
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
    this.requireOpen();
    return this.currentCount();
  }

  private currentCount(): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM model_request_metrics
    `).get() as { count: number };
    return row.count;
  }

  private queryAggregationRows(
    dimension: ModelRequestMetricsAggregationDimension,
    query: ModelRequestMetricsAggregationQuery,
  ): AggregateRow[] {
    const grouping = aggregationGrouping(dimension);
    const limit = dimension === "global" ? 1 : maximumAggregationGroups;
    return this.database.prepare(`
      WITH filtered AS (
        SELECT
          metric.*,
          ${grouping.provider} AS group_provider,
          ${grouping.model} AS group_model
        FROM model_request_metrics_enriched AS metric
        WHERE recorded_at_ms >= ?
          AND recorded_at_ms < ?
      ), aggregate_rows AS (
        SELECT
          group_provider AS provider,
          group_model AS model,
          COUNT(*) AS request_count,
          SUM(CASE WHEN ${observableCompletionSql} THEN 0 ELSE 1 END)
            AS unsuccessful_request_count,
          SUM(request_duration_ms) AS request_duration_ms,
          SUM(input_tokens) AS input_tokens,
          SUM(cached_input_tokens) AS cached_input_tokens,
          COUNT(input_tokens) AS input_token_count,
          COUNT(cached_input_tokens) AS cached_input_token_count,
          SUM(output_tokens) AS output_tokens,
          SUM(reasoning_output_tokens) AS reasoning_output_tokens,
          SUM(CASE WHEN non_reasoning_output_tokens > 0
                AND output_duration_ms > 0
              THEN non_reasoning_output_tokens ELSE 0 END)
            AS non_reasoning_output_tokens,
          SUM(CASE WHEN non_reasoning_output_tokens > 0
                AND output_duration_ms > 0
              THEN output_duration_ms ELSE 0 END)
            AS output_duration_ms,
          SUM(CASE WHEN non_reasoning_output_tokens > 0 THEN 1 ELSE 0 END)
            AS output_speed_sample_count,
          SUM(CASE WHEN non_reasoning_output_tokens > 0
                AND output_duration_ms > 0 THEN 1 ELSE 0 END)
            AS output_speed_timed_count,
          ${successfulCostAggregateSql},
          ${compactAggregateSql}
        FROM filtered
        GROUP BY group_provider, group_model
      ), ttft_ranked AS (
        SELECT
          group_provider AS provider,
          group_model AS model,
          ttft_ms,
          ROW_NUMBER() OVER (
            PARTITION BY group_provider, group_model ORDER BY ttft_ms
          ) AS ttft_rank,
          COUNT(*) OVER (
            PARTITION BY group_provider, group_model
          ) AS ttft_count
        FROM filtered
        WHERE ttft_ms IS NOT NULL
      ), ttft_rows AS (
        SELECT
          provider,
          model,
          AVG(ttft_ms) AS ttft_average_ms,
          MAX(CASE WHEN ttft_rank = CAST((ttft_count * 50 + 99) / 100 AS INTEGER)
            THEN ttft_ms END) AS ttft_p50_ms,
          MAX(CASE WHEN ttft_rank = CAST((ttft_count * 95 + 99) / 100 AS INTEGER)
            THEN ttft_ms END) AS ttft_p95_ms,
          COUNT(*) AS ttft_sample_count
        FROM ttft_ranked
        GROUP BY provider, model
      ), combined AS (
        SELECT
          aggregate_rows.*,
          ttft_rows.ttft_average_ms,
          ttft_rows.ttft_p50_ms,
          ttft_rows.ttft_p95_ms,
          COALESCE(ttft_rows.ttft_sample_count, 0) AS ttft_sample_count,
          COUNT(*) OVER () AS total_group_count
        FROM aggregate_rows
        LEFT JOIN ttft_rows
          ON aggregate_rows.provider IS ttft_rows.provider
          AND aggregate_rows.model IS ttft_rows.model
      )
      SELECT * FROM combined
      ORDER BY request_count DESC, provider ASC, model ASC
      LIMIT ?
    `).all(query.startAtMs, query.endAtMs, limit) as unknown as AggregateRow[];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.database.close();
    } finally {
      this.lock?.release();
    }
  }

  private initializeSchema(): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS schema_metadata (
          name TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );
      `);
      const version = this.database.prepare(`
        SELECT value FROM schema_metadata WHERE name = 'schema_version'
      `).get() as { value: number } | undefined;
      if (version && version.value !== schemaVersion) {
        throw new ModelRequestMetricsSchemaError(version.value, schemaVersion);
      }
      if (!version) {
        this.database.exec(`
          CREATE TABLE subagent_threads (
            thread_id TEXT PRIMARY KEY,
            parent_thread_id TEXT NOT NULL,
            parent_turn_id TEXT,
            agent_path TEXT NOT NULL,
            recorded_at_ms INTEGER NOT NULL
          );
          CREATE TABLE model_request_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL,
            billing_mode TEXT CHECK (
              billing_mode IS NULL OR billing_mode IN ('api', 'subscription', 'unknown')
            ),
            pricing_currency TEXT,
            pricing_source TEXT,
            pricing_effective_at_ms INTEGER,
            pricing_bucket TEXT CHECK (
              pricing_bucket IS NULL OR pricing_bucket IN ('peak', 'off-peak')
            ),
            uncached_input_price_per_million_nanos INTEGER CHECK (
              uncached_input_price_per_million_nanos IS NULL
              OR uncached_input_price_per_million_nanos >= 0
            ),
            cached_input_price_per_million_nanos INTEGER CHECK (
              cached_input_price_per_million_nanos IS NULL
              OR cached_input_price_per_million_nanos >= 0
            ),
            output_price_per_million_nanos INTEGER CHECK (
              output_price_per_million_nanos IS NULL
              OR output_price_per_million_nanos >= 0
            ),
            transport TEXT NOT NULL CHECK (transport IN ('http', 'websocket')),
            response_format TEXT NOT NULL CHECK (
              response_format IN ('sse', 'json', 'websocket', 'unknown')
            ),
            operation TEXT NOT NULL CHECK (operation IN ('response', 'compact')),
            thread_id TEXT,
            turn_id TEXT,
            model TEXT,
            service_tier TEXT,
            reasoning_effort TEXT,
            status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'incomplete', 'unknown')),
            http_status INTEGER,
            error_type TEXT,
            error_code TEXT,
            error_message TEXT,
            incomplete_reason TEXT,
            input_tokens INTEGER,
            cached_input_tokens INTEGER,
            output_tokens INTEGER,
            reasoning_output_tokens INTEGER,
            total_tokens INTEGER,
            upstream_created_at REAL,
            upstream_completed_at REAL,
            request_started_at_ms INTEGER NOT NULL,
            first_token_at_ms INTEGER,
            first_reasoning_delta_at_ms INTEGER,
            last_reasoning_delta_at_ms INTEGER,
            first_output_delta_at_ms INTEGER,
            last_output_delta_at_ms INTEGER,
            response_completed_at_ms INTEGER NOT NULL,
            recorded_at_ms INTEGER NOT NULL,
            weekly_quota_limit_id TEXT CHECK (
              weekly_quota_limit_id IS NULL OR weekly_quota_limit_id = 'codex'
            ),
            weekly_used_percent_millionths INTEGER CHECK (
              weekly_used_percent_millionths IS NULL
              OR weekly_used_percent_millionths BETWEEN 0 AND 100000000
            ),
            weekly_resets_at INTEGER CHECK (
              weekly_resets_at IS NULL OR weekly_resets_at >= 0
            ),
            weekly_quota_plan_type TEXT,
            quota_windows TEXT,
            CHECK (
              (
                billing_mode IS NULL
                AND pricing_currency IS NULL
                AND pricing_source IS NULL
                AND pricing_effective_at_ms IS NULL
                AND uncached_input_price_per_million_nanos IS NULL
                AND cached_input_price_per_million_nanos IS NULL
                AND output_price_per_million_nanos IS NULL
              ) OR (
                billing_mode IS NOT NULL
                AND pricing_source IS NOT NULL
                AND pricing_effective_at_ms IS NOT NULL
                AND (
                  (
                    uncached_input_price_per_million_nanos IS NULL
                    AND cached_input_price_per_million_nanos IS NULL
                    AND output_price_per_million_nanos IS NULL
                  ) OR pricing_currency IS NOT NULL
                )
              )
            )
          );
          CREATE INDEX model_request_metrics_recorded_at
            ON model_request_metrics (recorded_at_ms);
          CREATE INDEX model_request_metrics_thread_turn
            ON model_request_metrics (thread_id, turn_id, id);
          CREATE INDEX model_request_metrics_provider_model
            ON model_request_metrics (provider, model, id);
          CREATE VIEW model_request_metrics_enriched AS
          WITH metric_base AS (
            SELECT
              metric.*,
              CASE
                WHEN last_reasoning_delta_at_ms IS NULL THEN last_output_delta_at_ms
                WHEN last_output_delta_at_ms IS NULL THEN last_reasoning_delta_at_ms
                WHEN last_reasoning_delta_at_ms >= last_output_delta_at_ms
                  THEN last_reasoning_delta_at_ms
                ELSE last_output_delta_at_ms
              END AS last_token_at_ms,
              CASE
                WHEN input_tokens IS NOT NULL
                  AND cached_input_tokens IS NOT NULL
                  AND input_tokens >= cached_input_tokens
                  THEN input_tokens - cached_input_tokens
                ELSE NULL
              END AS uncached_input_tokens,
              CASE
                WHEN output_tokens IS NOT NULL
                  AND output_tokens >= COALESCE(reasoning_output_tokens, 0)
                  THEN output_tokens - COALESCE(reasoning_output_tokens, 0)
                ELSE NULL
              END AS non_reasoning_output_tokens
            FROM model_request_metrics AS metric
          ), derived AS (
            SELECT
              metric_base.*,
              CASE WHEN response_completed_at_ms >= request_started_at_ms
                THEN response_completed_at_ms - request_started_at_ms
              END AS request_duration_ms,
              CASE WHEN first_token_at_ms >= request_started_at_ms
                THEN first_token_at_ms - request_started_at_ms END AS ttft_ms,
              CASE WHEN last_reasoning_delta_at_ms >= first_reasoning_delta_at_ms
                THEN last_reasoning_delta_at_ms - first_reasoning_delta_at_ms
              END AS thinking_duration_ms,
              CASE WHEN last_output_delta_at_ms >= first_output_delta_at_ms
                THEN last_output_delta_at_ms - first_output_delta_at_ms
              END AS output_duration_ms,
              CASE WHEN last_token_at_ms >= first_token_at_ms
                THEN last_token_at_ms - first_token_at_ms
              END AS generation_duration_ms,
              CASE WHEN response_completed_at_ms >= last_token_at_ms
                THEN response_completed_at_ms - last_token_at_ms
              END AS completion_gap_ms,
              CASE WHEN upstream_completed_at >= upstream_created_at
                THEN (upstream_completed_at - upstream_created_at) * 1000
              END AS upstream_duration_ms,
              CASE WHEN input_tokens > 0 AND cached_input_tokens IS NOT NULL
                THEN cached_input_tokens * 1.0 / input_tokens
              END AS cache_hit_rate
            FROM metric_base
          ), rates AS (
            SELECT
              derived.*,
              CASE WHEN thinking_duration_ms > 0 AND reasoning_output_tokens IS NOT NULL
                THEN reasoning_output_tokens * 1000.0 / thinking_duration_ms
              END AS thinking_tokens_per_second,
              CASE WHEN output_duration_ms > 0 AND non_reasoning_output_tokens IS NOT NULL
                THEN non_reasoning_output_tokens * 1000.0 / output_duration_ms
              END AS output_tokens_per_second,
              CASE WHEN generation_duration_ms > 0 AND output_tokens IS NOT NULL
                THEN output_tokens * 1000.0 / generation_duration_ms
              END AS generation_tokens_per_second,
              CASE
                WHEN uncached_input_tokens = 0 THEN 0
                WHEN uncached_input_tokens IS NOT NULL
                  AND uncached_input_price_per_million_nanos IS NOT NULL
                  THEN CAST(ROUND(
                    uncached_input_tokens
                    * uncached_input_price_per_million_nanos / 1000000.0
                  ) AS INTEGER)
              END AS uncached_input_cost_nanos,
              CASE
                WHEN cached_input_tokens = 0 THEN 0
                WHEN cached_input_tokens IS NOT NULL
                  AND cached_input_price_per_million_nanos IS NOT NULL
                  THEN CAST(ROUND(
                    cached_input_tokens
                    * cached_input_price_per_million_nanos / 1000000.0
                  ) AS INTEGER)
              END AS cached_input_cost_nanos,
              CASE
                WHEN output_tokens = 0 THEN 0
                WHEN output_tokens IS NOT NULL
                  AND output_price_per_million_nanos IS NOT NULL
                  THEN CAST(ROUND(
                    output_tokens * output_price_per_million_nanos / 1000000.0
                  ) AS INTEGER)
              END AS output_cost_nanos
            FROM derived
          )
          SELECT
            rates.*,
            CASE
              WHEN uncached_input_cost_nanos IS NOT NULL
                AND cached_input_cost_nanos IS NOT NULL
                AND output_cost_nanos IS NOT NULL
                THEN uncached_input_cost_nanos
                  + cached_input_cost_nanos
                  + output_cost_nanos
            END AS total_cost_nanos
          FROM rates;
          INSERT INTO schema_metadata (name, value) VALUES ('schema_version', ${schemaVersion});
        `);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private requireCurrentSchema(): void {
    let value: number | undefined;
    try {
      value = (this.database.prepare(`
        SELECT value FROM schema_metadata WHERE name = 'schema_version'
      `).get() as { value: number } | undefined)?.value;
    } catch {
      throw new ModelRequestMetricsSchemaError(0, schemaVersion);
    }
    if (value !== schemaVersion) {
      throw new ModelRequestMetricsSchemaError(value ?? 0, schemaVersion);
    }
    try {
      this.database.prepare(`
        SELECT id, ${metricStorageColumnsSql}
        FROM model_request_metrics
        LIMIT 0
      `).all();
      this.database.prepare(`
        SELECT thread_id, parent_thread_id, parent_turn_id, agent_path, recorded_at_ms
        FROM subagent_threads
        LIMIT 0
      `).all();
      this.database.prepare(`
        SELECT id, total_cost_nanos
        FROM model_request_metrics_enriched
        LIMIT 0
      `).all();
    } catch (error) {
      throw new ModelRequestMetricsSchemaError(value, schemaVersion, { cause: error });
    }
  }

  private cleanup(nowMs: number): void {
    this.requireOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        DELETE FROM model_request_metrics WHERE recorded_at_ms < ?
      `).run(Math.max(0, nowMs - this.retentionMs));
      this.database.prepare(`
        DELETE FROM model_request_metrics
        WHERE id <= COALESCE((
          SELECT id FROM model_request_metrics ORDER BY id DESC LIMIT 1 OFFSET ?
        ), 0)
      `).run(this.maximumRows);
      this.database.exec("COMMIT");
      this.rowCount = this.currentCount();
      this.recordsSinceCleanup = 0;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("模型请求指标数据库已关闭");
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label}必须是正整数`);
  }
  return value;
}

export function modelRequestMetricsDatabasePath(stateDatabasePath: string): string {
  return requestMetricsDatabasePath(stateDatabasePath);
}

export class ModelRequestMetricsSchemaError extends Error {
  readonly code = "METRICS_SCHEMA_UNSUPPORTED";

  constructor(
    readonly actualVersion: number,
    readonly expectedVersion: number,
    options?: ErrorOptions,
  ) {
    const detail = options?.cause === undefined
      ? `版本不兼容：当前 ${actualVersion}，Gateway 需要 ${expectedVersion}。`
      : `Schema ${actualVersion} 结构不完整。`;
    const remedy = options?.cause === undefined
      && actualVersion >= 3
      && actualVersion < expectedVersion
      ? "codexc metrics upgrade 备份并升级指标库"
      : "codexc metrics reset 重建指标库";
    super(
      `模型请求指标数据库${detail}请运行 ${remedy}`,
      options,
    );
    this.name = "ModelRequestMetricsSchemaError";
  }
}

function toStoredMetric(row: MetricRow): StoredModelRequestMetric {
  const responseNotObserved = row.operation === "response"
    && row.status === "completed"
    && row.response_format === "unknown"
    && row.model === null
    && row.input_tokens === null
    && row.output_tokens === null
    && row.total_tokens === null;
  return {
    id: row.id,
    provider: row.provider,
    pricing: toPricingSnapshot(row),
    transport: row.transport,
    responseFormat: row.response_format,
    operation: row.operation,
    threadId: row.thread_id,
    turnId: row.turn_id,
    model: row.model,
    serviceTier: row.service_tier,
    reasoningEffort: row.reasoning_effort,
    status: responseNotObserved ? "incomplete" : row.status,
    httpStatus: row.http_status,
    errorType: row.error_type,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    incompleteReason: responseNotObserved
      ? "response_not_observed"
      : row.incomplete_reason,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    totalTokens: row.total_tokens,
    upstreamCreatedAt: row.upstream_created_at,
    upstreamCompletedAt: row.upstream_completed_at,
    requestStartedAtMs: row.request_started_at_ms,
    firstTokenAtMs: row.first_token_at_ms,
    firstReasoningDeltaAtMs: row.first_reasoning_delta_at_ms,
    lastReasoningDeltaAtMs: row.last_reasoning_delta_at_ms,
    firstOutputDeltaAtMs: row.first_output_delta_at_ms,
    lastOutputDeltaAtMs: row.last_output_delta_at_ms,
    responseCompletedAtMs: row.response_completed_at_ms,
    weeklyQuota: row.weekly_quota_limit_id === null
      || row.weekly_used_percent_millionths === null
      || row.weekly_resets_at === null
      ? null
      : {
          limitId: row.weekly_quota_limit_id,
          usedPercentMillionths: row.weekly_used_percent_millionths,
          resetsAt: row.weekly_resets_at,
          planType: row.weekly_quota_plan_type,
        },
    quotaWindows: parseQuotaWindows(row.quota_windows),
    recordedAtMs: row.recorded_at_ms,
    requestDurationMs: row.request_duration_ms,
    ttftMs: row.ttft_ms,
    thinkingDurationMs: row.thinking_duration_ms,
    outputDurationMs: row.output_duration_ms,
    generationDurationMs: row.generation_duration_ms,
    completionGapMs: row.completion_gap_ms,
    upstreamDurationMs: row.upstream_duration_ms,
    uncachedInputTokens: row.uncached_input_tokens,
    nonReasoningOutputTokens: row.non_reasoning_output_tokens,
    cacheHitRate: row.cache_hit_rate,
    thinkingTokensPerSecond: row.thinking_tokens_per_second,
    outputTokensPerSecond: row.output_tokens_per_second,
    generationTokensPerSecond: row.generation_tokens_per_second,
    uncachedInputCostNanos: row.uncached_input_cost_nanos,
    cachedInputCostNanos: row.cached_input_cost_nanos,
    outputCostNanos: row.output_cost_nanos,
    totalCostNanos: row.total_cost_nanos,
  };
}

function toStoredTurnSummary(row: TurnSummaryRow): StoredTurnRequestMetricsSummary {
  const outputDurationMs = row.output_duration_ms ?? 0;
  const nonReasoningOutputTokens = row.non_reasoning_output_tokens ?? 0;
  const pricing = toStoredAggregatePricing(row);
  return {
    provider: row.provider ?? null,
    model: row.model ?? null,
    reasoningEffort: row.reasoning_effort ?? null,
    turnId: row.turn_id!,
    requestCount: row.request_count,
    unsuccessfulRequestCount: row.unsuccessful_request_count,
    requestDurationMs: row.request_duration_ms ?? 0,
    inputTokens: row.input_tokens ?? 0,
    cachedInputTokens: row.input_token_count > 0
      && row.cached_input_token_count === row.input_token_count
      ? row.cached_input_tokens ?? 0
      : null,
    outputTokens: row.output_tokens ?? 0,
    reasoningOutputTokens: row.reasoning_output_tokens ?? 0,
    outputTokensPerSecond: outputDurationMs > 0 && nonReasoningOutputTokens > 0
      ? nonReasoningOutputTokens / (outputDurationMs / 1_000)
      : null,
    outputSpeedSampleCount: row.output_speed_sample_count,
    outputSpeedTimedCount: row.output_speed_timed_count,
    pricedInputTokens: row.priced_input_tokens ?? 0,
    pricedOutputTokens: row.priced_output_tokens ?? 0,
    ...pricing,
    compact: toStoredCompactSummary(row),
  };
}

function parseQuotaWindows(
  value: string | null,
): ReadonlyArray<{ windowId: string; resetsAt: number | null }> | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const window = entry as Record<string, unknown>;
    if (typeof window.windowId !== "string" || window.windowId.length === 0) {
      return [];
    }
    const resetsAt = window.resetsAt;
    if (
      resetsAt !== null
      && !(
        typeof resetsAt === "number"
        && Number.isSafeInteger(resetsAt)
        && resetsAt >= 0
      )
    ) {
      return [];
    }
    return [{
      windowId: window.windowId,
      resetsAt,
    }];
  });
}

function toStoredThreadAggregate(
  row: TurnSummaryRow,
): StoredThreadRequestMetricsAggregate {
  const summary = toStoredTurnSummary({
    ...row,
    turn_id: "aggregate",
  });
  return {
    provider: summary.provider,
    turnCount: row.turn_count,
    requestCount: summary.requestCount,
    unsuccessfulRequestCount: summary.unsuccessfulRequestCount,
    requestDurationMs: summary.requestDurationMs,
    inputTokens: summary.inputTokens,
    cachedInputTokens: summary.cachedInputTokens,
    outputTokens: summary.outputTokens,
    reasoningOutputTokens: summary.reasoningOutputTokens,
    outputTokensPerSecond: summary.outputTokensPerSecond,
    outputSpeedSampleCount: summary.outputSpeedSampleCount,
    outputSpeedTimedCount: summary.outputSpeedTimedCount,
    pricingCurrency: summary.pricingCurrency,
    pricedRequestCount: summary.pricedRequestCount,
    pricedInputTokens: summary.pricedInputTokens,
    pricedOutputTokens: summary.pricedOutputTokens,
    totalCostNanos: summary.totalCostNanos,
    inputCostNanos: summary.inputCostNanos,
    cachedInputCostNanos: summary.cachedInputCostNanos,
    outputCostNanos: summary.outputCostNanos,
    uncachedInputPricePerMillionNanos:
      summary.uncachedInputPricePerMillionNanos,
    cachedInputPricePerMillionNanos:
      summary.cachedInputPricePerMillionNanos,
    outputPricePerMillionNanos: summary.outputPricePerMillionNanos,
    hasMixedPrices: summary.hasMixedPrices,
    pricingBuckets: summary.pricingBuckets,
    compact: summary.compact,
  };
}

function validateAggregationQuery(query: ModelRequestMetricsAggregationQuery): void {
  validateMetricsTimeRange(query);
  if (!(["global", "provider", "model"] as const).includes(query.dimension)) {
    throw new Error("模型请求指标聚合维度无效");
  }
}

function validateThreadId(value: string, label: string): void {
  if (!value.trim() || value.length > 128) {
    throw new Error(`${label}无效`);
  }
}

function validateWeeklyQuotaEstimateQuery(query: WeeklyQuotaEstimateQuery): void {
  if (
    query.provider.length === 0
    || query.provider.length > 128
    || query.limitId !== "codex"
    || !Number.isSafeInteger(query.resetsAt)
    || query.resetsAt < 0
    || !Number.isSafeInteger(query.nowMs)
    || query.nowMs < 0
  ) throw new Error("周额度估算查询无效");
}

function estimateWeeklyQuotaRows(
  rows: MetricRow[],
  query: WeeklyQuotaEstimateQuery,
): StoredWeeklyQuotaEstimate | null {
  let baseline: number | null = null;
  let firstObservedAtMs: number | null = null;
  let lastObservedAtMs: number | null = null;
  let latestUsedPercentMillionths: number | null = null;
  let pending = emptyWeeklyInterval();
  let observedDeltaPercentMillionths = 0;
  let intervalCount = 0;
  const total = emptyWeeklyInterval();
  const currencies = new Set<string>();

  for (const row of rows) {
    const matching = row.weekly_quota_limit_id === query.limitId
      && row.weekly_resets_at === query.resetsAt
      && row.weekly_used_percent_millionths !== null;
    const hasOtherSnapshot = row.weekly_quota_limit_id !== null && !matching;
    if (hasOtherSnapshot) {
      baseline = null;
      pending = emptyWeeklyInterval();
      continue;
    }
    if (baseline === null) {
      if (!matching) continue;
      baseline = row.weekly_used_percent_millionths!;
      latestUsedPercentMillionths = baseline;
      firstObservedAtMs ??= row.recorded_at_ms;
      lastObservedAtMs = row.recorded_at_ms;
      continue;
    }

    addWeeklyIntervalRow(pending, row);
    if (!matching) continue;
    const current = row.weekly_used_percent_millionths!;
    latestUsedPercentMillionths = current;
    lastObservedAtMs = row.recorded_at_ms;
    const delta = current - baseline;
    if (delta < 0) {
      baseline = current;
      pending = emptyWeeklyInterval();
      continue;
    }
    if (delta === 0) continue;
    observedDeltaPercentMillionths += delta;
    intervalCount += 1;
    mergeWeeklyInterval(total, pending);
    for (const currency of pending.currencies) currencies.add(currency);
    baseline = current;
    pending = emptyWeeklyInterval();
  }

  if (
    observedDeltaPercentMillionths <= 0
    || firstObservedAtMs === null
    || lastObservedAtMs === null
    || latestUsedPercentMillionths === null
  ) return null;
  return {
    limitId: query.limitId,
    resetsAt: query.resetsAt,
    firstObservedAtMs,
    lastObservedAtMs,
    latestUsedPercentMillionths,
    observedDeltaPercentMillionths,
    intervalCount,
    requestCount: total.requestCount,
    unsuccessfulRequestCount: total.unsuccessfulRequestCount,
    pricedRequestCount: total.pricedRequestCount,
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    totalTokens: total.inputTokens + total.outputTokens,
    pricingCurrency: currencies.size === 1 ? [...currencies][0]! : null,
    totalCostNanos: currencies.size === 1 ? total.totalCostNanos : null,
  };
}

interface WeeklyIntervalAccumulator {
  requestCount: number;
  unsuccessfulRequestCount: number;
  pricedRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalCostNanos: number;
  currencies: Set<string>;
}

function emptyWeeklyInterval(): WeeklyIntervalAccumulator {
  return {
    requestCount: 0,
    unsuccessfulRequestCount: 0,
    pricedRequestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalCostNanos: 0,
    currencies: new Set(),
  };
}

function addWeeklyIntervalRow(target: WeeklyIntervalAccumulator, row: MetricRow): void {
  target.requestCount += 1;
  if (row.status !== "completed") target.unsuccessfulRequestCount += 1;
  target.inputTokens += row.input_tokens ?? 0;
  target.outputTokens += row.output_tokens ?? 0;
  if (
    row.status === "completed"
    && row.total_cost_nanos !== null
    && row.pricing_currency !== null
  ) {
    target.pricedRequestCount += 1;
    target.totalCostNanos += row.total_cost_nanos;
    target.currencies.add(row.pricing_currency);
  }
}

function mergeWeeklyInterval(
  target: WeeklyIntervalAccumulator,
  source: WeeklyIntervalAccumulator,
): void {
  target.requestCount += source.requestCount;
  target.unsuccessfulRequestCount += source.unsuccessfulRequestCount;
  target.pricedRequestCount += source.pricedRequestCount;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.totalCostNanos += source.totalCostNanos;
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

function toStoredMetricsGroup(row: AggregateRow): StoredModelRequestMetricsGroup {
  return {
    provider: row.provider,
    model: row.model,
    aggregate: toStoredMetricsAggregate(row),
  };
}

function toStoredMetricsAggregate(row: AggregateRow): StoredModelRequestMetricsAggregate {
  const outputDurationMs = row.output_duration_ms ?? 0;
  const nonReasoningOutputTokens = row.non_reasoning_output_tokens ?? 0;
  const pricing = toStoredAggregatePricing(row);
  return {
    requestCount: row.request_count,
    unsuccessfulRequestCount: row.unsuccessful_request_count,
    requestDurationMs: row.request_duration_ms ?? 0,
    inputTokens: row.input_tokens ?? 0,
    cachedInputTokens: row.input_token_count > 0
      && row.cached_input_token_count === row.input_token_count
      ? row.cached_input_tokens ?? 0
      : null,
    outputTokens: row.output_tokens ?? 0,
    reasoningOutputTokens: row.reasoning_output_tokens ?? 0,
    outputTokensPerSecond: outputDurationMs > 0 && nonReasoningOutputTokens > 0
      ? nonReasoningOutputTokens / (outputDurationMs / 1_000)
      : null,
    outputSpeedSampleCount: row.output_speed_sample_count,
    outputSpeedTimedCount: row.output_speed_timed_count,
    ttftAverageMs: row.ttft_average_ms,
    ttftP50Ms: row.ttft_p50_ms,
    ttftP95Ms: row.ttft_p95_ms,
    ttftSampleCount: row.ttft_sample_count,
    ...pricing,
    compact: toStoredCompactSummary(row),
  };
}

function toStoredCompactSummary(
  row: CompactSummaryRow,
): StoredCompactRequestMetricsSummary | null {
  if (row.compact_request_count === 0) return null;
  return {
    model: row.compact_model_count === 1 ? row.compact_model : null,
    hasMixedModels: row.compact_model_count > 1,
    requestCount: row.compact_request_count,
    unsuccessfulRequestCount: row.compact_unsuccessful_request_count,
    inputTokens: row.compact_input_tokens ?? 0,
    cachedInputTokens: row.compact_input_token_count > 0
      && row.compact_cached_input_token_count === row.compact_input_token_count
      ? row.compact_cached_input_tokens ?? 0
      : null,
    outputTokens: row.compact_output_tokens ?? 0,
    pricingCurrency: row.compact_pricing_currency_count === 1
      ? row.compact_pricing_currency
      : null,
    pricedRequestCount: row.compact_priced_request_count,
    totalCostNanos: row.compact_pricing_currency_count === 1
      ? row.compact_total_cost_nanos
      : null,
  };
}

function toStoredAggregatePricing(row: TurnSummaryRow | AggregateRow): Pick<
  StoredModelRequestMetricsAggregate,
  | "pricingCurrency"
  | "pricedRequestCount"
  | "totalCostNanos"
  | "inputCostNanos"
  | "cachedInputCostNanos"
  | "outputCostNanos"
  | "uncachedInputPricePerMillionNanos"
  | "cachedInputPricePerMillionNanos"
  | "outputPricePerMillionNanos"
  | "hasMixedPrices"
  | "pricingBuckets"
> {
  const hasMixedPrices = row.pricing_currency_count > 1
    || row.uncached_input_price_count > 1
    || row.cached_input_price_count > 1
    || row.output_price_count > 1;
  const hasSinglePrice = row.pricing_currency_count === 1 && !hasMixedPrices;
  const pricingBuckets: Array<"peak" | "off-peak"> =
    row.pricing_bucket_count >= 2
      ? ["off-peak", "peak"]
      : row.pricing_bucket_count === 1 && row.pricing_bucket !== null
        ? [row.pricing_bucket]
        : [];
  return {
    pricingCurrency: row.pricing_currency_count === 1
      ? row.pricing_currency
      : null,
    pricedRequestCount: row.priced_request_count,
    totalCostNanos: row.pricing_currency_count === 1
      ? row.total_cost_nanos
      : null,
    inputCostNanos: row.pricing_currency_count === 1
      ? row.uncached_input_cost_nanos
      : null,
    cachedInputCostNanos: row.pricing_currency_count === 1
      ? row.cached_input_cost_nanos
      : null,
    outputCostNanos: row.pricing_currency_count === 1
      ? row.output_cost_nanos
      : null,
    uncachedInputPricePerMillionNanos: hasSinglePrice
      ? row.uncached_input_price_per_million_nanos
      : null,
    cachedInputPricePerMillionNanos: hasSinglePrice
      ? row.cached_input_price_per_million_nanos
      : null,
    outputPricePerMillionNanos: hasSinglePrice
      ? row.output_price_per_million_nanos
      : null,
    hasMixedPrices,
    pricingBuckets,
  };
}

function toPricingSnapshot(row: MetricRow): ModelRequestPricingSnapshot | null {
  if (row.billing_mode === null) return null;
  if (row.pricing_source === null || row.pricing_effective_at_ms === null) {
    throw new Error(`模型请求指标 ${row.id} 的价格快照不完整`);
  }
  return {
    billingMode: row.billing_mode,
    currency: row.pricing_currency,
    source: row.pricing_source,
    effectiveAtMs: row.pricing_effective_at_ms,
    bucket: row.pricing_bucket,
    uncachedInputPricePerMillionNanos:
      row.uncached_input_price_per_million_nanos,
    cachedInputPricePerMillionNanos:
      row.cached_input_price_per_million_nanos,
    outputPricePerMillionNanos: row.output_price_per_million_nanos,
  };
}
