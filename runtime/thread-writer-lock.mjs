import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { codexHomePath } from "./codex-home.mjs";
import { resolveExecutableInvocation } from "./executable.mjs";

const redactedArgument = "[已脱敏]";
const sensitiveArgumentNamePattern = /(?:authorization|cookie|api[-_]?key|apikey|bearer[-_]?token|token|secret|password|header)/iu;

export function threadWriterLockPath(threadId, environment = process.env) {
  return join(codexHomePath(environment), "thread-writer-locks", `${threadId}.lock`);
}

export function inspectThreadWriterLock(threadId, environment = process.env, procRoot = "/proc") {
  const lockPath = threadWriterLockPath(threadId, environment);
  if (!existsSync(lockPath)) {
    return { held: false };
  }
  if (process.platform === "win32") {
    return inspectWindowsThreadWriterLock(lockPath, environment);
  }
  if (process.platform !== "linux") {
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
    const argumentsList = readFileSync(join(procRoot, String(pid), "cmdline"), "utf8")
      .split("\0")
      .filter(Boolean);
    return redactProcessArguments(argumentsList).join(" ");
  } catch {
    return "";
  }
}

export async function terminateThreadWriterHolder(pid, {
  timeoutMs = 8_000,
  startedAt,
  environment = process.env,
} = {}) {
  if (process.platform === "win32") {
    if (typeof startedAt !== "string" || !/^\d+$/u.test(startedAt)) return false;
    const response = invokeWindowsThreadWriterLock({
      operation: "terminate",
      pid,
      startedAt,
      timeoutMs,
    }, environment);
    return response?.ok === true && response.exited === true;
  }
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

function inspectWindowsThreadWriterLock(lockPath, environment) {
  const response = invokeWindowsThreadWriterLock({
    operation: "inspect",
    path: lockPath,
  }, environment);
  if (response?.ok !== true || !Array.isArray(response.holders)) {
    return { held: true, holder: null };
  }
  if (response.holders.length === 0) return { held: false };
  if (response.holders.length !== 1) return { held: true, holder: null };
  const [holder] = response.holders;
  if (
    !Number.isSafeInteger(holder?.pid)
    || holder.pid <= 0
    || typeof holder.startedAt !== "string"
    || !/^\d+$/u.test(holder.startedAt)
    || typeof holder.executable !== "string"
  ) {
    return { held: true, holder: null };
  }
  return {
    held: true,
    holder: {
      pid: holder.pid,
      command: holder.executable,
      executable: holder.executable,
      startedAt: holder.startedAt,
    },
  };
}

function invokeWindowsThreadWriterLock(request, environment) {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    "windows-thread-writer-lock.ps1",
  );
  let invocation;
  try {
    invocation = resolveExecutableInvocation(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
      ],
      environment,
    );
  } catch {
    return undefined;
  }
  const result = spawnSync(invocation.file, invocation.args, {
    input: JSON.stringify(request),
    encoding: "utf8",
    maxBuffer: 1_048_576,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error || result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return undefined;
  }
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

function redactProcessArguments(argumentsList) {
  let redactNext = false;
  return argumentsList.map((argument) => {
    if (redactNext) {
      redactNext = false;
      return redactedArgument;
    }
    const separatorIndex = argument.search(/[=:]/u);
    const name = separatorIndex < 0 ? argument : argument.slice(0, separatorIndex);
    if (!sensitiveArgumentNamePattern.test(name)) return argument;
    if (separatorIndex >= 0) {
      return `${argument.slice(0, separatorIndex)}${argument[separatorIndex]}${redactedArgument}`;
    }
    if (argument.startsWith("-")) {
      redactNext = true;
      return argument;
    }
    return redactedArgument;
  });
}
