import {
  ScheduledTaskStateError,
  type ScheduledRun,
  type ScheduledTask,
  type ScheduledTaskClock,
  type ScheduledTaskExecutionPort,
  type ScheduledTaskExecutionResult,
  type ScheduledTaskSchedulerOptions,
  type ScheduledTaskStorePort,
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
  private manualRunTail: Promise<void> = Promise.resolve();
  private lastCleanupAttemptAt: number | undefined;
  private cleanupIncomplete = false;

  constructor(
    private readonly store: ScheduledTaskStorePort,
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
    if (!Number.isSafeInteger(this.maxTasksPerTick) || this.maxTasksPerTick < 1 || this.maxTasksPerTick > 1_000) {
      throw new RangeError("单次调度任务数上限必须在 1 到 1000 之间");
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
      const result: MutableTickResult = {
        claimed: [],
        skippedOverlap: [],
        skippedCapacity: [],
        blocked: [],
        missed: [],
      };
      let processed = 0;
      const dispatchGroups = new Map<string, DispatchJob[]>();
      let claimOrder = 0;
      let claimFailure: Error | undefined;
      try {
        for (const initialTask of await this.store.listDueTasks(nowMs, this.maxTasksPerTick)) {
          if (this.stopping) break;
          if (processed >= this.maxTasksPerTick) break;
          let task = await this.store.getTask(initialTask.taskId);
          if (this.stopping) break;
          if (!task || task.status !== "active" || task.nextRunAt === null) continue;

          while (
            task.nextRunAt !== null
            && task.nextRunAt < nowMs - this.catchUpWindowMs
            && processed < this.maxTasksPerTick
            && !this.stopping
          ) {
            const missed = await this.store.claimDue(task.taskId, task.nextRunAt, "missed", nowMs);
            result.missed.push(missed.run);
            processed += 1;
            task = await this.store.getTask(task.taskId);
            if (!task || task.status !== "active") break;
          }
          if (!task || task.status !== "active" || task.nextRunAt === null || task.nextRunAt > nowMs) continue;
          if (processed >= this.maxTasksPerTick) break;

          const scheduledFor = task.nextRunAt;
          if (await this.store.hasBlockingRun(task.taskId)) {
            if (this.stopping) break;
            const skipped = await this.store.claimDue(task.taskId, scheduledFor, "claimed", nowMs);
            if (skipped.kind === "blocked") result.blocked.push(skipped.run);
            else result.skippedOverlap.push(skipped.run);
            processed += 1;
            continue;
          }
          const key = conversationKey(task);
          const reservedCapacity = dispatchGroups.get(key)?.length ?? 0;
          const capacityAvailable = await this.capacityAvailable(task, reservedCapacity);
          if (this.stopping) break;
          if (!capacityAvailable) {
            const skipped = await this.store.claimDue(task.taskId, scheduledFor, "skipped_capacity", nowMs);
            result.skippedCapacity.push(skipped.run);
            processed += 1;
            continue;
          }

          const claim = await this.store.claimDue(task.taskId, scheduledFor, "claimed", nowMs);
          processed += 1;
          if (claim.kind === "claimed") {
            // Claim serially in stable order. Independent Conversations
            // dispatch concurrently, but one Conversation stays in claim order
            // so async validation cannot reorder its fresh Thread starts.
            const group = dispatchGroups.get(key) ?? [];
            group.push({ order: claimOrder, task, run: claim.run });
            dispatchGroups.set(key, group);
            claimOrder += 1;
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
      } catch (error) {
        // Claims already persisted must be settled even if a later read or
        // capacity check fails. No new execution starts after this failure.
        claimFailure = error instanceof Error ? error : new Error("计划任务领取失败", { cause: error });
      }
      const dispatched = await Promise.allSettled(
        [...dispatchGroups.values()].map(async (group) => {
          const resolved: Array<{ readonly order: number; readonly run: ScheduledRun }> = [];
          const failures: unknown[] = [];
          for (const job of group) {
            try {
              if (this.stopping || claimFailure !== undefined || failures.length > 0) {
                const interrupted = await this.store.markInterrupted(
                  job.run.runId,
                  this.transitionTime(job.run),
                );
                resolved.push({
                  order: job.order,
                  run: await this.notifyRunStateChanged(interrupted),
                });
                continue;
              }
              resolved.push({
                order: job.order,
                run: await this.dispatchSafely(job.task, job.run),
              });
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length > 0) throw new AggregateError(failures, "计划任务派发状态收敛失败");
          return resolved;
        }),
      );
      const dispatchFailure = dispatched.find((entry) => entry.status === "rejected");
      if (dispatchFailure?.status === "rejected") {
        throw new AggregateError(dispatched.flatMap((entry) => entry.status === "rejected" ? [entry.reason as unknown] : []), "计划任务批次收敛失败");
      }
      if (claimFailure !== undefined) throw claimFailure;
      const resolvedByOrder = new Map(
        dispatched.flatMap((entry) => entry.status === "fulfilled" ? entry.value : [])
          .map(({ order, run }) => [order, run]),
      );
      result.claimed.push(
        ...[...resolvedByOrder.keys()].sort((left, right) => left - right)
          .map((order) => resolvedByOrder.get(order)!),
      );
      if (!this.stopping) await this.maybeCleanup(nowMs);
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

  runTaskNow(taskId: string, nowMs = this.clock.now()): Promise<ScheduledRun> {
    return this.runManual({ taskId }, nowMs);
  }

  retryRun(runId: string, nowMs = this.clock.now()): Promise<ScheduledRun> {
    return this.runManual({ runId }, nowMs);
  }

  private async runManual(selection: { taskId: string } | { runId: string }, nowMs: number): Promise<ScheduledRun> {
    let releaseManualRun!: () => void;
    const predecessor = this.manualRunTail;
    this.manualRunTail = new Promise<void>((resolve) => {
      releaseManualRun = resolve;
    });
    await predecessor;
    try {
      while (this.ticking && this.tickCompletion !== undefined) {
        await this.tickCompletion;
      }
      if (this.stopping) throw new Error("计划任务调度器正在停止");
      this.ticking = true;
      this.tickCompletion = new Promise<void>((resolve) => {
        this.resolveTickCompletion = resolve;
      });
      const retry = "runId" in selection ? await this.store.getRun(selection.runId) : undefined;
      if ("runId" in selection && retry?.state !== "uncertain") {
        throw new ScheduledTaskStateError("只有 uncertain Run 可以显式解除后重试");
      }
      const taskId = "taskId" in selection ? selection.taskId : retry!.taskId;
      const task = await this.store.getTask(taskId);
      if (!task) throw new Error(`任务不存在：${taskId}`);
      const claimOccurrence = (result: "claimed" | "skipped_capacity") => retry
        ? this.store.claimRetry(retry.runId, nowMs, result)
        : this.store.claimManual(taskId, nowMs, result);
      if (!await this.capacityAvailable(task, 0, retry !== undefined)) {
        if (this.stopping) throw new Error("计划任务调度器正在停止");
        return (await claimOccurrence("skipped_capacity")).run;
      }
      if (this.stopping) throw new Error("计划任务调度器正在停止");
      const claim = await claimOccurrence("claimed");
      if (claim.kind !== "claimed") return claim.run;
      return await this.dispatchSafely(task, claim.run);
    } finally {
      if (this.ticking) {
        this.ticking = false;
        this.resolveTickCompletion?.();
        this.resolveTickCompletion = undefined;
      }
      releaseManualRun();
    }
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

  async recoverAfterCrash(nowMs = this.clock.now(), signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted && !this.stopping) {
      const recovered = await this.store.recoverAfterCrash(nowMs);
      if (recovered.length < 200) return;
    }
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

  private async capacityAvailable(
    task: ScheduledTask,
    reservedCapacity: number,
    replacingUncertain = false,
  ): Promise<boolean> {
    const activeCount = await this.store.countConversationActiveRuns(task) - (replacingUncertain ? 1 : 0);
    if (this.stopping) return false;
    if (activeCount >= this.maxConcurrentRunsPerConversation) return false;
    if (this.executor.availableCapacity !== undefined) {
      const available = await this.executor.availableCapacity(task);
      if (!Number.isSafeInteger(available) || available < 0) {
        throw new RangeError("执行端口返回的后台容量无效");
      }
      return reservedCapacity < available;
    }
    return this.executor.canStart === undefined ? true : await this.executor.canStart(task);
  }

  private async dispatch(task: ScheduledTask, run: ScheduledRun): Promise<ScheduledRun> {
    if (this.stopping) {
      return await this.notifyRunStateChanged(await this.store.markInterrupted(run.runId, this.transitionTime(run)));
    }
    const controller = new AbortController();
    this.abortControllers.add(controller);
    let outcome: ScheduledTaskExecutionResult;
    try {
      outcome = await this.executor.execute(task, run, controller.signal);
    } catch {
      const updated = await this.store.markUncertain(run.runId, this.transitionTime(run));
      return await this.notifyRunStateChanged(updated);
    } finally {
      this.abortControllers.delete(controller);
    }
    switch (outcome.kind) {
      case "running":
        {
          const updated = await this.store.markRunning(
            run.runId,
            this.transitionTime(run),
            executionIdentifiers(outcome),
          );
          return await this.notifyRunStateChanged(updated);
        }
      case "completed":
        {
          const started = await this.store.markRunning(
            run.runId,
            this.transitionTime(run),
            executionIdentifiers(outcome),
          );
          const reconciled = await this.notifyRunStateChanged(started);
          if (reconciled.state !== "running") return reconciled;
          const updated = await this.store.markCompleted(
            run.runId,
            this.transitionTime(reconciled),
            executionIdentifiers(outcome),
          );
          return await this.notifyRunStateChanged(updated);
        }
      case "failed":
        {
          const updated = await this.store.markFailed(
            run.runId,
            outcome.category ?? "unknown",
            this.transitionTime(run),
            executionIdentifiers(outcome),
          );
          if (outcome.blockTask) {
            try {
              await this.store.blockTask(task.taskId, updated.completedAt ?? this.transitionTime(run));
            } catch (error) {
              this.reportError(error);
            }
          }
          return await this.notifyRunStateChanged(updated);
        }
      case "interrupted":
        {
          const updated = await this.store.markInterrupted(
            run.runId,
            this.transitionTime(run),
            executionIdentifiers(outcome),
          );
          return await this.notifyRunStateChanged(updated);
        }
      case "uncertain":
        {
          const updated = await this.store.markUncertain(
            run.runId,
            this.transitionTime(run),
            executionIdentifiers(outcome),
          );
          return await this.notifyRunStateChanged(updated);
        }
    }
  }

  private async dispatchSafely(task: ScheduledTask, run: ScheduledRun): Promise<ScheduledRun> {
    try {
      return await this.dispatch(task, run);
    } catch (error) {
      try {
        const latest = await this.store.getRun(run.runId);
        if (latest && latest.state !== "dispatching" && latest.state !== "running") {
          // A live completion can win an awaited transition. Its durable
          // terminal row is authoritative; never rewrite it as uncertain.
          if (error instanceof ScheduledTaskStateError) return latest;
        } else if (latest) {
          const uncertain = await this.store.markUncertain(run.runId, this.transitionTime(latest));
          await this.notifyRunStateChanged(uncertain);
        }
      } catch (recoveryError) {
        this.reportError(recoveryError);
      }
      throw error;
    }
  }

  private async notifyRunStateChanged(run: ScheduledRun): Promise<ScheduledRun> {
    try {
      await this.executor.onRunStateChanged?.(run);
    } catch (error) {
      // The Store transition is already durable.  A coordinator observer may
      // fail, but that must not make this dispatch look like an unknown write
      // or cause the scheduler to retry it.
      this.reportError(error);
    }
    // Observers may reconcile a raced completion and return the newer Store
    // row.  Always hand callers the authoritative latest row when available.
    return await this.store.getRun(run.runId) ?? run;
  }

  private transitionTime(run: ScheduledRun): number {
    return Math.max(
      this.clock.now(),
      run.startedAt ?? run.dispatchStartedAt ?? run.scheduledFor,
    );
  }

  private reportError(error: unknown): void {
    if (this.onError === undefined) return;
    try {
      this.onError(error);
    } catch {
      // An observer must never become an unhandled timer rejection.
    }
  }

  private async maybeCleanup(nowMs: number): Promise<void> {
    if (
      this.lastCleanupAttemptAt !== undefined
      && !this.cleanupIncomplete
      && nowMs - this.lastCleanupAttemptAt < scheduledTaskCleanupIntervalMs
    ) return;
    this.lastCleanupAttemptAt = nowMs;
    try {
      this.cleanupIncomplete = !(await this.store.cleanup(nowMs)).complete;
    } catch (error) {
      // Cleanup is terminal-row maintenance; a failed cleanup must not stop safe scheduling.
      this.reportError(error);
    }
  }
}

interface DispatchJob {
  readonly order: number;
  readonly task: ScheduledTask;
  readonly run: ScheduledRun;
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
  outcome: Extract<ScheduledTaskExecutionResult, {
    readonly kind: "running" | "completed" | "failed" | "interrupted" | "uncertain";
  }>,
): { readonly threadId?: string | null; readonly turnId?: string | null } {
  return {
    ...(outcome.threadId === undefined ? {} : { threadId: outcome.threadId }),
    ...(outcome.turnId === undefined ? {} : { turnId: outcome.turnId }),
  };
}

function conversationKey(task: ScheduledTask): string {
  return JSON.stringify([task.surface, task.accountId, task.conversationId]);
}

export class ScheduledTaskStopTimeoutError extends Error {
  readonly code = "scheduled-task.stop.timeout" as const;

  constructor() {
    super("计划任务停止等待超时，仍有执行中的调度任务");
    this.name = "ScheduledTaskStopTimeoutError";
  }
}
