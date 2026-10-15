import type { MaintenanceServiceOptions } from "./maintenance-services.mjs";

export interface SessionMenuPrompts {
  intro(message: string): void;
  cancel(message: string): void;
  isCancel(value: unknown): boolean;
  select(options: Record<string, unknown>): Promise<unknown>;
  text(options: Record<string, unknown>): Promise<unknown>;
  confirm(options: Record<string, unknown>): Promise<unknown>;
}

export function runSessionCleanupMenu(options: {
  prompts?: SessionMenuPrompts;
  runCleanup: (args: string[], options?: { signal: AbortSignal }) => void | Promise<unknown>;
  gatewayRunning?: () => boolean | Promise<boolean>;
  runService?: (action: "stop" | "start") => void | Promise<unknown>;
  services?: MaintenanceServiceOptions;
}): Promise<unknown>;
