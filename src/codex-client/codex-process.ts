import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface CodexProcessInvocation {
  file: string;
  args: readonly string[];
  windowsVerbatimArguments?: boolean;
}

export type CreateCodexProcessInvocation = (
  args: readonly string[],
) => CodexProcessInvocation;

export type TerminateCodexProcess = (
  child: ChildProcessWithoutNullStreams,
  options?: { gracePeriodMs?: number; forcePeriodMs?: number },
) => Promise<void>;
