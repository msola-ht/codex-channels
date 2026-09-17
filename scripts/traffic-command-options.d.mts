export const TRAFFIC_USAGE: string;

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
