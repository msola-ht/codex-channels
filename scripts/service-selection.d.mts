import type { ServiceDefinition, ServicePlatform, ServiceTarget } from "../runtime/service-targets.mjs";
import type { ManagedServiceStatusEntry } from "./service-status.mjs";

export function serviceDefinitionPath(
  platform: ServicePlatform,
  definition: ServiceDefinition,
  environment?: NodeJS.ProcessEnv,
  definitionsDirectory?: string,
): string;
export function serviceControlDefinitions(
  platform: ServicePlatform,
  target: ServiceTarget,
  order?: "start" | "stop" | "status" | "install" | "install-stop" | "uninstall",
  environment?: NodeJS.ProcessEnv,
  definitionsDirectory?: string,
): ServiceDefinition[];
export function serviceStatusRequiredDefinitions(
  platform: ServicePlatform,
  target: ServiceTarget,
  environment?: NodeJS.ProcessEnv,
  definitionsDirectory?: string,
): ServiceDefinition[];
export function serviceSnapshotHealthy(
  services: readonly ManagedServiceStatusEntry[],
  target: ServiceTarget,
  environment?: NodeJS.ProcessEnv,
): boolean;
export function waitForSelectedRelay(target: ServiceTarget, environment?: NodeJS.ProcessEnv): Promise<void>;
