import { spawnSync } from "node:child_process";
import { join } from "node:path";

export class ReportedChildExitError extends Error {
  constructor(exitCode, message = `子命令执行失败：exit=${exitCode}`) {
    super(message);
    this.exitCode = exitCode;
  }
}

export class ForwardedChildSignalError extends Error {
  constructor(signal) {
    super(`子命令被信号终止：${signal}`);
    this.signal = signal;
  }
}

export function assertSynchronousChildSuccess(result, {
  failureMessage = (exitCode) => `子命令执行失败：exit=${exitCode}`,
  failureReportedByChild = false,
  signalTarget = process,
} = {}) {
  if (result.error) throw result.error;
  if (result.signal) {
    signalTarget.kill(signalTarget.pid, result.signal);
    throw new ForwardedChildSignalError(result.signal);
  }
  if (result.status !== 0) {
    const exitCode = result.status ?? 1;
    if (failureReportedByChild) {
      throw new ReportedChildExitError(exitCode, failureMessage(exitCode));
    }
    throw new Error(failureMessage(exitCode));
  }
}

export function childProcessIsRunning(child) {
  return child !== undefined
    && child.exitCode === null
    && child.signalCode === null;
}

export function signalChildProcesses(children, signal) {
  for (const child of children) {
    if (!childProcessIsRunning(child)) continue;
    if (process.platform === "win32" && windowsTreeTerminationSignal(signal)) {
      const force = signal === "SIGKILL";
      const signaled = signalWindowsProcessTree(child, force);
      if (!signaled && !force && childProcessIsRunning(child)) {
        signalWindowsProcessTree(child, true);
      }
      continue;
    }
    child.kill(signal);
  }
}

export async function terminateChildProcess(child, {
  gracePeriodMs = 5_000,
  forcePeriodMs = 1_000,
} = {}) {
  if (!childProcessIsRunning(child)) return;
  if (process.platform === "win32") {
    const signaled = signalWindowsProcessTree(child, false);
    if (!signaled && childProcessIsRunning(child)) {
      signalWindowsProcessTree(child, true);
      if (await childExitedWithin(child, forcePeriodMs)) return;
      throw new Error("子进程在强制终止后仍未退出");
    }
  } else {
    child.kill("SIGTERM");
  }
  if (await childExitedWithin(child, gracePeriodMs)) return;
  if (childProcessIsRunning(child)) {
    if (process.platform === "win32") {
      signalWindowsProcessTree(child, true);
    } else {
      child.kill("SIGKILL");
    }
  }
  if (await childExitedWithin(child, forcePeriodMs)) return;
  throw new Error("子进程在强制终止后仍未退出");
}

export function installProcessSignalHandlers(handlers, source = process) {
  const entries = Object.entries(handlers).filter((entry) =>
    typeof entry[1] === "function");
  for (const [signal, handler] of entries) source.on(signal, handler);
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    for (const [signal, handler] of entries) source.off(signal, handler);
  };
}

function childExitedWithin(child, timeoutMs) {
  if (!childProcessIsRunning(child)) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    let timer;
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off("exit", onExit);
      resolveWait(exited);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    if (!childProcessIsRunning(child)) {
      finish(true);
      return;
    }
    timer = setTimeout(() => finish(!childProcessIsRunning(child)), timeoutMs);
  });
}

function windowsTreeTerminationSignal(signal) {
  return signal === "SIGINT" || signal === "SIGTERM" || signal === "SIGKILL";
}

function signalWindowsProcessTree(child, force) {
  if (child.pid === undefined) {
    return child.kill(force ? "SIGKILL" : "SIGTERM");
  }
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  if (!systemRoot) {
    throw new Error("Windows 进程树终止需要 SystemRoot");
  }
  const result = spawnSync(
    join(systemRoot, "System32", "taskkill.exe"),
    ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])],
    { stdio: "ignore", windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && !windowsProcessExists(child.pid)) {
    return true;
  }
  if (force && result.status !== 0 && childProcessIsRunning(child)) {
    throw new Error(`Windows 子进程树终止失败：pid=${child.pid} exit=${result.status ?? 1}`);
  }
  return result.status === 0;
}

function windowsProcessExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}
