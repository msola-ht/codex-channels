import { existsSync, closeSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { securePrivateFileSync } from "../runtime/private-file.mjs";
import { GatewayOwner } from "../runtime/gateway-owner.mjs";
import { DatabaseSync } from "node:sqlite";
import { stateDatabaseSchemaVersion as currentSchemaVersion } from "../dist/storage/index.js";

import {
  inspectScheduledTaskDatabaseFile,
  scheduledTaskDatabasePath,
} from "../dist/scheduled-tasks/index.js";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  requireUserConfig,
  resolveConfiguredPath,
} from "./runtime-config.mjs";

const preferenceColumns = ["surface", "account_id", "conversation_id", "model", "model_provider", "effort", "service_tier"];
const requiredStateColumns = Object.freeze({
  conversation_actors: ["surface", "account_id", "conversation_id", "actor_id", "created_at"],
  conversation_background_bindings: [
    "surface", "account_id", "conversation_id", "workspace_id", "thread_id", "session_id", "updated_at",
  ],
  conversation_bindings: [
    "surface", "account_id", "conversation_id", "workspace_id", "thread_id", "session_id", "updated_at",
  ],
  conversation_workspaces: [
    "surface", "account_id", "conversation_id", "workspace_id", "updated_at",
  ],
  conversation_idle_state: [
    "surface", "account_id", "conversation_id", "last_activity_at", "force_new",
  ],
});
export function inspectStateDatabase(environment = process.env) {
  const { databasePath } = resolveStateDatabaseContext(environment);
  const scheduledTasks = inspectScheduledTaskDatabaseFile(scheduledTaskDatabasePath(databasePath));
  if (!existsSync(databasePath)) {
    return {
      compatible: true,
      databasePath,
      exists: false,
      schemaVersion: null,
      targetSchemaVersion: currentSchemaVersion,
      scheduledTasks,
    };
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare("PRAGMA user_version").get();
    const schemaVersion = Number(row?.user_version);
    if (schemaVersion === currentSchemaVersion || schemaVersion === 5) {
      validateStateTables(database, Object.keys(requiredStateColumns));
      if (schemaVersion === currentSchemaVersion) validatePreferenceTable(database);
    }
    return {
      compatible: schemaVersion === currentSchemaVersion,
      databasePath,
      exists: true,
      schemaVersion,
      targetSchemaVersion: currentSchemaVersion,
      scheduledTasks,
    };
  } finally {
    database.close();
  }
}

export function validateStateDatabaseStructure(environment = process.env) {
  const status = inspectStateDatabase(environment);
  if (status.exists && !status.compatible) {
    throw new Error(
      `状态数据库 Schema ${status.schemaVersion ?? "unknown"} 不兼容，需要 ${currentSchemaVersion}`,
    );
  }
  if (status.scheduledTasks?.exists && !status.scheduledTasks.compatible) {
    throw new Error(
      `计划任务数据库 Schema ${status.scheduledTasks.schemaVersion ?? "unknown"} 不兼容，需要 ${status.scheduledTasks.targetSchemaVersion}`,
    );
  }
  return status;
}

function resolveStateDatabaseContext(environment) {
  const { configPath, dataDir } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const storage = isRecord(document.storage) ? document.storage : {};
  return {
    databasePath: resolveConfiguredPath(
      typeof storage.database_path === "string" ? storage.database_path : undefined,
      dataDir,
      "data/gateway.sqlite3",
    ),
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateStateTables(database, tables) {
  for (const table of tables) {
    const columns = new Set(
      database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name),
    );
    const missing = requiredStateColumns[table].filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new Error(`状态数据库结构不完整：${table} 缺少 ${missing.join("、")}`);
    }
  }
}

export function inspectStateDatabaseUpgrade(environment = process.env) {
  const status = inspectStateDatabase(environment);
  if (status.exists && !status.compatible && status.schemaVersion !== 5) {
    throw new Error(`状态数据库 Schema ${status.schemaVersion ?? "unknown"} 不兼容，需要 ${currentSchemaVersion}；仅支持 v5 → v6 升级`);
  }
  if (status.scheduledTasks?.exists && !status.scheduledTasks.compatible) {
    throw new Error(`计划任务数据库 Schema ${status.scheduledTasks.schemaVersion ?? "unknown"} 不兼容，需要 ${status.scheduledTasks.targetSchemaVersion}`);
  }
  return status;
}

export async function upgradeStateDatabase(environment = process.env) {
  const status = inspectStateDatabaseUpgrade(environment);
  if (!status.exists || status.compatible) return;
  const { configPath } = requireUserConfig(environment);
  const owner = new GatewayOwner(configPath);
  try {
    await owner.start();
  } catch (error) {
    throw new Error("升级状态数据库前必须停止 Gateway，且独占锁必须可用", { cause: error });
  }
  let database;
  try {
    database = new DatabaseSync(status.databasePath);
  } catch (error) {
    await owner.close();
    throw error;
  }
  let backupPath;
  let transaction = false;
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    if (version !== 5) throw new Error("状态数据库版本在预检后发生变化，请重新运行升级");
    validateStateTables(database, Object.keys(requiredStateColumns));
    backupPath = `${status.databasePath}.v5-backup-${randomUUID()}`;
    closeSync(openSync(backupPath, "wx", 0o600));
    securePrivateFileSync(backupPath);
    database.prepare("VACUUM INTO ?").run(backupPath);
    database.exec("BEGIN IMMEDIATE");
    transaction = true;
    database.exec(`CREATE TABLE conversation_model_preferences (
      surface TEXT NOT NULL CHECK (length(surface) > 0),
      account_id TEXT NOT NULL CHECK (length(account_id) > 0),
      conversation_id TEXT NOT NULL,
      model TEXT NOT NULL CHECK (length(model) > 0),
      model_provider TEXT NOT NULL CHECK (length(model_provider) > 0),
      effort TEXT,
      service_tier TEXT,
      PRIMARY KEY (surface, account_id, conversation_id)
    ) STRICT`);
    validatePreferenceTable(database);
    if (database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
      throw new Error("状态数据库完整性检查失败");
    }
    database.exec("PRAGMA user_version = 6; COMMIT");
    transaction = false;
  } catch (error) {
    if (transaction) database.exec("ROLLBACK");
    throw new Error(`状态数据库升级失败，未启动服务。${backupPath ? `备份位置：${backupPath}。` : ""}保留原库并修复后重试；回退须同时恢复 v5 数据库和旧源码。`, { cause: error });
  } finally {
    try { database.close(); } finally { await owner.close(); }
  }
  validateStateDatabaseStructure(environment);
}

function validatePreferenceTable(database) {
  const columns = new Set(database.prepare("PRAGMA table_info(conversation_model_preferences)").all().map(column => column.name));
  const missing = preferenceColumns.filter(column => !columns.has(column));
  if (missing.length) throw new Error(`状态数据库结构不完整：conversation_model_preferences 缺少 ${missing.join("、")}`);
}
