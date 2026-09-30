export const TRAFFIC_UPGRADE_USAGE: string;
export interface TrafficUpgradeOptions { enabled: boolean; mode: "production" | "debug" }
export function parseTrafficUpgradeArgs(args: readonly string[]): TrafficUpgradeOptions;
export function upgradeTrafficCapture(input: TrafficUpgradeOptions, environment?: NodeJS.ProcessEnv): Promise<{ result: string; backupPath: string | null; notice?: string }>;
