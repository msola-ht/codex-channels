import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  inspectScheduledTaskDatabaseFile,
  scheduledTaskDatabasePath,
} from "../dist/scheduled-tasks/index.js";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  requireUserConfig,
  resolveConfiguredPath,
} from "./runtime-config.mjs";

const currentSchemaVersion = 5;
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
    if (schemaVersion === currentSchemaVersion) {
      validateStateTables(database, Object.keys(requiredStateColumns));
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
