import type { Logger } from "pino";

import type { ProviderRoutingClient } from "../codex-client/index.js";
import {
  conversationTargetKey,
  surfaceAccountKey,
  type OutputEvent,
} from "../conversation-core/index.js";
import type { EventBus } from "../event-bus/index.js";
import type {
  SessionRouter,
  SubscriptionRestoreFailure,
} from "../session-routing/index.js";
import type { ConversationBinding } from "../storage/index.js";
import type { SurfaceAdapter } from "../surfaces/index.js";

const retryDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const escalationAttempts = 3;

export interface PendingBindingRestore {
  binding: ConversationBinding;
  occupiedNotified: boolean;
  failureCount: number;
}

export interface ScheduledBindingRecoveryPort {
  runningThreadIds(): ReadonlySet<string>;
  taskForThread(threadId: string): { modelProvider?: string | null } | undefined;
  recoverRunning(threadIds: ReadonlySet<string>): Promise<void>;
}

export interface BindingRestoreCoordinatorOptions {
  codex: Pick<ProviderRoutingClient, "knownProvider">;
  router: SessionRouter;
  output: EventBus<OutputEvent>;
  enabledSurfaces(): readonly Pick<SurfaceAdapter, "surface" | "accountId">[];
  scheduledRecovery(): ScheduledBindingRecoveryPort | undefined;
  markTurnStarted(
    target: ConversationBinding["target"],
    threadId: string,
    turnId: string,
  ): void;
  logger: Logger;
}

export class BindingRestoreCoordinator {
  private readonly disconnectedProviders: Set<string>;
  private readonly disconnectedBindingsByProvider: Map<string, Set<string>>;
  private readonly pendingBindingRestores: Map<string, PendingBindingRestore>;
  private readonly restoringThreadIds: Set<string>;
  private restoreTimer: NodeJS.Timeout | undefined;
  private readonly restoreTasks = new Set<Promise<void>>();
  private restoreAttempt: number;
  private stopped = false;

  constructor(
    private readonly options: BindingRestoreCoordinatorOptions,
    state?: {
      disconnectedProviders: Set<string>;
      disconnectedBindingsByProvider: Map<string, Set<string>>;
      pendingBindingRestores: Map<string, PendingBindingRestore>;
      restoringThreadIds: Set<string>;
      restoreAttempt: number;
    },
  ) {
    this.disconnectedProviders = state?.disconnectedProviders ?? new Set<string>();
    this.disconnectedBindingsByProvider = state?.disconnectedBindingsByProvider
      ?? new Map<string, Set<string>>();
    this.pendingBindingRestores = state?.pendingBindingRestores
      ?? new Map<string, PendingBindingRestore>();
    this.restoringThreadIds = state?.restoringThreadIds ?? new Set<string>();
    this.restoreAttempt = state?.restoreAttempt ?? 0;
  }

  isRestoring(threadId: string): boolean {
    const provider = this.options.codex.knownProvider(threadId);
    return this.pendingBindingRestores.has(threadId)
      || this.restoringThreadIds.has(threadId)
      || (provider !== undefined && this.disconnectedProviders.has(provider));
  }

  hasPending(threadId: string): boolean {
    return this.pendingBindingRestores.has(threadId);
  }

  markProviderDisconnected(provider: string, threadIds: ReadonlySet<string>): void {
    this.disconnectedProviders.add(provider);
    if (threadIds.size === 0) return;
    const existing = this.disconnectedBindingsByProvider.get(provider);
    if (existing) {
      for (const threadId of threadIds) existing.add(threadId);
      return;
    }
    this.disconnectedBindingsByProvider.set(provider, new Set(threadIds));
  }

  hasDisconnectedProviders(): boolean {
    return this.disconnectedProviders.size > 0;
  }

  nextDisconnectedProvider(): string | undefined {
    return this.disconnectedProviders.values().next().value;
  }

  affectedThreadsForProvider(provider: string): ReadonlySet<string> | undefined {
    return this.disconnectedBindingsByProvider.get(provider);
  }

  completeProviderReconnect(provider: string): void {
    this.disconnectedProviders.delete(provider);
    this.disconnectedBindingsByProvider.delete(provider);
  }

  restore(
    provider?: string,
    requestedThreadIds?: ReadonlySet<string>,
  ): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const task = this.restoreOnce(provider, requestedThreadIds);
    const tracked = task.finally(() => {
      this.restoreTasks.delete(tracked);
    });
    this.restoreTasks.add(tracked);
    return tracked;
  }

  private async restoreOnce(
    provider?: string,
    requestedThreadIds?: ReadonlySet<string>,
  ): Promise<void> {
    this.prunePendingRestores();
    const enabledSurfaces = new Set(
      this.options.enabledSurfaces().map((surface) =>
        surfaceAccountKey(surface.surface, surface.accountId)),
    );
    const scheduledRecovery = this.options.scheduledRecovery();
    const scheduledThreadIds = scheduledRecovery?.runningThreadIds()
      ?? new Set<string>();
    const candidateThreadIds = new Set(
      this.options.router.allBindings()
        .filter((binding) => {
          const bindingProvider = this.options.codex.knownProvider(binding.threadId);
          return !this.stopped
            && (
              enabledSurfaces.has(surfaceAccountKey(
                binding.target.surface,
                binding.target.accountId,
              ))
              || scheduledThreadIds.has(binding.threadId)
            )
            && !this.restoringThreadIds.has(binding.threadId)
            && (requestedThreadIds === undefined
              || requestedThreadIds.has(binding.threadId))
            && (provider === undefined || bindingProvider === provider)
            && (provider !== undefined
              || bindingProvider === undefined
              || !this.disconnectedProviders.has(bindingProvider));
        })
        .map((binding) => binding.threadId),
    );
    if (candidateThreadIds.size === 0) {
      if (provider === undefined && requestedThreadIds === undefined) {
        await scheduledRecovery?.recoverRunning(scheduledThreadIds);
      }
      return;
    }
    for (const threadId of candidateThreadIds) {
      this.restoringThreadIds.add(threadId);
    }
    const restoredThreadIds = new Set<string>();
    let failures: SubscriptionRestoreFailure[];
    try {
      failures = await this.options.router.restoreSubscriptions(
        (_target, binding) => candidateThreadIds.has(binding.threadId),
        (binding, thread) => {
          restoredThreadIds.add(binding.threadId);
          if (thread.status.type !== "active") {
            if (
              this.options.router.isBackgroundThread(binding.threadId)
              && !scheduledThreadIds.has(binding.threadId)
            ) {
              this.options.output.publish({
                type: "warning",
                target: binding.target,
                threadId: binding.threadId,
                background: true,
                message: "后台任务已在 Gateway 离线期间结束，可通过 /resume 查看完整会话。",
              }, true);
            }
            return;
          }
          if (thread.activeTurnId) {
            this.options.markTurnStarted(
              binding.target,
              binding.threadId,
              thread.activeTurnId,
            );
            this.options.logger.info(
              {
                surface: binding.target.surface,
                accountId: binding.target.accountId,
                conversationId: binding.target.conversationId,
                threadId: binding.threadId,
                turnId: thread.activeTurnId,
              },
              "已恢复正在运行的 Codex Turn",
            );
          }
        },
        (binding) => {
          const task = scheduledRecovery?.taskForThread(binding.threadId);
          return task?.modelProvider == null
            ? {}
            : { modelProvider: task.modelProvider };
        },
        (binding) => scheduledThreadIds.has(binding.threadId),
      );
    } finally {
      for (const threadId of candidateThreadIds) {
        this.restoringThreadIds.delete(threadId);
      }
    }
    for (const threadId of restoredThreadIds) {
      const pending = this.pendingBindingRestores.get(threadId);
      if (!pending) continue;
      this.pendingBindingRestores.delete(threadId);
      if (pending.occupiedNotified) {
        this.publishAvailability(pending.binding, "available");
      }
    }
    await scheduledRecovery?.recoverRunning(restoredThreadIds);
    for (const failure of failures) {
      if (!failure.bindingRemoved && !this.isCurrentBinding(failure.binding)) continue;
      this.options.logger.warn(
        {
          err: failure.error,
          threadId: failure.binding.threadId,
          bindingRemoved: failure.bindingRemoved,
        },
        failure.bindingRemoved
          ? "恢复 Codex Thread 订阅永久失败，已移除持久化绑定"
          : "恢复 Codex Thread 订阅暂时失败，已保留持久化绑定",
      );
      if (failure.bindingRemoved) {
        this.pendingBindingRestores.delete(failure.binding.threadId);
        continue;
      }
      const previous = this.pendingBindingRestores.get(failure.binding.threadId);
      const failureCount = (previous?.failureCount ?? 0) + 1;
      const shouldNotifyOccupied = failure.reason === "active-writer"
        || (failure.reason === "other" && failureCount >= escalationAttempts);
      const occupiedNotified = previous?.occupiedNotified === true
        || shouldNotifyOccupied;
      this.pendingBindingRestores.set(failure.binding.threadId, {
        binding: failure.binding,
        occupiedNotified,
        failureCount,
      });
      if (shouldNotifyOccupied && !previous?.occupiedNotified) {
        this.publishAvailability(failure.binding, "occupied");
      }
    }
    const bindingCount = this.options.router.allBindings().length;
    if (bindingCount > 0) {
      this.options.logger.info(
        { bindings: bindingCount },
        "已恢复外部会话与 Codex Thread 绑定",
      );
    }
    if (this.pendingBindingRestores.size === 0) {
      this.restoreAttempt = 0;
    }
  }

  retry(threadId: string): void {
    if (!this.pendingBindingRestores.has(threadId)) return;
    void this.restore(undefined, new Set([threadId])).catch((error) => {
      if (!this.stopped) {
        this.options.logger.warn({ err: error }, "Codex Thread 订阅立即恢复失败");
      }
    });
  }

  schedule(): void {
    this.prunePendingRestores();
    if (
      this.stopped
      || this.pendingBindingRestores.size === 0
      || this.restoreTimer
      || this.restoreTasks.size > 0
    ) {
      return;
    }
    const delayIndex = Math.min(this.restoreAttempt, retryDelaysMs.length - 1);
    const delayMs = retryDelaysMs[delayIndex]!;
    this.restoreAttempt += 1;
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = undefined;
      if (this.stopped) return;
      const requestedThreadIds = new Set(this.pendingBindingRestores.keys());
      void this.restore(undefined, requestedThreadIds)
        .catch((error) => {
          if (!this.stopped) {
            this.options.logger.warn({ err: error }, "Codex Thread 订阅后台恢复失败");
          }
        })
        .finally(() => {
          this.schedule();
        });
    }, delayMs);
    this.restoreTimer.unref();
  }

  close(): Promise<void> | undefined {
    this.stopped = true;
    if (this.restoreTimer) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = undefined;
    }
    if (this.restoreTasks.size === 0) return undefined;
    return Promise.allSettled([...this.restoreTasks]).then(() => undefined);
  }

  private isCurrentBinding(binding: ConversationBinding): boolean {
    return this.options.router.allBindings().some((current) =>
      current.threadId === binding.threadId && current.sessionId === binding.sessionId
      && current.workspaceId === binding.workspaceId
      && conversationTargetKey(current.target) === conversationTargetKey(binding.target));
  }

  private prunePendingRestores(): void {
    for (const [threadId, pending] of this.pendingBindingRestores) {
      if (!this.isCurrentBinding(pending.binding)) this.pendingBindingRestores.delete(threadId);
    }
  }

  private publishAvailability(
    binding: ConversationBinding,
    availability: "occupied" | "available",
  ): void {
    this.options.output.publish({
      type: "thread.availability",
      target: binding.target,
      threadId: binding.threadId,
      availability,
      background: this.options.router.isBackgroundThread(binding.threadId),
    }, true);
  }
}
