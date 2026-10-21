import { createInterface } from "node:readline";
import { withCliLifecycleCancellation } from "./cli-lifecycle-command.mjs";
import { normalizeTaskInput } from "./webui-management-tasks.mjs";

// Standard input remains available through the Windows owned-process Job.
// Cancellation is cooperative: a database commit or service recovery must settle
// before this command exits. Closing the owner pipe requests the same cleanup.
const input = createInterface({ input: process.stdin });
const cancel = () => process.emit("SIGTERM");
input.on("line", value => { if (value === "cancel") cancel(); });
input.on("close", cancel);
let outcome = { status: "failed", commitState: "not_started", failurePhases: [] };
let MaintenanceError;
const commitState = result => result?.committed === true ? "committed"
  : result?.committed === false ? "not_committed"
  : result?.committed === "unknown" ? "unknown"
  : result?.changed === false ? "unchanged" : "committed";
try {
  await withCliLifecycleCancellation("管理任务", async signal => {
    const task = normalizeTaskInput(JSON.parse(process.argv[2]));
    outcome.commitState = "unknown";
    if (task.operation === "service") {
      const { runServiceCommand, runRestartCommand } = await import("./service-command.mjs");
      signal.throwIfAborted();
      const { serviceCommandTarget } = await import("../runtime/service-targets.mjs");
      const targets = task.target === undefined ? [] : [serviceCommandTarget(task.target)];
      if (task.action === "restart") await runRestartCommand(targets, { signal });
      else await runServiceCommand([task.action, ...targets], { signal });
    } else if (task.operation === "traffic") {
      const { runTrafficCleanup } = await import("./traffic-cleanup.mjs");
      signal.throwIfAborted();
      const result = await runTrafficCleanup(process.argv.slice(4), { signal });
      outcome.commitState = result.targets.length === 0 ? "unchanged" : "committed";
    } else {
      const { MetricsMaintenanceError, resetMetricsDatabase, cleanupMetricsDatabase, pruneProviderMetrics } = await import("./metrics-database.mjs");
      MaintenanceError = MetricsMaintenanceError;
      signal.throwIfAborted();
      const result = task.action === "reset" ? resetMetricsDatabase()
        : task.action === "prune" ? pruneProviderMetrics(task.target) : cleanupMetricsDatabase();
      outcome.commitState = commitState(result);
    }
    if (task.operation === "service") outcome.commitState = "committed";
    outcome.status = "completed";
  });
} catch (error) {
  outcome.status = error?.exitCode === 130 || error?.exitCode === 143 ? "cancelled" : "failed";
  if (MaintenanceError && error instanceof MaintenanceError) {
    outcome.commitState = commitState(error.result);
    outcome.failurePhases = error.failures.map(({ phase }) => phase)
      .filter(phase => ["commit", "vacuum", "count", "close", "lock-release", "gateway-restart"].includes(phase));
  }
  process.exitCode = error?.exitCode ?? 1;
} finally {
  // Never include paths, backups, exceptions or raw CLI diagnostics.
  process.stdout.write(`\ncodexc-management-result:${process.argv[3]}:${JSON.stringify(outcome)}\n`);
  input.off("close", cancel);
  input.close();
  process.stdin.destroy();
}
