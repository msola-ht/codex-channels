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
    if (childProcessIsRunning(child)) child.kill(signal);
  }
}

export async function terminateChildProcess(child, {
  gracePeriodMs = 5_000,
  forcePeriodMs = 1_000,
} = {}) {
  if (!childProcessIsRunning(child)) return;
  child.kill("SIGTERM");
  if (await childExitedWithin(child, gracePeriodMs)) return;
  if (childProcessIsRunning(child)) child.kill("SIGKILL");
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
