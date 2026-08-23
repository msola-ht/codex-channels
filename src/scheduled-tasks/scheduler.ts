import {
  type ScheduledRun,
  type ScheduledTask,
  type ScheduledTaskClock,
  type ScheduledTaskExecutionPort,
  type ScheduledTaskExecutionResult,
  type ScheduledTaskSchedulerOptions,
  type ScheduledTaskStore,
  type ScheduledTaskTickResult,
} from "./types.js";

const defaultCatchUpWindowMs = 5 * 60_000;
const defaultPollIntervalMs = 30_000;
const defaultConversationCapacity = 3;
const defaultMaxTasksPerTick = 100;
const scheduledTaskCleanupIntervalMs = 24 * 60 * 60_000;
const maxTimerDelayMs = 2_147_483_647;
const systemClock: ScheduledTaskClock = { now: () => Date.now() };

/**
 * Pure Gateway-side scheduler.  App Server and Surface code enter only via
 * the execution port; this class owns no Thread/Turn state and never retries
 * an executor write whose result is unknown.
 */
export class ScheduledTaskScheduler {
  private readonly clock: ScheduledTaskClock;
  private readonly catchUpWindowMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxConcurrentRunsPerConversation: number;
  private readonly maxTasksPerTick: number;
  private readonly stopTimeoutMs: number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticking = false;
  private stopping = false;
  private tickCompletion: Promise<void> | undefined;
  private resolveTickCompletion: (() => void) | undefined;
  private readonly abortControllers = new Set<AbortController>();
  private lastCleanupAttemptAt: number | undefined;

  constructor(
    private readonly store: ScheduledTaskStore,
    private readonly executor: ScheduledTaskExecutionPort,
    options: ScheduledTaskSchedulerOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.catchUpWindowMs = options.catchUpWindowMs ?? defaultCatchUpWindowMs;
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
    this.maxConcurrentRunsPerConversation = options.maxConcurrentRunsPerConversation ?? defaultConversationCapacity;
    this.maxTasksPerTick = options.maxTasksPerTick ?? defaultMaxTasksPerTick;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    this.onError = options.onError;
    if (!Number.isSafeInteger(this.catchUpWindowMs) || this.catchUpWindowMs < 0) {
      throw new RangeError("计划任务补跑窗口必须是非负整数毫秒");
    }
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1 || this.pollIntervalMs > maxTimerDelayMs) {
      throw new RangeError("计划任务轮询间隔必须是正整数毫秒");
    }
    if (!Number.isSafeInteger(this.maxConcurrentRunsPerConversation) || this.maxConcurrentRunsPerConversation < 1) {
      throw new RangeError("Conversation 后台容量必须是正整数");
    }
    if (!Number.isSafeInteger(this.maxTasksPerTick) || this.maxTasksPerTick < 1) {
      throw new RangeError("单次调度任务数上限必须是正整数");
    }
    if (!Number.isSafeInteger(this.stopTimeoutMs) || this.stopTimeoutMs < 0 || this.stopTimeoutMs > maxTimerDelayMs) {
      throw new RangeError("计划任务停止等待上限必须是非负整数毫秒");
    }
  }

  async tick(nowMs = this.clock.now()): Promise<ScheduledTaskTickResult> {
    if (this.ticking || this.stopping) return emptyTickResult();
    this.ticking = true;
    this.tickCompletion = new Promise<void>((resolve) => {
      this.resolveTickCompletion = resolve;
    });
    try {
      this.maybeCleanup(nowMs);
      const result: MutableTickResult = {
        claimed: [],
        skippedOverlap: [],
        skippedCapacity: [],
        blocked: [],
        missed: [],
      };
      let processed = 0;
      for (const initialTask of this.store.listDueTasks(nowMs)) {
        if (this.stopping) break;
        if (processed >= this.maxTasksPerTick) break;
        let task = this.store.getTask(initialTask.taskId);
        if (!task || task.status !== "active" || task.nextRunAt === null) continue;

        while (
          task.nextRunAt !== null
          && task.nextRunAt < nowMs - this.catchUpWindowMs
          && processed < this.maxTasksPerTick
          && !this.stopping
        ) {
          const missed = this.store.claimDue(task.taskId, task.nextRunAt, "missed", nowMs);
          result.missed.push(missed.run);
          processed += 1;
          task = this.store.getTask(task.taskId);
          if (!task || task.status !== "active") break;
        }
        if (!task || task.status !== "active" || task.nextRunAt === null || task.nextRunAt > nowMs) continue;
        if (processed >= this.maxTasksPerTick) break;

        const scheduledFor = task.nextRunAt;
        if (this.activeRunExists(task)) {
          const skipped = this.store.claimDue(task.taskId, scheduledFor, "claimed", nowMs);
          if (skipped.kind === "blocked") result.blocked.push(skipped.run);
          else result.skippedOverlap.push(skipped.run);
          processed += 1;
          continue;
        }
        const capacityAvailable = await this.capacityAvailable(task);
        if (this.stopping) break;
        if (!capacityAvailable) {
          const skipped = this.store.claimDue(task.taskId, scheduledFor, "skipped_capacity", nowMs);
          result.skippedCapacity.push(skipped.run);
          processed += 1;
          continue;
        }

        const claim = this.store.claimDue(task.taskId, scheduledFor, "claimed", nowMs);
        processed += 1;
        if (claim.kind === "claimed") {
          result.claimed.push(await this.dispatch(task, claim.run, nowMs));
        } else if (claim.kind === "skipped_overlap") {
          result.skippedOverlap.push(claim.run);
        } else if (claim.kind === "skipped_capacity") {
          result.skippedCapacity.push(claim.run);
        } else if (claim.kind === "blocked") {
          result.blocked.push(claim.run);
        } else {
          result.missed.push(claim.run);
        }
      }
      return result;
    } finally {
      this.ticking = false;
      this.resolveTickCompletion?.();
      this.resolveTickCompletion = undefined;
    }
  }

  runOnce(nowMs = this.clock.now()): Promise<ScheduledTaskTickResult> {
    return this.tick(nowMs);
  }

  start(): void {
    if (this.timer !== undefined || this.stopping) return;
    this.scheduleNextTick(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const controller of this.abortControllers) controller.abort();
    const completion = this.tickCompletion;
    if (!this.ticking || completion === undefined) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      completion,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, this.stopTimeoutMs);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (this.ticking) throw new ScheduledTaskStopTimeoutError();
  }

  recoverAfterCrash(nowMs = this.clock.now()): ScheduledRun[] {
    return this.store.recoverAfterCrash(nowMs);
  }

  private scheduleNextTick(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick()
        .catch((error: unknown) => this.reportError(error))
        .finally(() => this.scheduleNextTick(this.pollIntervalMs));
    }, delayMs);
  }

  private activeRunExists(task: ScheduledTask): boolean {
    return this.store.hasBlockingRun(task.taskId);
  }

  private async capacityAvailable(task: ScheduledTask): Promise<boolean> {
    const activeCount = this.store.countConversationActiveRuns(task);
    if (activeCount >= this.maxConcurrentRunsPerConversation) return false;
    return this.executor.canStart === undefined ? true : await this.executor.canStart(task);
  }

  private async dispatch(task: ScheduledTask, run: ScheduledRun, nowMs: number): Promise<ScheduledRun> {
    const controller = new AbortController();
    this.abortControllers.add(controller);
    let outcome: ScheduledTaskExecutionResult;
    try {
      outcome = await this.executor.execute(task, run, controller.signal);
    } catch {
      return this.store.markUncertain(run.runId, nowMs);
    } finally {
      this.abortControllers.delete(controller);
    }
    switch (outcome.kind) {
      case "running":
        return this.store.markRunning(run.runId, nowMs, executionIdentifiers(outcome));
      case "completed":
        this.store.markRunning(run.runId, nowMs, executionIdentifiers(outcome));
        return this.store.markCompleted(run.runId, nowMs);
      case "failed":
        return this.store.markFailed(
          run.runId,
          outcome.category ?? "unknown",
          nowMs,
        );
      case "uncertain":
        return this.store.markUncertain(run.runId, nowMs);
    }
  }

  private reportError(error: unknown): void {
    if (this.onError === undefined) return;
    try {
      this.onError(error);
    } catch {
      // An observer must never become an unhandled timer rejection.
    }
  }

  private maybeCleanup(nowMs: number): void {
    if (
      this.lastCleanupAttemptAt !== undefined
      && nowMs - this.lastCleanupAttemptAt < scheduledTaskCleanupIntervalMs
    ) return;
    this.lastCleanupAttemptAt = nowMs;
    try {
      this.store.cleanup(nowMs);
    } catch (error) {
      // Cleanup is terminal-row maintenance; a failed cleanup must not stop safe scheduling.
      this.reportError(error);
    }
  }
}

interface MutableTickResult {
  claimed: ScheduledRun[];
  skippedOverlap: ScheduledRun[];
  skippedCapacity: ScheduledRun[];
  blocked: ScheduledRun[];
  missed: ScheduledRun[];
}

function emptyTickResult(): ScheduledTaskTickResult {
  return {
    claimed: [],
    skippedOverlap: [],
    skippedCapacity: [],
    blocked: [],
    missed: [],
  };
}

function executionIdentifiers(
  outcome: Extract<ScheduledTaskExecutionResult, { readonly kind: "running" | "completed" }>,
): { readonly threadId?: string | null; readonly turnId?: string | null } {
  return {
    ...(outcome.threadId === undefined ? {} : { threadId: outcome.threadId }),
    ...(outcome.turnId === undefined ? {} : { turnId: outcome.turnId }),
  };
}

export class ScheduledTaskStopTimeoutError extends Error {
  readonly code = "scheduled-task.stop.timeout" as const;

  constructor() {
    super("计划任务停止等待超时，仍有执行中的调度任务");
    this.name = "ScheduledTaskStopTimeoutError";
  }
}
