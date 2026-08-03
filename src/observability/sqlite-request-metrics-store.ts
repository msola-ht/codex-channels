import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type {
  ModelRequestMetricSample,
  ModelRequestMetricsStore,
  ModelRequestPricingSnapshot,
  StoredModelRequestMetric,
} from "./request-metrics.js";

const schemaVersion = 2;
const retentionMs = 30 * 24 * 60 * 60 * 1_000;
const maximumRows = 100_000;
const cleanupInterval = 100;

interface MetricRow {
  id: number;
  provider: string;
  billing_mode: "api" | "subscription" | "unknown" | null;
  pricing_currency: string | null;
  pricing_source: string | null;
  pricing_effective_at_ms: number | null;
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
          provider, billing_mode, pricing_currency, pricing_source, pricing_effective_at_ms,
          uncached_input_price_per_million_nanos,
          cached_input_price_per_million_nanos, output_price_per_million_nanos,
          transport, response_format, operation, thread_id, turn_id, model, service_tier,
          status, http_status, error_type, error_code, incomplete_reason,
          input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens,
          total_tokens, upstream_created_at, upstream_completed_at,
          request_started_at_ms, first_token_at_ms,
          first_reasoning_delta_at_ms, last_reasoning_delta_at_ms,
          first_output_delta_at_ms, last_output_delta_at_ms,
          response_completed_at_ms, recorded_at_ms
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?
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
      sample.pricing?.billingMode ?? null,
      sample.pricing?.currency ?? null,
      sample.pricing?.source ?? null,
      sample.pricing?.effectiveAtMs ?? null,
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
      SELECT * FROM model_request_metrics_enriched ORDER BY id DESC LIMIT ?
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
            billing_mode TEXT CHECK (
              billing_mode IS NULL OR billing_mode IN ('api', 'subscription', 'unknown')
            ),
            pricing_currency TEXT,
            pricing_source TEXT,
            pricing_effective_at_ms INTEGER,
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
            recorded_at_ms INTEGER NOT NULL,
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
    pricing: toPricingSnapshot(row),
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
    uncachedInputPricePerMillionNanos:
      row.uncached_input_price_per_million_nanos,
    cachedInputPricePerMillionNanos:
      row.cached_input_price_per_million_nanos,
    outputPricePerMillionNanos: row.output_price_per_million_nanos,
  };
}
