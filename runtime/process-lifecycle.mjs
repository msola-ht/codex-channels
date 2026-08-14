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
