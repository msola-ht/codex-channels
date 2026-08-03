import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
} from "../dist/observability/index.js";
import {
  locateUserConfig,
  resolveConfiguredPath,
} from "./runtime-config.mjs";

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

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    console.log("处理：停止 Gateway 后运行 codexc metrics reset");
  }
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
    } else {
      throw new Error("用法：codexc metrics <status|reset>");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
