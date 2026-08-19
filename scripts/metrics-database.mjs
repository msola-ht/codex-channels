import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { writeCliMessage } from "../runtime/cli-presentation.mjs";
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
  modelRequestMetricsSchemaVersion,
} from "../dist/observability/index.js";
import { resolveMetricsCenterSettings } from "./metrics-center-settings.mjs";
import {
  inspectMetricsDatabase,
  metricsDatabaseCanUpgrade,
  readMetricsExport,
  readMetricsReport,
  readMetricsRun,
  readMetricsThreads,
  readMetricsTurns,
  requireCompatibleMetricsDatabase,
  resolveMetricsDatabaseContext,
} from "./metrics-database-access.mjs";
import { resolveConfiguredPath } from "./runtime-config.mjs";
import {
  assertExportFormat,
  isMetricsProviderId,
  metricsProviderIds,
  metricsProviderUsage,
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
  loadDisplayContext,
} from "./metrics-export-format.mjs";
import {
  printMetricsExport,
  printMetricsReport,
  printMetricsRun,
  printMetricsThreads,
  printMetricsTurns,
  printStatus,
} from "./metrics-output-renderer.mjs";

export { metricsRange } from "./metrics-command-options.mjs";
export {
  inspectMetricsDatabase,
  readMetricsExport,
  readMetricsReport,
  readMetricsRun,
  readMetricsThreads,
  readMetricsTurns,
  readWeeklyQuota,
  validateMetricsDatabaseStructure,
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
    if (!metricsDatabaseCanUpgrade(status.schemaVersion)) {
      throw new Error(
        `指标数据库无法升级：当前 Schema ${status.schemaVersion ?? "unknown"}，`
        + `仅支持 v3/v4/v5/v6/v7/v8 升级到 v${modelRequestMetricsSchemaVersion}`,
      );
    }
    checkpoint(status.databasePath);
    const now = options.now ?? (() => new Date());
    const previousSchemaVersion = status.schemaVersion;
    const backupPath = `${status.databasePath}.v${previousSchemaVersion}.${backupTimestamp(now())}.bak`;
    if (existsSync(backupPath)) throw new Error(`指标数据库备份已存在：${backupPath}`);
    copyFileSync(status.databasePath, backupPath);
    chmodSync(backupPath, 0o600);
    const database = new DatabaseSync(status.databasePath);
    try {
      const statements = ["BEGIN IMMEDIATE;"];
      if (previousSchemaVersion === 3) {
        statements.push(`
          ALTER TABLE model_request_metrics ADD COLUMN weekly_quota_limit_id TEXT
            CHECK (weekly_quota_limit_id IS NULL OR weekly_quota_limit_id = 'codex');
          ALTER TABLE model_request_metrics ADD COLUMN weekly_used_percent_millionths INTEGER
            CHECK (weekly_used_percent_millionths IS NULL
              OR weekly_used_percent_millionths BETWEEN 0 AND 100000000);
          ALTER TABLE model_request_metrics ADD COLUMN weekly_resets_at INTEGER
            CHECK (weekly_resets_at IS NULL OR weekly_resets_at >= 0);
        `);
      }
      if (previousSchemaVersion < 5) {
        statements.push(`
          ALTER TABLE model_request_metrics ADD COLUMN weekly_quota_plan_type TEXT;
        `);
      }
      if (previousSchemaVersion < 6) {
        statements.push(`
          ALTER TABLE model_request_metrics ADD COLUMN error_message TEXT;
        `);
      }
      if (previousSchemaVersion < 8) {
        statements.push(`
          ALTER TABLE model_request_metrics ADD COLUMN pricing_bucket TEXT
            CHECK (pricing_bucket IS NULL OR pricing_bucket IN ('peak', 'off-peak'));
        `);
      }
      if (previousSchemaVersion < 9) {
        statements.push(`
          ALTER TABLE model_request_metrics ADD COLUMN quota_windows TEXT;
        `);
      }
      statements.push(`
        CREATE TABLE IF NOT EXISTS subagent_threads (
          thread_id TEXT PRIMARY KEY,
          parent_thread_id TEXT NOT NULL,
          agent_path TEXT NOT NULL,
          recorded_at_ms INTEGER NOT NULL
        );
      `);
      statements.push(`
        UPDATE schema_metadata SET value = ${modelRequestMetricsSchemaVersion}
          WHERE name = 'schema_version';
        COMMIT;
      `);
      database.exec(statements.join("\n"));
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
      previousSchemaVersion,
      schemaVersion: modelRequestMetricsSchemaVersion,
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

export function resetMetricsSyncState(environment = process.env, options = {}) {
  const runtime = resolveMetricsRuntime(environment);
  const gatewayRunning = options.gatewayRunning ?? (() => isGatewayRunning(environment));
  if (
    gatewayRunning()
    || runtime.metricsSocketPaths.some(metricsSocketIsActive)
  ) {
    throw new Error(
      "Gateway 仍在运行；请先执行 codexc service stop gateway，或使用 --restart-gateway 自动停止并重启",
    );
  }
  const statePath = metricsSyncStatePath(environment);
  if (!existsSync(statePath)) {
    return { backupPath: null, changed: false, statePath };
  }
  let deviceId;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    deviceId = parsed.deviceId;
  } catch {
    deviceId = undefined;
  }
  if (typeof deviceId !== "string" || deviceId.length === 0) {
    throw new Error(`指标同步状态文件缺少有效 deviceId：${statePath}`);
  }
  const backupPath = `${statePath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(statePath, backupPath);
  chmodSync(backupPath, 0o600);
  const next = {
    version: 1,
    deviceId,
    lastRequestLocalId: 0,
    lastSubagentRecordedAtMs: 0,
    lastSubagentThreadId: null,
  };
  const temporaryPath = `${statePath}.tmp`;
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, statePath);
  } catch (error) {
    try {
      renameSync(temporaryPath, `${temporaryPath}.failed-${Date.now()}`);
    } catch {
      // 保留原始异常
    }
    throw error;
  }
  return { backupPath, changed: true, statePath, deviceId };
}

export function resetMetricsSyncStateWithGatewayRestart(
  environment = process.env,
  options = {},
) {
  const stopGateway = options.stopGateway
    ?? (() => runGatewayServiceAction("stop", environment));
  const startGateway = options.startGateway
    ?? (() => runGatewayServiceAction("start", environment));
  const reset = options.reset
    ?? (() => resetMetricsSyncState(environment));
  let stopError;
  try {
    stopGateway();
  } catch (error) {
    stopError = error;
  }
  let result;
  let resetError;
  try {
    result = reset();
  } catch (error) {
    resetError = error;
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
      "重置同步水位前停止 Gateway 失败，且 Gateway 未能重新启动",
    );
  }
  if (stopError) throw stopError;
  if (resetError && startError) {
    throw new AggregateError(
      [resetError, startError],
      "重置同步水位失败，且 Gateway 未能重新启动",
    );
  }
  if (resetError) throw resetError;
  if (startError) throw startError;
  return result;
}

export function pruneProviderMetrics(provider, environment = process.env, options = {}) {
  assertPruneProvider(provider, environment);
  const localDatabasePath = options.localDatabasePath
    ?? resolveMetricsRuntime(environment).databasePath;
  const centerSettings = options.centerSettings
    ?? resolveMetricsCenterSettings({ environment });
  const configuredCenterPath = options.centerDatabasePath
    ?? centerSettings.databasePath;
  const centerDatabasePath = typeof configuredCenterPath === "string"
    && existsSync(configuredCenterPath)
    ? configuredCenterPath
    : null;
  const centerConfigured = centerDatabasePath !== null;
  const stopGateway = options.stopGateway
    ?? (() => runServiceAction("gateway", "stop", environment));
  const startGateway = options.startGateway
    ?? (() => runServiceAction("gateway", "start", environment));
  const stopCenter = options.stopCenter
    ?? (() => runServiceAction("center", "stop", environment));
  const startCenter = options.startCenter
    ?? (() => runServiceAction("center", "start", environment));

  const warnings = [];
  let gatewayStopped = false;
  let centerStopped = false;
  try {
    stopGateway();
    gatewayStopped = true;
  } catch (error) {
    warnings.push(`停止 Gateway 失败：${errorMessage(error)}`);
  }
  if (centerConfigured) {
    try {
      stopCenter();
      centerStopped = true;
    } catch (error) {
      warnings.push(`停止中心服务失败：${errorMessage(error)}`);
    }
  }

  let result;
  let operationError;
  try {
    result = pruneProviderDatabases({
      provider,
      localDatabasePath,
      centerDatabasePath,
      allowVacuumLocal: gatewayStopped,
      allowVacuumCenter: centerStopped,
    });
  } catch (error) {
    operationError = error;
  }

  const startFailures = [];
  if (centerConfigured) {
    try {
      startCenter();
    } catch (error) {
      startFailures.push(`中心服务启动失败：${errorMessage(error)}`);
    }
  }
  try {
    startGateway();
  } catch (error) {
    startFailures.push(`Gateway 启动失败：${errorMessage(error)}`);
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
  chmodSync(backupPath, 0o600);
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

function pruneProviderDatabases({
  provider,
  localDatabasePath,
  centerDatabasePath,
  allowVacuumLocal,
  allowVacuumCenter,
}) {
  const localBackupPath = backupMetricsDatabase(localDatabasePath, provider);
  const localDeleted = deleteProviderRows(
    localDatabasePath,
    "model_request_metrics",
    provider,
    allowVacuumLocal,
  );
  if (centerDatabasePath === null) {
    return {
      provider,
      local: {
        databasePath: localDatabasePath,
        backupPath: localBackupPath,
        deleted: localDeleted,
      },
      center: { skipped: true },
    };
  }
  const centerBackupPath = backupMetricsDatabase(centerDatabasePath, provider);
  const centerDeleted = deleteProviderRows(
    centerDatabasePath,
    "request_metrics",
    provider,
    allowVacuumCenter,
  );
  return {
    provider,
    local: {
      databasePath: localDatabasePath,
      backupPath: localBackupPath,
      deleted: localDeleted,
    },
    center: {
      databasePath: centerDatabasePath,
      backupPath: centerBackupPath,
      deleted: centerDeleted,
      skipped: false,
    },
  };
}

function backupMetricsDatabase(databasePath, provider) {
  if (!existsSync(databasePath)) return null;
  try {
    checkpoint(databasePath);
  } catch {
    // 服务未能完全停止时跳过备份，仍继续尝试删除（带 busy_timeout）。
    return null;
  }
  const backupPath = `${databasePath}.${provider}-prune-${backupTimestamp(new Date())}.bak`;
  copyFileSync(databasePath, backupPath);
  chmodSync(backupPath, 0o600);
  return backupPath;
}

function deleteProviderRows(databasePath, table, provider, allowVacuum) {
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

function assertPruneProvider(provider, environment = process.env) {
  if (!isMetricsProviderId(provider, environment)) {
    throw new Error(`用法：codexc metrics prune <${metricsProviderUsage}>`);
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

function metricsSyncStatePath(environment) {
  const runtime = resolveMetricsRuntime(environment);
  return join(dirname(runtime.databasePath), "metrics-sync-state.json");
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
        writeCliMessage("note", "指标数据库尚未创建，无需重置。");
        console.log(`数据库：${result.databasePath}`);
      } else {
        writeCliMessage("success", "指标数据库已归档并重置。");
        console.log(`数据库：${result.databasePath}`);
        console.log(`旧库备份：${result.backupPath}`);
        writeCliMessage("remediation", "启动 Gateway 后将自动创建当前 Schema。");
      }
    } else if (command === "upgrade" && process.argv.length === 3) {
      const result = upgradeMetricsDatabase();
      if (!result.changed) {
        writeCliMessage("note", result.schemaVersion === null
          ? "指标数据库尚未创建，无需升级。"
          : `指标数据库已经是 Schema v${result.schemaVersion}。`);
        if (result.schemaVersion === null) console.log(`数据库：${result.databasePath}`);
      } else {
        writeCliMessage("success", `指标数据库已升级到 Schema v${result.schemaVersion}。`);
        console.log(`数据库：${result.databasePath}`);
        console.log(`升级前备份：${result.backupPath}`);
      }
    } else if (command === "upgrade-restart" && process.argv.length === 3) {
      const result = upgradeMetricsDatabaseWithGatewayRestart();
      if (!result.changed) {
        writeCliMessage("note", result.schemaVersion === null
          ? "指标数据库尚未创建，无需升级。"
          : `指标数据库已经是 Schema v${result.schemaVersion}。`);
        if (result.schemaVersion === null) console.log(`数据库：${result.databasePath}`);
      } else {
        writeCliMessage("success", `指标数据库已升级到 Schema v${result.schemaVersion}。`);
        console.log(`数据库：${result.databasePath}`);
        console.log(`升级前备份：${result.backupPath}`);
      }
      writeCliMessage("success", "Gateway 已重新启动。");
    } else if (command === "sync-reset" && process.argv.length === 3) {
      const result = resetMetricsSyncState();
      if (!result.changed) {
        writeCliMessage("note", "指标同步状态尚未创建，无需重置。");
        console.log(`同步状态：${result.statePath}`);
      } else {
        writeCliMessage("success", `已重置指标同步水位（保留设备 ${result.deviceId}）。`);
        console.log(`同步状态：${result.statePath}`);
        console.log(`重置前备份：${result.backupPath}`);
        writeCliMessage("remediation", "重启 Gateway 后将从第一条记录重新上报（中心按主键覆盖修复历史）。");
      }
    } else if (command === "sync-reset-restart" && process.argv.length === 3) {
      const result = resetMetricsSyncStateWithGatewayRestart();
      if (!result.changed) {
        writeCliMessage("note", "指标同步状态尚未创建，无需重置。");
        console.log(`同步状态：${result.statePath}`);
      } else {
        writeCliMessage("success", `已重置指标同步水位（保留设备 ${result.deviceId}）。`);
        console.log(`同步状态：${result.statePath}`);
        console.log(`重置前备份：${result.backupPath}`);
      }
      writeCliMessage("success", "Gateway 已重新启动，将从第一条记录重新上报。");
    } else if (command === "prune" && process.argv.length === 4) {
      const provider = process.argv[3];
      const result = pruneProviderMetrics(provider);
      writeCliMessage("success", `已清理 ${result.provider} 请求指标：本地删除 ${result.local.deleted} 条。`);
      if (result.center.skipped) {
        writeCliMessage("note", "中心库未配置或不存在，已跳过。");
      } else {
        console.log(`中心删除 ${result.center.deleted} 条`);
      }
      if (result.local.backupPath !== null) {
        console.log(`本地备份：${result.local.backupPath}`);
      }
      if (!result.center.skipped && result.center.backupPath !== null) {
        console.log(`中心备份：${result.center.backupPath}`);
      }
      for (const warning of result.warnings) {
        writeCliMessage("note", `警告：${warning}`, { destination: "stderr" });
      }
      if (result.center.skipped) {
        writeCliMessage("success", "Gateway 已重新启动。");
      } else {
        writeCliMessage("success", "Gateway 与中心服务已重新启动。");
      }
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
        new Set(["--range", "--from", "--to", "--group", "--format"]),
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
        new Set(["--range", "--from", "--to", "--format", "--thread"]),
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
