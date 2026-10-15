import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  assertStateDatabaseSchema,
  stateDatabaseSchemaVersion as currentSchemaVersion,
} from "../dist/storage/index.js";

export { assertStateDatabaseSchema };

import {
  inspectScheduledTaskDatabaseFile,
  scheduledTaskDatabasePath,
} from "../dist/scheduled-tasks/index.js";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  requireUserConfig,
  resolveConfiguredPath,
} from "./runtime-config.mjs";

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
    if (schemaVersion === 0 || schemaVersion === currentSchemaVersion) {
      assertStateDatabaseSchema(database, { allowEmpty: true });
    }
    return {
      compatible: schemaVersion === 0 || schemaVersion === currentSchemaVersion,
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
