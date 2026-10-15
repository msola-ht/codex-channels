import type { MetricsMenuPrompts } from "./metrics-menu.mjs";
export type MaintenanceTarget = "gateway" | "app-server" | "relay";
export interface MaintenanceServiceOptions {
  isRunning?: (target: MaintenanceTarget) => boolean | Promise<boolean>;
  runService?: (action: "stop" | "start", target: MaintenanceTarget) => void | Promise<unknown>;
}
export function maintenanceServiceRunning(target: MaintenanceTarget): boolean;
export function runMaintenanceCommand(script: string, args: string[], options: {
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
}): Promise<void>;
export function runMaintenanceServices(options: MaintenanceServiceOptions & {
  prompts: Pick<MetricsMenuPrompts, "confirm" | "cancel" | "isCancel">;
  targets: MaintenanceTarget[];
  run: (options: { signal: AbortSignal }) => unknown | Promise<unknown>;
}): Promise<unknown>;
