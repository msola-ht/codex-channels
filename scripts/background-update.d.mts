import type { BackgroundUpdateJob, BackgroundUpdateReceipt } from "./background-update-state.mjs";

export function backgroundUpdateEnvironment(environment: NodeJS.ProcessEnv, nodeBinary: string, configPath: string): Record<string, string>;
export function backgroundUnitArguments(job: BackgroundUpdateJob, jobDirectory: string, recover?: boolean): string[];
export interface BackgroundUpdateOptions {
  platform?: NodeJS.Platform;
  packageDirectory?: string;
  nodeBinary?: string;
  systemd?: (args: string[], environment: NodeJS.ProcessEnv) => string;
}
export function submitBackgroundUpdate(sourceDirectory: string, environment?: NodeJS.ProcessEnv, options?: BackgroundUpdateOptions): Promise<BackgroundUpdateReceipt & {jobDirectory: string}>;
export function inspectBackgroundUpdate(taskId?: string, environment?: NodeJS.ProcessEnv, options?: BackgroundUpdateOptions): BackgroundUpdateReceipt & {jobDirectory: string; sourceDirectory: string; serviceState: string};
export function runBackgroundUpdateCommand(args: readonly string[], environment?: NodeJS.ProcessEnv): Promise<void>;
