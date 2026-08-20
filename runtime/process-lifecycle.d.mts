import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";

export class ReportedChildExitError extends Error {
  readonly exitCode: number;
  constructor(exitCode: number, message?: string);
}

export class ForwardedChildSignalError extends Error {
  readonly signal: NodeJS.Signals;
  constructor(signal: NodeJS.Signals);
}

export function assertSynchronousChildSuccess(
  result: {
    error?: Error;
    signal: NodeJS.Signals | null;
    status: number | null;
  },
  options?: {
    failureMessage?: (exitCode: number) => string;
    failureReportedByChild?: boolean;
    signalTarget?: { pid: number; kill(pid: number, signal: NodeJS.Signals): unknown };
  },
): void;

export function childProcessIsRunning(
  child: Pick<ChildProcess, "exitCode" | "signalCode"> | undefined,
): boolean;
export function signalChildProcesses(
  children: Array<Pick<ChildProcess, "exitCode" | "signalCode" | "kill">>,
  signal: NodeJS.Signals,
): void;
export function terminateChildProcess(
  child: Pick<ChildProcess, "exitCode" | "signalCode" | "kill" | "once" | "off">,
  options?: {
    gracePeriodMs?: number;
    forcePeriodMs?: number;
  },
): Promise<void>;
export function installProcessSignalHandlers(
  handlers: Partial<Record<NodeJS.Signals, () => void>>,
  source?: EventEmitter,
): () => void;
