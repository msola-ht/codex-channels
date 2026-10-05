import type { UpdateReceipt } from "./background-update-state.mjs";

export function assertBackgroundUpdateWorkerIdentity(
  unitName: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  cgroup: string,
  recover?: boolean,
): void;

export function runBackgroundUpdateWorker(
  root: string,
  id: string,
  options?: { recover?: boolean },
): Promise<UpdateReceipt>;
