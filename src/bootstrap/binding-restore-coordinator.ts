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

interface PendingBindingRestore {
  binding: ConversationBinding;
  occupiedNotified: boolean;
  failureCount: number;
  retryable: boolean;
}

export interface ScheduledBindingRecoveryPort {
  runningThreadIds(): ReadonlySet<string>;
  taskForThread(threadId: string): Promise<{ modelProvider?: string | null } | undefined>;
  recoverRunning(threadIds: ReadonlySet<string>, signal: AbortSignal): Promise<void>;
}

export interface BindingRestoreCoordinatorOptions {
  codex: Pick<ProviderRoutingClient, "knownProvider">;
  router: SessionRouter;
  output: EventBus<OutputEvent>;
  enabledSurfaces(): readonly Pick<SurfaceAdapter, "surface" | "accountId" | "prepareBindingRestore">[];
  canRestoreBinding?(binding: ConversationBinding): boolean;
  scheduledRecovery(): ScheduledBindingRecoveryPort | undefined;
  releaseBackground(threadId: string, isCurrent: () => boolean): Promise<boolean>;
  restored?(threadId: string): void;
  trackThreadActivity(threadId: string): {
    restore(target: ConversationBinding["target"], activeTurnId: string | null): void;
    stop(): void;
  };
  logger: Logger;
}

export class BindingRestoreCoordinator {
  private readonly disconnectedProviders = new Set<string>();
  private readonly providerDisconnectGenerations = new Map<string, number>();
  private readonly disconnectedBindingsByProvider = new Map<string, Set<string>>();
  private readonly pendingBindingRestores = new Map<string, PendingBindingRestore>();
  private readonly restoringThreadIds = new Set<string>();
  private restoreTimer: NodeJS.Timeout | undefined;
  private readonly restoreTasks = new Set<Promise<void>>();
  private restoreAttempt = 0;
  private stopped = false;
  private readonly recoveryAbort = new AbortController();

  constructor(private readonly options: BindingRestoreCoordinatorOptions) {}

  isRestoring(threadId: string): boolean {
    this.prunePendingRestores();
    const provider = this.options.codex.knownProvider(threadId);
    return this.pendingBindingRestores.has(threadId)
      || this.restoringThreadIds.has(threadId)
      || (provider !== undefined && this.disconnectedProviders.has(provider));
  }

  hasPending(threadId: string): boolean {
    this.prunePendingRestores();
    return this.pendingBindingRestores.has(threadId);
  }

  markProviderDisconnected(provider: string, threadIds: ReadonlySet<string>): void {
    this.providerDisconnectGenerations.set(
      provider,
      (this.providerDisconnectGenerations.get(provider) ?? 0) + 1,
    );
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
    const disconnectGenerations = new Map(this.providerDisconnectGenerations);
    const disconnectedProviders = new Set(this.disconnectedProviders);
    const bindingProviders = new Map(this.options.router.allBindings().map((binding) =>
      [binding.threadId, this.options.codex.knownProvider(binding.threadId)]));
    const candidateThreadIds = new Set(
      this.options.router.allBindings()
        .filter((binding) => {
          const bindingProvider = this.options.codex.knownProvider(binding.threadId);
          return !this.stopped
            && this.options.canRestoreBinding?.(binding) !== false
            && (
              enabledSurfaces.has(surfaceAccountKey(
                binding.target.surface,
                binding.target.accountId,
              ))
              || scheduledThreadIds.has(binding.threadId)
            )
            && !this.restoringThreadIds.has(binding.threadId)
            && (provider !== undefined || requestedThreadIds !== undefined
              || this.pendingBindingRestores.get(binding.threadId)?.retryable !== false)
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
        await scheduledRecovery?.recoverRunning(scheduledThreadIds, this.recoveryAbort.signal);
      }
      return;
    }
    for (const threadId of candidateThreadIds) {
      this.restoringThreadIds.add(threadId);
    }
    const restoredThreadIds = new Set<string>();
    const restoredBindings = new Map<string, ConversationBinding>();
    const releasedThreadIds = new Set<string>();
    const isConnectionCurrent = (binding: ConversationBinding): boolean => {
      if (this.stopped || !candidateThreadIds.has(binding.threadId)) return false;
      const currentProvider = this.options.codex.knownProvider(binding.threadId);
      const expectedProvider = bindingProviders.get(binding.threadId);
      if (expectedProvider !== undefined && currentProvider !== expectedProvider) return false;
      if (currentProvider === undefined) return true;
      return (this.providerDisconnectGenerations.get(currentProvider) ?? 0)
          === (disconnectGenerations.get(currentProvider) ?? 0)
        && (provider === currentProvider || !disconnectedProviders.has(currentProvider));
    };
    const canRestore = (binding: ConversationBinding): boolean =>
      isConnectionCurrent(binding) && this.isCurrentBinding(binding)
      && this.options.canRestoreBinding?.(binding) !== false;
    let failures: SubscriptionRestoreFailure[];
    try {
      const scheduledProviders = new Map<string, string>();
      for (const threadId of candidateThreadIds) {
        if (!scheduledThreadIds.has(threadId)) continue;
        const task = await scheduledRecovery?.taskForThread(threadId);
        if (this.recoveryAbort.signal.aborted) return;
        if (task?.modelProvider != null) scheduledProviders.set(threadId, task.modelProvider);
      }
      failures = await this.options.router.restoreSubscriptions(
        (_target, binding) => canRestore(binding),
        (threadId) => {
          const activity = this.options.trackThreadActivity(threadId);
          return {
            restored: (binding, thread) => {
              if (!canRestore(binding)) return;
              bindingProviders.set(binding.threadId, this.options.codex.knownProvider(binding.threadId));
              restoredThreadIds.add(binding.threadId);
              restoredBindings.set(binding.threadId, binding);
              // Notifications received during resume are newer than its snapshot.
              activity.restore(binding.target,
                thread.status.type === "active" ? thread.activeTurnId : null);
            },
            stop: () => activity.stop(),
          };
        },
        (binding) => {
          const modelProvider = scheduledProviders.get(binding.threadId);
          return modelProvider === undefined
            ? {}
            : { modelProvider };
        },
        async (binding) => {
          const surface = this.options.enabledSurfaces().find(candidate =>
            candidate.surface === binding.target.surface && candidate.accountId === binding.target.accountId);
          await surface?.prepareBindingRestore?.(binding.target, this.recoveryAbort.signal);
        },
      );
      // Router has released the per-Thread restore locks. Background cleanup
      // must use Application's complete descendant/Queue/interaction checks.
      for (const [threadId, binding] of restoredBindings) {
        if (!canRestore(binding)) {
          restoredThreadIds.delete(threadId);
          continue;
        }
        if (
          !this.options.router.isBackgroundThread(threadId)
          || scheduledThreadIds.has(threadId)
        ) continue;
        const isCurrent = () => canRestore(binding)
          && this.options.router.isBackgroundThread(threadId);
        try {
          const released = await this.options.releaseBackground(threadId, isCurrent);
          if (!isConnectionCurrent(binding)) {
            restoredThreadIds.delete(threadId);
            continue;
          }
          if (released) {
            if (this.options.router.allBindings().some((current) => current.threadId === threadId)) {
              restoredThreadIds.delete(threadId);
              continue;
            }
            releasedThreadIds.add(threadId);
            this.options.output.publish({
              type: "warning",
              target: binding.target,
              threadId,
              background: true,
              message: "恢复检查确认原后台会话已无待处理任务，已解除后台绑定；可通过 /resume 查看完整会话。",
            }, true);
          } else if (!canRestore(binding)) {
            restoredThreadIds.delete(threadId);
          }
        } catch (error) {
          restoredThreadIds.delete(threadId);
          if (!isCurrent()) continue;
          failures.push({
            binding,
            error: error instanceof Error ? error : new Error(String(error)),
            bindingRemoved: false,
            reason: "other",
          });
        }
      }
    } finally {
      for (const threadId of candidateThreadIds) {
        this.restoringThreadIds.delete(threadId);
      }
    }
    if (this.stopped) return;
    for (const threadId of restoredThreadIds) {
      const binding = restoredBindings.get(threadId)!;
      if (
        !isConnectionCurrent(binding)
        || (!releasedThreadIds.has(threadId) && !this.isCurrentBinding(binding))
        || (releasedThreadIds.has(threadId)
          && this.options.router.allBindings().some((current) => current.threadId === threadId))
      ) {
        restoredThreadIds.delete(threadId);
        continue;
      }
      this.options.restored?.(threadId);
      const pending = this.pendingBindingRestores.get(threadId);
      if (!pending) continue;
      this.pendingBindingRestores.delete(threadId);
      if (pending.occupiedNotified) {
        this.publishAvailability(pending.binding, "available");
      }
    }
    await scheduledRecovery?.recoverRunning(restoredThreadIds, this.recoveryAbort.signal);
    if (this.stopped) return;
    for (const failure of failures) {
      if (!failure.bindingRemoved && !canRestore(failure.binding)) continue;
      const background = this.options.router.isBackgroundThread(failure.binding.threadId);
      // Background/scheduled Runs have a separate authoritative recovery owner;
      // keep retrying rather than stranding a Run that cannot be resumed by /resume.
      const retryable = failure.reason !== "history-unavailable"
        || background || scheduledThreadIds.has(failure.binding.threadId);
      this.options.logger.warn(
        {
          err: failure.error,
          threadId: failure.binding.threadId,
          bindingRemoved: failure.bindingRemoved,
        },
        failure.bindingRemoved
          ? "恢复 Codex Thread 订阅永久失败，已移除持久化绑定"
          : !retryable
          ? "恢复 Codex Thread 缺少历史记录，已保留绑定并暂停自动重试"
          : "恢复 Codex Thread 订阅暂时失败，已保留持久化绑定",
      );
      if (failure.bindingRemoved) {
        this.pendingBindingRestores.delete(failure.binding.threadId);
        continue;
      }
      const previous = this.pendingBindingRestores.get(failure.binding.threadId);
      const failureCount = (previous?.failureCount ?? 0) + 1;
      const shouldNotifyOccupied = failure.reason === "active-writer"
        || ((failure.reason === "other" || (failure.reason === "history-unavailable" && retryable))
          && failureCount >= escalationAttempts);
      const occupiedNotified = previous?.occupiedNotified === true
        || shouldNotifyOccupied;
      this.pendingBindingRestores.set(failure.binding.threadId, {
        binding: failure.binding,
        occupiedNotified,
        failureCount,
        retryable,
      });
      if (failure.reason === "history-unavailable"
        && (retryable ? !previous : previous?.retryable !== false)) {
        this.options.output.publish({
          type: "warning",
          target: failure.binding.target,
          threadId: failure.binding.threadId,
          background,
          message: retryable
            ? "后台会话缺少可恢复的历史记录，原会话和绑定已保留，将继续尝试恢复订阅。请核对后台任务及 /schedule 状态；已提交的任务不会自动重跑。"
            : "会话缺少可恢复的历史记录，自动恢复已暂停，原会话和绑定已保留。请用 /new 新建，或在历史可用后用 /resume 显式重试；新建时若提示速度档位未知，请先用 /fast 明确选择。",
        }, true);
      }
      if (shouldNotifyOccupied && !previous?.occupiedNotified) {
        this.publishAvailability(failure.binding, "occupied");
      }
    }
    const bindingCount = this.options.router.allBindings().length;
    if (bindingCount > 0) {
      this.options.logger.info(
        { bindings: bindingCount, restored: restoredThreadIds.size,
          pending: this.pendingBindingRestores.size },
        "Codex Thread 订阅恢复检查已完成",
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
      || ![...this.pendingBindingRestores.values()].some(pending => pending.retryable)
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
      const requestedThreadIds = new Set([...this.pendingBindingRestores]
        .filter(([, pending]) => pending.retryable).map(([threadId]) => threadId));
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
    this.recoveryAbort.abort();
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
      if (!this.isCurrentBinding(pending.binding)
        || (!pending.retryable && !this.options.router.subscriptionRestoreError(threadId))) {
        this.pendingBindingRestores.delete(threadId);
      } else if (!pending.retryable && this.options.router.isBackgroundThread(threadId)) {
        pending.retryable = true;
      }
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
