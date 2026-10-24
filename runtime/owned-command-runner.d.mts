import type { OwnedProcessInvocation } from "./owned-process.mjs";

export class OwnedCommandError extends Error {
  readonly reason: string;
  constructor(reason: string, options?: ErrorOptions);
}

export class OwnedCommandRunner {
  run(invocation: OwnedProcessInvocation, options: {
    timeoutMs: number;
    signal?: AbortSignal;
    input?: string;
    environment?: NodeJS.ProcessEnv;
    maxOutputBytes?: number;
  }): Promise<{ status: number | null; stdout: string; stderr: string }>;
  cancel(): void;
  close(): Promise<void>;
  waitForExit(): Promise<void>;
}

export function closeOwnedCommandRunners(): Promise<void>;
export function waitForOwnedCommandRunnersExit(): Promise<void>;
