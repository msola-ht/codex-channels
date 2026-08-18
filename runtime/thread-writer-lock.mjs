import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import { codexHomePath } from "./codex-home.mjs";

export function threadWriterLockPath(threadId, environment = process.env) {
  return join(codexHomePath(environment), "thread-writer-locks", `${threadId}.lock`);
}

export function inspectThreadWriterLock(threadId, environment = process.env, procRoot = "/proc") {
  const lockPath = threadWriterLockPath(threadId, environment);
  if (!existsSync(lockPath)) {
    return { held: false };
  }
  if (process.platform !== "linux") {
    // 非 Linux 平台没有 /proc，无法可靠识别持锁进程。
    return { held: true, holder: null };
  }
  try {
    readdirSync(procRoot);
  } catch {
    // /proc 不可读时无法确认锁是否仍被持有，不能误报未占用。
    return { held: true, holder: null };
  }
  const holders = threadWriterLockHolders(lockPath, procRoot);
  if (holders.length === 0) {
    return { held: false };
  }
  const pid = holders[0];
  return {
    held: true,
    holder: {
      pid,
      command: processCommandLine(pid, procRoot),
    },
  };
}

export function threadWriterLockHolders(lockPath, procRoot = "/proc") {
  const holders = [];
  let processEntries;
  try {
    processEntries = readdirSync(procRoot);
  } catch {
    return holders;
  }
  for (const entry of processEntries) {
    if (!/^\d+$/u.test(entry)) {
      continue;
    }
    const descriptorDirectory = join(procRoot, entry, "fd");
    let descriptors;
    try {
      descriptors = readdirSync(descriptorDirectory);
    } catch {
      continue;
    }
    for (const descriptor of descriptors) {
      try {
        if (readlinkSync(join(descriptorDirectory, descriptor)) === lockPath) {
          holders.push(Number(entry));
          break;
        }
      } catch {
        // 描述符可能在读取时关闭，跳过即可。
      }
    }
  }
  return holders;
}

export function processCommandLine(pid, procRoot = "/proc") {
  try {
    return readFileSync(join(procRoot, String(pid), "cmdline"), "utf8")
      .split("\0")
      .filter(Boolean)
      .join(" ");
  } catch {
    return "";
  }
}

export async function terminateThreadWriterHolder(pid, { timeoutMs = 8_000 } = {}) {
  if (!isRunningProcess(pid)) {
    return true;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ([
      "ESRCH",
      "ERR_INVALID_ARG_VALUE",
      "ERR_INVALID_ARG_TYPE",
      "ERR_OUT_OF_RANGE",
    ].includes(error?.code)) {
      return true;
    }
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunningProcess(pid)) {
      return true;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return !isRunningProcess(pid);
}

function isRunningProcess(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !["ESRCH", "ERR_INVALID_ARG_VALUE", "ERR_INVALID_ARG_TYPE", "ERR_OUT_OF_RANGE"]
      .includes(error?.code);
  }
}
