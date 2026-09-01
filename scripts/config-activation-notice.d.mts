import type { ConfigActivationResult } from "./config-activation-result.mjs";

export const gatewayConfigActivationNotice: string;

export function writeGatewayConfigActivationNotice(
  output: { write(value: string): void },
  environment?: NodeJS.ProcessEnv,
  action?:
    | "auto"
    | "none"
    | "restart"
    | "restart-webui"
    | "restart-center"
    | "restart-gateway-webui"
    | "reinstall"
    | "reinstall-services"
    | ConfigActivationResult,
): void;
