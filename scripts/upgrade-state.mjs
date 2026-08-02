import { chmodSync, copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  requireUserConfig,
  resolveConfiguredPath,
} from "./runtime-config.mjs";

const currentSchemaVersion = 4;
const supportedPreviousSchemaVersion = 3;

export function upgradeStateDatabase(environment = process.env) {
  const { configPath, dataDir } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const storage = isRecord(document.storage) ? document.storage : {};
  const databasePath = resolveConfiguredPath(
    typeof storage.database_path === "string" ? storage.database_path : undefined,
    dataDir,
    "data/gateway.sqlite3",
  );
  if (!existsSync(databasePath)) {
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

function backupTimestamp() {
  return new Date().toISOString().replaceAll(/[:.]/gu, "-");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const result = upgradeStateDatabase();
    if (!result.changed) {
      console.log(`状态数据库已是 Schema ${result.version}：${result.databasePath}`);
    } else {
      console.log(`状态数据库已升级到 Schema ${result.version}：${result.databasePath}`);
      console.log(`升级前备份：${result.backupPath}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
