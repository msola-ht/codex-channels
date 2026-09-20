export type ConfigActivationStatus =
  | "none"
  | "reload"
  | "next-thread"
  | "next-tui"
  | "next-thread-and-tui"
  | "restart"
  | "reinstall-required"
  | "failed";

export type ConfigActivationTarget =
  | "none"
  | "codex"
  | "gateway"
  | "webui"
  | "app-server"
  | "app-server-webui"
  | "all"
  | "services"
  | "unknown";

export interface ConfigActivationResult {
  readonly status: ConfigActivationStatus;
  readonly target: ConfigActivationTarget;
  readonly commands: readonly string[];
}

export function configActivationResult(activation: string): ConfigActivationResult;
