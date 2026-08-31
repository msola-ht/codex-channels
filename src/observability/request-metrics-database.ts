import {
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { securePrivateFileSync } from "../../runtime/private-file.mjs";

export const modelRequestMetricsSchemaVersion = 11;
const incompleteLockGraceMs = 30_000;

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
  try {
    removeStaleLegacyLock(databasePath);
  } catch (error) {
    closeLockDatabase(database);
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

function removeStaleLegacyLock(databasePath: string): void {
  const lockPath = `${databasePath}.lock`;
  if (!existsSync(lockPath)) return;
  const owner = readLegacyLockOwner(lockPath);
  if (owner !== null && legacyLockOwnerIsActive(owner.pid, lockPath)) {
    throw new ModelRequestMetricsDatabaseLockedError();
  }
  if (owner === null && !incompleteLockIsStale(lockPath)) {
    throw new ModelRequestMetricsDatabaseLockedError();
  }
  unlinkIfPresent(lockPath);
}

function legacyLockOwnerIsActive(pid: number, lockPath: string): boolean {
  return processIsAlive(pid) && !lockPredatesCurrentLinuxBoot(lockPath);
}

function lockPredatesCurrentLinuxBoot(lockPath: string): boolean {
  if (process.platform !== "linux") return false;
  try {
    const bootTimeMatch = /^btime\s+(\d+)$/mu.exec(readFileSync("/proc/stat", "utf8"));
    if (!bootTimeMatch) return false;
    const bootTimeMs = Number(bootTimeMatch[1]) * 1_000;
    return Number.isSafeInteger(bootTimeMs) && statSync(lockPath).mtimeMs < bootTimeMs;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    return false;
  }
}

function incompleteLockIsStale(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs >= incompleteLockGraceMs;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    throw error;
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

export class ModelRequestMetricsDatabaseLockedError extends Error {
  readonly code = "METRICS_DATABASE_LOCKED";

  constructor() {
    super("模型请求指标数据库正在使用；请先停止 Gateway");
    this.name = "ModelRequestMetricsDatabaseLockedError";
  }
}

interface LegacyLockOwner {
  pid: number;
  token: string;
}

function readLegacyLockOwner(lockPath: string): LegacyLockOwner | null {
  if (!existsSync(lockPath)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    return Number.isSafeInteger(record.pid)
      && Number(record.pid) > 0
      && typeof record.token === "string"
      && record.token.length > 0
      ? { pid: Number(record.pid), token: record.token }
      : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

function isSqliteLockError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "errcode" in error
    && (error.errcode === 5 || error.errcode === 6);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}
