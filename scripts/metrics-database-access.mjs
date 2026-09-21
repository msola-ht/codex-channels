import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  modelRequestMetricsSchemaVersion,
  metricStorageColumns,
  RequestMetricsQueryService,
  requestMetricsDatabasePath,
  requireCurrentModelRequestMetricsSchema,
  SqliteModelRequestMetricsStore,
} from "../dist/observability/index.js";
import {
  locateUserConfig,
  resolveConfiguredPath,
} from "./runtime-config.mjs";
import {
  metricsDimension,
  metricsRangeOptions,
  metricsFilterOptions,
} from "./metrics-command-options.mjs";

export { metricsRange } from "./metrics-command-options.mjs";
export const upgradeableMetricsSchemaVersions = Object.freeze([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
const legacyMetricsColumns = Object.freeze([
  "id", "provider", "billing_mode", "pricing_currency", "pricing_source",
  "pricing_effective_at_ms", "uncached_input_price_per_million_nanos",
  "cached_input_price_per_million_nanos", "output_price_per_million_nanos",
  "transport", "response_format", "operation", "thread_id", "turn_id", "model",
  "service_tier", "reasoning_effort", "status", "http_status", "error_type",
  "error_code", "incomplete_reason", "input_tokens", "cached_input_tokens",
  "output_tokens", "reasoning_output_tokens", "total_tokens", "upstream_created_at",
  "upstream_completed_at", "request_started_at_ms", "first_token_at_ms",
  "first_reasoning_delta_at_ms", "last_reasoning_delta_at_ms",
  "first_output_delta_at_ms", "last_output_delta_at_ms", "response_completed_at_ms",
  "recorded_at_ms",
]);

export function metricsDatabaseCanUpgrade(schemaVersion) {
  return upgradeableMetricsSchemaVersions.includes(schemaVersion);
}

export function inspectMetricsDatabase(environment = process.env) {
  const databasePath = resolveMetricsDatabaseContext(environment).databasePath;
  if (!existsSync(databasePath)) {
    return {
      compatible: false,
      count: null,
      databasePath,
      exists: false,
      schemaVersion: null,
    };
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const schemaVersion = readSchemaVersion(database);
    const count = hasTable(database, "model_request_metrics")
      ? Number(database.prepare("SELECT COUNT(*) AS count FROM model_request_metrics").get()?.count)
      : null;
    return {
      compatible: schemaVersion === modelRequestMetricsSchemaVersion,
      count,
      databasePath,
      exists: true,
      schemaVersion,
    };
  } finally {
    database.close();
  }
}

export function validateMetricsDatabaseStructure(
  environment = process.env,
  options = {},
) {
  const status = inspectMetricsDatabase(environment);
  if (!status.exists) return status;
  if (
    !status.compatible
    && (
      options.allowUpgradeable !== true
      || !metricsDatabaseCanUpgrade(status.schemaVersion)
    )
  ) {
    throw new Error(
      `指标数据库 Schema ${status.schemaVersion ?? "unknown"} 不受支持`,
    );
  }
  const database = new DatabaseSync(status.databasePath, { readOnly: true });
  try {
    if (status.compatible) {
      requireCurrentModelRequestMetricsSchema(database);
    } else if (status.schemaVersion >= 14 && status.schemaVersion <= 18) {
      requireColumns(database, "model_request_metrics", [
        "id", ...metricStorageColumns.filter((column) =>
          column !== "request_service_tier"
          && (status.schemaVersion >= 18 || column !== "total_duration_ms")
          && (status.schemaVersion >= 17 || !["traffic_label", "traffic_session", "traffic_interaction"].includes(column))
          && (status.schemaVersion >= 16 || !["first_content_ms", "request_model", "response_model"].includes(column))
          && (status.schemaVersion !== 14 || column !== "upstream_ttft_ms")),
      ]);
    } else {
      const requiredColumns = [
        ...legacyMetricsColumns,
        ...(status.schemaVersion >= 4
          ? ["weekly_quota_limit_id", "weekly_used_percent_millionths", "weekly_resets_at"]
          : []),
        ...(status.schemaVersion >= 5 ? ["weekly_quota_plan_type"] : []),
        ...(status.schemaVersion >= 6 ? ["error_message"] : []),
        ...(status.schemaVersion >= 8 ? ["pricing_bucket"] : []),
        ...(status.schemaVersion >= 9 ? ["quota_windows"] : []),
        ...(status.schemaVersion >= 13 ? ["user_agent"] : []),
      ];
      requireColumns(database, "model_request_metrics", requiredColumns);
      database.prepare(`
        SELECT id, total_cost_nanos FROM model_request_metrics_enriched LIMIT 0
      `).all();
    }
  } catch (error) {
    throw new Error(
      `指标数据库 Schema ${status.schemaVersion} 结构不完整，`
      + (status.compatible ? "请运行 codexc metrics reset" : "无法安全更新"),
      { cause: error },
    );
  } finally {
    database.close();
  }
  return status;
}

export function readMetricsReport(environment = process.env, options = {}) {
  const range = metricsRangeOptions(options, options.nowMs ?? Date.now());
  const filters = metricsFilterOptions(options);
  const dimension = metricsDimension(options.group ?? "models");
  const databasePath = requireCompatibleMetricsDatabase(environment);
  const store = new SqliteModelRequestMetricsStore(
    databasePath,
    range.endAtMs,
    { readOnly: true },
  );
  try {
    const queries = new RequestMetricsQueryService(store);
    return {
      format: "codex-connect-request-metrics-report",
      version: 3,
      generatedAt: new Date(range.endAtMs).toISOString(),
      range,
      weeklyQuota: readWeeklyQuota(store, range.endAtMs),
      filters,
      report: queries.aggregate(dimension, range, filters),
      errors: queries.errors(range, filters),
    };
  } finally {
    store.close();
  }
}

export function readMetricsExport(environment = process.env, options = {}) {
  const range = metricsRangeOptions(options, options.nowMs ?? Date.now());
  const filters = metricsFilterOptions(options);
  const databasePath = requireCompatibleMetricsDatabase(environment);
  const store = new SqliteModelRequestMetricsStore(
    databasePath,
    range.endAtMs,
    { readOnly: true },
  );
  try {
    const queries = new RequestMetricsQueryService(store);
    const records = [];
    let offset = 0;
    do {
      const page = queries.page(range, {
        ...filters,
        offset,
        limit: 500,
        sortKey: "recordedAtMs",
        sortDirection: "asc",
      });
      records.push(...page.records);
      offset = page.nextOffset ?? -1;
    } while (offset >= 0);
    return {
      format: "codex-connect-request-metrics-export",
      version: 3,
      generatedAt: new Date(range.endAtMs).toISOString(),
      range,
      filters,
      aggregate: queries.aggregate("global", range, filters).aggregate,
      weeklyQuota: readWeeklyQuota(store, range.endAtMs),
      records,
    };
  } finally {
    store.close();
  }
}

export function readQuotaHistory(environment = process.env, options = {}) {
  const range = metricsRangeOptions(options, options.nowMs ?? Date.now());
  const databasePath = requireCompatibleMetricsDatabase(environment);
  const store = new SqliteModelRequestMetricsStore(databasePath, range.endAtMs, { readOnly: true });
  try {
    const queries = new RequestMetricsQueryService(store);
    return {
      format: "codex-connect-quota-history",
      version: 1,
      generatedAt: new Date(range.endAtMs).toISOString(),
      range,
      periods: queries.quotaHistory(range),
    };
  } finally {
    store.close();
  }
}

export function readWeeklyQuota(store, nowMs) {
  const queries = new RequestMetricsQueryService(store);
  const window = queries.latestWeeklyQuota("openai", nowMs);
  if (window === null) return null;
  const estimate = queries.weeklyQuotaEstimate(
    "openai",
    window.limitId,
    window.resetsAt,
    nowMs,
  );
  const usedPercent = window.usedPercentMillionths / 1_000_000;
  return {
    limitId: window.limitId,
    planType: window.planType,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    resetsAt: window.resetsAt,
    observedAtMs: window.observedAtMs,
    estimate: estimate === null ? null : {
      observedDeltaPercent: estimate.observedDeltaPercentMillionths / 1_000_000,
      intervalCount: estimate.intervalCount,
      requestCount: estimate.requestCount,
      unsuccessfulRequestCount: estimate.unsuccessfulRequestCount,
      inputTokensPerPercent: perQuotaPercent(
        estimate.inputTokens,
        estimate.observedDeltaPercentMillionths,
      ),
      outputTokensPerPercent: perQuotaPercent(
        estimate.outputTokens,
        estimate.observedDeltaPercentMillionths,
      ),
      totalTokensPerPercent: perQuotaPercent(
        estimate.totalTokens,
        estimate.observedDeltaPercentMillionths,
      ),
    },
  };
}

export function readMetricsRun(environment = process.env, threadId) {
  const databasePath = requireCompatibleMetricsDatabase(environment);
  const store = new SqliteModelRequestMetricsStore(
    databasePath,
    undefined,
    { readOnly: true },
  );
  try {
    const summary = new RequestMetricsQueryService(store).threadSummary(threadId);
    return {
      format: "codex-connect-request-metrics-run",
      version: 2,
      generatedAt: new Date().toISOString(),
      threadId,
      latestTurn: summary.latestTurn,
      threadAggregate: summary.threadAggregate,
    };
  } finally {
    store.close();
  }
}

export function readMetricsThreads(environment = process.env, options = {}) {
  const range = metricsRangeOptions(options, options.nowMs ?? Date.now(), "all");
  const filters = metricsFilterOptions(options);
  const databasePath = requireCompatibleMetricsDatabase(environment);
  const store = new SqliteModelRequestMetricsStore(
    databasePath,
    undefined,
    { readOnly: true },
  );
  try {
    const queries = new RequestMetricsQueryService(store);
    const threads = [];
    let offset = 0;
    do {
      const page = queries.threadList(range, { ...filters, offset, limit: 500 });
      threads.push(...page.threads);
      offset = page.nextOffset ?? -1;
    } while (offset >= 0);
    return {
      format: "codex-connect-request-metrics-threads",
      version: 1,
      generatedAt: new Date().toISOString(),
      range,
      filters,
      threads,
    };
  } finally {
    store.close();
  }
}

export function readMetricsTurns(environment = process.env, threadId, options = {}) {
  const range = metricsRangeOptions(options, options.nowMs ?? Date.now(), "all");
  const filters = metricsFilterOptions({ ...options, threadId });
  const databasePath = requireCompatibleMetricsDatabase(environment);
  const store = new SqliteModelRequestMetricsStore(
    databasePath,
    undefined,
    { readOnly: true },
  );
  try {
    const queries = new RequestMetricsQueryService(store);
    const turns = [];
    let offset = 0;
    do {
      const page = queries.threadTurnSummaries(threadId, range, { ...filters, offset, limit: 500 });
      turns.push(...page.turns);
      offset = page.nextOffset ?? -1;
    } while (offset >= 0);
    return {
      format: "codex-connect-request-metrics-turns",
      version: 2,
      generatedAt: new Date().toISOString(),
      threadId,
      range,
      filters,
      turns,
    };
  } finally {
    store.close();
  }
}

export function resolveMetricsDatabaseContext(environment) {
  const { configPath, dataDir } = locateUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const storage = isRecord(document.storage) ? document.storage : {};
  const stateDatabasePath = resolveConfiguredPath(
    typeof storage.database_path === "string" ? storage.database_path : undefined,
    dataDir,
    "data/gateway.sqlite3",
  );
  return {
    databasePath: requestMetricsDatabasePath(stateDatabasePath),
    dataDir,
    document,
  };
}

function requireColumns(database, table, requiredColumns) {
  const columns = new Set(
    database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name),
  );
  const missing = requiredColumns.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(`${table} 缺少 ${missing.join("、")}`);
  }
}

export function requireCompatibleMetricsDatabase(environment = process.env) {
  const status = inspectMetricsDatabase(environment);
  if (!status.exists) throw new Error(`指标数据库尚未创建：${status.databasePath}`);
  if (!status.compatible) {
    throw new Error(metricsDatabaseCanUpgrade(status.schemaVersion)
      ? "模型请求指标数据库版本不兼容；请运行 codexc update"
      : "模型请求指标数据库版本不兼容；请停止 Gateway 后运行 codexc metrics reset");
  }
  return status.databasePath;
}

function readSchemaVersion(database) {
  if (!hasTable(database, "schema_metadata")) return null;
  const row = database.prepare(`
    SELECT value FROM schema_metadata WHERE name = 'schema_version'
  `).get();
  const value = Number(row?.value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function hasTable(database, name) {
  return database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name) !== undefined;
}

function perQuotaPercent(value, deltaMillionths) {
  return Math.round(value / (deltaMillionths / 1_000_000));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
