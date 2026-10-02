import { inspectManagedServiceStatus } from "./service-status.mjs";
import { serviceControlEnvironment } from "./runtime-environment.mjs";

export function maintenanceServiceRunning(target) {
  const service = inspectManagedServiceStatus({ target: target === "relay" ? "model-relay" : target,
    environment: serviceControlEnvironment() }).services.find(entry => entry.target === (target === "relay" ? "model-relay" : target));
  if (!service || (!service.running && !["inactive", "inactive/dead", "not-found", "missing", "not-loaded", "stopped", "disabled", "ready"].includes(service.state))) {
    throw new Error(`无法确认 ${target} 服务状态，已取消维护`);
  }
  return service.running;
}

export async function runMaintenanceServices({ prompts, targets, run,
  isRunning = maintenanceServiceRunning,
  runService = async (action, target) => (await import("./service-command.mjs")).runServiceCommand([action, target]),
}) {
  const running = [];
  // Read every state before stopping any service.
  for (const target of targets) if (await isRunning(target)) running.push(target);
  if (running.length === 0) return run();
  const accepted = await prompts.confirm({
    message: `需要临时停止 ${running.join("、")}，相关请求将中断；完成、取消或失败后按原状态恢复。继续？`,
    initialValue: false,
  });
  if (prompts.isCancel(accepted) || accepted !== true) { prompts.cancel("已取消"); return; }
  const attempted = [];
  let result;
  let operationError;
  try {
    for (const target of running) {
      attempted.push(target);
      await runService("stop", target);
    }
    result = await run();
  } catch (error) { operationError = error; }
  const failures = [];
  const failedTargets = [];
  for (const target of attempted.reverse()) {
    try { await runService("start", target); }
    catch (error) { failures.push(error); failedTargets.push(target); }
  }
  if (failures.length) throw new AggregateError(
    [...(operationError ? [operationError] : []), ...failures],
    `维护流程结束，但服务恢复失败；请运行 ${failedTargets.map(target => `codexc service start ${target}`).join("；")}`,
    { cause: failures[0] },
  );
  if (operationError) throw operationError;
  return result;
}
