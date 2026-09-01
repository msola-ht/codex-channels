export type ConfigActivationStatus =
  | "none"
  | "reload"
  | "restart"
  | "reinstall-required"
  | "failed";

export type ConfigActivationTarget =
  | "none"
  | "gateway"
  | "webui"
  | "center"
  | "gateway+webui"
  | "app-server"
  | "all"
  | "services"
  | "unknown";

export interface ConfigActivationResult {
  readonly status: ConfigActivationStatus;
  readonly target: ConfigActivationTarget;
  readonly commands: readonly string[];
}

export function configActivationResult(activation: string): ConfigActivationResult;
