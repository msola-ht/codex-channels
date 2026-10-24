import type { MetricsMenuPrompts } from "./metrics-menu.mjs";

import type { MaintenanceServiceOptions } from "./maintenance-services.mjs";
import type { TrafficCleanupDependencies, TrafficCleanupPlan } from "./traffic-cleanup.mjs";

export const cleanupUsage: string;
export function runCleanupMenu(options: {
  prompts?: MetricsMenuPrompts;
  services?: MaintenanceServiceOptions;
  runSessionCleanup: (args: string[], options?: { signal: AbortSignal }) => void | Promise<unknown>;
  runTrafficCleanup: (args: string[], options?: TrafficCleanupDependencies) => Promise<TrafficCleanupPlan>;
  runDatabaseCommand: (args: string[], options?: { signal: AbortSignal }) => void | Promise<unknown>;
  readStorage?: () => Record<string, unknown>;
}): Promise<void>;
