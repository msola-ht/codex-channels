import { spawnSync } from "node:child_process";
export { validateMetricsDatabaseStructure } from "./metrics-database-access.mjs";
import {
  copyFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { securePrivateFileSync } from "../runtime/private-file.mjs";
import {
  providerMetricsSocketPath,
} from "../runtime/model-provider-runtime.mjs";
import {
  assertSynchronousChildSuccess,
  ForwardedChildSignalError,
  ReportedChildExitError,
} from "../runtime/process-lifecycle.mjs";
import { serviceIdentifiers } from "../runtime/service-targets.mjs";
import {
  acquireRequestMetricsDatabaseLock,
} from "../dist/observability/index.js";
import {
  inspectMetricsDatabase,
  readMetricsExport,
  readQuotaHistory,
  readMetricsReport,
  readMetricsRun,
  readMetricsThreads,
  readMetricsTurns,
  requireCompatibleMetricsDatabase,
  resolveMetricsDatabaseContext,
} from "./metrics-database-access.mjs";
import { inspectManagedServiceStatus } from "./service-status.mjs";
import { resolveConfiguredPath } from "./runtime-config.mjs";
import {
  assertExportFormat,
  isPrunableMetricsProviderId,
  metricsProviderIds,
  metricsQueryOptions,
  parseCleanupOptions,
  parseLocalDate,
  parseMetricsOptions,
  parseMetricsRunArgs,
  parseMetricsThreadsArgs,
  parseMetricsTurnsArgs,
  positiveInteger,
} from "./metrics-command-options.mjs";
import {
  isRecord,
} from "./metrics-export-format.mjs";
import {
  printMetricsExport,
  printMetricsReport,
  printMetricsRun,
  printMetricsThreads,
  printMetricsTurns,
  printQuotaHistory,
  printStatus,
} from "./metrics-output-renderer.mjs";

export { metricsRange } from "./metrics-command-options.mjs";
export {
  inspectMetricsDatabase,
  readMetricsExport,
  readQuotaHistory,
  readMetricsReport,
  readMetricsRun,
  readMetricsThreads,
  readMetricsTurns,
  readWeeklyQuota,
} from "./metrics-database-access.mjs";

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
    securePrivateFileSync(backupPath);
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

export function pruneProviderMetrics(provider, environment = process.env, options = {}) {
  assertPruneProvider(provider);
  const localDatabasePath = options.localDatabasePath
    ?? resolveMetricsRuntime(environment).databasePath;
  const stopGateway = options.stopGateway
    ?? (() => runServiceAction("gateway", "stop", environment));
  const startGateway = options.startGateway
    ?? (() => runServiceAction("gateway", "start", environment));

  // Maintenance must restore the state that existed before the operation.
  // Test/in-process callers can provide explicit state; the CLI queries the
  // managed service status before stopping anything.
  const gatewayWasRunning = options.gatewayRunning
    ?? (options.stopGateway !== undefined || options.startGateway !== undefined
      ? true
      : isManagedServiceRunning("gateway", environment));
  const warnings = [];
  let gatewayStopped = false;
  const stopErrors = [];
  if (gatewayWasRunning) {
    try {
      stopGateway();
      gatewayStopped = true;
    } catch (error) {
      stopErrors.push(error);
    }
  }
  let result;
  let operationError;
  if (stopErrors.length > 0) {
    operationError = stopErrors.length === 1
      ? stopErrors[0]
      : new AggregateError(stopErrors, "停止指标服务失败");
  } else {
    try {
      result = pruneProviderDatabase({
        provider,
        localDatabasePath,
        allowVacuumLocal: gatewayStopped,
      });
    } catch (error) {
      operationError = error;
    }
  }

  const startFailures = [];
  if (gatewayWasRunning) {
    try {
      startGateway();
    } catch (error) {
      startFailures.push(`Gateway 启动失败：${errorMessage(error)}`);
    }
  }

  if (operationError !== undefined && startFailures.length > 0) {
    throw new AggregateError(
      [operationError, ...startFailures.map((message) => new Error(message))],
      `清理 ${provider} 请求指标失败，且服务未能全部重新启动`,
    );
  }
  if (operationError !== undefined) throw operationError;
  if (startFailures.length > 0) {
    throw new Error(startFailures.join("；"));
  }
  return {
    ...result,
    gatewayWasRunning,
    warnings,
  };
}

export function cleanupMetricsDatabase(environment = process.env, options = {}) {
  const { runtime, keepDays, maxRows, beforeMs } = resolveCleanupPolicy(
    environment,
    options,
  );
  const gatewayRunning = options.gatewayRunning ?? (() => isGatewayRunning(environment));
  if (gatewayRunning() || runtime.metricsSocketPaths.some(metricsSocketIsActive)) {
    throw new Error(
      "Gateway 仍在运行；请先执行 codexc service stop gateway，或使用 --restart-gateway 自动停止并重启",
    );
  }
  const databasePath = requireCompatibleMetricsDatabase(environment);
  checkpoint(databasePath);
  const backupPath = `${databasePath}.cleanup-${backupTimestamp(new Date())}.bak`;
  copyFileSync(databasePath, backupPath);
  securePrivateFileSync(backupPath);
  const database = new DatabaseSync(databasePath);
  let deletedByAge;
  let deletedByLimit;
  try {
    database.exec("BEGIN IMMEDIATE");
    deletedByAge = Number(database.prepare(`
      DELETE FROM model_request_metrics WHERE recorded_at_ms < ?
    `).run(Math.max(0, beforeMs)).changes);
    deletedByLimit = Number(database.prepare(`
      DELETE FROM model_request_metrics
      WHERE id <= COALESCE((
        SELECT id FROM model_request_metrics ORDER BY id DESC LIMIT 1 OFFSET ?
      ), 0)
    `).run(maxRows).changes);
    database.exec("COMMIT");
    if (options.vacuum === true) database.exec("VACUUM");
    const remaining = Number(database.prepare(
      "SELECT COUNT(*) AS count FROM model_request_metrics",
    ).get()?.count ?? 0);
    return {
      backupPath,
      databasePath,
      deleted: deletedByAge + deletedByLimit,
      deletedByAge,
      deletedByLimit,
      keepDays,
      maxRows,
      remaining,
      vacuumed: options.vacuum === true,
    };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // 保留原始异常
    }
    throw error;
  } finally {
    database.close();
  }
}

export function cleanupMetricsDatabaseWithGatewayRestart(
  environment = process.env,
  options = {},
) {
  resolveCleanupPolicy(environment, options);
  const stopGateway = options.stopGateway
    ?? (() => runGatewayServiceAction("stop", environment));
  const startGateway = options.startGateway
    ?? (() => runGatewayServiceAction("start", environment));
  stopGateway();
  try {
    return cleanupMetricsDatabase(environment, options);
  } finally {
    startGateway();
  }
}

function resolveCleanupPolicy(environment, options) {
  if (options.before !== undefined && options.keepDays !== undefined) {
    throw new Error("--before 与 --keep-days 不能同时使用");
  }
  const runtime = resolveMetricsRuntime(environment);
  const keepDays = positiveInteger(options.keepDays ?? runtime.retentionDays, "--keep-days");
  const maxRows = positiveInteger(options.maxRows ?? runtime.maxRows, "--max-rows");
  const beforeMs = options.before === undefined
    ? Date.now() - keepDays * 24 * 60 * 60 * 1_000
    : parseLocalDate(options.before);
  return { runtime, keepDays, maxRows, beforeMs };
}

function pruneProviderDatabase({
  provider,
  localDatabasePath,
  allowVacuumLocal,
}) {
  const localBackupPath = backupMetricsDatabase(localDatabasePath, provider);
  const localDeleted = deleteProviderRows(
    localDatabasePath,
    "model_request_metrics",
    provider,
    allowVacuumLocal,
  );
  return {
    provider,
    local: {
      databasePath: localDatabasePath,
      backupPath: localBackupPath,
      deleted: localDeleted,
    },
  };
}

function backupMetricsDatabase(databasePath, provider) {
  if (!existsSync(databasePath)) return null;
  try {
    checkpoint(databasePath);
  } catch (error) {
    throw new Error(`备份指标数据库失败：${errorMessage(error)}`, { cause: error });
  }
  const backupPath = `${databasePath}.${provider}-prune-${backupTimestamp(new Date())}.bak`;
  copyFileSync(databasePath, backupPath);
  securePrivateFileSync(backupPath);
  return backupPath;
}

function deleteProviderRows(databasePath, table, provider, allowVacuum) {
  if (!existsSync(databasePath)) return 0;
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 10000;");
    const info = database.prepare(
      `DELETE FROM ${table} WHERE provider = ?`,
    ).run(provider);
    if (allowVacuum) {
      database.exec("VACUUM");
    }
    return Number(info.changes ?? 0);
  } finally {
    database.close();
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function assertPruneProvider(provider) {
  if (!isPrunableMetricsProviderId(provider)) {
    throw new Error("用法：codexc metrics prune <provider>");
  }
}

function runGatewayServiceAction(action, environment) {
  const cli = resolve(import.meta.dirname, "../bin/codexc.mjs");
  const result = spawnSync(
    process.execPath,
    [cli, "service", action, "gateway"],
    { env: environment, stdio: "inherit" },
  );
  assertSynchronousChildSuccess(result, { failureReportedByChild: true });
}

function runServiceAction(target, action, environment) {
  const cli = resolve(import.meta.dirname, "../bin/codexc.mjs");
  const result = spawnSync(
    process.execPath,
    [cli, "service", action, target],
    { env: environment, stdio: "inherit" },
  );
  assertSynchronousChildSuccess(result, { failureReportedByChild: true });
}

function resolveMetricsRuntime(environment) {
  const { databasePath, dataDir, document } = resolveMetricsDatabaseContext(environment);
  const codex = isRecord(document.codex) ? document.codex : {};
  const metrics = isRecord(document.metrics) ? document.metrics : {};
  const metricsStorage = isRecord(metrics.storage) ? metrics.storage : {};
  const appServerSocketPath = resolveConfiguredPath(
    typeof codex.socket_path === "string" ? codex.socket_path : undefined,
    dataDir,
    "runtime/codex-app-server.sock",
  );
  return {
    databasePath,
    retentionDays: positiveInteger(
      typeof metricsStorage.retention_days === "number"
        ? metricsStorage.retention_days
        : 365,
      "metrics.storage.retention_days",
    ),
    maxRows: positiveInteger(
      typeof metricsStorage.max_rows === "number" ? metricsStorage.max_rows : 1_000_000,
      "metrics.storage.max_rows",
    ),
    metricsSocketPaths: metricsProviderIds.map((provider) =>
      providerMetricsSocketPath(appServerSocketPath, provider)
    ),
  };
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
    const gatewayUnit = serviceIdentifiers("systemd", "gateway")[0];
    const result = spawnSync(
      environment.SYSTEMCTL_BINARY || "systemctl",
      ["--user", "show", "--property=ActiveState", "--value", gatewayUnit],
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
    const gatewayLabel = serviceIdentifiers("launchd", "gateway")[0];
    const result = spawnSync(
      environment.LAUNCHCTL_BINARY || "launchctl",
      ["print", `gui/${uid}/${gatewayLabel}`],
      { stdio: "ignore", env: environment },
    );
    if (result.error) throw result.error;
    return result.status === 0;
  }
  return false;
}

function isManagedServiceRunning(target, environment) {
  if (environment.CODEX_CONNECT_SERVICE_ROLE === target) return true;
  const status = inspectManagedServiceStatus({ environment, target });
  return status.services.some((service) => service.running);
}

function metricsSocketIsActive(socketPath) {
  if (!existsSync(socketPath)) return false;
  const connectionSource = process.platform === "win32"
    ? `const { createPrivateIpcConnection } = await import(process.argv[2]);
const socket = createPrivateIpcConnection(process.argv[1]);`
    : `const { createConnection } = await import("node:net");
const socket = createConnection(process.argv[1]);`;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `${connectionSource}
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
      new URL("../runtime/private-ipc.mjs", import.meta.url).href,
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

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const command = process.argv[2];
    if (
      command === "status"
      && (
        process.argv.length === 3
        || (process.argv.length === 4 && process.argv[3] === "--json")
      )
    ) {
      printStatus(inspectMetricsDatabase(), { json: process.argv[3] === "--json" });
    } else if (command === "reset" && process.argv.length === 3) {
      const result = resetMetricsDatabase();
      if (!result.changed) {
        writeCliMessage("note", "指标数据库尚未创建，无需重置。");
        console.log(`数据库：${result.databasePath}`);
      } else {
        writeCliMessage("success", "指标数据库已归档并重置。");
        console.log(`数据库：${result.databasePath}`);
        console.log(`旧库备份：${result.backupPath}`);
        writeCliMessage("remediation", "启动 Gateway 后将自动创建当前 Schema。");
      }
    } else if (command === "prune" && process.argv.length === 4) {
      const provider = process.argv[3];
      const result = pruneProviderMetrics(provider);
      writeCliMessage("success", `已清理 ${result.provider} 请求指标：本地删除 ${result.local.deleted} 条。`);
      if (result.local.backupPath !== null) {
        console.log(`本地备份：${result.local.backupPath}`);
      }
      for (const warning of result.warnings) {
        writeCliMessage("note", `警告：${warning}`, { destination: "stderr" });
      }
      const restored = [];
      restored.push(result.gatewayWasRunning ? "Gateway 已恢复运行" : "Gateway 原为停止，保持停止");
      writeCliMessage("success", restored.join("；") + "。");
    } else if (command === "cleanup" || command === "cleanup-restart") {
      const options = parseCleanupOptions(process.argv.slice(3));
      const result = command === "cleanup-restart"
        ? cleanupMetricsDatabaseWithGatewayRestart(process.env, options)
        : cleanupMetricsDatabase(process.env, options);
      writeCliMessage("success", `已清理 ${result.deleted} 条指标，剩余 ${result.remaining} 条。`);
      console.log(`数据库：${result.databasePath}`);
      console.log(`备份：${result.backupPath}`);
      if (!result.vacuumed) {
        writeCliMessage("note", "未执行 VACUUM；空闲页会由 SQLite 后续复用。需要立即缩小文件时加 --vacuum。");
      }
    } else if (command === "report") {
      const options = parseMetricsOptions(
        process.argv.slice(3),
        new Set([...metricsQueryOptions, "--group", "--format"]),
      );
      const format = options.format ?? "markdown";
      assertExportFormat(format, ["markdown", "json", "csv"]);
      printMetricsReport(readMetricsReport(process.env, options), format);
    } else if (command === "export") {
      const options = parseMetricsOptions(
        process.argv.slice(3),
        new Set([...metricsQueryOptions, "--format"]),
      );
      const format = options.format ?? "json";
      assertExportFormat(format, ["json", "csv", "markdown"]);
      printMetricsExport(
        readMetricsExport(process.env, {
          ...options,
          ...(options.thread ? { threadId: options.thread } : {}),
        }),
        format,
      );
    } else if (command === "quota") {
      const options = parseMetricsOptions(process.argv.slice(3), new Set(["--range", "--from", "--to", "--format"]));
      const format = options.format ?? "markdown";
      assertExportFormat(format, ["markdown", "json", "csv"]);
      printQuotaHistory(readQuotaHistory(process.env, options), format);
    } else if (command === "run") {
      const options = parseMetricsRunArgs(process.argv.slice(3));
      printMetricsRun(readMetricsRun(process.env, options.threadId), options.format);
    } else if (command === "threads") {
      const options = parseMetricsThreadsArgs(process.argv.slice(3));
      printMetricsThreads(readMetricsThreads(process.env, options), options.format);
    } else if (command === "turns") {
      const options = parseMetricsTurnsArgs(process.argv.slice(3));
      printMetricsTurns(readMetricsTurns(process.env, options.threadId, options), options.format);
    } else {
      throw new Error(
        "用法：codexc metrics <status|run|threads|turns|report|export|quota|reset|cleanup|prune>",
      );
    }
  } catch (error) {
    if (
      !(error instanceof ReportedChildExitError)
      && !(error instanceof ForwardedChildSignalError)
    ) {
      writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    }
    if (error instanceof ReportedChildExitError) {
      process.exitCode = error.exitCode;
    } else if (!(error instanceof ForwardedChildSignalError)) {
      process.exitCode = 1;
    }
  }
}
