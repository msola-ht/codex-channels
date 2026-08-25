import type { DatabaseSync } from "node:sqlite";

import { modelRequestMetricsSchemaVersion } from "./request-metrics-database.js";

const schemaVersion = modelRequestMetricsSchemaVersion;

export const metricStorageColumnsSql = `
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

const schemaMetadataSql = `
  CREATE TABLE IF NOT EXISTS schema_metadata (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
`;

const initialSchemaSql = `
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
`;

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

export function ensureCurrentModelRequestMetricsSchema(database: DatabaseSync): void {
  database.exec(schemaMetadataSql);
  const version = database.prepare(`
    SELECT value FROM schema_metadata WHERE name = 'schema_version'
  `).get() as { value: number } | undefined;
  if (version && version.value !== schemaVersion) {
    throw new ModelRequestMetricsSchemaError(version.value, schemaVersion);
  }
  if (!version) database.exec(initialSchemaSql);
}

export function requireCurrentModelRequestMetricsSchema(database: DatabaseSync): void {
  let value: number | undefined;
  try {
    value = (database.prepare(`
      SELECT value FROM schema_metadata WHERE name = 'schema_version'
    `).get() as { value: number } | undefined)?.value;
  } catch {
    throw new ModelRequestMetricsSchemaError(0, schemaVersion);
  }
  if (value !== schemaVersion) {
    throw new ModelRequestMetricsSchemaError(value ?? 0, schemaVersion);
  }
  try {
    database.prepare(`
      SELECT id, ${metricStorageColumnsSql}
      FROM model_request_metrics
      LIMIT 0
    `).all();
    database.prepare(`
      SELECT thread_id, parent_thread_id, parent_turn_id, agent_path, recorded_at_ms
      FROM subagent_threads
      LIMIT 0
    `).all();
    database.prepare(`
      SELECT id, total_cost_nanos
      FROM model_request_metrics_enriched
      LIMIT 0
    `).all();
  } catch (error) {
    throw new ModelRequestMetricsSchemaError(value, schemaVersion, { cause: error });
  }
}
