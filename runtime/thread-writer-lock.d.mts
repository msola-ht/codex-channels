import type { OwnedCommandRunner } from "./owned-command-runner.mjs";

export interface ThreadWriterLockHolder {
  pid: number;
  command: string;
  executable?: string;
  startedAt?: string;
}

export type ThreadWriterLockInspection =
  | { held: false }
  | { held: true; holder: ThreadWriterLockHolder }
  | { held: true; holder: null; reason: "unsupported-platform" | "inspection-unavailable" };

export function threadWriterLockPath(
  threadId: string,
  environment?: NodeJS.ProcessEnv,
): string;

export function inspectThreadWriterLock(
  threadId: string,
  environment?: NodeJS.ProcessEnv,
  procRoot?: string,
  options?: { runner?: OwnedCommandRunner; signal?: AbortSignal; timeoutMs?: number },
): Promise<ThreadWriterLockInspection>;

export function threadWriterLockHolders(
  lockPath: string,
  procRoot?: string,
): number[];

export function processCommandLine(
  pid: number,
  procRoot?: string,
): string;

export function terminateThreadWriterHolder(
  pid: number,
  options?: {
    timeoutMs?: number;
    startedAt?: string;
    environment?: NodeJS.ProcessEnv;
    runner?: OwnedCommandRunner;
    signal?: AbortSignal;
    beforeTerminate?: () => void;
  },
): Promise<boolean>;
