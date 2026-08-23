/**
 * The scheduled-task domain deliberately has no dependency on a Surface, the
 * App Server protocol, or the existing binding database.  Values crossing the
 * SQLite boundary use UTC epoch milliseconds; keeping that representation
 * explicit avoids accidental host-timezone conversions.
 */

export const scheduledTasksSchemaVersion = 1 as const;
export const scheduledTaskDatabaseFileName = "scheduled-tasks.sqlite3" as const;

export const scheduleWeekdays = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type ScheduleWeekday = (typeof scheduleWeekdays)[number];

export type Schedule =
  | {
      readonly type: "hourly";
      readonly intervalHours: number;
      /** UTC epoch milliseconds. */
      readonly anchorAt: number;
    }
  | {
      readonly type: "daily";
      /** A strict 24-hour local time in HH:mm form. */
      readonly time: string;
    }
  | {
      readonly type: "weekdays";
      /** A strict 24-hour local time in HH:mm form. */
      readonly time: string;
    }
  | {
      readonly type: "weekly";
      readonly days: readonly ScheduleWeekday[];
      /** A strict 24-hour local time in HH:mm form. */
      readonly time: string;
    };

export type ScheduledTaskStatus = "active" | "paused" | "blocked" | "deleted";

export type ScheduledTaskSandbox = "read-only" | "workspace-write";

/**
 * Unattended runs never wait for an interactive approval.  The type does not
 * include danger-full-access or an approval policy other than `never`, so a
 * caller cannot accidentally widen the unattended boundary by construction.
 */
export interface ScheduledTaskPermission {
  readonly sandbox: ScheduledTaskSandbox;
  readonly approvalPolicy: "never";
  readonly permissions: string | null;
}

export type ScheduledRunState =
  | "dispatching"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "uncertain"
  | "missed"
  | "skipped_overlap"
  | "skipped_capacity"
  | "blocked";

export type ScheduledRunErrorCategory =
  | "authorization"
  | "workspace"
  | "provider"
  | "model"
  | "approval"
  | "capacity"
  | "overlap"
  | "missed"
  | "interrupted"
  | "gateway_crash"
  | "unknown";

export interface ScheduledTask {
  readonly taskId: string;
  readonly name: string;
  readonly status: ScheduledTaskStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly surface: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly prompt: string;
  readonly schedule: Schedule | null;
  readonly timezone: string | null;
  readonly nextRunAt: number | null;
  readonly modelProvider: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly serviceTier: string | null;
  readonly permission: ScheduledTaskPermission | null;
}

export interface ScheduledRun {
  readonly runId: string;
  readonly taskId: string;
  /** UTC epoch milliseconds for the occurrence represented by this run. */
  readonly scheduledFor: number;
  readonly state: ScheduledRunState;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly dispatchStartedAt: number | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly errorCategory: ScheduledRunErrorCategory | null;
  /** Stable bounded diagnostic category; never an executor message or model output. */
  readonly errorMessage: string | null;
}

export const activeScheduledRunStates = ["dispatching", "running"] as const;
export type ActiveScheduledRunState = (typeof activeScheduledRunStates)[number];

/** States that can still represent an in-flight or unresolved side effect. */
export const blockingScheduledRunStates = ["dispatching", "running", "uncertain"] as const;
export type BlockingScheduledRunState = (typeof blockingScheduledRunStates)[number];

export interface CreateScheduledTaskInput {
  readonly taskId?: string;
  readonly name: string;
  readonly surface: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly prompt: string;
  readonly schedule: Schedule;
  readonly timezone: string;
  readonly modelProvider?: string | null;
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
  readonly serviceTier?: string | null;
  readonly sandbox?: ScheduledTaskSandbox;
  readonly approvalPolicy?: "never";
  readonly permissions?: string | null;
  readonly createdAt?: number;
}

export type ScheduledTaskClaimResult =
  | { readonly kind: "claimed"; readonly run: ScheduledRun }
  | { readonly kind: "skipped_overlap"; readonly run: ScheduledRun }
  | { readonly kind: "skipped_capacity"; readonly run: ScheduledRun }
  | { readonly kind: "missed"; readonly run: ScheduledRun }
  | { readonly kind: "blocked"; readonly run: ScheduledRun };

export interface ScheduledTaskStore {
  readonly path?: string;
  createTask(input: CreateScheduledTaskInput): ScheduledTask;
  getTask(taskId: string): ScheduledTask | undefined;
  listTasks(options?: {
    readonly conversation?: {
      readonly surface: string;
      readonly accountId: string;
      readonly conversationId: string;
    };
    readonly includeDeleted?: boolean;
  }): ScheduledTask[];
  renameTask(taskId: string, name: string, nowMs?: number): ScheduledTask;
  pauseTask(taskId: string, nowMs?: number): ScheduledTask;
  resumeTask(taskId: string, nowMs?: number): ScheduledTask;
  blockTask(taskId: string, nowMs?: number): ScheduledTask;
  deleteTask(taskId: string, nowMs?: number): ScheduledTask;
  listDueTasks(nowMs: number): ScheduledTask[];
  listRuns(taskId: string, options?: { readonly limit?: number }): ScheduledRun[];
  /** All running rows, independent of per-task display retention windows. */
  listRunningRuns(): ScheduledRun[];
  /** Narrow query used by the scheduler; it must not depend on the display limit. */
  hasBlockingRun(taskId: string): boolean;
  /** Count in-flight or unresolved runs for one Conversation without loading history. */
  countConversationActiveRuns(conversation: {
    readonly surface: string;
    readonly accountId: string;
    readonly conversationId: string;
  }): number;
  getRun(runId: string): ScheduledRun | undefined;
  claimDue(
    taskId: string,
    scheduledFor: number,
    result: "claimed" | "skipped_overlap" | "skipped_capacity" | "missed" | "blocked",
    nowMs: number,
  ): ScheduledTaskClaimResult;
  /** Claim an independent manual occurrence without advancing nextRunAt. */
  claimManual(
    taskId: string,
    nowMs: number,
    result?: "claimed" | "skipped_capacity",
  ): ScheduledTaskClaimResult;
  markRunning(
    runId: string,
    nowMs: number,
    identifiers?: { readonly threadId?: string | null; readonly turnId?: string | null },
  ): ScheduledRun;
  /** Persist that an unattended interactive request was safely rejected. */
  markApprovalRejected(runId: string): ScheduledRun;
  markCompleted(
    runId: string,
    nowMs?: number,
    identifiers?: { readonly threadId?: string | null; readonly turnId?: string | null },
  ): ScheduledRun;
  markFailed(
    runId: string,
    category: ScheduledRunErrorCategory,
    nowMs?: number,
    identifiers?: { readonly threadId?: string | null; readonly turnId?: string | null },
  ): ScheduledRun;
  markInterrupted(
    runId: string,
    nowMs?: number,
    identifiers?: { readonly threadId?: string | null; readonly turnId?: string | null },
  ): ScheduledRun;
  markUncertain(
    runId: string,
    nowMs?: number,
    identifiers?: { readonly threadId?: string | null; readonly turnId?: string | null },
  ): ScheduledRun;
  /** Explicitly closes an uncertain run; this never happens automatically. */
  resolveUncertain(
    runId: string,
    resolution: ScheduledUncertainResolution,
    nowMs?: number,
  ): ScheduledRun;
  /** Convert dispatching rows left by a crashed Gateway into uncertain. */
  recoverAfterCrash(nowMs?: number): ScheduledRun[];
  /** Remove terminal runs older than 90 days and retain at most 200 per task. */
  cleanup(nowMs?: number): number;
  /** Copy the private database, preserving its restrictive file mode. */
  backup(destinationPath?: string): string;
  close(): void;
}

export type ScheduledUncertainResolution = "failed" | "interrupted";

export interface ScheduledTaskExecutionPort {
  /** Return false when the Conversation has no background capacity. */
  canStart?(task: ScheduledTask): boolean | Promise<boolean>;
  /** Return the current number of free background slots for this Conversation. */
  availableCapacity?(task: ScheduledTask): number | Promise<number>;
  execute(
    task: ScheduledTask,
    run: ScheduledRun,
    signal: AbortSignal,
  ): Promise<ScheduledTaskExecutionResult>;
  /** Optional hook after the Store records the dispatch result. */
  onRunStateChanged?(run: ScheduledRun): void | Promise<void>;
}

export type ScheduledTaskExecutionResult =
  | {
      readonly kind: "running";
      readonly threadId?: string | null;
      readonly turnId?: string | null;
    }
  | { readonly kind: "completed"; readonly threadId?: string | null; readonly turnId?: string | null }
  | {
      readonly kind: "failed";
      readonly category?: ScheduledRunErrorCategory;
      /** Permanent authorization/configuration loss blocks future occurrences. */
      readonly blockTask?: boolean;
      readonly threadId?: string | null;
      readonly turnId?: string | null;
    }
  | {
      readonly kind: "interrupted";
      readonly threadId?: string | null;
      readonly turnId?: string | null;
    }
  | {
      readonly kind: "uncertain";
      readonly threadId?: string | null;
      readonly turnId?: string | null;
    };

export interface ScheduledTaskClock {
  now(): number;
}

export interface ScheduledTaskSchedulerOptions {
  readonly clock?: ScheduledTaskClock;
  readonly pollIntervalMs?: number;
  readonly catchUpWindowMs?: number;
  readonly maxConcurrentRunsPerConversation?: number;
  readonly maxTasksPerTick?: number;
  /** Maximum time stop() waits for a tick after aborting its executions. */
  readonly stopTimeoutMs?: number;
  /** Receives errors raised by timer-driven ticks. */
  readonly onError?: (error: unknown) => void;
}

export interface ScheduledTaskTickResult {
  readonly claimed: ScheduledRun[];
  readonly skippedOverlap: ScheduledRun[];
  readonly skippedCapacity: ScheduledRun[];
  readonly blocked: ScheduledRun[];
  readonly missed: ScheduledRun[];
}
