import { mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";

const defaultTimeoutMs = 2_000;
const staleLockMs = 30_000;

export async function withPrivateFileLock(
  targetPath,
  operation,
  { label = "私有文件", timeoutMs = defaultTimeoutMs } = {},
) {
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  const lockPath = `${targetPath}.lock`;
  const lock = await acquirePrivateFileLock(lockPath, label, timeoutMs);
  let result;
  let operationFailed = false;
  let operationError;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  let releaseError;
  try {
    await lock.handle.close();
  } catch (error) {
    releaseError = error;
  }
  try {
    const current = statSync(lockPath);
    if (current.dev === lock.dev && current.ino === lock.ino) unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT" && releaseError === undefined) releaseError = error;
  }
  if (operationFailed) throw operationError;
  if (releaseError !== undefined) throw releaseError;
  return result;
}

async function acquirePrivateFileLock(lockPath, label, timeoutMs) {
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
        const metadata = await handle.stat();
        return { handle, dev: metadata.dev, ino: metadata.ino };
      } catch (error) {
        await handle.close().catch(() => undefined);
        try {
          unlinkSync(lockPath);
        } catch (unlinkError) {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        }
        throw error;
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (stalePrivateFileLock(lockPath)) {
        try {
          unlinkSync(lockPath);
          continue;
        } catch (unlinkError) {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        }
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`${label}正在由其他进程修改，请稍后重试`, { cause: error });
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
}

function stalePrivateFileLock(lockPath) {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs <= staleLockMs) return false;
    const ownerPid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    return !Number.isSafeInteger(ownerPid) || ownerPid <= 0 || !processIsAlive(ownerPid);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
