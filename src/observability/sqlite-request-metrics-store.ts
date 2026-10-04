import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { SqliteQuotaQueries } from "./sqlite-quota-queries.js";
import { SqliteRequestMetricsQueries, validateThreadId } from "./sqlite-request-metrics-queries.js";

import {
  securePrivateDirectorySync,
  securePrivateFileSync,
} from "../../runtime/private-file.mjs";

import {
  acquireRequestMetricsDatabaseLock,
  requestMetricsDatabasePath,
  type RequestMetricsDatabaseLock,
} from "./request-metrics-database.js";
import { parseQuotaWindows } from "./sqlite-request-metrics-row-codec.js";
import {
  ensureCurrentModelRequestMetricsSchema,
  metricStorageColumns,
  metricStorageColumnsSql,
  requireCurrentModelRequestMetricsSchema,
} from "./sqlite-request-metrics-schema.js";

import type {
  TurnExecutionMetric,
  TurnExecutionStore,
  SessionExecutionTiming,
  ModelRequestMetricSample,
  ModelRequestMetricsAggregationQuery,
  ModelRequestMetricsErrorQuery,
  ModelRequestMetricsPageQuery,
  ModelRequestMetricsScope,
  ModelRequestMetricsStore,
  ModelRequestMetricsThreadQuery,
  QuotaHistoryQuery,
  StoredModelRequestMetric,
  StoredModelRequestMetricsDailyRow,
  StoredModelRequestMetricsErrorReport,
  StoredModelRequestMetricsHourlyRow,
  StoredModelRequestMetricsPage,
  StoredModelRequestMetricsReport,
  StoredQuotaPeriod,
  StoredSubagentThreadRecord,
  SubagentThreadsQuery,
  StoredThreadSubagentsPage,
  StoredThreadListPage,
  StoredThreadRequestMetricsSummary,
  StoredThreadTurnsPage,
  StoredTurnRequestMetricsSummary,
  StoredWeeklyQuotaEstimate,
  StoredWeeklyQuotaWindow,
  WeeklyQuotaEstimateQuery,
} from "./request-metrics.js";

const dayMs = 24 * 60 * 60 * 1_000;
const defaultRetentionDays = 365;
const defaultMaximumRows = 1_000_000;
const cleanupInterval = 100;

export class SqliteModelRequestMetricsStore implements ModelRequestMetricsStore, TurnExecutionStore {
  private readonly database: DatabaseSync;
  private readonly queries = new SqliteRequestMetricsQueries({
    prepare: (sql) => this.database.prepare(sql),
    iterateRows: (sql, ...parameters) => this.iterateRows(sql, ...parameters),
    requireOpen: () => this.requireOpen(),
  });
  private readonly quotaQueries = new SqliteQuotaQueries({
    prepare: (sql) => this.database.prepare(sql),
    iterateRows: (sql, ...parameters) => this.iterateRows(sql, ...parameters),
  });
  private readonly activeReadStatements = new Set<StatementSync>();
  private readonly insert?: StatementSync;
  private readonly insertSubagentThread?: StatementSync;
  private readonly insertSubagentTurn?: StatementSync;
  private readonly lock?: RequestMetricsDatabaseLock;
  private closed = false;
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
          ${metricStorageColumns.map(() => "?").join(", ")}
        ) ON CONFLICT(relay_request_id) WHERE source = 'relay' DO NOTHING
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

  recordTurnExecution(threadId: string, provider: string, turn: TurnExecutionMetric): void {
    this.writeThreadExecutions(threadId, provider, [turn], false);
  }

  isExecutionHistoryComplete(threadId: string): boolean {
    this.requireOpen();
    validateThreadId(threadId, "Thread ID");
    return this.database.prepare("SELECT history_complete FROM thread_execution_state WHERE thread_id = ?")
      .get(threadId)?.history_complete === 1;
  }

  /** Complete authoritative snapshot, oldest first. Revert removes obsolete timing facts here. */
  replaceThreadExecutions(threadId: string, provider: string, turns: readonly TurnExecutionMetric[]): void {
    this.writeThreadExecutions(threadId, provider, turns, true);
  }

  invalidateThreadExecutions(threadId: string, clearDurations = true): void {
    this.requireOpen();
    if (!this.insert) throw new Error("只读模型请求指标数据库不能写入");
    validateThreadId(threadId, "Thread ID");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE thread_execution_state SET history_complete = 0 WHERE thread_id = ?").run(threadId);
      if (clearDurations) this.database.prepare("DELETE FROM turn_execution_metrics WHERE thread_id = ?").run(threadId);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  turnExecutionDuration(threadId: string, turnId: string): number | null {
    return this.queries.turnExecutionDuration(threadId, turnId);
  }

  sessionExecutionDuration(threadId: string, throughTurnId?: string): number | null {
    return this.queries.sessionExecutionDuration(threadId, throughTurnId);
  }

  sessionExecutionTiming(threadId: string, throughTurnId?: string): SessionExecutionTiming {
    return this.queries.sessionExecutionTiming(threadId, throughTurnId);
  }

  private writeThreadExecutions(threadId: string, provider: string, turns: readonly TurnExecutionMetric[], replace: boolean): void {
    this.requireOpen();
    if (!this.insert) throw new Error("只读模型请求指标数据库不能写入");
    validateThreadId(threadId, "Thread ID");
    validateThreadId(provider, "Provider");
    if (turns.length > 10_000) throw new Error("轮次耗时快照超过上限");
    const ids = new Set<string>();
    for (const turn of turns) {
      validateThreadId(turn.turnId, "Turn ID");
      if (ids.has(turn.turnId)) throw new Error("轮次耗时快照包含重复轮次");
      ids.add(turn.turnId);
      if ((turn.durationMs !== null && (!Number.isSafeInteger(turn.durationMs) || turn.durationMs < 0))
        || !Number.isSafeInteger(turn.recordedAtMs) || turn.recordedAtMs < 0) throw new Error("轮次耗时无效");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const resolved = replace ? turns.map(turn => ({ ...turn,
        durationMs: turn.durationMs ?? this.turnExecutionDuration(threadId, turn.turnId),
      })) : turns;
      this.database.prepare(`INSERT INTO thread_execution_state VALUES (?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET provider = excluded.provider,
        history_complete = CASE WHEN ? THEN 1 ELSE history_complete END`).run(threadId, provider, replace ? 1 : 0, replace ? 1 : 0);
      if (replace) this.database.prepare("DELETE FROM turn_execution_metrics WHERE thread_id = ?").run(threadId);
      const insert = this.database.prepare(`INSERT INTO turn_execution_metrics VALUES (?, ?, ?,
        (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM turn_execution_metrics WHERE thread_id = ?), ?)
        ON CONFLICT(thread_id, turn_id) DO UPDATE SET
          duration_ms = COALESCE(excluded.duration_ms, duration_ms)`);
      const cutoff = Math.max(0, Date.now() - this.retentionMs);
      for (const turn of resolved) {
        if (turn.recordedAtMs < cutoff) continue;
        insert.run(threadId, turn.turnId, turn.durationMs, threadId, turn.recordedAtMs);
      }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    this.finishRecords(turns.length, Date.now());
  }

  record(sample: ModelRequestMetricSample): void {
    this.requireOpen();
    if (!this.insert) throw new Error("只读模型请求指标数据库不能写入");
    const recordedAtMs = this.insertSample(sample);
    this.finishRecords(1, recordedAtMs);
  }

  recordBatch(samples: readonly ModelRequestMetricSample[]): void {
    this.requireOpen();
    if (!this.insert) throw new Error("只读模型请求指标数据库不能写入");
    if (samples.length === 0) return;
    if (samples.length === 1) {
      this.record(samples[0]!);
      return;
    }
    let latestRecordedAtMs = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const sample of samples) {
        latestRecordedAtMs = Math.max(latestRecordedAtMs, this.insertSample(sample));
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    this.finishRecords(samples.length, latestRecordedAtMs);
  }

  private insertSample(sample: ModelRequestMetricSample): number {
    if (sample.source === "relay" && (typeof sample.relayRequestId !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(sample.relayRequestId))) {
      throw new Error("Relay 指标请求 ID 无效");
    }
    if (sample.responseUsageAmount != null && (typeof sample.responseUsageAmount !== "string"
      || sample.responseUsageAmount.length > 128 || !/^[0-9]+(?:\.[0-9]+)?$/u.test(sample.responseUsageAmount))) {
      throw new Error("单次响应用量数值无效");
    }
    const recordedAtMs = sample.recordedAtMs ?? Date.now();
    this.insert!.run(
      sample.provider,
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
      sample.requestStartedAtMs,
      sample.responseCompletedAtMs,
      recordedAtMs,
      sample.weeklyQuota?.limitId ?? null,
      sample.weeklyQuota?.usedPercentMillionths ?? null,
      sample.weeklyQuota?.resetsAt ?? null,
      sample.weeklyQuota?.planType ?? null,
      sample.quotaWindows === undefined || sample.quotaWindows === null
        ? null
        : JSON.stringify(sample.quotaWindows),
      sample.userAgent ?? null,
      sample.upstreamTtftMs ?? null,
      sample.firstTokenMs ?? null,
      sample.requestModel ?? null,
      sample.responseModel ?? null,
      sample.traffic?.label ?? null,
      sample.traffic?.session ?? null,
      sample.traffic?.interaction ?? null,
      sample.totalDurationMs ?? null,
      sample.requestServiceTier ?? null,
      sample.source ?? "owned", sample.callerId ?? null, sample.keyId ?? null,
      sample.credentialGeneration ?? null, sample.relayRequestId ?? null, sample.deliveryStatus ?? null,
      sample.responseUsageAmount ?? null,
      sample.upstreamProvider ?? null,
      sample.upstreamAttemptCount ?? null,
      sample.modelAttemptCount ?? null,
      sample.finishReason ?? null,
      sample.errorStage ?? null,
      sample.upstreamErrorCode ?? null,
      sample.upstreamErrorType ?? null,
      sample.upstreamHttpStatus ?? null,

    );
    return recordedAtMs;
  }

  private finishRecords(count: number, recordedAtMs: number): void {
    this.recordsSinceCleanup += count;
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
    return this.queries.recent(limit);
  }

  relayCallerUsage(callers: readonly { callerId: string; keyId: string }[], startAtMs: number, endAtMs: number) {
    return this.queries.relayCallerUsage(callers, startAtMs, endAtMs);
  }

  weeklyQuotaEstimate(query: WeeklyQuotaEstimateQuery): StoredWeeklyQuotaEstimate | null {
    this.requireOpen();
    return this.quotaQueries.weeklyQuotaEstimate(query);
  }

  latestWeeklyQuota(provider: string, nowMs: number = Date.now()): StoredWeeklyQuotaWindow | null {
    this.requireOpen();
    return this.quotaQueries.latestWeeklyQuota(provider, nowMs);
  }

  quotaHistory(query: QuotaHistoryQuery): StoredQuotaPeriod[] {
    this.requireOpen();
    return this.quotaQueries.quotaHistory(query);
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
    this.cleanupAccountSnapshots(snapshot.observedAtMs);
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

  latestAccountSnapshots() {
    const rows = this.database.prepare(`
      SELECT s.provider, s.account_id, a.observed_at_ms, a.available,
        a.usage_json, a.limits_json
      FROM account_snapshots a JOIN account_sources s ON s.source_id = a.source_id
      WHERE a.observed_at_ms = (
        SELECT MAX(a2.observed_at_ms) FROM account_snapshots a2
        WHERE a2.source_id = a.source_id
      )
      ORDER BY s.provider, s.account_id
    `).all() as Array<{
      provider: string; account_id: string | null; observed_at_ms: number;
      available: number; usage_json: string; limits_json: string;
    }>;
    return rows.map((row) => ({
      provider: row.provider,
      accountId: row.account_id,
      observedAtMs: row.observed_at_ms,
      available: row.available === 1,
      usage: JSON.parse(row.usage_json) as unknown,
      limits: JSON.parse(row.limits_json) as unknown,
    }));
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
    return this.queries.forEachProviderTokenMetric(query, visit);
  }

  page(query: ModelRequestMetricsPageQuery): StoredModelRequestMetricsPage {
    return this.queries.page(query);
  }

  providers(): string[] {
    return this.queries.providers();
  }

  aggregate(
    query: ModelRequestMetricsAggregationQuery,
  ): StoredModelRequestMetricsReport {
    return this.queries.aggregate(query);
  }

  /** 多个同步查询共享同一 SQLite 读快照；不持有写锁。 */
  readSnapshot<T>(read: () => T): T {
    this.requireOpen();
    this.database.exec("BEGIN");
    try {
      const result = read();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  daily(
    query: { startAtMs: number; endAtMs: number },
  ): StoredModelRequestMetricsDailyRow[] {
    return this.queries.daily(query);
  }

  hourly(
    query: { startAtMs: number; endAtMs: number },
  ): StoredModelRequestMetricsHourlyRow[] {
    return this.queries.hourly(query);
  }

  errors(
    query: ModelRequestMetricsErrorQuery,
  ): StoredModelRequestMetricsErrorReport {
    return this.queries.errors(query);
  }

  threadSummary(threadId: string): StoredThreadRequestMetricsSummary {
    return this.queries.threadSummary(threadId);
  }

  threadTurnTaskSummary(
    threadId: string,
    turnId: string,
  ): StoredTurnRequestMetricsSummary | null {
    return this.queries.threadTurnTaskSummary(threadId, turnId);
  }

  threadTurnSummary(
    threadId: string,
    turnId: string,
  ): StoredTurnRequestMetricsSummary | null {
    return this.queries.threadTurnSummary(threadId, turnId);
  }

  threadTurnSummaries(threadId: string, query: ModelRequestMetricsThreadQuery): StoredThreadTurnsPage {
    return this.queries.threadTurnSummaries(threadId, query);
  }

  /**
   * Count Turns recorded directly on a Thread without traversing subagent
   * descendants. This is the inexpensive local equivalent used by session
   * pickers; full summaries retain their aggregate/subagent semantics.
   */
  threadTurnCount(threadId: string): number | null {
    return this.queries.threadTurnCount(threadId);
  }

  threadList(query: ModelRequestMetricsThreadQuery): StoredThreadListPage {
    return this.queries.threadList(query);
  }

  threadCounts(query: ModelRequestMetricsScope): { threadCount: number; turnCount: number } {
    return this.queries.threadCounts(query);
  }

  threadSubagents(threadId: string, query: SubagentThreadsQuery): StoredThreadSubagentsPage {
    return this.queries.threadSubagents(threadId, query);
  }

  subagents(query: SubagentThreadsQuery): StoredThreadSubagentsPage {
    return this.queries.subagents(query);
  }

  subagentThread(threadId: string): {
    agentPath: string | null;
    parentThreadId: string | null;
    parentTurnId: string | null;
  } {
    return this.queries.subagentThread(threadId);
  }

  requestRowsAfter(
    afterLocalId: number,
    limit: number,
  ): StoredModelRequestMetric[] {
    return this.queries.requestRowsAfter(afterLocalId, limit);
  }

  subagentThreadsAfter(
    recordedAtMs: number,
    afterThreadId?: string,
  ): StoredSubagentThreadRecord[] {
    return this.queries.subagentThreadsAfter(recordedAtMs, afterThreadId);
  }

  count(): number {
    return this.queries.count();
  }

  private *iterateRows(sql: string, ...parameters: SQLInputValue[]) {
    const statement = this.database.prepare(sql);
    // Node 22.13 的 SQLite 迭代器不持有 statement，读取期间必须防止其被 GC 提前释放。
    this.activeReadStatements.add(statement);
    try {
      yield* statement.iterate(...parameters);
    } finally {
      this.activeReadStatements.delete(statement);
    }
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
      requireCurrentModelRequestMetricsSchema(this.database);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private cleanupAccountSnapshots(nowMs: number): void {
    // 最新观测是账户状态，不随历史保留期限失效；只有后续观测可以替换它。
    this.database.prepare(`
      DELETE FROM account_snapshots
      WHERE observed_at_ms < ? AND EXISTS (
        SELECT 1 FROM account_snapshots newer
        WHERE newer.source_id = account_snapshots.source_id
          AND newer.observed_at_ms > account_snapshots.observed_at_ms
      )
    `).run(Math.max(0, nowMs - this.retentionMs));
  }

  private cleanup(nowMs: number): void {
    this.requireOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM turn_execution_metrics WHERE recorded_at_ms < ?").run(Math.max(0, nowMs - this.retentionMs));
      this.database.prepare(`DELETE FROM turn_execution_metrics WHERE rowid IN (
        SELECT rowid FROM turn_execution_metrics ORDER BY recorded_at_ms DESC, rowid DESC LIMIT -1 OFFSET ?
      )`).run(this.maximumRows);
      this.database.exec("DELETE FROM thread_execution_state WHERE thread_id NOT IN (SELECT thread_id FROM turn_execution_metrics)");
      this.database.prepare(`
        DELETE FROM model_request_metrics WHERE recorded_at_ms < ?
      `).run(Math.max(0, nowMs - this.retentionMs));
      this.database.prepare(`
        DELETE FROM subagent_turns WHERE recorded_at_ms < ?
      `).run(Math.max(0, nowMs - this.retentionMs));
      this.cleanupAccountSnapshots(nowMs);
      // 行数裁剪按 id 上界一次定位，避免 ORDER BY ... OFFSET 在每次清理时
      // 对主键做全表倒扫；id 出现空洞时只会更早清掉最旧记录，不会删掉更新的记录。
      this.database.prepare(`
        DELETE FROM model_request_metrics
        WHERE id <= (SELECT MAX(id) FROM model_request_metrics) - ?
      `).run(this.maximumRows);
      this.database.exec("COMMIT");
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

export { ModelRequestMetricsSchemaError } from "./sqlite-request-metrics-schema.js";
