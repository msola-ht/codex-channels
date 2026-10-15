import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ReportedChildExitError } from "../runtime/process-lifecycle.mjs";
import { inspectManagedServiceStatusAsync } from "./service-status.mjs";
import { serviceControlEnvironment } from "./runtime-environment.mjs";
import { serviceCommandTarget } from "../runtime/service-targets.mjs";
import { runCliLifecycleCommand } from "./cli-lifecycle-command.mjs";
import { withCliProgress } from "./cli-operation-progress.mjs";

export const runMaintenanceCommand = runCliLifecycleCommand;

function commandTarget(target) {
  return serviceCommandTarget(target === "relay" ? "model-relay" : target);
}

export async function maintenanceServiceRunning(target) {
  const status = await inspectManagedServiceStatusAsync({ target: target === "relay" ? "model-relay" : target,
    environment: serviceControlEnvironment() });
  const service = status.services.find(entry => entry.target === (target === "relay" ? "model-relay" : target));
  if (!service || (!service.running && !["inactive", "inactive/dead", "not-found", "missing", "not-loaded", "stopped", "disabled", "ready"].includes(service.state))) {
    throw new Error(`无法确认 ${target} 服务状态，已取消维护`);
  }
  return service.running;
}

async function runMaintenanceService(action, target) {
  // A service step must settle even if the launcher is interrupted. In
  // particular, restoration cannot share the terminal's foreground group.
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning",
    fileURLToPath(new URL("../bin/codexc.mjs", import.meta.url)), action, commandTarget(target)], {
    stdio: "inherit", detached: true, windowsHide: true,
  });
  let failure;
  const result = await new Promise(resolve => {
    child.once("error", error => { failure = error; });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (failure) throw failure;
  if (result.signal) throw new Error(`${target} 服务${action === "stop" ? "停止" : "恢复"}结果未确认：${result.signal}`);
  if (result.code !== 0) throw new ReportedChildExitError(result.code ?? 1);
}

export async function runMaintenanceServices({ prompts, targets, run,
  isRunning = maintenanceServiceRunning,
  runService = runMaintenanceService,
}) {
  const controller = new AbortController();
  const cancel = signal => controller.abort(Object.assign(new Error("维护已取消"), {
    name: "AbortError", exitCode: signal === "SIGINT" ? 130 : 143,
  }));
  const interrupt = () => cancel("SIGINT");
  const terminate = () => cancel("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const running = [];
  const attempted = [];
  let result;
  let operationError;
  try {
    try {
      // Read every state before stopping any service.
      await withCliProgress("检查维护前服务状态", async progress => {
        for (const target of targets) {
          controller.signal.throwIfAborted();
          progress.message(`检查 ${target} 服务状态`);
          if (await isRunning(target)) running.push(target);
        }
      }, { signal: controller.signal, handleSignals: false, output: process.stderr, delayMs: 250 });
      controller.signal.throwIfAborted();
      if (running.length > 0) {
        const accepted = await prompts.confirm({
          message: `需要临时停止 ${running.join("、")}，相关请求将中断；完成、取消或失败后按原状态恢复。继续？`,
          initialValue: false,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        if (prompts.isCancel(accepted) || accepted !== true) { prompts.cancel("已取消"); return; }
      }
      for (const target of running) {
        controller.signal.throwIfAborted();
        attempted.push(target);
        await runService("stop", target);
      }
      controller.signal.throwIfAborted();
      // The command owns its cancellation and must settle before this promise
      // rejects; restoring writers while maintenance is still running is unsafe.
      result = await run({ signal: controller.signal });
      controller.signal.throwIfAborted();
    } catch (error) { operationError = error; }
    // Signal listeners remain installed throughout restoration. Repeated
    // cancellation must not interrupt the remaining recovery steps.
    const failures = [];
    const failedTargets = [];
    for (const target of attempted.reverse()) {
      try { await runService("start", target); }
      catch (error) { failures.push(error); failedTargets.push(target); }
    }
    if (failures.length) throw Object.assign(new AggregateError(
      [...(operationError ? [operationError] : []), ...failures],
      `维护流程结束，但服务恢复失败；请运行 ${failedTargets.map(target => `codexc start ${commandTarget(target)}`).join("；")}`,
      { cause: failures[0] },
    ), controller.signal.aborted ? { exitCode: controller.signal.reason.exitCode } : {});
    if (operationError) {
      if (controller.signal.aborted) {
        const failure = operationError instanceof Error ? operationError : new Error(String(operationError), { cause: operationError });
        failure.exitCode = controller.signal.reason.exitCode;
        throw failure;
      }
      throw operationError;
    }
    controller.signal.throwIfAborted();
    return result;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
