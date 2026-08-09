import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";

export function childProcessIsRunning(
  child: Pick<ChildProcess, "exitCode" | "signalCode"> | undefined,
): boolean;
export function signalChildProcesses(
  children: Array<Pick<ChildProcess, "exitCode" | "signalCode" | "kill">>,
  signal: NodeJS.Signals,
): void;
export function installProcessSignalHandlers(
  handlers: Partial<Record<NodeJS.Signals, () => void>>,
  source?: EventEmitter,
): () => void;
