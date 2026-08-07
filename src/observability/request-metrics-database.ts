import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const modelRequestMetricsSchemaVersion = 6;
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
  const lockPath = `${databasePath}.lock`;
  const token = randomUUID();
  const temporaryLockPath = `${lockPath}.${process.pid}.${token}.tmp`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryLockPath, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token })}\n`);
      fsyncSync(descriptor);
      linkSync(temporaryLockPath, lockPath);
      unlinkSync(temporaryLockPath);
      const ownedDescriptor = descriptor;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          closeSync(ownedDescriptor);
          const owner = readLockOwner(lockPath);
          if (owner?.token === token) unlinkSync(lockPath);
        },
      };
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        unlinkIfPresent(temporaryLockPath);
      }
      if (!isNodeError(error, "EEXIST") || !existsSync(lockPath)) throw error;
      const owner = readLockOwner(lockPath);
      if (owner !== null && !processIsAlive(owner.pid)) {
        unlinkIfPresent(lockPath);
        continue;
      }
      if (owner === null && incompleteLockIsStale(lockPath)) {
        unlinkIfPresent(lockPath);
        continue;
      }
      throw new ModelRequestMetricsDatabaseLockedError();
    }
  }
  throw new Error("无法清理模型请求指标数据库的失效锁");
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

interface LockOwner {
  pid: number;
  token: string;
}

function readLockOwner(lockPath: string): LockOwner | null {
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

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}
