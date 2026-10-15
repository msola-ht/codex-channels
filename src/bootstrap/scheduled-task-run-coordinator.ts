import type { Logger } from "pino";

import type {
  ConversationTarget,
  OutputEvent,
  TurnStatus,
} from "../conversation-core/index.js";
import type { ThreadHistoryPort } from "../application/index.js";
import { ScheduledTaskStateError } from "../scheduled-tasks/index.js";
import type {
  ScheduledRun,
  ScheduledRunErrorCategory,
  ScheduledTask,
  ScheduledTaskStorePort,
} from "../scheduled-tasks/index.js";
import type { SessionRouter } from "../session-routing/index.js";

interface ExecutionReference {
  runId: string;
  taskId: string;
  threadId: string;
  turnId: string | null;
}

interface PendingTerminal {
  status: Exclude<TurnStatus, "inProgress">;
}

export interface ScheduledTaskRunCoordinatorOptions {
  /** Revalidate the same authorization boundary used before a fresh Run. */
  validateRun: (
    task: ScheduledTask,
    signal?: AbortSignal,
  ) => Promise<ScheduledTaskRunValidation | undefined>;
  logger?: Logger;
  onRecovered?: (run: ScheduledRun, target: ConversationTarget) => void;
}

export interface ScheduledTaskRunValidation {
  readonly category: ScheduledRunErrorCategory;
  /** Only permanent authorization/configuration loss blocks future occurrences. */
  readonly blockTask: boolean;
}

/**
 * Bridges App Server turn lifecycle events to the independent Run Store.
 * It is deliberately keyed by persisted Thread/Turn IDs, not by Core's
 * in-memory active-turn map, so Gateway restart can reconcile from history.
 */
export class ScheduledTaskRunCoordinator {
  private initialized = false;
  private readonly referencesByRun = new Map<string, ExecutionReference>();
  private readonly runIdsByThread = new Map<string, Set<string>>();
  private readonly pendingTerminalByRun = new Map<string, PendingTerminal>();
  private readonly pendingFailureByRun = new Map<string, ScheduledRunErrorCategory>();
  private readonly validateRun: ScheduledTaskRunCoordinatorOptions["validateRun"];
  private readonly logger: Logger | undefined;
  private readonly onRecovered: ScheduledTaskRunCoordinatorOptions["onRecovered"];

  constructor(
    private readonly store: ScheduledTaskStorePort,
    private readonly router: SessionRouter,
    private readonly history: ThreadHistoryPort,
    options: ScheduledTaskRunCoordinatorOptions,
  ) {
    if (typeof options.validateRun !== "function") {
      throw new Error("计划任务恢复校验依赖不完整");
    }
    this.validateRun = options.validateRun;
    this.logger = options.logger;
    this.onRecovered = options.onRecovered;
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    this.initialized = false;
    this.referencesByRun.clear();
    this.runIdsByThread.clear();
    this.pendingTerminalByRun.clear();
    this.pendingFailureByRun.clear();
    let afterRunId: string | undefined;
    while (!signal?.aborted) {
      const runs = await this.store.listRunningRuns(afterRunId === undefined ? {} : { afterRunId });
      if (signal?.aborted) return;
      for (const run of runs) {
        if (signal?.aborted) return;
        if (run.threadId === null || run.turnId === null) {
          await this.markUncertainIfRunning(run.runId, signal);
          continue;
        }
        this.remember({
          runId: run.runId,
          taskId: run.taskId,
          threadId: run.threadId,
          turnId: run.turnId,
        });
        if (run.errorCategory === "approval") {
          this.pendingFailureByRun.set(run.runId, "approval");
        }
      }
      if (runs.length < 200) {
        this.initialized = true;
        return;
      }
      afterRunId = runs.at(-1)!.runId;
    }
  }

  /** Running scheduled Threads must remain bound while authoritative history is read. */
  runningThreadIds(): ReadonlySet<string> {
    return new Set(this.runIdsByThread.keys());
  }

  async taskForThread(threadId: string): Promise<ScheduledTask | undefined> {
    if (!this.initialized) throw new Error("计划任务运行关联尚未就绪");
    const runIds = this.runIdsByThread.get(threadId);
    for (const runId of runIds ?? []) {
      const reference = this.referencesByRun.get(runId);
      if (!reference) continue;
      const run = await this.store.getRun(runId);
      if (run?.state === "dispatching" || run?.state === "running") {
        return this.store.getTask(reference.taskId);
      }
    }
    return undefined;
  }

  /** Revalidate persisted Runs before any Provider-specific subscription restore. */
  async prepareRecovery(signal?: AbortSignal): Promise<void> {
    for (const reference of [...this.referencesByRun.values()]) {
      if (signal?.aborted) return;
      await this.applyRecoveryValidation(reference, signal);
    }
  }

  onThreadStarted(run: ScheduledRun, _target: ConversationTarget, threadId: string): void {
    this.remember({
      runId: run.runId,
      taskId: run.taskId,
      threadId,
      turnId: null,
    });
  }

  onTurnStarted(
    run: ScheduledRun,
    _target: ConversationTarget,
    threadId: string,
    turnId: string,
  ): void {
    this.remember({
      runId: run.runId,
      taskId: run.taskId,
      threadId,
      turnId,
    });
  }

  async noteServerRequestRejected(threadId: string): Promise<void> {
    for (const runId of this.runIdsByThread.get(threadId) ?? []) {
      this.pendingFailureByRun.set(runId, "approval");
      const run = await this.store.getRun(runId);
      if (run?.state === "dispatching" || run?.state === "running") {
        this.pendingFailureByRun.set(runId, "approval");
        try {
          await this.store.markApprovalRejected(runId);
        } catch (error) {
          this.logger?.warn(
            { err: error, runId, threadId },
            "计划任务无人值守审批拒绝状态持久化失败",
          );
        }
      }
    }
  }

  /** Apply a completion that raced the scheduler's dispatching -> running write. */
  async onRunStateChanged(run: ScheduledRun): Promise<void> {
    if (
      run.state === "completed"
      || run.state === "failed"
      || run.state === "interrupted"
      || run.state === "uncertain"
    ) {
      this.pendingTerminalByRun.delete(run.runId);
      this.pendingFailureByRun.delete(run.runId);
      this.forget(run.runId);
      return;
    }
    const pending = this.pendingTerminalByRun.get(run.runId);
    if (!pending) return;
    this.pendingTerminalByRun.delete(run.runId);
    await this.applyTerminal(run.runId, pending.status);
  }

  async handleOutput(event: OutputEvent): Promise<void> {
    if (event.type !== "turn.completed" || event.status === "inProgress") return;
    await this.handleCompletion(event.threadId, event.turnId, event.status);
  }

  /** Remember live completion before asynchronous output consumers can fall behind recovery. */
  observeOutput(event: OutputEvent): void {
    if (event.type !== "turn.completed" || event.status === "inProgress") return;
    const reference = this.referenceFor(event.threadId, event.turnId);
    if (reference) this.pendingTerminalByRun.set(reference.runId, { status: event.status });
  }

  async handleCompletion(
    threadId: string,
    turnId: string,
    status: Exclude<TurnStatus, "inProgress">,
  ): Promise<void> {
    const run = this.referenceFor(threadId, turnId);
    if (!run) return;
    const stored = await this.store.getRun(run.runId);
    if (!stored || stored.state === "completed" || stored.state === "failed" || stored.state === "interrupted") {
      return;
    }
    if (stored.state === "dispatching") {
      this.pendingTerminalByRun.set(run.runId, { status });
      return;
    }
    await this.applyTerminal(run.runId, status);
  }

  /**
   * Reconcile persisted running Runs after subscriptions have been restored.
   * Idle is never treated as success: the exact Turn must be found in the
   * authoritative paginated history with a terminal status.
   */
  async recoverRunning(threadIds?: ReadonlySet<string>, signal?: AbortSignal): Promise<void> {
    const running = [...this.referencesByRun.values()].filter((reference) =>
      threadIds === undefined || threadIds.has(reference.threadId));
    for (const reference of running) {
      if (signal?.aborted) return;
      const run = await this.store.getRun(reference.runId);
      const task = await this.store.getTask(reference.taskId);
      if (signal?.aborted) return;
      if (!run || run.state !== "running" || !task) continue;
      if (await this.applyRecoveryValidation(reference, signal)) continue;
      if (signal?.aborted) return;
      const binding = this.router.targetForThread(reference.threadId);
      if (!binding || !this.router.isBackgroundThread(reference.threadId)) {
        await this.markUncertainIfRunning(run.runId, signal);
        continue;
      }
      const settings = this.router.modelSettingsForThread(reference.threadId);
      if (
        task.modelProvider != null
        && settings?.modelProvider !== task.modelProvider
      ) {
        await this.markUncertainIfRunning(run.runId, signal);
        continue;
      }
      if (
        task.model != null
        && settings?.model !== task.model
      ) {
        await this.markUncertainIfRunning(run.runId, signal);
        continue;
      }
      try {
        const turn = await this.findTurn(reference.threadId, reference.turnId, signal);
        if (signal?.aborted) return;
        if (!turn) {
          await this.markUncertainIfRunning(run.runId, signal);
          continue;
        }
        if (turn.status === "inProgress") continue;
        const liveCompletionObserved = this.pendingTerminalByRun.has(run.runId);
        const currentTarget = this.router.targetForThread(reference.threadId);
        const stillOwned = currentTarget?.surface === binding.surface
          && currentTarget.accountId === binding.accountId
          && currentTarget.conversationId === binding.conversationId
          && currentTarget.surface === task.surface
          && currentTarget.accountId === task.accountId
          && currentTarget.conversationId === task.conversationId
          && this.router.isBackgroundThread(reference.threadId);
        const recovered = await this.applyTerminal(run.runId, turn.status, signal);
        if (signal?.aborted) return;
        if (!stillOwned) continue;
        if (recovered && !liveCompletionObserved) this.onRecovered?.(recovered, currentTarget);
        await this.router.releaseBackground(reference.threadId).catch((error) => {
          if (signal?.aborted) return;
          this.logger?.warn({ err: error, threadId: reference.threadId }, "恢复计划任务后台绑定清理失败");
        });
      } catch (error) {
        if (signal?.aborted) return;
        this.logger?.warn(
          { err: error, threadId: reference.threadId, turnId: reference.turnId },
          "计划任务运行状态无法从权威 Turn 历史恢复",
        );
        await this.markUncertainIfRunning(run.runId, signal);
      }
    }
  }

  private async findTurn(threadId: string, turnId: string | null, signal?: AbortSignal) {
    if (turnId === null) return undefined;
    let cursor: string | null = null;
    const cursors = new Set<string>();
    for (let page = 0; page < 100; page += 1) {
      signal?.throwIfAborted();
      const result = await this.history.listThreadTurns(threadId, {
        cursor,
        limit: 100,
        sortDirection: "desc",
      });
      signal?.throwIfAborted();
      const match = result.turns.find((turn) => turn.id === turnId);
      if (match) return match;
      if (result.nextCursor === null) return undefined;
      if (cursors.has(result.nextCursor)) throw new Error("Codex Turn 历史返回循环游标");
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error("Codex Turn 历史分页超过安全上限");
  }

  private async applyRecoveryValidation(reference: ExecutionReference, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return true;
    const run = await this.store.getRun(reference.runId);
    const task = await this.store.getTask(reference.taskId);
    if (signal?.aborted) return true;
    if (!run || run.state !== "running") return true;
    if (!task) {
      await this.markUncertainIfRunning(run.runId, signal);
      return true;
    }
    let validation: ScheduledTaskRunValidation | undefined;
    try {
      validation = await this.validateRun(task, signal);
    } catch (error) {
      if (signal?.aborted) return true;
      throw error;
    }
    if (signal?.aborted) return true;
    if (!validation) return false;
    if (!validation.blockTask) {
      await this.markUncertainIfRunning(run.runId, signal);
      return true;
    }
    await this.blockTask(task.taskId);
    if (signal?.aborted) return true;
    await this.markFailedIfRunning(run.runId, validation.category, signal);
    if (signal?.aborted) return true;
    try {
      await this.router.releaseBackground(reference.threadId);
    } catch (error) {
      if (signal?.aborted) return true;
      if (validation.category === "provider") {
        this.router.forgetThread(reference.threadId);
      }
      this.logger?.warn(
        { err: error, threadId: reference.threadId },
        "计划任务恢复校验失败后的后台绑定清理失败",
      );
    }
    return true;
  }

  private async applyTerminal(
    runId: string,
    status: Exclude<TurnStatus, "inProgress">,
    signal?: AbortSignal,
  ): Promise<ScheduledRun | undefined> {
    const run = await this.store.getRun(runId);
    if (signal?.aborted) return;
    if (!run || (run.state !== "running" && run.state !== "dispatching")) return;
    const forcedFailure = this.pendingFailureByRun.get(runId);
    this.pendingFailureByRun.delete(runId);
    try {
      if (forcedFailure !== undefined) {
        await this.store.markFailed(runId, forcedFailure);
      } else if (status === "completed") {
        await this.store.markCompleted(runId);
      } else if (status === "interrupted") {
        await this.store.markInterrupted(runId);
      } else {
        await this.store.markFailed(runId, "unknown");
      }
    } catch (error) {
      if (!(error instanceof ScheduledTaskStateError)) throw error;
      const latest = await this.store.getRun(runId);
      if (!latest || latest.state === "dispatching" || latest.state === "running" || latest.state === "uncertain") throw error;
    }
    this.forget(runId);
    return this.store.getRun(runId);
  }

  private referenceFor(threadId: string, turnId: string): ExecutionReference | undefined {
    return [...(this.runIdsByThread.get(threadId) ?? [])]
      .map((runId) => this.referencesByRun.get(runId))
      .find((reference): reference is ExecutionReference =>
        reference !== undefined && (reference.turnId === null || reference.turnId === turnId));
  }

  private remember(reference: ExecutionReference): void {
    this.referencesByRun.set(reference.runId, reference);
    const runs = this.runIdsByThread.get(reference.threadId) ?? new Set<string>();
    runs.add(reference.runId);
    this.runIdsByThread.set(reference.threadId, runs);
  }

  private forget(runId: string): void {
    const reference = this.referencesByRun.get(runId);
    if (!reference) return;
    this.referencesByRun.delete(runId);
    this.pendingTerminalByRun.delete(runId);
    this.pendingFailureByRun.delete(runId);
    const runs = this.runIdsByThread.get(reference.threadId);
    runs?.delete(runId);
    if (runs?.size === 0) this.runIdsByThread.delete(reference.threadId);
  }

  private async blockTask(taskId: string): Promise<void> {
    try {
      await this.store.blockTask(taskId);
    } catch (error) {
      this.logger?.warn({ err: error, taskId }, "计划任务授权失败后无法标记 blocked");
    }
  }

  private async markFailedIfRunning(runId: string, category: ScheduledRunErrorCategory, signal?: AbortSignal): Promise<void> {
    const run = await this.store.getRun(runId);
    if (signal?.aborted) return;
    if (run?.state === "running") {
      await this.store.markFailed(runId, category);
      this.forget(runId);
    }
  }

  private async markUncertainIfRunning(runId: string, signal?: AbortSignal): Promise<void> {
    const run = await this.store.getRun(runId);
    if (signal?.aborted) return;
    if (run?.state === "running") {
      await this.store.markUncertain(runId);
      this.forget(runId);
    }
  }
}
