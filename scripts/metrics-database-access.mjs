import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  modelRequestMetricsSchemaVersion,
  requestMetricsDatabasePath,
  SqliteModelRequestMetricsStore,
} from "../dist/observability/index.js";
import {
  locateUserConfig,
  resolveConfiguredPath,
} from "./runtime-config.mjs";
import {
  metricsDimension,
  metricsRangeOptions,
} from "./metrics-command-options.mjs";
import { isRecord } from "./metrics-export-format.mjs";

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

export function readMetricsReport(environment = process.env, options = {}) {
  const range = metricsRangeOptions(options, options.nowMs ?? Date.now());
  const dimension = metricsDimension(options.group ?? "models");
  const databasePath = requireCompatibleMetricsDatabase(environment);
  const store = new SqliteModelRequestMetricsStore(
    databasePath,
    range.endAtMs,
    { readOnly: true },
  );
  try {
    return {
      format: "codex-connect-request-metrics-report",
      version: 2,
      generatedAt: new Date(range.endAtMs).toISOString(),
      range,
      weeklyQuota: readWeeklyQuota(store, range.endAtMs),
      report: store.aggregate({
        dimension,
        startAtMs: range.startAtMs,
        endAtMs: range.endAtMs,
      }),
      errors: store.errors({
        startAtMs: range.startAtMs,
        endAtMs: range.endAtMs,
      }),
    };
  } finally {
    store.close();
  }
}

export function readMetricsExport(environment = process.env, options = {}) {
  const range = metricsRangeOptions(options, options.nowMs ?? Date.now());
  const threadId = options.threadId;
  const databasePath = requireCompatibleMetricsDatabase(environment);
  const store = new SqliteModelRequestMetricsStore(
    databasePath,
    range.endAtMs,
    { readOnly: true },
  );
  try {
    const records = [];
    let offset = 0;
    do {
      const page = store.page({
        startAtMs: range.startAtMs,
        endAtMs: range.endAtMs,
        offset,
        limit: 500,
        sortKey: "recordedAtMs",
        sortDirection: "asc",
      });
      records.push(
        ...(threadId === undefined
          ? page.records
          : page.records.filter((record) => record.threadId === threadId)),
      );
      offset = page.nextOffset ?? -1;
    } while (offset >= 0);
    return {
      format: "codex-connect-request-metrics-export",
      version: 2,
      generatedAt: new Date(range.endAtMs).toISOString(),
      range,
      weeklyQuota: readWeeklyQuota(store, range.endAtMs),
      records,
    };
  } finally {
    store.close();
  }
}

export function readWeeklyQuota(store, nowMs) {
  const window = store.latestWeeklyQuota("openai", nowMs);
  if (window === null) return null;
  const estimate = store.weeklyQuotaEstimate({
    provider: "openai",
    limitId: window.limitId,
    resetsAt: window.resetsAt,
    nowMs,
  });
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
      pricedRequestCount: estimate.pricedRequestCount,
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
      pricingCurrency: estimate.pricingCurrency,
      costPerPercentNanos: estimate.totalCostNanos === null
        ? null
        : perQuotaPercent(
            estimate.totalCostNanos,
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
    const summary = store.threadSummary(threadId);
    return {
      format: "codex-connect-request-metrics-run",
      version: 1,
      generatedAt: new Date().toISOString(),
      threadId,
      latestTurn: summary.latestTurn,
      threadAggregate: summary.threadAggregate,
      latestDirectApi: summary.latestDirectApi,
    };
  } finally {
    store.close();
  }
}

export function readMetricsThreads(environment = process.env) {
  const databasePath = requireCompatibleMetricsDatabase(environment);
  const store = new SqliteModelRequestMetricsStore(
    databasePath,
    undefined,
    { readOnly: true },
  );
  try {
    return {
      format: "codex-connect-request-metrics-threads",
      version: 1,
      generatedAt: new Date().toISOString(),
      threads: store.threadList(),
    };
  } finally {
    store.close();
  }
}

export function readMetricsTurns(environment = process.env, threadId) {
  const databasePath = requireCompatibleMetricsDatabase(environment);
  const store = new SqliteModelRequestMetricsStore(
    databasePath,
    undefined,
    { readOnly: true },
  );
  try {
    return {
      format: "codex-connect-request-metrics-turns",
      version: 1,
      generatedAt: new Date().toISOString(),
      threadId,
      turns: store.threadTurnSummaries(threadId),
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
    throw new Error(status.schemaVersion === 3
      ? "模型请求指标数据库版本不兼容；请停止 Gateway 后运行 codexc metrics upgrade"
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
