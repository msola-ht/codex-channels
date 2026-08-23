import type { Logger } from "pino";

import type {
  ConversationTarget,
  OutputEvent,
  TurnStatus,
} from "../conversation-core/index.js";
import type { ThreadHistoryPort } from "../application/index.js";
import type {
  ScheduledRun,
  ScheduledRunErrorCategory,
  ScheduledTask,
  ScheduledTaskStore,
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
  ) => Promise<ScheduledTaskRunValidation | undefined>;
  logger?: Logger;
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
  private readonly referencesByRun = new Map<string, ExecutionReference>();
  private readonly runIdsByThread = new Map<string, Set<string>>();
  private readonly pendingTerminalByRun = new Map<string, PendingTerminal>();
  private readonly pendingFailureByRun = new Map<string, ScheduledRunErrorCategory>();
  private readonly validateRun: ScheduledTaskRunCoordinatorOptions["validateRun"];
  private readonly logger: Logger | undefined;

  constructor(
    private readonly store: ScheduledTaskStore,
    private readonly router: SessionRouter,
    private readonly history: ThreadHistoryPort,
    options: ScheduledTaskRunCoordinatorOptions,
  ) {
    if (typeof options.validateRun !== "function") {
      throw new Error("计划任务恢复校验依赖不完整");
    }
    this.validateRun = options.validateRun;
    this.logger = options.logger;
  }

  initialize(): void {
    this.referencesByRun.clear();
    this.runIdsByThread.clear();
    this.pendingTerminalByRun.clear();
    this.pendingFailureByRun.clear();
    for (const run of this.store.listRunningRuns()) {
      if (run.threadId === null || run.turnId === null) {
        this.markUncertainIfRunning(run.runId);
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
  }

  /** Running scheduled Threads must remain bound while authoritative history is read. */
  runningThreadIds(): ReadonlySet<string> {
    return new Set(this.runIdsByThread.keys());
  }

  taskForThread(threadId: string): ScheduledTask | undefined {
    const runIds = this.runIdsByThread.get(threadId);
    for (const runId of runIds ?? []) {
      const reference = this.referencesByRun.get(runId);
      if (!reference) continue;
      const run = this.store.getRun(runId);
      if (run?.state === "dispatching" || run?.state === "running") {
        return this.store.getTask(reference.taskId);
      }
    }
    return undefined;
  }

  /** Revalidate persisted Runs before any Provider-specific subscription restore. */
  async prepareRecovery(): Promise<void> {
    for (const reference of [...this.referencesByRun.values()]) {
      await this.applyRecoveryValidation(reference);
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

  noteServerRequestRejected(threadId: string): void {
    for (const runId of this.runIdsByThread.get(threadId) ?? []) {
      const run = this.store.getRun(runId);
      if (run?.state === "dispatching" || run?.state === "running") {
        this.pendingFailureByRun.set(runId, "approval");
        try {
          this.store.markApprovalRejected(runId);
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
  onRunStateChanged(run: ScheduledRun): void {
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
    this.applyTerminal(run.runId, pending.status);
  }

  handleOutput(event: OutputEvent): void {
    if (event.type !== "turn.completed" || event.status === "inProgress") return;
    this.handleCompletion(event.threadId, event.turnId, event.status);
  }

  handleCompletion(
    threadId: string,
    turnId: string,
    status: Exclude<TurnStatus, "inProgress">,
  ): void {
    const run = this.referenceFor(threadId, turnId);
    if (!run) return;
    const stored = this.store.getRun(run.runId);
    if (!stored || stored.state === "completed" || stored.state === "failed" || stored.state === "interrupted") {
      return;
    }
    if (stored.state === "dispatching") {
      this.pendingTerminalByRun.set(run.runId, { status });
      return;
    }
    this.applyTerminal(run.runId, status);
  }

  /**
   * Reconcile persisted running Runs after subscriptions have been restored.
   * Idle is never treated as success: the exact Turn must be found in the
   * authoritative paginated history with a terminal status.
   */
  async recoverRunning(threadIds?: ReadonlySet<string>): Promise<void> {
    const running = [...this.referencesByRun.values()].filter((reference) =>
      threadIds === undefined || threadIds.has(reference.threadId));
    for (const reference of running) {
      const run = this.store.getRun(reference.runId);
      const task = this.store.getTask(reference.taskId);
      if (!run || run.state !== "running" || !task) continue;
      if (await this.applyRecoveryValidation(reference)) continue;
      const binding = this.router.targetForThread(reference.threadId);
      if (!binding || !this.router.isBackgroundThread(reference.threadId)) {
        this.markUncertainIfRunning(run.runId);
        continue;
      }
      const settings = this.router.modelSettingsForThread(reference.threadId);
      if (
        task.modelProvider != null
        && settings?.modelProvider !== task.modelProvider
      ) {
        this.markUncertainIfRunning(run.runId);
        continue;
      }
      if (
        task.model != null
        && settings?.model !== task.model
      ) {
        this.markUncertainIfRunning(run.runId);
        continue;
      }
      try {
        const turn = await this.findTurn(reference.threadId, reference.turnId);
        if (!turn) {
          this.markUncertainIfRunning(run.runId);
          continue;
        }
        if (turn.status === "inProgress") continue;
        this.applyTerminal(run.runId, turn.status);
        await this.router.releaseBackground(reference.threadId).catch((error) => {
          this.logger?.warn({ err: error, threadId: reference.threadId }, "恢复计划任务后台绑定清理失败");
        });
      } catch (error) {
        this.logger?.warn(
          { err: error, threadId: reference.threadId, turnId: reference.turnId },
          "计划任务运行状态无法从权威 Turn 历史恢复",
        );
        this.markUncertainIfRunning(run.runId);
      }
    }
  }

  private async findTurn(threadId: string, turnId: string | null) {
    if (turnId === null) return undefined;
    let cursor: string | null = null;
    const cursors = new Set<string>();
    for (let page = 0; page < 100; page += 1) {
      const result = await this.history.listThreadTurns(threadId, {
        cursor,
        limit: 100,
        sortDirection: "desc",
      });
      const match = result.turns.find((turn) => turn.id === turnId);
      if (match) return match;
      if (result.nextCursor === null) return undefined;
      if (cursors.has(result.nextCursor)) throw new Error("Codex Turn 历史返回循环游标");
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error("Codex Turn 历史分页超过安全上限");
  }

  private async applyRecoveryValidation(reference: ExecutionReference): Promise<boolean> {
    const run = this.store.getRun(reference.runId);
    const task = this.store.getTask(reference.taskId);
    if (!run || run.state !== "running") return true;
    if (!task) {
      this.markUncertainIfRunning(run.runId);
      return true;
    }
    const validation = await this.validateRun(task);
    if (!validation) return false;
    if (!validation.blockTask) {
      this.markUncertainIfRunning(run.runId);
      return true;
    }
    this.blockTask(task.taskId);
    this.markFailedIfRunning(run.runId, validation.category);
    try {
      await this.router.releaseBackground(reference.threadId);
    } catch (error) {
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

  private applyTerminal(
    runId: string,
    status: Exclude<TurnStatus, "inProgress">,
  ): void {
    const run = this.store.getRun(runId);
    if (!run || (run.state !== "running" && run.state !== "dispatching")) return;
    const forcedFailure = this.pendingFailureByRun.get(runId);
    this.pendingFailureByRun.delete(runId);
    if (forcedFailure !== undefined) {
      this.store.markFailed(runId, forcedFailure);
    } else if (status === "completed") {
      this.store.markCompleted(runId);
    } else if (status === "interrupted") {
      this.store.markInterrupted(runId);
    } else {
      this.store.markFailed(runId, "unknown");
    }
    this.forget(runId);
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
    this.pendingFailureByRun.delete(runId);
    const runs = this.runIdsByThread.get(reference.threadId);
    runs?.delete(runId);
    if (runs?.size === 0) this.runIdsByThread.delete(reference.threadId);
  }

  private blockTask(taskId: string): void {
    try {
      this.store.blockTask(taskId);
    } catch (error) {
      this.logger?.warn({ err: error, taskId }, "计划任务授权失败后无法标记 blocked");
    }
  }

  private markFailedIfRunning(runId: string, category: ScheduledRunErrorCategory): void {
    const run = this.store.getRun(runId);
    if (run?.state === "running") {
      this.store.markFailed(runId, category);
      this.forget(runId);
    }
  }

  private markUncertainIfRunning(runId: string): void {
    const run = this.store.getRun(runId);
    if (run?.state === "running") {
      this.store.markUncertain(runId);
      this.forget(runId);
    }
  }
}
