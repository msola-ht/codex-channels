import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  inspectPrivateDirectoryAccessSync,
  readPrivateFileSync,
  securePrivateDirectorySync,
  securePrivateFileSync,
} from "./private-file.mjs";

const lockTimeoutMs = 2_000;
const staleLockMs = 30_000;
const lockVersion = 1;
const lockOwnerPattern = /^owner-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;

export class PrivateDirectoryLockBusyError extends Error {
  constructor() {
    super("资源正被其他进程使用，或锁所有者无法确认；请稍后重试并核对锁状态");
    this.name = "PrivateDirectoryLockBusyError";
  }
}

export class PrivateDirectoryLockReleaseError extends Error {
  constructor(result, cause) {
    super("同步操作已完成，但私有目录锁释放失败", { cause });
    this.name = "PrivateDirectoryLockReleaseError";
    Object.defineProperty(this, "result", { value: result });
  }
}

export function withPrivateDirectoryLockSync(lockPath, operation) {
  const lock = acquireLock(lockPath);
  let result;
  let operationFailed = false;
  let operationError;
  try {
    result = operation();
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => undefined);
      throw new TypeError("私有目录锁只接受同步操作");
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  let releaseError;
  try {
    if (!removeLock(lockPath, lock)) {
      throw new Error("私有目录锁的所有权已变化，未删除其他锁；请核对锁状态");
    }
  } catch (error) {
    releaseError = error;
  }
  if (operationFailed) throw operationError;
  if (releaseError !== undefined) throw new PrivateDirectoryLockReleaseError(result, releaseError);
  return result;
}

function acquireLock(lockPath) {
  const startedAt = performance.now();
  while (true) {
    let created = false;
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (created) return initializeLock(lockPath);
    const lock = inspectLock(lockPath);
    if (lock && Date.now() - lock.modifiedAt > staleLockMs && ownerIsProvenDead(lock.owner.pid)) {
      if (removeLock(lockPath, lock)) continue;
    }
    if (performance.now() - startedAt >= lockTimeoutMs) throw new PrivateDirectoryLockBusyError();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

function initializeLock(lockPath) {
  // Protect the newly owned directory before writing owner metadata, including on Windows.
  securePrivateDirectorySync(lockPath);
  const identity = inspectPrivateDirectoryAccessSync(lockPath);
  const owner = { version: lockVersion, pid: process.pid, id: randomUUID() };
  const markerName = `owner-${owner.id}.json`;
  const markerPath = join(lockPath, markerName);
  const temporaryPath = `${lockPath}.${owner.id}.tmp`;
  const expected = { ...identity, owner, markerName };
  let temporaryCreated = false;
  try {
    // Publish a complete marker atomically. Other acquirers may see an empty lock,
    // but must never mistake a partially written owner record for corrupt data.
    writeFileSync(temporaryPath, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
    temporaryCreated = true;
    securePrivateFileSync(temporaryPath);
    const current = inspectPrivateDirectoryAccessSync(lockPath);
    if (current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error("私有目录锁在创建期间发生变化");
    }
    renameSync(temporaryPath, markerPath);
    temporaryCreated = false;
    const lock = inspectLock(lockPath);
    if (!sameLock(lock, expected)) throw new Error("私有目录锁在创建期间发生变化");
    return lock;
  } catch (error) {
    if (temporaryCreated) {
      try { unlinkSync(temporaryPath); } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") {
          const failure = new Error("私有目录锁初始化及临时所有者文件清理失败；请核对锁状态", { cause: error });
          Object.defineProperty(failure, "cleanupError", { value: cleanupError });
          throw failure;
        }
      }
    }
    // Unknown or incomplete ownership remains for explicit inspection; never remove an empty lock.
    try { removeLock(lockPath, expected); } catch { /* Preserve the acquisition error. */ }
    throw error;
  }
}

function inspectLock(lockPath) {
  try {
    const identity = inspectPrivateDirectoryAccessSync(lockPath);
    const entries = readdirSync(lockPath);
    // Acquisition and release briefly leave no marker. Wait without reclaiming it.
    if (entries.length === 0) return undefined;
    const match = entries.length === 1 ? lockOwnerPattern.exec(entries[0]) : undefined;
    if (!match) throw new Error("私有目录锁所有者标记无效；请人工核对，不会自动清理");
    const markerName = entries[0];
    const markerPath = join(lockPath, markerName);
    const before = lstatSync(markerPath);
    if (!before.isFile() || before.nlink !== 1) throw new Error("私有目录锁所有者标记类型无效");
    let owner;
    try { owner = JSON.parse(readPrivateFileSync(markerPath, 256)); } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw new Error("私有目录锁所有者标记无法安全读取", { cause: error });
    }
    if (!owner || typeof owner !== "object" || Array.isArray(owner)
      || Object.keys(owner).length !== 3 || owner.version !== lockVersion
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2_147_483_647
      || owner.id !== match[1]) {
      throw new Error("私有目录锁所有者格式无效；请人工核对，不会自动清理");
    }
    const after = lstatSync(markerPath);
    const current = inspectPrivateDirectoryAccessSync(lockPath);
    const currentEntries = readdirSync(lockPath);
    if (current.dev !== identity.dev || current.ino !== identity.ino
      || before.dev !== after.dev || before.ino !== after.ino || after.nlink !== 1
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || currentEntries.length !== 1 || currentEntries[0] !== markerName) {
      return undefined;
    }
    return { ...identity, owner, markerName, modifiedAt: after.mtimeMs };
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function sameLock(current, expected) {
  return current !== undefined && current.dev === expected.dev && current.ino === expected.ino
    && current.markerName === expected.markerName
    && current.owner.id === expected.owner.id && current.owner.pid === expected.owner.pid;
}

function removeLock(lockPath, expected) {
  let descriptor;
  try {
    if (process.platform !== "win32") {
      // Pin the Unix directory inode until removal finishes so a replacement cannot
      // immediately reuse its identity after the marker has been unlinked.
      descriptor = openSync(lockPath, constants.O_RDONLY | constants.O_NONBLOCK
        | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0));
      const opened = fstatSync(descriptor);
      if (opened.dev !== expected.dev || opened.ino !== expected.ino) return false;
    }
    if (!sameLock(inspectLock(lockPath), expected)) return false;
    // The unique marker identifies the owner even if the directory is replaced.
    unlinkSync(join(lockPath, expected.markerName));
    // Only the successful marker remover may remove the directory. A losing reclaimer
    // must never rmdir a successor's directory while its marker is being initialized.
    const current = inspectPrivateDirectoryAccessSync(lockPath);
    if (current.dev !== expected.dev || current.ino !== expected.ino) return false;
    rmdirSync(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function ownerIsProvenDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}
