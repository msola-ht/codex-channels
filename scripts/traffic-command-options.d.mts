export const TRAFFIC_USAGE: string;
export const TRAFFIC_CLEANUP_USAGE: string;

export interface TrafficCleanupOptions {
  confirm: boolean;
  directory: string | undefined;
}

export interface TrafficCommandOptions {
  all: boolean;
  directory: string | undefined;
  exchange: number | undefined;
  files: string[];
  follow: boolean;
  grep: string | undefined;
  list: boolean;
  maxBytes: number | undefined;
}

export function parseTrafficCommandArgs(
  args: readonly string[],
): TrafficCommandOptions;

export function parseTrafficCleanupArgs(
  args: readonly string[],
): TrafficCleanupOptions;
