import { chmodSync, copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import {
  requireUserConfig,
  resolveConfiguredPath,
} from "./runtime-config.mjs";

const currentSchemaVersion = 4;
const supportedPreviousSchemaVersion = 3;
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
});

export function inspectStateDatabase(environment = process.env) {
  const { databasePath } = resolveStateDatabaseContext(environment);
  if (!existsSync(databasePath)) {
    return {
      compatible: true,
      databasePath,
      exists: false,
      schemaVersion: null,
      targetSchemaVersion: currentSchemaVersion,
      updateable: true,
    };
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare("PRAGMA user_version").get();
    const schemaVersion = Number(row?.user_version);
    if (schemaVersion === currentSchemaVersion) {
      validateStateTables(database, Object.keys(requiredStateColumns));
    } else if (schemaVersion === supportedPreviousSchemaVersion) {
      validateStateTables(
        database,
        Object.keys(requiredStateColumns).filter((table) =>
          table !== "conversation_background_bindings"
        ),
      );
    }
    return {
      compatible: schemaVersion === currentSchemaVersion,
      databasePath,
      exists: true,
      schemaVersion,
      targetSchemaVersion: currentSchemaVersion,
      updateable: schemaVersion === currentSchemaVersion
        || schemaVersion === supportedPreviousSchemaVersion,
    };
  } finally {
    database.close();
  }
}

export function validateStateDatabaseStructure(environment = process.env) {
  const status = inspectStateDatabase(environment);
  if (!status.exists) return status;
  if (!status.compatible) {
    throw new Error(
      `状态数据库 Schema ${status.schemaVersion ?? "unknown"} 尚未更新到 ${currentSchemaVersion}`,
    );
  }
  return status;
}

export function upgradeStateDatabase(environment = process.env, options = {}) {
  const { databasePath } = resolveStateDatabaseContext(environment);
  if (!existsSync(databasePath)) {
    if (options.allowMissing === true) {
      return { changed: false, databasePath, version: null };
    }
    throw new Error("状态数据库尚未创建，请先启动一次 Gateway");
  }

  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 1000; PRAGMA journal_mode = DELETE;");
    const row = database.prepare("PRAGMA user_version").get();
    const version = Number(row?.user_version);
    if (version === currentSchemaVersion) {
      return { changed: false, databasePath, version };
    }
    if (version !== supportedPreviousSchemaVersion) {
      throw new Error(
        `状态数据库版本不支持升级：当前 ${version}，只支持 ${supportedPreviousSchemaVersion} → ${currentSchemaVersion}`,
      );
    }

    const backupPath = `${databasePath}.v${version}.${backupTimestamp()}.bak`;
    database.exec("BEGIN EXCLUSIVE");
    try {
      copyFileSync(databasePath, backupPath);
      chmodSync(backupPath, 0o600);
      database.exec(`
        CREATE TABLE conversation_background_bindings (
          surface TEXT NOT NULL CHECK (length(surface) > 0),
          account_id TEXT NOT NULL CHECK (length(account_id) > 0),
          conversation_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          thread_id TEXT NOT NULL PRIMARY KEY,
          session_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        PRAGMA user_version = ${currentSchemaVersion};
        COMMIT;
      `);
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // COMMIT 失败后 SQLite 可能已经自动回滚。
      }
      throw error;
    }
    return { changed: true, backupPath, databasePath, version: currentSchemaVersion };
  } finally {
    database.close();
  }
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

function backupTimestamp() {
  return new Date().toISOString().replaceAll(/[:.]/gu, "-");
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

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const result = upgradeStateDatabase();
    if (!result.changed) {
      writeCliMessage("note", `状态数据库已是 Schema ${result.version}。`);
      console.log(`数据库：${result.databasePath}`);
    } else {
      writeCliMessage("success", `状态数据库已升级到 Schema ${result.version}。`);
      console.log(`数据库：${result.databasePath}`);
      console.log(`升级前备份：${result.backupPath}`);
    }
  } catch (error) {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
