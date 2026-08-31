export type ServiceTarget = "gateway" | "app-server" | "webui" | "center" | "all";
export type ServicePlatform = "systemd" | "launchd" | "windows";

export interface ServiceDefinition {
  readonly target: Exclude<ServiceTarget, "all">;
  readonly displayName: string;
  readonly systemd: string;
  readonly launchd: string;
  readonly windows: string;
  readonly core: boolean;
  readonly helpOrder: number;
  readonly startOrder: number;
  readonly stopOrder: number;
}

export const serviceDefinitions: readonly ServiceDefinition[];
export const serviceTargetUsage: string;
export function parseServiceTarget(value: string): ServiceTarget;
export function defaultServiceTarget(action: string): ServiceTarget;
export function serviceTargetIncludes(target: string, expected: string): boolean;
export function serviceDefinitionsForTarget(
  target: string,
  order?: "start" | "stop",
): ServiceDefinition[];
export function serviceIdentifiers(
  platform: ServicePlatform,
  target?: string,
  order?: "start" | "stop",
): string[];
