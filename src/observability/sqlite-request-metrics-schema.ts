import type { DatabaseSync } from "node:sqlite";

import { modelRequestMetricsSchemaVersion } from "./request-metrics-database.js";

const schemaVersion = modelRequestMetricsSchemaVersion;

export const metricStorageColumns = [
  "provider", "transport", "response_format", "operation", "thread_id", "turn_id",
  "model", "service_tier", "reasoning_effort", "status", "http_status", "error_type",
  "error_code", "error_message", "incomplete_reason", "input_tokens",
  "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens",
  "request_started_at_ms", "response_completed_at_ms", "recorded_at_ms",
  "weekly_quota_limit_id", "weekly_used_percent_millionths", "weekly_resets_at",
  "weekly_quota_plan_type", "quota_windows", "user_agent", "upstream_ttft_ms",
  "first_content_ms", "request_model", "response_model",
] as const;

export const metricStorageColumnsSql = metricStorageColumns.join(", ");

export const modelRequestMetricsTableSql = `
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
    request_started_at_ms INTEGER NOT NULL,
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
    user_agent TEXT,
    upstream_ttft_ms REAL CHECK (upstream_ttft_ms IS NULL OR upstream_ttft_ms >= 0),
    first_content_ms REAL CHECK (first_content_ms IS NULL OR first_content_ms >= 0),
    request_model TEXT,
    response_model TEXT
  );
`;

export const modelRequestMetricsIndexesSql = `
  CREATE INDEX model_request_metrics_recorded_at
    ON model_request_metrics (recorded_at_ms);
  CREATE INDEX model_request_metrics_thread_turn
    ON model_request_metrics (thread_id, turn_id, id);
  CREATE INDEX model_request_metrics_provider_model
    ON model_request_metrics (provider, model, id);
`;

const schemaMetadataSql = `
  CREATE TABLE IF NOT EXISTS schema_metadata (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
`;

const initialSchemaSql = `
  CREATE TABLE account_sources (
    source_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    account_id TEXT,
    display_name TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    UNIQUE (provider, account_id)
  );
  CREATE TABLE account_snapshots (
    snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL REFERENCES account_sources(source_id) ON DELETE CASCADE,
    observed_at_ms INTEGER NOT NULL,
    available INTEGER NOT NULL CHECK (available IN (0, 1)),
    usage_json TEXT NOT NULL,
    limits_json TEXT NOT NULL,
    UNIQUE (source_id, observed_at_ms)
  );
  CREATE INDEX account_snapshots_latest ON account_snapshots (source_id, observed_at_ms DESC);
  CREATE TABLE subagent_threads (
    thread_id TEXT PRIMARY KEY,
    parent_thread_id TEXT NOT NULL,
    parent_turn_id TEXT,
    agent_path TEXT NOT NULL,
    recorded_at_ms INTEGER NOT NULL
  );
  CREATE TABLE subagent_turns (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    parent_thread_id TEXT NOT NULL,
    parent_turn_id TEXT NOT NULL,
    agent_path TEXT NOT NULL,
    recorded_at_ms INTEGER NOT NULL,
    PRIMARY KEY (thread_id, turn_id)
  );
  CREATE INDEX subagent_turns_parent_turn
    ON subagent_turns (parent_thread_id, parent_turn_id);
  ${modelRequestMetricsTableSql}
  ${modelRequestMetricsIndexesSql}
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
    const metricColumns = database.prepare("PRAGMA table_info(model_request_metrics)")
      .all().map((column) => (column as { name: string }).name);
    if (
      metricColumns.length !== metricStorageColumns.length + 1
      || metricColumns[0] !== "id"
      || metricStorageColumns.some((column, index) => metricColumns[index + 1] !== column)
    ) {
      throw new Error("model_request_metrics 列定义不匹配");
    }
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
      SELECT thread_id, turn_id, parent_thread_id, parent_turn_id,
        agent_path, recorded_at_ms
      FROM subagent_turns
      LIMIT 0
    `).all();
    database.prepare(`
      SELECT source_id, provider, account_id, display_name, enabled
      FROM account_sources LIMIT 0
    `).all();
    database.prepare(`
      SELECT snapshot_id, source_id, observed_at_ms, available, usage_json, limits_json
      FROM account_snapshots LIMIT 0
    `).all();
    const legacyView = database.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'view' AND name = 'model_request_metrics_enriched'
    `).get();
    if (legacyView !== undefined) throw new Error("遗留指标 View 仍然存在");
  } catch (error) {
    throw new ModelRequestMetricsSchemaError(value, schemaVersion, { cause: error });
  }
}
