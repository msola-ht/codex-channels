import type { MetricsMenuPrompts } from "./metrics-menu.mjs";
export type MaintenanceTarget = "gateway" | "app-server" | "relay";
export interface MaintenanceServiceOptions {
  isRunning?: (target: MaintenanceTarget) => boolean | Promise<boolean>;
  runService?: (action: "stop" | "start", target: MaintenanceTarget) => void | Promise<unknown>;
}
export function maintenanceServiceRunning(target: MaintenanceTarget): boolean;
export function runMaintenanceServices(options: MaintenanceServiceOptions & {
  prompts: Pick<MetricsMenuPrompts, "confirm" | "cancel" | "isCancel">;
  targets: MaintenanceTarget[];
  run: () => unknown | Promise<unknown>;
}): Promise<unknown>;
