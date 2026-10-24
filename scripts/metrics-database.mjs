import { spawnSync } from "node:child_process";
export { validateMetricsDatabaseStructure } from "./metrics-database-access.mjs";
import {
  constants,
  copyFileSync,
  existsSync,
  unlinkSync,
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
import { serviceCommandTarget } from "../runtime/service-targets.mjs";
import {
  acquireRequestMetricsDatabaseLock,
  requireCurrentModelRequestMetricsSchema,
} from "../dist/observability/index.js";
import {
  inspectMetricsDatabase,
  readQuotaHistory,
  readMetricsReport,
  readMetricsRun,
  readMetricsThreads,
  readMetricsTurns,
  requireCompatibleMetricsDatabase,
  resolveMetricsDatabaseContext,
  validateMetricsDatabaseStructure,
} from "./metrics-database-access.mjs";
import { inspectManagedServiceStatus } from "./service-status.mjs";
import { withCliLifecycleCancellation } from "./cli-lifecycle-command.mjs";
import { createMetricsExportOwner } from "./metrics-export-stream.mjs";
import { resolveConfiguredPath } from "./runtime-config.mjs";
import {
  assertExportFormat,
  isPrunableMetricsProviderId,
  metricsProviderIds,
  metricsQueryOptions,
  metricsRequestPurposeOption,
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
  printMetricsReport,
  printMetricsRun,
  printMetricsThreads,
  printMetricsTurns,
  printQuotaHistory,
  printStatus,
} from "./metrics-output-renderer.mjs";

export { metricsRange } from "./metrics-command-options.mjs";

export class MetricsMaintenanceError extends AggregateError {
  constructor(result, failures) {
    const state = result.committed === true ? "指标数据已提交"
      : result.committed === "unknown" ? "指标提交结果未确认" : "指标维护未改变数据";
    const phases = { commit: "提交", vacuum: "VACUUM", count: "读取剩余数量", close: "关闭数据库", "lock-release": "释放数据库锁", "gateway-restart": "恢复 Gateway" };
    super(failures.map(failure => failure.error),
      `${state}，但后续处理失败：${failures.map(failure => `${phases[failure.phase]}：${errorMessage(failure.error)}`).join("；")}；请先核对数据与备份，勿重复清理`);
    this.name = "MetricsMaintenanceError";
    this.result = result;
    this.failures = failures;
  }
}

function maintenanceFailure(result, error, phase) {
  return new MetricsMaintenanceError(result, [
    ...(error instanceof MetricsMaintenanceError ? error.failures : []),
    ...(phase === undefined ? [] : [{ phase, error }]),
  ]);
}

function withMetricsMaintenanceLock(databasePath, operation) {
  const lock = acquireRequestMetricsDatabaseLock(databasePath);
  let result;
  let failure;
  try {
    result = operation();
  } catch (error) {
    failure = error;
  }
  try {
    lock.release();
  } catch (error) {
    const outcome = result ?? (failure instanceof MetricsMaintenanceError ? failure.result : undefined);
    failure = outcome === undefined
      ? new AggregateError([...(failure === undefined ? [] : [failure]), error], "指标数据库锁释放失败")
      : new MetricsMaintenanceError(outcome, [
        ...(failure instanceof MetricsMaintenanceError ? failure.failures : []), { phase: "lock-release", error },
      ]);
  }
  if (failure !== undefined) throw failure;
  return result;
}

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
    throw new Error("Gateway 仍在运行；请先执行 codexc stop gateway，再重试");
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
  validateMetricsDatabaseStructure(environment);
  const lock = acquireRequestMetricsDatabaseLock(databasePath);
  try {
    const status = validateMetricsDatabaseStructure(environment);
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
    copyFileSync(status.databasePath, backupPath, constants.COPYFILE_EXCL);
    securePrivateFileSync(backupPath);
    unlinkSync(status.databasePath);
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
  // In-process callers can provide explicit state; the CLI queries the
  // managed service status before stopping anything.
  const gatewayWasRunning = options.gatewayRunning
    ?? (options.stopGateway !== undefined || options.startGateway !== undefined
      ? true
      : isManagedServiceRunning("gateway", environment));
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

  const outcome = result ?? (operationError instanceof MetricsMaintenanceError ? operationError.result : undefined);
  if (outcome !== undefined) {
    result = { ...outcome, gatewayWasRunning, gatewayRestored: !gatewayWasRunning || startFailures.length === 0, warnings: [] };
    if (operationError instanceof MetricsMaintenanceError) {
      operationError = maintenanceFailure(result, operationError);
    }
    if (startFailures.length > 0) {
      const failures = operationError instanceof MetricsMaintenanceError ? operationError.failures : [];
      throw new MetricsMaintenanceError(result, [...failures,
        { phase: "gateway-restart", error: new Error(startFailures.join("；") + "；请运行 codexc start gateway") },
      ]);
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
  return result;
}

export function cleanupMetricsDatabase(environment = process.env, options = {}) {
  const { runtime, keepDays, maxRows, beforeMs } = resolveCleanupPolicy(
    environment,
    options,
  );
  const gatewayRunning = options.gatewayRunning ?? (() => isGatewayRunning(environment));
  if (gatewayRunning() || runtime.metricsSocketPaths.some(metricsSocketIsActive)) {
    throw new Error(
      "Gateway 仍在运行；请先执行 codexc stop gateway，或使用 --restart-gateway 自动停止并重启",
    );
  }
  const databasePath = requireCompatibleMetricsDatabase(environment);
  return withMetricsMaintenanceLock(databasePath, () => {
    requireCompatibleDatabasePath(databasePath);
    return cleanupCompatibleMetricsDatabase(databasePath, { ...options, keepDays, maxRows, beforeMs });
  });
}

function cleanupCompatibleMetricsDatabase(databasePath, options) {
  const { keepDays, maxRows, beforeMs } = options;
  checkpoint(databasePath);
  const backupPath = `${databasePath}.cleanup-${backupTimestamp(new Date())}.bak`;
  copyFileSync(databasePath, backupPath, constants.COPYFILE_EXCL);
  securePrivateFileSync(backupPath);
  const database = new DatabaseSync(databasePath);
  let deletedByAge;
  let deletedByLimit;
  let result;
  let failure;
  let phase = "transaction";
  try {
    database.exec("BEGIN IMMEDIATE");
    deletedByAge = Number(database.prepare(`
      DELETE FROM model_request_metrics WHERE recorded_at_ms < ?
    `).run(Math.max(0, beforeMs)).changes);
    deletedByLimit = Number(database.prepare(`
      DELETE FROM model_request_metrics
      WHERE id <= (SELECT MAX(id) FROM model_request_metrics) - ?
    `).run(maxRows).changes);
    database.prepare(`UPDATE thread_execution_state SET history_complete = 0 WHERE thread_id IN (
      SELECT thread_id FROM turn_execution_metrics WHERE recorded_at_ms < ?
        OR rowid IN (SELECT rowid FROM turn_execution_metrics ORDER BY recorded_at_ms DESC, rowid DESC LIMIT -1 OFFSET ?)
    )`).run(Math.max(0, beforeMs), maxRows);
    database.prepare("DELETE FROM turn_execution_metrics WHERE recorded_at_ms < ?").run(Math.max(0, beforeMs));
    database.prepare(`DELETE FROM turn_execution_metrics WHERE rowid IN (
      SELECT rowid FROM turn_execution_metrics ORDER BY recorded_at_ms DESC, rowid DESC LIMIT -1 OFFSET ?
    )`).run(maxRows);
    database.exec("DELETE FROM thread_execution_state WHERE thread_id NOT IN (SELECT thread_id FROM turn_execution_metrics)");
    database.prepare(`UPDATE auto_approval_review_turns SET continuous = 0
      WHERE (thread_id, turn_id) IN (SELECT thread_id, turn_id FROM auto_approval_reviews
        WHERE recorded_at_ms < ? OR rowid IN (SELECT rowid FROM auto_approval_reviews
          ORDER BY recorded_at_ms DESC, rowid DESC LIMIT -1 OFFSET ?))
    `).run(Math.max(0, beforeMs), maxRows);
    for (const table of ["auto_approval_reviews", "auto_approval_review_turns"]) {
      database.prepare(`DELETE FROM ${table} WHERE recorded_at_ms < ?
        OR rowid IN (SELECT rowid FROM ${table} ORDER BY recorded_at_ms DESC, rowid DESC LIMIT -1 OFFSET ?)
      `).run(Math.max(0, beforeMs), maxRows);
    }
    database.exec(`DELETE FROM auto_approval_reviews WHERE (thread_id, turn_id) NOT IN (
      SELECT thread_id, turn_id FROM auto_approval_review_turns
    )`);
    result = {
      committed: "unknown",
      backupPath,
      databasePath,
      deleted: deletedByAge + deletedByLimit,
      deletedByAge,
      deletedByLimit,
      keepDays,
      maxRows,
      remaining: null,
      vacuumed: false,
    };
    phase = "commit";
    database.exec("COMMIT");
    result.committed = true;
    if (options.vacuum === true) {
      phase = "vacuum";
      database.exec("VACUUM");
      result.vacuumed = true;
    }
    phase = "count";
    result.remaining = Number(database.prepare(
      "SELECT COUNT(*) AS count FROM model_request_metrics",
    ).get().count);
  } catch (error) {
    if (result?.committed !== true) {
      try { database.exec("ROLLBACK"); result = undefined; } catch { /* 无法确认回滚时保留未知提交状态 */ }
    }
    failure = result === undefined ? error : maintenanceFailure(result, error, phase);
  }
  try { database.close(); } catch (error) {
    failure = result === undefined
      ? new AggregateError([...(failure === undefined ? [] : [failure]), error], "指标数据库关闭失败")
      : new MetricsMaintenanceError(result, [
        ...(failure instanceof MetricsMaintenanceError ? failure.failures : []), { phase: "close", error },
      ]);
  }
  if (failure !== undefined) throw failure;
  return result;
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
  let result;
  let operationError;
  try {
    stopGateway();
    result = cleanupMetricsDatabase(environment, options);
  } catch (error) { operationError = error; }
  try {
    startGateway();
  } catch (error) {
    const outcome = result ?? (operationError instanceof MetricsMaintenanceError ? operationError.result : undefined);
    if (outcome !== undefined) {
      throw new MetricsMaintenanceError({ ...outcome, gatewayRestored: false }, [
        ...(operationError instanceof MetricsMaintenanceError ? operationError.failures : []),
        { phase: "gateway-restart", error: new Error("Gateway 恢复失败；请运行 codexc start gateway", { cause: error }) },
      ]);
    }
    throw new AggregateError(operationError ? [operationError, error] : [error],
      "指标清理流程结束，但 Gateway 恢复失败；请运行 codexc start gateway", { cause: error });
  }
  if (operationError instanceof MetricsMaintenanceError) {
    throw maintenanceFailure({ ...operationError.result, gatewayRestored: true }, operationError);
  }
  if (operationError) throw operationError;
  return { ...result, gatewayRestored: true };
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
  if (!existsSync(localDatabasePath)) {
    return { provider, committed: false, local: { databasePath: localDatabasePath, backupPath: null, deleted: 0, vacuumed: false } };
  }
  requireCompatibleDatabasePath(localDatabasePath);
  return withMetricsMaintenanceLock(localDatabasePath, () => {
    requireCompatibleDatabasePath(localDatabasePath);
    return pruneCompatibleProviderDatabase({ provider, localDatabasePath, allowVacuumLocal });
  });
}

function requireCompatibleDatabasePath(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    requireCurrentModelRequestMetricsSchema(database);
  } finally {
    database.close();
  }
}

function pruneCompatibleProviderDatabase({ provider, localDatabasePath, allowVacuumLocal }) {
  const localBackupPath = backupMetricsDatabase(localDatabasePath, provider);
  const result = {
    provider,
    committed: false,
    local: {
      databasePath: localDatabasePath,
      backupPath: localBackupPath,
      deleted: 0,
      vacuumed: false,
    },
  };
  return deleteProviderRows(localDatabasePath, provider, allowVacuumLocal, result);
}

function backupMetricsDatabase(databasePath, provider) {
  if (!existsSync(databasePath)) return null;
  try {
    checkpoint(databasePath);
  } catch (error) {
    throw new Error(`备份指标数据库失败：${errorMessage(error)}`, { cause: error });
  }
  const backupPath = `${databasePath}.${provider}-prune-${backupTimestamp(new Date())}.bak`;
  copyFileSync(databasePath, backupPath, constants.COPYFILE_EXCL);
  securePrivateFileSync(backupPath);
  return backupPath;
}

function deleteProviderRows(databasePath, provider, allowVacuum, result) {
  const database = new DatabaseSync(databasePath);
  let failure;
  let phase = "transaction";
  try {
    database.exec("PRAGMA busy_timeout = 10000;");
    database.exec("BEGIN IMMEDIATE");
    database.prepare(`DELETE FROM auto_approval_reviews WHERE (thread_id, turn_id) IN (
        SELECT thread_id, turn_id FROM auto_approval_review_turns WHERE provider = ?
      )`).run(provider);
    database.prepare("DELETE FROM auto_approval_review_turns WHERE provider = ?").run(provider);
    database.prepare(`DELETE FROM turn_execution_metrics WHERE thread_id IN (
        SELECT thread_id FROM thread_execution_state WHERE provider = ?
      )`).run(provider);
    database.prepare("DELETE FROM thread_execution_state WHERE provider = ?").run(provider);
    const info = database.prepare(
      "DELETE FROM model_request_metrics WHERE provider = ?",
    ).run(provider);
    result.local.deleted = Number(info.changes);
    result.committed = "unknown";
    phase = "commit";
    database.exec("COMMIT");
    result.committed = true;
    if (allowVacuum) {
      phase = "vacuum";
      database.exec("VACUUM");
      result.local.vacuumed = true;
    }
  } catch (error) {
    if (result.committed !== true) {
      try { database.exec("ROLLBACK"); result.committed = false; } catch { /* 无法确认回滚时保留未知提交状态 */ }
    }
    failure = result.committed ? maintenanceFailure(result, error, phase) : error;
  }
  try { database.close(); } catch (error) {
    failure = result.committed
      ? new MetricsMaintenanceError(result, [
        ...(failure instanceof MetricsMaintenanceError ? failure.failures : []), { phase: "close", error },
      ])
      : new AggregateError([...(failure === undefined ? [] : [failure]), error], "指标数据库关闭失败");
  }
  if (failure !== undefined) throw failure;
  return result;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function assertPruneProvider(provider) {
  if (!isPrunableMetricsProviderId(provider)) {
    throw new Error("用法：codexc cleanup metrics prune <provider>");
  }
}

function runGatewayServiceAction(action, environment) {
  const cli = resolve(import.meta.dirname, "../bin/codexc.mjs");
  const result = spawnSync(
    process.execPath,
    [cli, action, "gateway"],
    { env: environment, stdio: "inherit" },
  );
  assertSynchronousChildSuccess(result, { failureReportedByChild: true });
}

function runServiceAction(target, action, environment) {
  const cli = resolve(import.meta.dirname, "../bin/codexc.mjs");
  const result = spawnSync(
    process.execPath,
    [cli, action, serviceCommandTarget(target)],
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
  return isManagedServiceRunning("gateway", environment);
}

function isManagedServiceRunning(target, environment) {
  if (environment.CODEX_CONNECT_SERVICE_ROLE === target) return true;
  const status = inspectManagedServiceStatus({ environment: {
    ...environment, CODEX_CONNECT_HOME: resolveMetricsDatabaseContext(environment).dataDir,
  }, target });
  const service = status.services.find(entry => entry.target === target);
  if (!service || (!service.running && !["inactive", "inactive/dead", "not-found", "missing", "not-loaded", "stopped", "disabled", "ready"].includes(service.state))) {
    throw new Error("无法确认 Gateway 服务状态；为保护指标数据库，已拒绝维护");
  }
  return service.running;
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

function printMaintenanceResult(result, failed = false) {
  const kind = failed ? "note" : "success";
  const unknown = result.committed === "unknown";
  const state = unknown ? "指标提交结果未确认；" : result.committed ? "指标数据已提交；" : "";
  if ("provider" in result) {
    writeCliMessage(kind, `${state}${result.provider} 请求指标：本地${unknown ? "拟删除" : "删除"} ${result.local.deleted} 条。`);
    console.log(`数据库：${result.local.databasePath}`);
    if (result.local.backupPath !== null) console.log(`本地备份：${result.local.backupPath}`);
    console.log(`VACUUM：${result.local.vacuumed ? "已完成" : "未完成或未执行"}`);
    for (const warning of result.warnings ?? []) {
      writeCliMessage("note", `警告：${warning}`, { destination: "stderr" });
    }
    if (result.gatewayRestored !== false) {
      writeCliMessage(kind, result.gatewayWasRunning ? "Gateway 已恢复运行。" : "Gateway 原为停止，保持停止。");
    }
  } else {
    const remaining = result.remaining === null ? "剩余数量未能读取" : `剩余 ${result.remaining} 条`;
    writeCliMessage(kind, `${state}${unknown ? "拟清理" : "已清理"} ${result.deleted} 条指标，${remaining}。`);
    console.log(`数据库：${result.databasePath}`);
    console.log(`备份：${result.backupPath}`);
    console.log(`VACUUM：${result.vacuumed ? "已完成" : "未完成或未执行"}`);
    if (!failed && !result.vacuumed) {
      writeCliMessage("note", "未执行 VACUUM；空闲页会由 SQLite 后续复用。需要立即缩小文件时加 --vacuum。");
    }
    if (result.gatewayRestored === true) writeCliMessage(kind, "Gateway 已恢复运行。");
  }
  if (result.gatewayRestored === false) writeCliMessage("failure", "Gateway 恢复失败；请运行 codexc start gateway。");
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await withCliLifecycleCancellation("指标命令", async signal => {
      signal.throwIfAborted();
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
        printMaintenanceResult(result);
      } else if (command === "cleanup" || command === "cleanup-restart") {
        const options = parseCleanupOptions(process.argv.slice(3));
        const result = command === "cleanup-restart"
          ? cleanupMetricsDatabaseWithGatewayRestart(process.env, options)
          : cleanupMetricsDatabase(process.env, options);
        printMaintenanceResult(result);
      } else if (command === "report") {
        const options = parseMetricsOptions(
          process.argv.slice(3),
          new Set([...metricsQueryOptions, metricsRequestPurposeOption, "--group", "--format"]),
        );
        const format = options.format ?? "markdown";
        assertExportFormat(format, ["markdown", "json", "csv"]);
        printMetricsReport(readMetricsReport(process.env, options), format);
      } else if (command === "export") {
        const options = parseMetricsOptions(
          process.argv.slice(3),
          new Set([...metricsQueryOptions, metricsRequestPurposeOption, "--format"]),
        );
        const format = options.format ?? "json";
        assertExportFormat(format, ["json", "csv", "markdown"]);
        const exports = createMetricsExportOwner();
        try {
          await exports.stream(process.env, {
            ...options,
            ...(options.thread ? { threadId: options.thread } : {}),
          }, { format, output: process.stdout, signal });
        } finally {
          await exports.close();
        }
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
          "查询：codexc metrics <status|run|threads|turns|report|export|quota>；维护：codexc cleanup metrics [prune|reset]",
        );
      }
    });
  } catch (error) {
    if (error instanceof MetricsMaintenanceError) printMaintenanceResult(error.result, true);
    if (
      !(error instanceof ReportedChildExitError)
      && !(error instanceof ForwardedChildSignalError)
    ) {
      writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    }
    if (error instanceof ReportedChildExitError) {
      process.exitCode = error.exitCode;
    } else if (error instanceof ForwardedChildSignalError) {
      process.exitCode = error.signal === "SIGINT" ? 130 : error.signal === "SIGTERM" ? 143 : 1;
    } else {
      process.exitCode = error?.exitCode ?? 1;
    }
  }
}
