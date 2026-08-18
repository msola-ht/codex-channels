export interface ThreadWriterLockHolder {
  pid: number;
  command: string;
}

export type ThreadWriterLockInspection =
  | { held: false }
  | { held: true; holder: ThreadWriterLockHolder | null };

export function threadWriterLockPath(
  threadId: string,
  environment?: NodeJS.ProcessEnv,
): string;

export function inspectThreadWriterLock(
  threadId: string,
  environment?: NodeJS.ProcessEnv,
  procRoot?: string,
): ThreadWriterLockInspection;

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
  options?: { timeoutMs?: number },
): Promise<boolean>;
