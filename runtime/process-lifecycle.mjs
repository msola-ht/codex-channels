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

export function signalChildProcessGroup(child, signal) {
  if (!childProcessIsRunning(child)) return;
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code === "ESRCH") return;
    }
  }
  child.kill(signal);
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
