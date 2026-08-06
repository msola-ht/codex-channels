import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { providerMetricsSocketPath } from "../runtime/model-provider-runtime.mjs";
import {
  acquireRequestMetricsDatabaseLock,
  modelRequestMetricsSchemaVersion,
  requestMetricsDatabasePath,
  SqliteModelRequestMetricsStore,
} from "../dist/observability/index.js";
import {
  locateUserConfig,
  resolveConfiguredPath,
} from "./runtime-config.mjs";
import {
  csvCell,
  enrichCosts,
  exchangeRateLine,
  formatCost,
  formatCurrencyNanos,
  formatDuration,
  formatLocalTime,
  formatTokenCount,
  isRecord,
  loadDisplayContext,
  markdownCell,
} from "./metrics-export-format.mjs";

export function inspectMetricsDatabase(environment = process.env) {
  const databasePath = resolveMetricsDatabasePath(environment);
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

export function resetMetricsDatabase(
  environment = process.env,
  options = {},
) {
  const runtime = resolveMetricsRuntime(environment);
  const gatewayRunning = options.gatewayRunning ?? (() => isGatewayRunning(environment));
  if (
    gatewayRunning()
    || runtime.metricsSocketPaths.some(metricsSocketIsActive)
  ) {
    throw new Error("Gateway 仍在运行；请先执行 codexc service stop gateway，再重试");
  }

  const databasePath = runtime.databasePath;
  if (!existsSync(databasePath)) {
    return {
      backupPath: null,
      changed: false,
      databasePath,
      previousSchemaVersion: null,
    };
  }
  const lock = acquireRequestMetricsDatabaseLock(databasePath);
  try {
    const status = inspectMetricsDatabase(environment);
    if (!status.exists) {
      return {
        backupPath: null,
        changed: false,
        databasePath: status.databasePath,
        previousSchemaVersion: null,
      };
    }

    checkpoint(status.databasePath);
    const now = options.now ?? (() => new Date());
    const version = status.schemaVersion ?? "unknown";
    const backupPath = `${status.databasePath}.v${version}.${backupTimestamp(now())}.bak`;
    if (existsSync(backupPath)) {
      throw new Error(`指标数据库备份已存在：${backupPath}`);
    }
    renameSync(status.databasePath, backupPath);
    chmodSync(backupPath, 0o600);
    return {
      backupPath,
      changed: true,
      databasePath: status.databasePath,
      previousSchemaVersion: status.schemaVersion,
    };
  } finally {
    lock.release();
  }
}

export function upgradeMetricsDatabase(
  environment = process.env,
  options = {},
) {
  const runtime = resolveMetricsRuntime(environment);
  const gatewayRunning = options.gatewayRunning ?? (() => isGatewayRunning(environment));
  if (
    gatewayRunning()
    || runtime.metricsSocketPaths.some(metricsSocketIsActive)
  ) {
    throw new Error("Gateway 仍在运行；请先执行 codexc service stop gateway，再重试");
  }
  if (!existsSync(runtime.databasePath)) {
    return {
      backupPath: null,
      changed: false,
      databasePath: runtime.databasePath,
      previousSchemaVersion: null,
      schemaVersion: null,
    };
  }
  const lock = acquireRequestMetricsDatabaseLock(runtime.databasePath);
  try {
    const status = inspectMetricsDatabase(environment);
    if (status.schemaVersion === modelRequestMetricsSchemaVersion) {
      return {
        backupPath: null,
        changed: false,
        databasePath: status.databasePath,
        previousSchemaVersion: status.schemaVersion,
        schemaVersion: status.schemaVersion,
      };
    }
    if (status.schemaVersion !== 3 || modelRequestMetricsSchemaVersion !== 4) {
      throw new Error(
        `指标数据库无法升级：当前 Schema ${status.schemaVersion ?? "unknown"}，`
        + `仅支持 v3 升级到 v${modelRequestMetricsSchemaVersion}`,
      );
    }
    checkpoint(status.databasePath);
    const now = options.now ?? (() => new Date());
    const backupPath = `${status.databasePath}.v3.${backupTimestamp(now())}.bak`;
    if (existsSync(backupPath)) throw new Error(`指标数据库备份已存在：${backupPath}`);
    copyFileSync(status.databasePath, backupPath);
    chmodSync(backupPath, 0o600);
    const database = new DatabaseSync(status.databasePath);
    try {
      database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE model_request_metrics ADD COLUMN weekly_quota_limit_id TEXT
          CHECK (weekly_quota_limit_id IS NULL OR weekly_quota_limit_id = 'codex');
        ALTER TABLE model_request_metrics ADD COLUMN weekly_used_percent_millionths INTEGER
          CHECK (weekly_used_percent_millionths IS NULL
            OR weekly_used_percent_millionths BETWEEN 0 AND 100000000);
        ALTER TABLE model_request_metrics ADD COLUMN weekly_resets_at INTEGER
          CHECK (weekly_resets_at IS NULL OR weekly_resets_at >= 0);
        UPDATE schema_metadata SET value = 4 WHERE name = 'schema_version';
        COMMIT;
      `);
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    } finally {
      database.close();
    }
    return {
      backupPath,
      changed: true,
      databasePath: status.databasePath,
      previousSchemaVersion: 3,
      schemaVersion: 4,
    };
  } finally {
    lock.release();
  }
}

export function upgradeMetricsDatabaseWithGatewayRestart(
  environment = process.env,
  options = {},
) {
  const stopGateway = options.stopGateway
    ?? (() => runGatewayServiceAction("stop", environment));
  const startGateway = options.startGateway
    ?? (() => runGatewayServiceAction("start", environment));
  const upgrade = options.upgrade
    ?? (() => upgradeMetricsDatabase(environment));
  let stopError;
  try {
    stopGateway();
  } catch (error) {
    stopError = error;
  }
  let result;
  let upgradeError;
  try {
    result = upgrade();
  } catch (error) {
    upgradeError = error;
  }
  let startError;
  try {
    startGateway();
  } catch (error) {
    startError = error;
  }
  if (stopError && startError) {
    throw new AggregateError(
      [stopError, startError],
      "指标库升级前停止 Gateway 失败，且 Gateway 未能重新启动",
    );
  }
  if (stopError) throw stopError;
  if (upgradeError && startError) {
    throw new AggregateError(
      [upgradeError, startError],
      "指标库升级失败，且 Gateway 未能重新启动",
    );
  }
  if (upgradeError) throw upgradeError;
  if (startError) throw startError;
  return result;
}

function runGatewayServiceAction(action, environment) {
  const cli = resolve(import.meta.dirname, "../bin/codexc.mjs");
  const result = spawnSync(
    process.execPath,
    [cli, "service", action, "gateway"],
    { env: environment, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Gateway ${action === "stop" ? "停止" : "启动"}失败`);
  }
}

export function readMetricsReport(environment = process.env, options = {}) {
  const range = metricsRange(options.range ?? "30d", options.nowMs ?? Date.now());
  const dimension = metricsDimension(options.group ?? "models");
  const databasePath = requireReadableMetricsDatabase(environment);
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
  const range = metricsRange(options.range ?? "30d", options.nowMs ?? Date.now());
  const threadId = options.threadId;
  const databasePath = requireReadableMetricsDatabase(environment);
  const store = new SqliteModelRequestMetricsStore(
    databasePath,
    range.endAtMs,
    { readOnly: true },
  );
  try {
    const records = [];
    let afterId;
    do {
      const page = store.page({
        startAtMs: range.startAtMs,
        endAtMs: range.endAtMs,
        ...(afterId === undefined ? {} : { afterId }),
        limit: 500,
      });
      records.push(
        ...(threadId === undefined
          ? page.records
          : page.records.filter((record) => record.threadId === threadId)),
      );
      afterId = page.nextAfterId ?? undefined;
    } while (afterId !== undefined);
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

function perQuotaPercent(value, deltaMillionths) {
  return Math.round(value / (deltaMillionths / 1_000_000));
}

export function readMetricsRun(environment = process.env, threadId) {
  const databasePath = requireReadableMetricsDatabase(environment);
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
  const databasePath = requireReadableMetricsDatabase(environment);
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
  const databasePath = requireReadableMetricsDatabase(environment);
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

function requireReadableMetricsDatabase(environment) {
  const status = inspectMetricsDatabase(environment);
  if (!status.exists) throw new Error(`指标数据库尚未创建：${status.databasePath}`);
  if (!status.compatible) {
    throw new Error(status.schemaVersion === 3
      ? "模型请求指标数据库版本不兼容；请停止 Gateway 后运行 codexc metrics upgrade"
      : "模型请求指标数据库版本不兼容；请停止 Gateway 后运行 codexc metrics reset");
  }
  return status.databasePath;
}

function resolveMetricsDatabasePath(environment) {
  return resolveMetricsRuntime(environment).databasePath;
}

function resolveMetricsRuntime(environment) {
  const { configPath, dataDir } = locateUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const storage = isRecord(document.storage) ? document.storage : {};
  const codex = isRecord(document.codex) ? document.codex : {};
  const stateDatabasePath = resolveConfiguredPath(
    typeof storage.database_path === "string" ? storage.database_path : undefined,
    dataDir,
    "data/gateway.sqlite3",
  );
  const appServerSocketPath = resolveConfiguredPath(
    typeof codex.socket_path === "string" ? codex.socket_path : undefined,
    dataDir,
    "runtime/codex-app-server.sock",
  );
  return {
    databasePath: requestMetricsDatabasePath(stateDatabasePath),
    metricsSocketPaths: ["openai", "deepseek"].map((provider) =>
      providerMetricsSocketPath(appServerSocketPath, provider)
    ),
  };
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

function checkpoint(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 1000;");
    const result = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (Number(result?.busy) !== 0) {
      throw new Error("指标数据库仍被其他进程占用；请确认 Gateway 已停止");
    }
  } finally {
    database.close();
  }
}

function isGatewayRunning(environment) {
  if (
    environment.CODEX_CONNECT_SERVICE_ROLE === "gateway"
    || environment.CODEX_CONNECT_GATEWAY_SUPERVISED === "1"
  ) {
    return true;
  }
  if (process.platform === "linux") {
    const result = spawnSync(
      environment.SYSTEMCTL_BINARY || "systemctl",
      ["--user", "show", "--property=ActiveState", "--value", "codex-connect-gateway.service"],
      { encoding: "utf8", env: environment },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error("无法确认 Gateway 服务状态；为保护指标数据库，已拒绝重置");
    }
    const state = result.stdout.trim();
    return state !== "inactive";
  }
  if (process.platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const result = spawnSync(
      environment.LAUNCHCTL_BINARY || "launchctl",
      ["print", `gui/${uid}/com.hegenai.codex-gateway`],
      { stdio: "ignore", env: environment },
    );
    if (result.error) throw result.error;
    return result.status === 0;
  }
  return false;
}

function metricsSocketIsActive(socketPath) {
  if (!existsSync(socketPath)) return false;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { createConnection } from "node:net";
const socket = createConnection(process.argv[1]);
let settled = false;
const finish = (code) => {
  if (settled) return;
  settled = true;
  socket.destroy();
  process.exitCode = code;
};
socket.once("connect", () => finish(0));
socket.once("error", () => finish(1));
socket.setTimeout(500, () => finish(2));`,
      socketPath,
    ],
    { stdio: "ignore", timeout: 1_000 },
  );
  if (result.error) {
    throw new Error("无法确认 Gateway 指标 Socket 状态；为保护指标数据库，已拒绝重置");
  }
  return result.status !== 1;
}

function backupTimestamp(date) {
  return date.toISOString().replaceAll(/[:.]/gu, "-");
}

function printStatus(result) {
  console.log(`指标数据库：${result.databasePath}`);
  if (!result.exists) {
    console.log("状态：尚未创建");
    return;
  }
  console.log(`Schema：${result.schemaVersion ?? "无法识别"}`);
  console.log(`兼容：${result.compatible ? "是" : "否"}`);
  console.log(`记录：${result.count ?? "无法读取"}`);
  if (!result.compatible) {
    console.log(result.schemaVersion === 3
      ? "处理：停止 Gateway 后运行 codexc metrics upgrade"
      : "处理：停止 Gateway 后运行 codexc metrics reset");
  }
}

function printMetricsReport(result, format, display = null) {
  const aggregateProvider = singleReportProvider(result.report);
  if (format === "json") {
    console.log(JSON.stringify({
      ...result,
      report: {
        ...result.report,
        aggregate: enrichSummaryCosts(result.report.aggregate, display, aggregateProvider),
        groups: result.report.groups.map((group) => ({
          ...group,
          aggregate: enrichSummaryCosts(group.aggregate, display, group.provider ?? null),
        })),
      },
    }, null, 2));
    return;
  }
  if (format === "csv") {
    const columns = [
      ["type", (row) => row.type],
      ["provider", (row) => row.provider],
      ["model", (row) => row.model],
      ["group", (row) => row.group],
      ["status", (row) => row.status],
      ["errorType", (row) => row.errorType],
      ["httpStatus", (row) => row.httpStatus],
      ["lastOccurredAtMs", (row) => row.lastOccurredAtMs],
      ["requestCount", (row) => row.requestCount],
      ["unsuccessfulRequestCount", (row) => row.unsuccessfulRequestCount],
      ["requestDurationMs", (row) => row.requestDurationMs],
      ["inputTokens", (row) => row.inputTokens],
      ["cachedInputTokens", (row) => row.cachedInputTokens],
      ["outputTokens", (row) => row.outputTokens],
      ["reasoningOutputTokens", (row) => row.reasoningOutputTokens],
      ["outputTokensPerSecond", (row) => row.outputTokensPerSecond],
      ["pricingCurrency", (row) => row.pricingCurrency],
      ["pricedRequestCount", (row) => row.pricedRequestCount],
      ["totalCostNanos", (row) => row.totalCostNanos],
      ["inputCostNanos", (row) => row.inputCostNanos],
      ["cachedInputCostNanos", (row) => row.cachedInputCostNanos],
      ["outputCostNanos", (row) => row.outputCostNanos],
      ["totalCostCnyNanos", (row) => row.totalCostCnyNanos],
      ["inputCostCnyNanos", (row) => row.inputCostCnyNanos],
      ["cachedInputCostCnyNanos", (row) => row.cachedInputCostCnyNanos],
      ["outputCostCnyNanos", (row) => row.outputCostCnyNanos],
      ...compactCsvColumns(),
      ["ttftP50Ms", (row) => row.ttftP50Ms],
      ["ttftP95Ms", (row) => row.ttftP95Ms],
      ...weeklyQuotaCsvColumns(),
    ];
    console.log(columns.map(([heading]) => csvCell(heading)).join(","));
    const rows = [
      ...(result.report.aggregate === null
        ? []
        : [{
            type: "aggregate",
            provider: aggregateProvider,
            model: null,
            group: "global",
            ...enrichSummaryCosts(result.report.aggregate, display, aggregateProvider),
          }]),
      ...result.report.groups.map((group) => ({
        type: "group",
        provider: group.provider,
        model: group.model,
        group: group.model ?? group.provider ?? "全部",
        ...enrichSummaryCosts(group.aggregate, display, group.provider ?? null),
      })),
      {
        type: "error_summary",
        provider: null,
        model: null,
        group: "global",
        requestCount: result.errors.requestCount,
        unsuccessfulRequestCount: result.errors.unsuccessfulRequestCount,
      },
      ...result.errors.groups.map((group) => ({
        type: "error",
        provider: group.provider,
        model: group.model,
        group: group.model ?? group.provider ?? "全部",
        status: group.status,
        errorType: group.errorType,
        httpStatus: group.httpStatus,
        lastOccurredAtMs: group.lastOccurredAtMs,
        requestCount: group.requestCount,
      })),
      ...(result.weeklyQuota === null
        ? []
        : [{ type: "weekly_quota", ...flattenWeeklyQuota(result.weeklyQuota) }]),
    ];
    for (const row of rows) {
      console.log(
        columns.map(([, read]) => csvCell(read(row))).join(","),
      );
    }
    return;
  }
  const aggregate = result.report.aggregate;
  console.log("# Codex Connect 请求指标报告");
  console.log("");
  const rateLine = exchangeRateLine(display);
  if (rateLine) console.log(`- ${rateLine}`);
  console.log(`- 生成时间：${result.generatedAt}`);
  console.log(`- 时间范围：${result.range.name}`);
  console.log(`- 起始时间：${new Date(result.range.startAtMs).toISOString()}`);
  console.log(`- 截止时间：${new Date(result.range.endAtMs).toISOString()}`);
  printWeeklyQuotaMarkdown(result.weeklyQuota);
  console.log("");
  console.log("## 汇总");
  console.log("");
  if (!aggregate) {
    console.log("本时间范围没有请求记录。");
    return;
  }
  console.log(`- 模型请求：${aggregate.requestCount}`);
  console.log(`- 异常或未完整观测：${aggregate.unsuccessfulRequestCount}`);
  console.log(`- 输入 Token：${aggregate.inputTokens}`);
  console.log(`- 缓存输入 Token：${aggregate.cachedInputTokens ?? "未知"}`);
  console.log(`- 输出 Token：${aggregate.outputTokens}`);
  if (aggregateProvider && aggregateProvider !== "openai") {
    console.log(`- 推理输出 Token：${aggregate.reasoningOutputTokens}`);
  }
  console.log(`- 计价覆盖：${aggregate.pricedRequestCount}/${aggregate.requestCount}`);
  console.log(`- 参考总价：${formatCost(
    { ...aggregate, provider: aggregateProvider },
    display,
  )}`);
  printCompactSummary(aggregate.compact, display, aggregateProvider);
  console.log(`- 首段延迟 P50/P95：${formatDuration(aggregate.ttftP50Ms)}/${formatDuration(aggregate.ttftP95Ms)}`);
  if (result.report.groups.length > 0) {
    console.log("");
    console.log("## 明细");
    console.log("");
    console.log("| 提供商 | 模型 | 请求 | 异常/未完整 | 输入 | 缓存输入 | 输出 | 参考总价 | 上下文压缩 |");
    console.log("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
    for (const group of result.report.groups) {
      const value = group.aggregate;
      console.log(`| ${markdownCell(group.provider ?? "全部")} | ${markdownCell(group.model ?? "全部/未观测")} | ${value.requestCount} | ${value.unsuccessfulRequestCount} | ${value.inputTokens} | ${value.cachedInputTokens ?? "未知"} | ${value.outputTokens} | ${formatCost({ ...value, provider: group.provider ?? null }, display)} | ${markdownCell(formatCompactSummary(value.compact, display, group.provider ?? null) ?? "无")} |`);
    }
    const hidden = result.report.totalGroupCount - result.report.groups.length;
    if (hidden > 0) console.log(`\n仅显示请求量最高的 ${result.report.groups.length} 组，另有 ${hidden} 组。`);
  }
  console.log("");
  console.log("## 异常与未完整观测");
  console.log("");
  if (result.errors.groups.length === 0) {
    console.log("本时间范围没有异常或未完整观测请求。");
    return;
  }
  console.log("| 提供商 | 模型 | 状态 | 类型 | HTTP | 次数 |");
  console.log("| --- | --- | --- | --- | ---: | ---: |");
  for (const group of result.errors.groups) {
    console.log(`| ${markdownCell(group.provider)} | ${markdownCell(group.model ?? "未观测")} | ${group.status} | ${markdownCell(group.errorType ?? "未提供")} | ${group.httpStatus ?? ""} | ${group.requestCount} |`);
  }
}

function singleReportProvider(report) {
  if (report.totalGroupCount !== report.groups.length) return null;
  const providers = new Set(
    report.groups
      .map((group) => group.provider)
      .filter((provider) => provider != null),
  );
  return providers.size === 1 ? providers.values().next().value : null;
}

function printMetricsExport(result, format, display = null) {
  if (format === "json") {
    console.log(JSON.stringify({
      ...result,
      records: result.records.map((record) => enrichCosts(record, display)),
    }, null, 2));
    return;
  }
  if (format === "markdown") {
    console.log("# Codex Connect 请求明细");
    console.log("");
    const rateLine = exchangeRateLine(display);
    if (rateLine) console.log(`- ${rateLine}`);
    console.log(`- 生成时间：${result.generatedAt}`);
    console.log(`- 时间范围：${result.range.name}`);
    printWeeklyQuotaMarkdown(result.weeklyQuota);
    console.log("");
    if (result.records.length === 0) {
      console.log("本时间范围没有请求记录。");
      return;
    }
    console.log("| 时间 | 提供商 | 模型 | 操作 | 思考等级 | 状态 | 耗时 | 输入 | 缓存输入 | 输出 | 参考价 |");
    console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const record of result.records) {
      const pricingCurrency = record.pricing?.currency ?? null;
      const cost = record.totalCostNanos === null || pricingCurrency === null
        ? "未知"
        : formatCost({ ...record, pricingCurrency }, display);
      console.log(
        [
          markdownCell(formatLocalTime(record.recordedAtMs)),
          markdownCell(record.provider ?? ""),
          markdownCell(record.model ?? ""),
          markdownCell(record.operation),
          markdownCell(record.reasoningEffort ?? "模型默认"),
          markdownCell(record.status ?? ""),
          markdownCell(formatDuration(record.requestDurationMs)),
          markdownCell(formatTokenCount(record.inputTokens ?? 0)),
          markdownCell(formatTokenCount(record.cachedInputTokens ?? 0)),
          markdownCell(formatTokenCount(record.outputTokens ?? 0)),
          markdownCell(cost),
        ].join(" | "),
      );
    }
    return;
  }
  const columns = [
    ["type", (row) => row.type],
    ...csvColumns(),
    ...weeklyQuotaCsvColumns(),
  ];
  const rows = [
    ...result.records.map((record) => ({
      type: "request",
      ...enrichCosts(record, display),
      ...flattenRecordedWeeklyQuota(record),
    })),
    ...(result.weeklyQuota === null
      ? []
      : [{
          type: "weekly_quota_summary",
          ...flattenWeeklyQuota(result.weeklyQuota),
        }]),
  ];
  console.log(columns.map(([heading]) => csvCell(heading)).join(","));
  for (const row of rows) {
    console.log(columns.map(([, read]) => csvCell(read(row))).join(","));
  }
}

function printWeeklyQuotaMarkdown(quota) {
  console.log("");
  console.log("## 当前周额度区间");
  console.log("");
  if (quota === null) {
    console.log("暂无统计代理捕获的周额度快照。");
    return;
  }
  console.log(`- 已用：${quota.usedPercent}%`);
  console.log(`- 剩余：${quota.remainingPercent}%`);
  console.log(`- 重置时间：${new Date(quota.resetsAt * 1_000).toISOString()}`);
  console.log(`- 观测时间：${new Date(quota.observedAtMs).toISOString()}`);
  if (quota.estimate === null) {
    console.log("- 每 1% 估算：正在采样，尚未观测到额度增长");
    return;
  }
  console.log(`- 观测变化：${quota.estimate.observedDeltaPercent}%（${quota.estimate.intervalCount} 个区间）`);
  console.log(`- 每 1%：约 ${quota.estimate.totalTokensPerPercent} Token`);
  console.log(`- 每 1% API 参考费用：${quota.estimate.costPerPercentNanos === null
    || quota.estimate.pricingCurrency === null
    ? "暂无完整价格样本"
    : formatCurrencyNanos(
        quota.estimate.costPerPercentNanos,
        quota.estimate.pricingCurrency,
        null,
        "openai",
      )}`);
}

function flattenWeeklyQuota(quota) {
  if (quota === null) return {};
  return {
    weeklyQuotaLimitId: quota.limitId,
    weeklyQuotaUsedPercent: quota.usedPercent,
    weeklyQuotaRemainingPercent: quota.remainingPercent,
    weeklyQuotaResetsAt: quota.resetsAt,
    weeklyQuotaObservedAtMs: quota.observedAtMs,
    weeklyQuotaObservedDeltaPercent: quota.estimate?.observedDeltaPercent,
    weeklyQuotaIntervalCount: quota.estimate?.intervalCount,
    weeklyQuotaRequestCount: quota.estimate?.requestCount,
    weeklyQuotaTotalTokensPerPercent: quota.estimate?.totalTokensPerPercent,
    weeklyQuotaPricingCurrency: quota.estimate?.pricingCurrency,
    weeklyQuotaCostPerPercentNanos: quota.estimate?.costPerPercentNanos,
  };
}

function flattenRecordedWeeklyQuota(record) {
  const quota = record.weeklyQuota;
  if (quota === null) return {};
  const usedPercent = quota.usedPercentMillionths / 1_000_000;
  return {
    weeklyQuotaLimitId: quota.limitId,
    weeklyQuotaUsedPercent: usedPercent,
    weeklyQuotaRemainingPercent: Math.max(0, 100 - usedPercent),
    weeklyQuotaResetsAt: quota.resetsAt,
    weeklyQuotaObservedAtMs: record.recordedAtMs,
  };
}

function weeklyQuotaCsvColumns() {
  return [
    ["weeklyQuotaLimitId", (row) => row.weeklyQuotaLimitId],
    ["weeklyQuotaUsedPercent", (row) => row.weeklyQuotaUsedPercent],
    ["weeklyQuotaRemainingPercent", (row) => row.weeklyQuotaRemainingPercent],
    ["weeklyQuotaResetsAt", (row) => row.weeklyQuotaResetsAt],
    ["weeklyQuotaObservedAtMs", (row) => row.weeklyQuotaObservedAtMs],
    ["weeklyQuotaObservedDeltaPercent", (row) => row.weeklyQuotaObservedDeltaPercent],
    ["weeklyQuotaIntervalCount", (row) => row.weeklyQuotaIntervalCount],
    ["weeklyQuotaRequestCount", (row) => row.weeklyQuotaRequestCount],
    ["weeklyQuotaTotalTokensPerPercent", (row) => row.weeklyQuotaTotalTokensPerPercent],
    ["weeklyQuotaPricingCurrency", (row) => row.weeklyQuotaPricingCurrency],
    ["weeklyQuotaCostPerPercentNanos", (row) => row.weeklyQuotaCostPerPercentNanos],
  ];
}

function compactCsvColumns() {
  return [
    ["compactModel", (row) => row.compact?.model],
    ["compactHasMixedModels", (row) => row.compact?.hasMixedModels],
    ["compactRequestCount", (row) => row.compact?.requestCount],
    ["compactUnsuccessfulRequestCount", (row) =>
      row.compact?.unsuccessfulRequestCount],
    ["compactInputTokens", (row) => row.compact?.inputTokens],
    ["compactCachedInputTokens", (row) => row.compact?.cachedInputTokens],
    ["compactOutputTokens", (row) => row.compact?.outputTokens],
    ["compactPricingCurrency", (row) => row.compact?.pricingCurrency],
    ["compactPricedRequestCount", (row) => row.compact?.pricedRequestCount],
    ["compactTotalCostNanos", (row) => row.compact?.totalCostNanos],
    ["compactTotalCostCnyNanos", (row) => row.compact?.totalCostCnyNanos],
  ];
}

function enrichSummaryCosts(value, display, provider = null) {
  const enriched = enrichCosts(value, display, provider);
  if (enriched === null || enriched === undefined || value.compact == null) {
    return enriched;
  }
  const compactCost = enrichCosts(value.compact, display, provider);
  return {
    ...enriched,
    compact: {
      ...value.compact,
      totalCostCnyNanos: compactCost.totalCostCnyNanos,
    },
  };
}

function printCompactSummary(compact, display, provider = null) {
  const summary = formatCompactSummary(compact, display, provider);
  if (summary === null) return;
  console.log(`- 上下文压缩：${summary}`);
}

function formatCompactSummary(compact, display, provider = null) {
  if (compact == null) return null;
  const model = compact.hasMixedModels
    ? "混合模型"
    : compact.model ?? "模型未知";
  const failures = compact.unsuccessfulRequestCount > 0
    ? `（异常 ${compact.unsuccessfulRequestCount} 次）`
    : "";
  const cost = formatCost({ ...compact, provider }, display);
  const coverage = compact.pricedRequestCount === compact.requestCount
    ? ""
    : `（已计价 ${compact.pricedRequestCount}/${compact.requestCount} 次）`;
  return `${compact.requestCount} 次${failures} · ${model} · ${formatTokenCount(compact.inputTokens + compact.outputTokens)} Token · ${cost}${coverage}`;
}

function printMetricsRun(result, format, display = null) {
  if (format === "json") {
    console.log(JSON.stringify({
      ...result,
      latestTurn: enrichSummaryCosts(result.latestTurn, display),
      threadAggregate: enrichSummaryCosts(result.threadAggregate, display),
    }, null, 2));
    return;
  }
  if (format === "csv") {
    const rows = [
      ...(result.latestTurn === null
        ? []
        : [{ type: "latest", ...enrichSummaryCosts(result.latestTurn, display) }]),
      ...(result.threadAggregate === null
        ? []
        : [{ type: "thread", ...enrichSummaryCosts(result.threadAggregate, display) }]),
    ];
    printTurnSummaryCsv(rows);
    return;
  }
  const { latestTurn, threadAggregate } = result;
  console.log("# Codex Connect 本次运行统计");
  console.log("");
  const rateLine = exchangeRateLine(display);
  if (rateLine) console.log(`- ${rateLine}`);
  console.log(`- Thread：${result.threadId}`);
  console.log(`- 生成时间：${result.generatedAt}`);
  console.log("");
  console.log("## 最近运行聚合");
  console.log("");
  if (latestTurn === null) {
    console.log("该 Thread 暂无已记录请求。");
  } else {
    printTurnSummary(latestTurn, false, display, latestTurn.provider ?? null);
  }
  console.log("");
  console.log("## 当前会话指标累计");
  console.log("");
  if (threadAggregate === null) {
    console.log("该 Thread 暂无累计记录。");
  } else {
    printTurnSummary(
      threadAggregate,
      true,
      display,
      latestTurn?.provider ?? null,
    );
  }
}

function printTurnSummaryCsv(rows) {
  const columns = [
    ["type", (row) => row.type],
    ["provider", (row) => row.provider],
    ["model", (row) => row.model],
    ["reasoningEffort", (row) => row.reasoningEffort],
    ["recordedAt", (row) => row.recordedAtMs === undefined ? "" : new Date(row.recordedAtMs).toISOString()],
    ["turnId", (row) => row.turnId],
    ["requestCount", (row) => row.requestCount],
    ["unsuccessfulRequestCount", (row) => row.unsuccessfulRequestCount],
    ["requestDurationMs", (row) => row.requestDurationMs],
    ["inputTokens", (row) => row.inputTokens],
    ["cachedInputTokens", (row) => row.cachedInputTokens],
    ["outputTokens", (row) => row.outputTokens],
    ["reasoningOutputTokens", (row) => row.reasoningOutputTokens],
    ["outputTokensPerSecond", (row) => row.outputTokensPerSecond],
    ["pricingCurrency", (row) => row.pricingCurrency],
    ["pricedRequestCount", (row) => row.pricedRequestCount],
    ["totalCostNanos", (row) => row.totalCostNanos],
    ["inputCostNanos", (row) => row.inputCostNanos],
    ["cachedInputCostNanos", (row) => row.cachedInputCostNanos],
    ["outputCostNanos", (row) => row.outputCostNanos],
    ["totalCostCnyNanos", (row) => row.totalCostCnyNanos],
    ["inputCostCnyNanos", (row) => row.inputCostCnyNanos],
    ["cachedInputCostCnyNanos", (row) => row.cachedInputCostCnyNanos],
    ["outputCostCnyNanos", (row) => row.outputCostCnyNanos],
    ...compactCsvColumns(),
  ];
  console.log(columns.map(([heading]) => csvCell(heading)).join(","));
  for (const row of rows) {
    console.log(columns.map(([, read]) => csvCell(read(row))).join(","));
  }
}

function printMetricsTurns(result, format, display = null) {
  if (format === "json") {
    console.log(JSON.stringify({
      ...result,
      turns: result.turns.map((turn) => enrichSummaryCosts(turn, display)),
    }, null, 2));
    return;
  }
  if (format === "csv") {
    printTurnSummaryCsv(result.turns.map((turn) => ({
      type: "turn",
      ...enrichSummaryCosts(turn, display),
    })));
    return;
  }
  console.log(`# 会话对话明细 · ${result.threadId}`);
  console.log("");
  const rateLine = exchangeRateLine(display);
  if (rateLine) console.log(`- ${rateLine}`);
  if (result.turns.length === 0) {
    console.log("该会话暂无可导出的对话记录。");
    return;
  }
  console.log("| # | 对话 ID | 时间 | 模型 | 思考等级 | 请求 | 异常 | 耗时 | 总 Token | 缓存率 | 速度 | 参考总价 | 上下文压缩 |");
  console.log("| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const [index, turn] of result.turns.entries()) {
    const cacheRate = turn.cachedInputTokens === null || turn.inputTokens === 0
      ? "未知"
      : `${((turn.cachedInputTokens / turn.inputTokens) * 100).toFixed(2)}%`;
    const speed = turn.outputTokensPerSecond === null
      ? "未知"
      : `${turn.outputTokensPerSecond.toFixed(0)} t/s`;
    const cost = turn.totalCostNanos === null || turn.pricingCurrency === null
      ? "未知"
      : formatCost(turn, display);
    console.log(
      [
        String(result.turns.length - index),
        markdownCell(turn.turnId),
        markdownCell(formatLocalTime(turn.recordedAtMs)),
        markdownCell(turn.model ?? "未观测"),
        markdownCell(turn.reasoningEffort ?? "模型默认"),
        String(turn.requestCount),
        String(turn.unsuccessfulRequestCount),
        markdownCell(formatDuration(turn.requestDurationMs)),
        formatTokenCount(turn.inputTokens + turn.outputTokens),
        cacheRate,
        speed,
        cost,
        markdownCell(formatCompactSummary(turn.compact, display, turn.provider) ?? "无"),
      ].join(" | "),
    );
  }
}

function printMetricsThreads(result, format, display = null) {
  if (format === "json") {
    console.log(JSON.stringify({
      ...result,
      threads: result.threads.map((thread) => enrichSummaryCosts(thread, display)),
    }, null, 2));
    return;
  }
  if (format === "csv") {
    const columns = [
      ["threadId", (thread) => thread.threadId],
      ["provider", (thread) => thread.provider],
      ["model", (thread) => thread.model],
      ["reasoningEffort", (thread) => thread.reasoningEffort],
      ["turnCount", (thread) => thread.turnCount],
      ["requestCount", (thread) => thread.requestCount],
      ["inputTokens", (thread) => thread.inputTokens],
      ["outputTokens", (thread) => thread.outputTokens],
      ["pricingCurrency", (thread) => thread.pricingCurrency],
      ["pricedRequestCount", (thread) => thread.pricedRequestCount],
      ["totalCostNanos", (thread) => thread.totalCostNanos],
      ["totalCostCnyNanos", (thread) => thread.totalCostCnyNanos],
      ...compactCsvColumns(),
      ["lastRecordedAtMs", (thread) => thread.lastRecordedAtMs],
    ];
    console.log(columns.map(([heading]) => csvCell(heading)).join(","));
    for (const thread of result.threads.map((item) =>
      enrichSummaryCosts(item, display))) {
      console.log(columns.map(([, read]) => csvCell(read(thread))).join(","));
    }
    return;
  }
  if (result.threads.length === 0) {
    console.log("指标库中暂无可导出的会话记录。");
    return;
  }
  console.log(`# 指标会话列表（${result.threads.length}）`);
  console.log("");
  const rateLine = exchangeRateLine(display);
  if (rateLine) console.log(`- ${rateLine}`);
  console.log("| # | Thread | 模型 | 思考等级 | 对话数 | 请求数 | 总 Token | 参考总价 | 上下文压缩 | 最近记录 |");
  console.log("| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |");
  for (const [index, thread] of result.threads.entries()) {
    const cost = thread.totalCostNanos === null || thread.pricingCurrency === null
      ? "未知"
      : formatCost(thread, display);
    console.log(
      [
        String(index + 1),
        markdownCell(thread.threadId),
        markdownCell(thread.model ?? "未观测"),
        markdownCell(thread.reasoningEffort ?? "模型默认"),
        String(thread.turnCount),
        String(thread.requestCount),
        formatTokenCount(thread.inputTokens + thread.outputTokens),
        cost,
        markdownCell(formatCompactSummary(thread.compact, display, thread.provider) ?? "无"),
        markdownCell(formatLocalTime(thread.lastRecordedAtMs)),
      ].join(" | "),
    );
  }
  console.log("");
  console.log("导出某会话每次对话：codexc metrics turns <Thread ID>");
}

function printTurnSummary(summary, aggregate = false, display = null, provider = null) {
  const totalTokens = summary.inputTokens + summary.outputTokens;
  if (summary.model !== undefined && summary.model !== null) {
    console.log(`- 模型：${summary.model}`);
  }
  if (summary.reasoningEffort !== undefined && summary.reasoningEffort !== null) {
    console.log(`- 思考等级：${summary.reasoningEffort}`);
  }
  console.log(
    `- 模型请求：${summary.requestCount} 次${summary.unsuccessfulRequestCount > 0 ? `（异常 ${summary.unsuccessfulRequestCount} 次）` : ""}`,
  );
  console.log(
    `- ${aggregate ? "模型请求累计耗时" : "模型请求聚合耗时"}：${formatDuration(summary.requestDurationMs)}`,
  );
  console.log(`- 总 Token：${formatTokenCount(totalTokens)}`);
  if (summary.cachedInputTokens === null) {
    console.log("  - 缓存：上游未提供完整数据");
  } else {
    console.log(`  - 输入命中缓存：${formatTokenCount(summary.cachedInputTokens)}`);
    console.log(
      `  - 输入未命中缓存：${formatTokenCount(Math.max(0, summary.inputTokens - summary.cachedInputTokens))}`,
    );
    console.log(
      `  - 缓存命中率：${summary.inputTokens === 0 ? "0%" : `${((summary.cachedInputTokens / summary.inputTokens) * 100).toFixed(2)}%`}`,
    );
  }
  console.log(`  - 输出：${formatTokenCount(summary.outputTokens)}`);
  if (provider === "deepseek" && summary.reasoningOutputTokens > 0) {
    console.log(`    - 其中推理输出：${formatTokenCount(summary.reasoningOutputTokens)}`);
  }
  if (
    summary.outputTokensPerSecond !== null
    && summary.outputSpeedTimedCount > 0
  ) {
    console.log(
      `  - 综合输出速度：${summary.outputTokensPerSecond.toFixed(0)} token/s（覆盖 ${summary.outputSpeedTimedCount}/${summary.outputSpeedSampleCount} 次请求）`,
    );
  }
  if (summary.totalCostNanos !== null && summary.pricingCurrency !== null) {
    console.log(
      `- 参考总价：${formatCost(summary, display)}（已计价 ${summary.pricedRequestCount}/${summary.requestCount} 次请求）`,
    );
    if (summary.inputCostNanos !== null) {
      console.log(`  - 输入价格：${formatCurrencyNanos(summary.inputCostNanos, summary.pricingCurrency, display, summary.provider)}`);
    }
    if (summary.cachedInputCostNanos !== null) {
      console.log(`  - 缓存价格：${formatCurrencyNanos(summary.cachedInputCostNanos, summary.pricingCurrency, display, summary.provider)}`);
    }
    if (summary.outputCostNanos !== null) {
      console.log(`  - 输出价格：${formatCurrencyNanos(summary.outputCostNanos, summary.pricingCurrency, display, summary.provider)}`);
    }
  }
  printCompactSummary(summary.compact, display, summary.provider ?? null);
}

export function metricsRange(name, nowMs) {
  const duration = {
    "24h": 24 * 60 * 60 * 1_000,
    "7d": 7 * 24 * 60 * 60 * 1_000,
    "30d": 30 * 24 * 60 * 60 * 1_000,
  }[name];
  if (duration === undefined) throw new Error("--range 只支持 24h、7d 或 30d");
  return { name, startAtMs: Math.max(0, nowMs - duration), endAtMs: nowMs };
}

function metricsDimension(value) {
  const result = { global: "global", providers: "provider", models: "model" }[value];
  if (!result) throw new Error("--group 只支持 global、providers 或 models");
  return result;
}

function parseMetricsOptions(args, allowed) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!allowed.has(option)) throw new Error(`未知参数：${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} 缺少值`);
    result[option.slice(2)] = value;
    index += 1;
  }
  return result;
}

function parseMetricsRunArgs(args) {
  let threadId;
  let format = "markdown";
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--format") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--format 缺少值");
      }
      format = value;
      index += 1;
      continue;
    }
    if (option.startsWith("--")) {
      throw new Error(`未知参数：${option}`);
    }
    if (threadId !== undefined) {
      throw new Error("只能指定一个 Thread ID");
    }
    threadId = option;
  }
  if (!threadId) {
    throw new Error("用法：codexc metrics run <Thread ID> [--format markdown|json|csv]");
  }
  assertExportFormat(format, ["markdown", "json", "csv"]);
  return { threadId, format };
}

function parseMetricsTurnsArgs(args) {
  let threadId;
  let format = "markdown";
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--format") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--format 缺少值");
      }
      format = value;
      index += 1;
      continue;
    }
    if (option.startsWith("--")) {
      throw new Error(`未知参数：${option}`);
    }
    if (threadId !== undefined) {
      throw new Error("只能指定一个 Thread ID");
    }
    threadId = option;
  }
  if (!threadId) {
    throw new Error("用法：codexc metrics turns <Thread ID> [--format markdown|json|csv]");
  }
  assertExportFormat(format, ["markdown", "json", "csv"]);
  return { threadId, format };
}

function parseMetricsThreadsArgs(args) {
  let format = "markdown";
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--format") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--format 缺少值");
      }
      format = value;
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${option}`);
  }
  assertExportFormat(format, ["markdown", "json", "csv"]);
  return { format };
}

function assertExportFormat(value, allowed) {
  if (!allowed.includes(value)) {
    throw new Error(`--format 只支持 ${allowed.join("、")}`);
  }
}

function csvColumns() {
  return [
    ["id", (record) => record.id],
    ["recordedAt", (record) => record.recordedAtMs === undefined
      ? ""
      : new Date(record.recordedAtMs).toISOString()],
    ["provider", (record) => record.provider],
    ["model", (record) => record.model],
    ["serviceTier", (record) => record.serviceTier],
    ["reasoningEffort", (record) => record.reasoningEffort],
    ["status", (record) => record.status],
    ["errorType", (record) => record.errorType],
    ["incompleteReason", (record) => record.incompleteReason],
    ["httpStatus", (record) => record.httpStatus],
    ["transport", (record) => record.transport],
    ["responseFormat", (record) => record.responseFormat],
    ["operation", (record) => record.operation],
    ["threadId", (record) => record.threadId],
    ["turnId", (record) => record.turnId],
    ["requestDurationMs", (record) => record.requestDurationMs],
    ["ttftMs", (record) => record.ttftMs],
    ["inputTokens", (record) => record.inputTokens],
    ["cachedInputTokens", (record) => record.cachedInputTokens],
    ["uncachedInputTokens", (record) => record.uncachedInputTokens],
    ["outputTokens", (record) => record.outputTokens],
    ["reasoningOutputTokens", (record) => record.reasoningOutputTokens],
    ["outputTokensPerSecond", (record) => record.outputTokensPerSecond],
    ["pricingCurrency", (record) => record.pricing?.currency],
    ["uncachedInputPricePerMillionNanos", (record) => record.pricing?.uncachedInputPricePerMillionNanos],
    ["cachedInputPricePerMillionNanos", (record) => record.pricing?.cachedInputPricePerMillionNanos],
    ["outputPricePerMillionNanos", (record) => record.pricing?.outputPricePerMillionNanos],
    ["totalCostNanos", (record) => record.totalCostNanos],
  ];
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const command = process.argv[2];
    if (command === "status" && process.argv.length === 3) {
      printStatus(inspectMetricsDatabase());
    } else if (command === "reset" && process.argv.length === 3) {
      const result = resetMetricsDatabase();
      if (!result.changed) {
        console.log(`指标数据库尚未创建：${result.databasePath}`);
      } else {
        console.log(`指标数据库已归档并重置：${result.databasePath}`);
        console.log(`旧库备份：${result.backupPath}`);
        console.log("启动 Gateway 后将自动创建当前 Schema。");
      }
    } else if (command === "upgrade" && process.argv.length === 3) {
      const result = upgradeMetricsDatabase();
      if (!result.changed) {
        console.log(result.schemaVersion === null
          ? `指标数据库尚未创建：${result.databasePath}`
          : `指标数据库已经是 Schema v${result.schemaVersion}。`);
      } else {
        console.log(`指标数据库已升级到 Schema v${result.schemaVersion}：${result.databasePath}`);
        console.log(`升级前备份：${result.backupPath}`);
      }
    } else if (command === "upgrade-restart" && process.argv.length === 3) {
      const result = upgradeMetricsDatabaseWithGatewayRestart();
      if (!result.changed) {
        console.log(result.schemaVersion === null
          ? `指标数据库尚未创建：${result.databasePath}`
          : `指标数据库已经是 Schema v${result.schemaVersion}。`);
      } else {
        console.log(`指标数据库已升级到 Schema v${result.schemaVersion}：${result.databasePath}`);
        console.log(`升级前备份：${result.backupPath}`);
      }
      console.log("Gateway 已重新启动。");
    } else if (command === "report") {
      const options = parseMetricsOptions(
        process.argv.slice(3),
        new Set(["--range", "--group", "--format"]),
      );
      const format = options.format ?? "markdown";
      assertExportFormat(format, ["markdown", "json", "csv"]);
      printMetricsReport(
        readMetricsReport(process.env, options),
        format,
        loadDisplayContext(process.env),
      );
    } else if (command === "export") {
      const options = parseMetricsOptions(
        process.argv.slice(3),
        new Set(["--range", "--format", "--thread"]),
      );
      const format = options.format ?? "json";
      assertExportFormat(format, ["json", "csv", "markdown"]);
      const display = loadDisplayContext(process.env);
      printMetricsExport(
        readMetricsExport(process.env, {
          ...options,
          ...(options.thread ? { threadId: options.thread } : {}),
        }),
        format,
        display,
      );
    } else if (command === "run") {
      const options = parseMetricsRunArgs(process.argv.slice(3));
      printMetricsRun(
        readMetricsRun(process.env, options.threadId),
        options.format,
        loadDisplayContext(process.env),
      );
    } else if (command === "threads") {
      const options = parseMetricsThreadsArgs(process.argv.slice(3));
      printMetricsThreads(
        readMetricsThreads(process.env),
        options.format,
        loadDisplayContext(process.env),
      );
    } else if (command === "turns") {
      const options = parseMetricsTurnsArgs(process.argv.slice(3));
      printMetricsTurns(
        readMetricsTurns(process.env, options.threadId),
        options.format,
        loadDisplayContext(process.env),
      );
    } else {
      throw new Error("用法：codexc metrics <status|run|threads|turns|report|export|upgrade|reset>");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
