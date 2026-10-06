import type { ManagedServiceStatus } from "./service-status.mjs";
import type { ServiceTarget } from "../runtime/service-targets.mjs";

export function windowsServiceDefinitionsDirectory(
  environment?: NodeJS.ProcessEnv,
): string;

export function controlWindowsServices(options: {
  action: "preflight" | "install" | "uninstall" | "start" | "stop" | "reload" | "status" | "logs";
  target?: ServiceTarget;
  definitionsDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  follow?: boolean;
  lines?: number;
  json?: boolean;
}): Promise<ManagedServiceStatus | void>;

export function inspectWindowsServiceStatus(options?: {
  target?: ServiceTarget;
  definitionsDirectory?: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<ManagedServiceStatus>;
