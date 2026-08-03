import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type {
  ModelRequestMetricSample,
  ModelRequestMetricsStore,
  StoredModelRequestMetric,
} from "./request-metrics.js";

const schemaVersion = 1;
const retentionMs = 30 * 24 * 60 * 60 * 1_000;
const maximumRows = 100_000;
const cleanupInterval = 100;

interface MetricRow {
  id: number;
  provider: string;
  transport: "http" | "websocket";
  response_format: "sse" | "json" | "websocket" | "unknown";
  operation: "response" | "compact";
  thread_id: string | null;
  turn_id: string | null;
  model: string | null;
  service_tier: string | null;
  status: "completed" | "failed" | "incomplete" | "unknown";
  http_status: number | null;
  error_type: string | null;
  error_code: string | null;
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
}

export class SqliteModelRequestMetricsStore implements ModelRequestMetricsStore {
  private readonly database: DatabaseSync;
  private readonly insert: StatementSync;
  private closed = false;
  private rowCount = 0;
  private recordsSinceCleanup = 0;

  constructor(readonly path: string, nowMs: number = Date.now()) {
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
    this.database = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.database.exec(`
        PRAGMA busy_timeout = 10;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
      `);
      this.initializeSchema();
      this.insert = this.database.prepare(`
        INSERT INTO model_request_metrics (
          provider, transport, response_format, operation, thread_id, turn_id, model, service_tier,
          status, http_status, error_type, error_code, incomplete_reason,
          input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens,
          total_tokens, upstream_created_at, upstream_completed_at,
          request_started_at_ms, first_token_at_ms,
          first_reasoning_delta_at_ms, last_reasoning_delta_at_ms,
          first_output_delta_at_ms, last_output_delta_at_ms,
          response_completed_at_ms, recorded_at_ms
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `);
      this.cleanup(nowMs);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  record(sample: ModelRequestMetricSample): void {
    this.requireOpen();
    const recordedAtMs = Date.now();
    this.insert.run(
      sample.provider,
      sample.transport,
      sample.responseFormat,
      sample.operation,
      sample.threadId,
      sample.turnId,
      sample.model,
      sample.serviceTier,
      sample.status,
      sample.httpStatus,
      sample.errorType,
      sample.errorCode,
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
    );
    this.rowCount += 1;
    this.recordsSinceCleanup += 1;
    if (this.recordsSinceCleanup >= cleanupInterval) {
      this.cleanup(recordedAtMs);
    }
  }

  recent(limit: number): StoredModelRequestMetric[] {
    this.requireOpen();
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("模型请求指标查询数量必须在 1 到 500 之间");
    }
    const rows = this.database.prepare(`
      SELECT * FROM model_request_metrics ORDER BY id DESC LIMIT ?
    `).all(limit) as unknown as MetricRow[];
    return rows.map(toStoredMetric);
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
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
        throw new Error(`模型请求指标数据库 Schema 不受支持：${version.value}`);
      }
      if (!version) {
        this.database.exec(`
          CREATE TABLE model_request_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL,
            transport TEXT NOT NULL CHECK (transport IN ('http', 'websocket')),
            response_format TEXT NOT NULL CHECK (
              response_format IN ('sse', 'json', 'websocket', 'unknown')
            ),
            operation TEXT NOT NULL CHECK (operation IN ('response', 'compact')),
            thread_id TEXT,
            turn_id TEXT,
            model TEXT,
            service_tier TEXT,
            status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'incomplete', 'unknown')),
            http_status INTEGER,
            error_type TEXT,
            error_code TEXT,
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
            recorded_at_ms INTEGER NOT NULL
          );
          CREATE INDEX model_request_metrics_recorded_at
            ON model_request_metrics (recorded_at_ms);
          CREATE INDEX model_request_metrics_thread_turn
            ON model_request_metrics (thread_id, turn_id, id);
          CREATE INDEX model_request_metrics_provider_model
            ON model_request_metrics (provider, model, id);
          INSERT INTO schema_metadata (name, value) VALUES ('schema_version', ${schemaVersion});
        `);
      }
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
      `).run(Math.max(0, nowMs - retentionMs));
      this.database.prepare(`
        DELETE FROM model_request_metrics
        WHERE id <= COALESCE((
          SELECT id FROM model_request_metrics ORDER BY id DESC LIMIT 1 OFFSET ?
        ), 0)
      `).run(maximumRows);
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

export function modelRequestMetricsDatabasePath(stateDatabasePath: string): string {
  return join(dirname(stateDatabasePath), "request-metrics.sqlite3");
}

function toStoredMetric(row: MetricRow): StoredModelRequestMetric {
  return {
    id: row.id,
    provider: row.provider,
    transport: row.transport,
    responseFormat: row.response_format,
    operation: row.operation,
    threadId: row.thread_id,
    turnId: row.turn_id,
    model: row.model,
    serviceTier: row.service_tier,
    status: row.status,
    httpStatus: row.http_status,
    errorType: row.error_type,
    errorCode: row.error_code,
    incompleteReason: row.incomplete_reason,
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
    recordedAtMs: row.recorded_at_ms,
  };
}
