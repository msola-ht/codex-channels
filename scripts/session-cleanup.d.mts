export interface SessionCleanupArgs {
  confirm: boolean;
  maxTurns: number;
  idleDays: number | null;
}

export function parseSessionCleanupArgs(args: readonly string[]): SessionCleanupArgs;
export function isThreadIdle(
  thread: { recencyAt?: number | null; updatedAt?: number },
  cutoffSeconds: number,
): boolean;

export function runSessionCleanup(
  args: readonly string[],
  options?: {
    environment?: NodeJS.ProcessEnv;
    output?: Pick<Console, "log">;
  },
): Promise<unknown>;
