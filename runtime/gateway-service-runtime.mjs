import { spawn } from "node:child_process";

import {
  installProcessSignalHandlers,
  signalChildProcesses,
} from "./process-lifecycle.mjs";

const nodeExperimentalWarningOption = "--disable-warning=ExperimentalWarning";

export async function runGatewayService(
  runtime,
  gatewayEntryPath,
  waitForAppServerReadiness,
) {
  if (runtime.environment.CODEX_CONNECT_SERVICE_ROLE === "gateway") {
    await waitForAppServerReadiness(
      "app-server",
      runtime.environment,
      { stableMs: 0 },
    );
  }
  const child = spawn(process.execPath, [
    nodeExperimentalWarningOption,
    gatewayEntryPath,
  ], {
    stdio: "inherit",
    env: runtime.environment,
    cwd: runtime.dataDir,
  });
  const forwardSignal = (signal) => signalChildProcesses([child], signal);
  const forwardReload = () => forwardSignal("SIGHUP");
  const forwardTerminate = () => forwardSignal("SIGTERM");
  const forwardInterrupt = () => forwardSignal("SIGINT");
  const cleanup = installProcessSignalHandlers({
    SIGHUP: forwardReload,
    SIGTERM: forwardTerminate,
    SIGINT: forwardInterrupt,
  });
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
}
