import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

/** The notification endpoint carries no metrics or account data. */
export function metricsEventsPath(configPath) {
  return eventsPath(configPath, "metrics");
}

export function accountSnapshotEventsPath(configPath) {
  return eventsPath(configPath, "accounts");
}

function eventsPath(configPath, kind) {
  const path = resolve(configPath);
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 16);
  return join(dirname(path), "runtime", `${kind}-events-${digest}.sock`);
}
