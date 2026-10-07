// Generated from 679132a4:src/observability/sqlite-request-metrics-schema.ts.
// Regenerate with node database-upgrades/generate-historical-schemas.mjs.
const modelRequestMetricsSchemaVersion = 30;
const schemaVersion = modelRequestMetricsSchemaVersion;
export const metricStorageColumns = [
    "provider", "transport", "response_format", "operation", "thread_id", "turn_id",
    "model", "service_tier", "reasoning_effort", "status", "http_status", "error_type",
    "error_code", "error_message", "incomplete_reason", "input_tokens",
    "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens",
    "request_started_at_ms", "response_completed_at_ms", "recorded_at_ms",
    "weekly_quota_limit_id", "weekly_used_percent_millionths", "weekly_resets_at",
    "weekly_quota_plan_type", "quota_windows", "user_agent", "upstream_ttft_ms",
    "first_token_ms", "request_model", "response_model",
    "traffic_label", "traffic_session", "traffic_interaction",
    "total_duration_ms",
    "request_service_tier",
    "source", "caller_id", "key_id", "credential_generation", "relay_request_id", "delivery_status",
    "response_usage_amount", "upstream_provider", "upstream_attempt_count", "model_attempt_count", "finish_reason", "error_stage", "upstream_error_code", "upstream_error_type", "upstream_http_status", "quota_observed_at_ms",
    "response_time_ms", "generation_timing",
];
export const metricStorageColumnsSql = metricStorageColumns.join(", ");
const baseMetricsTableSql = `
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
    first_token_ms REAL CHECK (first_token_ms IS NULL OR first_token_ms >= 0),
    request_model TEXT,
    response_model TEXT,
    traffic_label TEXT,
    traffic_session TEXT,
    traffic_interaction INTEGER,
    total_duration_ms REAL CHECK (total_duration_ms IS NULL OR total_duration_ms >= 0),
    request_service_tier TEXT,
    CHECK (
      (traffic_label IS NULL AND traffic_session IS NULL AND traffic_interaction IS NULL)
      OR (traffic_label IS NOT NULL AND length(traffic_label) > 0
        AND traffic_session IS NOT NULL AND length(traffic_session) > 0
        AND traffic_interaction IS NOT NULL AND traffic_interaction > 0)
    )
  );
`;
const relayIdentityCheck = `
  (source = 'owned' AND caller_id IS NULL AND key_id IS NULL
    AND credential_generation IS NULL AND relay_request_id IS NULL AND delivery_status IS NULL)
  OR
  (source = 'relay' AND thread_id IS NULL AND turn_id IS NULL
    AND transport = 'http' AND operation = 'response'
    AND caller_id IS NOT NULL AND length(caller_id) BETWEEN 1 AND 64
    AND caller_id NOT GLOB '*[^a-z0-9_-]*' AND substr(caller_id,1,1) GLOB '[a-z0-9]'
    AND key_id IS NOT NULL AND length(key_id) BETWEEN 1 AND 64
    AND key_id NOT GLOB '*[^a-z0-9_-]*' AND substr(key_id,1,1) GLOB '[a-z0-9]'
    AND credential_generation IS NOT NULL AND typeof(credential_generation) = 'integer'
    AND credential_generation BETWEEN 1 AND 9007199254740991
    AND relay_request_id IS NOT NULL AND length(relay_request_id) = 36
    AND delivery_status IS NOT NULL AND delivery_status IN ('finished', 'disconnected', 'failed')
    AND (traffic_label IS NULL OR traffic_label IN ('relay.chat', 'relay.responses')))
`;
export const relayMetricColumnDefinitions = [
    "source TEXT NOT NULL DEFAULT 'owned' CHECK (source IN ('owned', 'relay'))",
    "caller_id TEXT", "key_id TEXT", "credential_generation INTEGER", "relay_request_id TEXT",
    `delivery_status TEXT CHECK (${relayIdentityCheck})`,
];
export const responseUsageAmountColumn = "response_usage_amount TEXT CHECK (response_usage_amount IS NULL OR (typeof(response_usage_amount) = 'text' AND length(response_usage_amount) BETWEEN 1 AND 128))";
export const requestDiagnosticColumnDefinitions = [
    "upstream_provider TEXT CHECK (upstream_provider IS NULL OR (typeof(upstream_provider) = 'text' AND length(upstream_provider) BETWEEN 1 AND 256 AND upstream_provider NOT GLOB '*[^a-zA-Z0-9_.:/-]*'))",
    "upstream_attempt_count INTEGER CHECK (upstream_attempt_count IS NULL OR (typeof(upstream_attempt_count) = 'integer' AND upstream_attempt_count BETWEEN 0 AND 9007199254740991))",
    "model_attempt_count INTEGER CHECK (model_attempt_count IS NULL OR (typeof(model_attempt_count) = 'integer' AND model_attempt_count BETWEEN 0 AND 9007199254740991))",
    "finish_reason TEXT CHECK (finish_reason IS NULL OR (typeof(finish_reason) = 'text' AND length(finish_reason) BETWEEN 1 AND 256 AND finish_reason NOT GLOB '*[^a-zA-Z0-9_.:/-]*'))",
    "error_stage TEXT CHECK (error_stage IS NULL OR (error_stage IN ('http', 'stream')))",
    "upstream_error_code TEXT CHECK (upstream_error_code IS NULL OR (typeof(upstream_error_code) = 'text' AND length(upstream_error_code) BETWEEN 1 AND 256 AND upstream_error_code NOT GLOB '*[^a-zA-Z0-9_.:/-]*'))",
    "upstream_error_type TEXT CHECK (upstream_error_type IS NULL OR (typeof(upstream_error_type) = 'text' AND length(upstream_error_type) BETWEEN 1 AND 256 AND upstream_error_type NOT GLOB '*[^a-zA-Z0-9_.:/-]*'))",
    "upstream_http_status INTEGER CHECK (upstream_http_status IS NULL OR (typeof(upstream_http_status) = 'integer' AND upstream_http_status BETWEEN 400 AND 599))",
];
export const quotaObservedAtColumn = "quota_observed_at_ms INTEGER CHECK (quota_observed_at_ms IS NULL OR (typeof(quota_observed_at_ms) = 'integer' AND quota_observed_at_ms BETWEEN 0 AND 9007199254740991))";
export const modelRequestMetricsTableSql = baseMetricsTableSql.replace("    CHECK (", `    ${[...relayMetricColumnDefinitions, responseUsageAmountColumn, ...requestDiagnosticColumnDefinitions, quotaObservedAtColumn,
    "response_time_ms REAL CHECK (response_time_ms IS NULL OR response_time_ms >= 0)",
    "generation_timing TEXT CHECK (generation_timing IS NULL OR json_valid(generation_timing))",
].join(",\n    ")},\n    CHECK (`);
export const relayMetricIndexesSql = `
  CREATE UNIQUE INDEX model_request_metrics_relay_request
    ON model_request_metrics(relay_request_id) WHERE source = 'relay';
  CREATE INDEX model_request_metrics_source_caller
    ON model_request_metrics(source, caller_id, recorded_at_ms);
`;
export const modelRequestMetricsIndexesSql = `
  CREATE INDEX model_request_metrics_recorded_at
    ON model_request_metrics (recorded_at_ms);
  CREATE INDEX model_request_metrics_thread_turn
    ON model_request_metrics (thread_id, turn_id, id);
  CREATE INDEX model_request_metrics_provider_model
    ON model_request_metrics (provider, model, id);
` + relayMetricIndexesSql;
export const schemaMetadataSql = `
  CREATE TABLE IF NOT EXISTS schema_metadata (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
`;
export const turnExecutionSchemaSql = `
  CREATE TABLE thread_execution_state (
    thread_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    history_complete INTEGER NOT NULL CHECK (history_complete IN (0, 1))
  );
  CREATE TABLE turn_execution_metrics (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    duration_ms INTEGER CHECK (duration_ms >= 0 AND duration_ms <= 9007199254740991),
    ordinal INTEGER NOT NULL,
    recorded_at_ms INTEGER NOT NULL,
    PRIMARY KEY (thread_id, turn_id)
  );
  CREATE INDEX turn_execution_metrics_order ON turn_execution_metrics (thread_id, ordinal);
  CREATE INDEX turn_execution_metrics_retention ON turn_execution_metrics (recorded_at_ms);
`;
export const autoApprovalReviewSchemaSql = `
  CREATE TABLE auto_approval_review_turns (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    started INTEGER NOT NULL CHECK (started IN (0, 1)),
    completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
    continuous INTEGER NOT NULL CHECK (continuous IN (0, 1)),
    recorded_at_ms INTEGER NOT NULL,
    PRIMARY KEY (thread_id, turn_id)
  );
  CREATE TABLE auto_approval_reviews (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    review_id TEXT NOT NULL,
    completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
    approved INTEGER NOT NULL CHECK (approved IN (0, 1) AND approved <= completed),
    status TEXT NOT NULL CHECK (
      (status = 'inProgress' AND completed = 0 AND approved = 0)
      OR (status = 'approved' AND completed = 1 AND approved = 1)
      OR (status IN ('denied', 'timedOut', 'aborted', 'unknown') AND completed = 1 AND approved = 0)
    ),
    recorded_at_ms INTEGER NOT NULL,
    PRIMARY KEY (thread_id, turn_id, review_id)
  );
  CREATE INDEX auto_approval_review_turns_retention ON auto_approval_review_turns (recorded_at_ms);
  CREATE INDEX auto_approval_reviews_retention ON auto_approval_reviews (recorded_at_ms);
`;
export const initialSchemaSql = `
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
  ${turnExecutionSchemaSql}
  ${autoApprovalReviewSchemaSql}
  INSERT INTO schema_metadata (name, value) VALUES ('schema_version', ${schemaVersion});
`;
export class ModelRequestMetricsSchemaError extends Error {
    actualVersion;
    expectedVersion;
    code = "METRICS_SCHEMA_UNSUPPORTED";
    constructor(actualVersion, expectedVersion, options) {
        const detail = options?.cause === undefined
            ? `版本不兼容：当前 ${actualVersion}，Gateway 需要 ${expectedVersion}。`
            : `Schema ${actualVersion} 结构不完整。`;
        super(`模型请求指标数据库${detail}仅支持当前 Schema；请停止服务并核对数据库版本及备份，勿删除数据库。`, options);
        this.actualVersion = actualVersion;
        this.expectedVersion = expectedVersion;
        this.name = "ModelRequestMetricsSchemaError";
    }
}
export function ensureCurrentModelRequestMetricsSchema(database) {
    database.exec(schemaMetadataSql);
    const version = database.prepare(`
    SELECT value FROM schema_metadata WHERE name = 'schema_version'
  `).get();
    if (version && version.value !== schemaVersion) {
        throw new ModelRequestMetricsSchemaError(version.value, schemaVersion);
    }
    if (!version)
        database.exec(initialSchemaSql);
}
export function requireCurrentModelRequestMetricsSchema(database) {
    let value;
    try {
        value = database.prepare(`
      SELECT value FROM schema_metadata WHERE name = 'schema_version'
    `).get()?.value;
    }
    catch {
        throw new ModelRequestMetricsSchemaError(0, schemaVersion);
    }
    if (value !== schemaVersion) {
        throw new ModelRequestMetricsSchemaError(value ?? 0, schemaVersion);
    }
    try {
        database.prepare("SELECT thread_id, provider, history_complete FROM thread_execution_state LIMIT 0").all();
        database.prepare("SELECT thread_id, turn_id, duration_ms, ordinal, recorded_at_ms FROM turn_execution_metrics LIMIT 0").all();
        const metricColumns = database.prepare("PRAGMA table_info(model_request_metrics)")
            .all().map((column) => column.name);
        if (metricColumns.length !== metricStorageColumns.length + 1
            || metricColumns[0] !== "id"
            || metricStorageColumns.some((column, index) => metricColumns[index + 1] !== column)) {
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
        const tableSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'model_request_metrics'").get()?.sql;
        const normalize = (text) => text.replace(/\s+/gu, " ").trim();
        for (const statement of (turnExecutionSchemaSql + autoApprovalReviewSchemaSql).split(";").filter(sql => sql.trim())) {
            const name = /CREATE (?:TABLE|INDEX) (\w+)/u.exec(statement)?.[1];
            const actual = database.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name)?.sql;
            if (typeof actual !== "string" || normalize(actual) !== normalize(statement))
                throw new Error("轮次耗时 Schema 结构不匹配");
        }
        if (typeof tableSql !== "string" || !normalize(tableSql).includes(normalize(relayIdentityCheck))) {
            throw new Error("Relay 指标身份约束缺失");
        }
        if (!normalize(tableSql).includes(normalize(quotaObservedAtColumn))) {
            throw new Error("额度快照时间约束缺失");
        }
        const relayIndex = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'model_request_metrics_relay_request'").get()?.sql;
        if (typeof relayIndex !== "string" || normalize(relayIndex) !== normalize(relayMetricIndexesSql.split(";")[0])) {
            throw new Error("Relay 指标唯一索引缺失");
        }
        const callerIndex = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'model_request_metrics_source_caller'").get()?.sql;
        if (typeof callerIndex !== "string" || normalize(callerIndex) !== normalize(relayMetricIndexesSql.split(";")[1]))
            throw new Error("Relay 调用方索引缺失");
        const legacyView = database.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'view' AND name = 'model_request_metrics_enriched'
    `).get();
        if (legacyView !== undefined)
            throw new Error("遗留指标 View 仍然存在");
    }
    catch (error) {
        throw new ModelRequestMetricsSchemaError(value, schemaVersion, { cause: error });
    }
}
