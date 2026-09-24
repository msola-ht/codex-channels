import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  modelRequestMetricsSchemaVersion,
  ModelRequestMetricsSchemaError,
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
) {
  const status = inspectMetricsDatabase(environment);
  if (!status.exists) return status;
  if (!status.compatible) {
    throw new Error(
      `指标数据库 Schema ${status.schemaVersion ?? "unknown"} 不受支持`,
    );
  }
  const database = new DatabaseSync(status.databasePath, { readOnly: true });
  try {
    requireCurrentModelRequestMetricsSchema(database);
  } catch (error) {
    throw new Error(
      `指标数据库 Schema ${status.schemaVersion} 结构不完整，`
      + "请运行 codexc metrics reset",
      { cause: error },
    );
  } finally {
    database.close();
  }
  return status;
}

export class MetricsDatabaseAccessError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.code = code;
  }
}

export function openReadOnlyMetricsDatabase(environment = process.env, nowMs = Date.now()) {
  const { databasePath } = resolveMetricsDatabaseContext(environment);
  if (!existsSync(databasePath)) {
    throw new MetricsDatabaseAccessError("metrics_database_unavailable",
      `指标数据库尚未创建：${databasePath}`);
  }
  try {
    return new SqliteModelRequestMetricsStore(databasePath, nowMs, { readOnly: true });
  } catch (error) {
    if (error instanceof ModelRequestMetricsSchemaError) {
      throw new MetricsDatabaseAccessError("metrics_database_incompatible",
        "模型请求指标数据库版本或结构不兼容；请停止 Gateway 后运行 codexc metrics reset", error);
    }
    throw error;
  }
}

export function readMetricsReport(environment = process.env, options = {}) {
  const range = metricsRangeOptions(options, options.nowMs ?? Date.now());
  const filters = metricsFilterOptions(options);
  const dimension = metricsDimension(options.group ?? "models");
  const store = openReadOnlyMetricsDatabase(environment, range.endAtMs);
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
  const store = openReadOnlyMetricsDatabase(environment, range.endAtMs);
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
  const store = openReadOnlyMetricsDatabase(environment, range.endAtMs);
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
  const store = openReadOnlyMetricsDatabase(environment);
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
  const store = openReadOnlyMetricsDatabase(environment);
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
  const store = openReadOnlyMetricsDatabase(environment);
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

export function requireCompatibleMetricsDatabase(environment = process.env) {
  const status = inspectMetricsDatabase(environment);
  if (!status.exists) throw new Error(`指标数据库尚未创建：${status.databasePath}`);
  if (!status.compatible) {
    throw new Error("模型请求指标数据库版本不兼容；请停止 Gateway 后运行 codexc metrics reset");
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
