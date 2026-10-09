import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";

export function installServiceControlHandler(
  handler: (message: { type: "codexc-stop" | "codexc-reload"; deadline?: number; signal?: AbortSignal }) => void | boolean | Promise<void | boolean>,
): () => void;
export function createChildServiceControl(child: ChildProcess): {
  send(type: "codexc-stop" | "codexc-reload", options?: { deadline?: number; signal?: AbortSignal }): Promise<boolean>;
  close(): void;
};

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
/** Register a Unix child spawned with detached:true as a dedicated group leader. */
export function registerChildProcessGroup(child: ChildProcess): void;
export function signalChildProcesses(
  children: Array<Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill">>,
  signal: NodeJS.Signals,
): void;
export function terminateChildProcess(
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill" | "once" | "off">,
  options?: {
    gracePeriodMs?: number;
    forcePeriodMs?: number;
  },
): Promise<void>;
export function installProcessSignalHandlers(
  handlers: Partial<Record<NodeJS.Signals, () => void>>,
  source?: EventEmitter,
): () => void;
