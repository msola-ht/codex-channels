import type { MetricsMenuPrompts } from "./metrics-menu.mjs";

export const cleanupUsage: string;
export function runCleanupMenu(options: {
  prompts?: MetricsMenuPrompts;
  runSessionCleanup: (args: string[]) => void | Promise<unknown>;
  runTrafficCleanup: (args: string[]) => void | Promise<unknown>;
  runDatabaseCommand: (args: string[]) => void;
  readStorage?: () => Record<string, unknown>;
}): Promise<void>;
