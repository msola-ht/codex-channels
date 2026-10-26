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

export async function inspectThreadWriterLock(threadId, environment = process.env, procRoot = "/proc", options = {}) {
  if (options.signal?.aborted) return { held: true, holder: null, reason: "inspection-unavailable" };
  const lockPath = threadWriterLockPath(threadId, environment);
  if (!existsSync(lockPath)) {
    return { held: false };
  }
  if (process.platform === "win32") {
    return inspectWindowsThreadWriterLock(lockPath, environment, options);
  }
  if (process.platform !== "linux") {
    return { held: true, holder: null, reason: "unsupported-platform" };
  }
  try {
    readdirSync(procRoot);
  } catch {
    // /proc 不可读时无法确认锁是否仍被持有，不能误报未占用。
    return { held: true, holder: null, reason: "inspection-unavailable" };
  }
  const holders = threadWriterLockHolders(lockPath, procRoot);
  if (holders.length === 0) {
    return { held: false };
  }
  if (holders.length !== 1) return { held: true, holder: null, reason: "inspection-unavailable" };
  const pid = holders[0];
  const startedAt = processStartedAt(pid, procRoot);
  const command = processCommandLine(pid, procRoot);
  if (startedAt === undefined || processStartedAt(pid, procRoot) !== startedAt) {
    return { held: true, holder: null, reason: "inspection-unavailable" };
  }
  return {
    held: true,
    holder: {
      pid,
      command,
      startedAt,
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
  runner,
  signal,
  beforeTerminate,
} = {}) {
  if (signal?.aborted) return false;
  if (process.platform === "win32") {
    if (typeof startedAt !== "string" || !/^\d+$/u.test(startedAt)) return false;
    const response = await invokeWindowsThreadWriterLock({
      operation: "terminate",
      pid,
      startedAt,
      timeoutMs,
    }, environment, { runner, signal, timeoutMs, beforeSubmit: beforeTerminate });
    return response?.ok === true && response.exited === true;
  }
  if (process.platform !== "linux") return false;
  if (!isRunningProcess(pid)) {
    return true;
  }
  // Reject an already changed or unreadable identity immediately before the
  // numeric signal. /proc and kill still have a non-atomic PID-reuse window.
  beforeTerminate?.();
  if (typeof startedAt !== "string" || !/^\d+$/u.test(startedAt)
    || processStartedAt(pid) !== startedAt) return false;
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
    if (signal?.aborted) return false;
    if (processIdentityExited(pid, startedAt)) {
      return true;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return processIdentityExited(pid, startedAt);
}

function processIdentityExited(pid, startedAt) {
  if (!isRunningProcess(pid)) return true;
  const actual = processStartedAt(pid);
  return actual !== undefined && actual !== startedAt;
}

function processStartedAt(pid, procRoot = "/proc") {
  try {
    const stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
    // comm is parenthesized and may contain spaces or closing parentheses.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
    const startedAt = fields[19]; // field 22; fields starts at state (field 3).
    return typeof startedAt === "string" && /^\d+$/u.test(startedAt) ? startedAt : undefined;
  } catch { return undefined; }
}

async function inspectWindowsThreadWriterLock(lockPath, environment, options) {
  const response = await invokeWindowsThreadWriterLock({
    operation: "inspect",
    path: lockPath,
  }, environment, options);
  if (response?.ok !== true || !Array.isArray(response.holders)) {
    return { held: true, holder: null, reason: "inspection-unavailable" };
  }
  if (response.holders.length === 0) return { held: false };
  if (response.holders.length !== 1) return { held: true, holder: null, reason: "inspection-unavailable" };
  const [holder] = response.holders;
  if (
    !Number.isSafeInteger(holder?.pid)
    || holder.pid <= 0
    || typeof holder.startedAt !== "string"
    || !/^\d+$/u.test(holder.startedAt)
    || typeof holder.executable !== "string"
  ) {
    return { held: true, holder: null, reason: "inspection-unavailable" };
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

async function invokeWindowsThreadWriterLock(request, environment, { runner, signal, timeoutMs = 8_000, beforeSubmit } = {}) {
  if (!runner || signal?.aborted) return undefined;
  const deadline = Date.now() + timeoutMs;
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
  beforeSubmit?.();
  try {
    const result = await runner.run(invocation, {
      input: JSON.stringify({ ...request, deadline }),
      timeoutMs,
      environment,
      ...(signal ? { signal } : {}),
      maxOutputBytes: 1_048_576,
    });
    if (signal?.aborted || result.status !== 0) return undefined;
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
