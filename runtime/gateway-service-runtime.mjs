import { spawn } from "node:child_process";

import {
  installProcessSignalHandlers,
  installServiceControlHandler,
  createChildServiceControl,
  signalChildProcesses,
} from "./process-lifecycle.mjs";

const nodeExperimentalWarningOption = "--disable-warning=ExperimentalWarning";

export async function runGatewayService(
  runtime,
  gatewayEntryPath,
  waitForAppServerReadiness,
) {
  let child;
  let childControl;
  const waitingForChild = new Set();
  const startup = new AbortController();
  const waitForChild = (deadline, signal) => new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      startup.signal.removeEventListener("abort", finish);
      waitingForChild.delete(finish);
      resolve(Boolean(child) && !signal?.aborted && !startup.signal.aborted && Date.now() < deadline);
    };
    const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
    waitingForChild.add(finish);
    signal?.addEventListener("abort", finish, { once: true });
    startup.signal.addEventListener("abort", finish, { once: true });
    if (child || signal?.aborted || startup.signal.aborted) finish();
  });
  const send = async (type, { deadline = Date.now() + 5_000, signal } = {}) => {
    if (type === "codexc-stop") startup.abort();
    if (!child) {
      if (type === "codexc-stop") return true;
      if (!(await waitForChild(deadline, signal))) return false;
    }
    if (type === "codexc-reload" && (startup.signal.aborted || signal?.aborted || Date.now() >= deadline)) return false;
    if (process.platform !== "win32") {
      signalChildProcesses([child], type === "codexc-stop" ? "SIGTERM" : "SIGHUP");
      return true;
    }
    const sent = await childControl.send(type, { deadline, signal });
    if (!sent && type === "codexc-stop" && child.exitCode === null && child.signalCode === null) {
      signalChildProcesses([child], "SIGTERM");
    }
    return sent;
  };
  const cleanupControl = installServiceControlHandler(message => send(message.type, message));
  const requestSignal = (type) => {
    void send(type).then(sent => {
      if (!sent && type === "codexc-reload" && !startup.signal.aborted) console.error("Gateway 重新加载结果未确认");
    }).catch(() => { console.error("Gateway 服务控制失败"); process.exitCode = 1; });
  };
  const cleanupSignals = installProcessSignalHandlers({
    SIGHUP: () => requestSignal("codexc-reload"),
    SIGTERM: () => requestSignal("codexc-stop"),
    SIGINT: () => requestSignal("codexc-stop"),
  });
  const cleanup = () => {
    cleanupSignals();
    cleanupControl();
    childControl?.close();
    for (const finish of waitingForChild) finish();
  };
  try {
    if (runtime.environment.CODEX_CONNECT_SERVICE_ROLE === "gateway") {
      await waitForAppServerReadiness(
        "app-server",
        runtime.environment,
        { stableMs: 0, signal: startup.signal },
      );
    }
    if (startup.signal.aborted) { cleanup(); return; }
    child = spawn(process.execPath, [
      nodeExperimentalWarningOption,
      gatewayEntryPath,
    ], {
      stdio: process.platform === "win32"
        ? ["inherit", "inherit", "inherit", "ipc"]
        : "inherit",
      env: runtime.unresolvedProxyEnvironment,
      cwd: runtime.dataDir,
    });
    childControl = createChildServiceControl(child);
    for (const finish of waitingForChild) finish();
    child.once("error", (error) => {
      cleanup();
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = code ?? 1;
    });
  } catch (error) {
    cleanup();
    if (!startup.signal.aborted) throw error;
  }
}
