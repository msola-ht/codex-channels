import type { ScheduledTaskStore } from "./types.js";

export const scheduledTaskWorkerMethods = [
  "createTask", "getTask", "listTasks", "renameTask", "pauseTask", "resumeTask", "blockTask", "deleteTask",
  "listDueTasks", "listRuns", "listRecoverableRuns", "hasBlockingRun", "countConversationActiveRuns", "getRun",
  "claimDue", "claimManual", "claimRetry", "markRunning", "markApprovalRejected", "markCompleted",
  "markFailed", "markInterrupted", "markUncertain", "resolveUncertain", "recoverAfterCrash", "cleanup", "backup",
] as const satisfies readonly (keyof ScheduledTaskStore)[];

export type ScheduledTaskWorkerMethod = (typeof scheduledTaskWorkerMethods)[number];
export type ScheduledTaskWorkerRequest = {
  [K in ScheduledTaskWorkerMethod]: { readonly id: number; readonly method: K; readonly args: Parameters<ScheduledTaskStore[K]> }
}[ScheduledTaskWorkerMethod];

export type ScheduledTaskWorkerReply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly reason: "state" | "schema" | "sqlite" | "invalid-input" | "storage"; readonly stateMessage?: string };
