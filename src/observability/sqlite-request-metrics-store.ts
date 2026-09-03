import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import {
  securePrivateDirectorySync,
  securePrivateFileSync,
} from "../../runtime/private-file.mjs";

import {
  acquireRequestMetricsDatabaseLock,
  requestMetricsDatabasePath,
  type RequestMetricsDatabaseLock,
} from "./request-metrics-database.js";
import {
  toStoredCompactSummary,
  toStoredMetric,
  toStoredMetricsAggregate,
  toStoredMetricsGroup,
  toStoredThreadAggregate,
  toStoredTurnSummary,
  type AggregateRow,
  type CompactSummaryRow,
  type ErrorGroupRow,
  type ErrorSummaryRow,
  type MetricRow,
  type TurnSummaryRow,
} from "./sqlite-request-metrics-row-codec.js";
import {
  ensureCurrentModelRequestMetricsSchema,
  metricStorageColumnsSql,
  requireCurrentModelRequestMetricsSchema,
} from "./sqlite-request-metrics-schema.js";

import type {
  ModelRequestMetricSample,
  ModelRequestMetricsAggregationDimension,
  ModelRequestMetricsAggregationQuery,
  ModelRequestMetricsErrorQuery,
  ModelRequestMetricsPageQuery,
  ModelRequestMetricsStore,
  StoredModelRequestMetric,
  StoredModelRequestMetricsErrorReport,
  StoredModelRequestMetricsPage,
  StoredModelRequestMetricsReport,
  StoredThreadRequestMetricsSummary,
  StoredThreadListItem,
  StoredThreadTurnSummary,
  StoredSubagentThreadRecord,
  StoredTurnRequestMetricsSummary,
  StoredWeeklyQuotaEstimate,
  StoredWeeklyQuotaWindow,
  QuotaHistoryQuery,
  StoredQuotaPeriod,
  WeeklyQuotaEstimateQuery,
} from "./request-metrics.js";

const dayMs = 24 * 60 * 60 * 1_000;
const defaultRetentionDays = 365;
const defaultMaximumRows = 1_000_000;
const weeklyWindowMs = 7 * 24 * 60 * 60 * 1_000;
// 上游额度接口的 resetsAt 可能在相邻快照间有数秒抖动；仅在很小范围内归并，
// 避免把真实的不定期重置误合并。
const quotaResetJitterSeconds = 5 * 60;
const cleanupInterval = 100;
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

export class SqliteModelRequestMetricsStore implements ModelRequestMetricsStore {
  private readonly database: DatabaseSync;
  private readonly insert?: StatementSync;
  private readonly insertSubagentThread?: StatementSync;
  private readonly insertSubagentTurn?: StatementSync;
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
        requireCurrentModelRequestMetricsSchema(this.database);
        this.rowCount = this.currentCount();
      } catch (error) {
        database.close();
        throw error;
      }
      return;
    }
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    securePrivateDirectorySync(parent);
    this.lock = acquireRequestMetricsDatabaseLock(path);
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(path);
      this.database = database;
      securePrivateFileSync(path);
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
      this.insertSubagentTurn = this.database.prepare(`
        INSERT INTO subagent_turns (
          thread_id, turn_id, parent_thread_id, parent_turn_id, agent_path,
          recorded_at_ms
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, turn_id) DO UPDATE SET
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

  recordSubagentTurn(details: {
    agentThreadId: string;
    agentTurnId: string;
    parentThreadId: string;
    parentTurnId: string;
    agentPath: string;
  }): void {
    const {
      agentThreadId,
      agentTurnId,
      parentThreadId,
      parentTurnId,
      agentPath,
    } = details;
    this.requireOpen();
    if (!this.insertSubagentTurn) {
      throw new Error("只读模型请求指标数据库不能写入");
    }
    validateThreadId(agentThreadId, "子代理 Thread ID");
    validateThreadId(agentTurnId, "子代理 Turn ID");
    validateThreadId(parentThreadId, "子代理父 Thread ID");
    validateThreadId(parentTurnId, "子代理父 Turn ID");
    if (!agentPath.trim() || agentPath.length > 512) {
      throw new Error("子代理路径无效");
    }
    this.insertSubagentTurn.run(
      agentThreadId,
      agentTurnId,
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

  quotaHistory(query: QuotaHistoryQuery): StoredQuotaPeriod[] {
    this.requireOpen();
    if (!Number.isSafeInteger(query.startAtMs) || !Number.isSafeInteger(query.endAtMs)
      || query.startAtMs < 0 || query.startAtMs >= query.endAtMs) {
      throw new Error("额度历史查询时间范围无效");
    }
    const rows = this.database.prepare(`
      SELECT * FROM model_request_metrics_enriched
      WHERE recorded_at_ms >= ? AND recorded_at_ms < ?
      ORDER BY recorded_at_ms ASC, id ASC
    `).all(query.startAtMs, query.endAtMs) as unknown as MetricRow[];
    const groups = new Map<string, StoredQuotaPeriod>();
    for (const row of rows) {
      const metric = toStoredMetric(row);
      const snapshots: Array<{
        windowId: string;
        resetsAt: number | null;
        usedPercentMillionths: number | null;
        planType: string | null;
      }> = [];
      if (metric.weeklyQuota) snapshots.push({
        windowId: metric.weeklyQuota.limitId,
        resetsAt: metric.weeklyQuota.resetsAt,
        usedPercentMillionths: metric.weeklyQuota.usedPercentMillionths,
        planType: metric.weeklyQuota.planType,
      });
      for (const window of metric.quotaWindows ?? []) snapshots.push({
        windowId: window.windowId,
        resetsAt: window.resetsAt,
        usedPercentMillionths: null,
        planType: null,
      });
      for (const snapshot of snapshots) {
        if (snapshot.resetsAt === null) continue;
        const exactKey = `${metric.provider}\u0000${snapshot.windowId}\u0000${snapshot.resetsAt}`;
        let key = exactKey;
        let existing = groups.get(key);
        if (!existing) {
          for (const [candidateKey, candidate] of groups) {
            if (candidate.provider === metric.provider
              && candidate.windowId === snapshot.windowId
              && Math.abs(candidate.resetsAt - snapshot.resetsAt) <= quotaResetJitterSeconds) {
              key = candidateKey;
              existing = candidate;
              break;
            }
          }
        }
        const successful = metric.status === "completed" ? 1 : 0;
        const inputTokens = metric.inputTokens ?? 0;
        const outputTokens = metric.outputTokens ?? 0;
        const totalTokens = metric.totalTokens ?? inputTokens + outputTokens;
        const cost = metric.totalCostNanos;
        if (!existing) {
          groups.set(key, {
            provider: metric.provider,
            windowId: snapshot.windowId,
            resetsAt: snapshot.resetsAt,
            periodStartAtMs: quotaPeriodStartAtMs(snapshot.windowId, snapshot.resetsAt),
            periodEndAtMs: snapshot.resetsAt * 1_000,
            firstObservedAtMs: metric.recordedAtMs,
            lastObservedAtMs: metric.recordedAtMs,
            snapshotCount: 1,
            requestCount: 1,
            unsuccessfulRequestCount: 1 - successful,
            inputTokens,
            outputTokens,
            totalTokens,
            pricedRequestCount: cost === null ? 0 : 1,
            totalCostNanos: cost,
            latestUsedPercentMillionths: snapshot.usedPercentMillionths,
            planType: snapshot.planType,
          });
        } else {
          existing.lastObservedAtMs = metric.recordedAtMs;
          existing.snapshotCount += 1;
          existing.requestCount += 1;
          existing.unsuccessfulRequestCount += 1 - successful;
          existing.inputTokens += inputTokens;
          existing.outputTokens += outputTokens;
          existing.totalTokens += totalTokens;
          if (cost !== null) {
            existing.pricedRequestCount += 1;
            existing.totalCostNanos = existing.totalCostNanos === null
              ? cost : existing.totalCostNanos + cost;
          }
          if (snapshot.usedPercentMillionths !== null) {
            existing.latestUsedPercentMillionths = snapshot.usedPercentMillionths;
          }
          if (snapshot.planType !== null) existing.planType = snapshot.planType;
        }
      }
    }
    const periods = [...groups.values()];
    applyObservedQuotaResetBoundaries(periods);
    return periods.sort((a, b) => b.lastObservedAtMs - a.lastObservedAtMs);
  }

  upsertAccountSnapshot(snapshot: {
    sourceId: string; provider: string; accountId: string | null; displayName: string;
    enabled: boolean; observedAtMs: number; available: boolean; usage: unknown; limits: unknown;
  }): void {
    if (this.closed) throw new Error("指标数据库已关闭");
    this.database.prepare(`
      INSERT INTO account_sources (source_id, provider, account_id, display_name, enabled)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET provider=excluded.provider,
        account_id=excluded.account_id, display_name=excluded.display_name,
        enabled=excluded.enabled
    `).run(snapshot.sourceId, snapshot.provider, snapshot.accountId, snapshot.displayName,
      snapshot.enabled ? 1 : 0);
    this.database.prepare(`
      INSERT INTO account_snapshots
        (source_id, observed_at_ms, available, usage_json, limits_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_id, observed_at_ms) DO UPDATE SET available=excluded.available,
        usage_json=excluded.usage_json, limits_json=excluded.limits_json
    `).run(snapshot.sourceId, snapshot.observedAtMs, snapshot.available ? 1 : 0,
      JSON.stringify(snapshot.usage), JSON.stringify(snapshot.limits));
  }

  latestAccountSnapshot(provider: string, accountId?: string) {
    const row = this.database.prepare(`
      SELECT s.provider, s.account_id, a.observed_at_ms, a.available,
        a.usage_json, a.limits_json
      FROM account_snapshots a JOIN account_sources s ON s.source_id = a.source_id
      WHERE s.provider = ? AND (? IS NULL OR s.account_id = ?)
      ORDER BY a.observed_at_ms DESC LIMIT 1
    `).get(provider, accountId ?? null, accountId ?? null) as {
      provider: string; account_id: string | null; observed_at_ms: number;
      available: number; usage_json: string; limits_json: string;
    } | undefined;
    if (!row) return null;
    return {
      provider: row.provider,
      accountId: row.account_id,
      observedAtMs: row.observed_at_ms,
      available: row.available === 1,
      usage: JSON.parse(row.usage_json) as unknown,
      limits: JSON.parse(row.limits_json) as unknown,
    };
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
    const failuresSql = query.onlyFailures ? ` AND NOT (${observableCompletionSql})` : "";
    const matchedTotal = (this.database.prepare(`
      SELECT COUNT(*) AS n
      FROM model_request_metrics_enriched
      WHERE recorded_at_ms >= ?
        AND recorded_at_ms < ?${failuresSql}${filterSql}
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
        ${failuresSql}${filterSql}
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
      : this.queryThreadTurnSummary(threadId, latestTurn.turn_id);
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
      FROM subagent_turns
      WHERE parent_thread_id = ?
        AND parent_turn_id = ?
      LIMIT 1
    `).get(threadId, turnId);
    if (child === undefined) return null;
    const row = this.database.prepare(`
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
        FROM model_request_metrics_enriched AS metric
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

  threadTurnSummary(
    threadId: string,
    turnId: string,
  ): StoredTurnRequestMetricsSummary | null {
    this.requireOpen();
    validateThreadId(threadId, "Thread ID");
    validateThreadId(turnId, "Turn ID");
    const row = this.queryThreadTurnSummary(threadId, turnId);
    return row === undefined ? null : toStoredTurnSummary(row);
  }

  private queryThreadTurnSummary(
    threadId: string,
    turnId: string,
  ): TurnSummaryRow | undefined {
    return this.database.prepare(`
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
    `).get(threadId, turnId) as TurnSummaryRow | undefined;
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

  /**
   * Count Turns recorded directly on a Thread without traversing subagent
   * descendants. This is the inexpensive local equivalent used by session
   * pickers; full summaries retain their aggregate/subagent semantics.
   */
  threadTurnCount(threadId: string): number | null {
    this.requireOpen();
    if (!threadId.trim() || threadId.length > 128) {
      throw new Error("Thread ID 无效");
    }
    const row = this.database.prepare(`
      SELECT COUNT(DISTINCT turn_id) AS turn_count, COUNT(*) AS request_count
      FROM model_request_metrics_enriched
      WHERE thread_id = ? AND turn_id IS NOT NULL
    `).get(threadId) as { turn_count: number; request_count: number };
    return row.request_count === 0 ? null : row.turn_count;
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
      ensureCurrentModelRequestMetricsSchema(this.database);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
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
        DELETE FROM subagent_turns WHERE recorded_at_ms < ?
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

function applyObservedQuotaResetBoundaries(periods: StoredQuotaPeriod[]): void {
  const groups = new Map<string, StoredQuotaPeriod[]>();
  for (const period of periods) {
    if (period.periodStartAtMs === null) continue;
    const key = `${period.provider}\u0000${period.windowId}`;
    const group = groups.get(key) ?? [];
    group.push(period);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.periodStartAtMs! - right.periodStartAtMs!);
    for (let index = 0; index < group.length - 1; index += 1) {
      const period = group[index]!;
      const nextPeriod = group[index + 1]!;
      const nominalDurationMs = period.periodEndAtMs - period.periodStartAtMs!;
      const resetOffsetMs = Math.abs(nextPeriod.periodStartAtMs! - period.periodEndAtMs);
      if (nextPeriod.periodStartAtMs! > period.periodStartAtMs!
        && resetOffsetMs < nominalDurationMs) {
        period.periodEndAtMs = nextPeriod.periodStartAtMs!;
      }
    }
  }
}

function quotaPeriodStartAtMs(windowId: string, resetsAt: number): number | null {
  const endAtMs = resetsAt * 1_000;
  if (windowId === "codex" || windowId === "weekly") return endAtMs - weeklyWindowMs;
  if (windowId === "rolling") return endAtMs - 5 * 60 * 60 * 1_000;
  if (windowId !== "monthly") return null;
  const date = new Date(endAtMs);
  const previousMonth = date.getUTCMonth() - 1;
  const year = date.getUTCFullYear();
  const lastDay = new Date(Date.UTC(year, previousMonth + 1, 0)).getUTCDate();
  return Date.UTC(year, previousMonth, Math.min(date.getUTCDate(), lastDay), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds());
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

export { ModelRequestMetricsSchemaError } from "./sqlite-request-metrics-schema.js";

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
  const periodTotal = emptyWeeklyInterval();
  const currencies = new Set<string>();

  for (const row of rows) {
    addWeeklyIntervalRow(periodTotal, row);
    const matching = row.weekly_quota_limit_id === query.limitId
      && row.weekly_resets_at !== null
      && Math.abs(row.weekly_resets_at - query.resetsAt) <= quotaResetJitterSeconds
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

  // 周期内最后一个额度快照之后通常仍有请求；它们没有下一个快照
  // 可以闭合区间，但仍属于本周期样本，必须计入总量。
  mergeWeeklyInterval(total, pending);
  for (const currency of pending.currencies) currencies.add(currency);

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
    periodRequestCount: periodTotal.requestCount,
    periodInputTokens: periodTotal.inputTokens,
    periodOutputTokens: periodTotal.outputTokens,
    periodTotalTokens: periodTotal.inputTokens + periodTotal.outputTokens,
    periodTotalCostNanos: periodTotal.currencies.size === 1 ? periodTotal.totalCostNanos : null,
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
