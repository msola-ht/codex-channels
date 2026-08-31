import type { ManagedServiceStatus } from "./service-status.mjs";

export function windowsServiceDefinitionsDirectory(
  environment?: NodeJS.ProcessEnv,
): string;

export function controlWindowsServices(options: {
  action: "preflight" | "install" | "uninstall" | "start" | "stop" | "reload" | "restart" | "status" | "logs";
  target?: "gateway" | "app-server" | "webui" | "center" | "all";
  definitionsDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  follow?: boolean;
  lines?: number;
  json?: boolean;
}): Promise<ManagedServiceStatus | void>;

export function inspectWindowsServiceStatus(options?: {
  target?: "gateway" | "app-server" | "webui" | "center" | "all";
  definitionsDirectory?: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<ManagedServiceStatus>;
