import type { CoreServiceReadinessOptions } from "./local-installation.mjs";

export const serviceCommandActions: readonly string[];
export const serviceCommandUsage: Readonly<Record<string, string>>;
export function runRestartCommand(args?: readonly string[]): Promise<void>;
export function runServiceCommand(args: readonly string[]): Promise<void>;
export function runGatewayServiceCommand(args: readonly string[]): Promise<void>;
export function runAppServerServiceCommand(args: readonly string[]): Promise<void>;
export function runModelRelayServiceCommand(args: readonly string[]): Promise<void>;
export function waitForManagedServiceReadiness(
  target: "gateway" | "app-server" | "all",
  environment?: NodeJS.ProcessEnv,
  options?: CoreServiceReadinessOptions,
): Promise<void>;
