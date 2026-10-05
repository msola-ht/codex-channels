export interface TrafficCleanupPreview {
  bytes: number;
  directory: string;
  labels: number;
  resources: Array<
    | { createdAtMs: number; label: string; session: string; type: "v2" }
  >;
  targets: string[];
  v2Sessions: number;
}

export interface TrafficCleanupDependencies {
  assertAppServersStopped?: (
    environment: NodeJS.ProcessEnv,
    directory: string,
  ) => Promise<void>;
  environment?: NodeJS.ProcessEnv;
  output?: Pick<Console, "log">;
}

export function runTrafficCleanup(
  args: readonly string[],
  dependencies?: TrafficCleanupDependencies,
): Promise<TrafficCleanupPreview>;

export function trafficCleanupPreview(directory: string): TrafficCleanupPreview;

export function assertConfiguredAppServersStopped(
  environment: NodeJS.ProcessEnv,
  directory: string,
): Promise<void>;

export const TRAFFIC_CLEANUP_USAGE: string;
