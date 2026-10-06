import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { securePrivateFileSync } from "../../runtime/private-file.mjs";

export const modelRequestMetricsSchemaVersion = 28;

export interface RequestMetricsDatabaseLock {
  release(): void;
}

export function requestMetricsDatabasePath(stateDatabasePath: string): string {
  return join(dirname(stateDatabasePath), "request-metrics.sqlite3");
}

export function acquireRequestMetricsDatabaseLock(
  databasePath: string,
): RequestMetricsDatabaseLock {
  const lockDatabasePath = `${databasePath}.lock.sqlite3`;
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(lockDatabasePath);
    securePrivateFileSync(lockDatabasePath);
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch (error) {
    database?.close();
    if (isSqliteLockError(error)) throw new ModelRequestMetricsDatabaseLockedError();
    throw error;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      closeLockDatabase(database);
    },
  };
}

function closeLockDatabase(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }
}

export class ModelRequestMetricsDatabaseLockedError extends Error {
  readonly code = "METRICS_DATABASE_LOCKED";

  constructor() {
    super("模型请求指标数据库正在使用；请先停止 Gateway");
    this.name = "ModelRequestMetricsDatabaseLockedError";
  }
}


function isSqliteLockError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "errcode" in error
    && (error.errcode === 5 || error.errcode === 6);
}
