import type { Logger } from "pino";

import type {
  ConversationIdleReleaseResult,
  ConversationIdleReleaseCondition,
} from "../application/index.js";
import type { ConversationTarget } from "../conversation-core/index.js";
import type {
  ConversationBinding,
  ConversationIdleState,
} from "../storage/index.js";

const defaultScanIntervalMs = 60_000;
const defaultStopTimeoutMs = 5_000;

export interface ConversationIdleReleaserOptions {
  logger: Logger;
  idleThresholdMs: number;
  scanIntervalMs?: number;
  stopTimeoutMs?: number;
  nowMs?: () => number;
  listForegroundBindings: () => readonly ConversationBinding[];
  idleState: (target: ConversationTarget) => ConversationIdleState;
  ensureIdleState: (target: ConversationTarget, atMs: number) => void;
  isBindingRestoring?: (threadId: string) => boolean;
  canRelease?: (threadId: string) => boolean;
  restoreBinding?: (threadId: string) => void;
  releaseIdle: (target: ConversationTarget, condition: ConversationIdleReleaseCondition) => Promise<ConversationIdleReleaseResult>;
  notifyReleased: (target: ConversationTarget, threadId: string) => void;
}

export class ConversationIdleReleaser {
  private readonly logger: Logger;
  private readonly idleThresholdMs: number;
  private readonly scanIntervalMs: number;
  private readonly stopTimeoutMs: number;
  private readonly nowMs: () => number;
  private readonly listForegroundBindings:
    ConversationIdleReleaserOptions["listForegroundBindings"];
  private readonly idleState:
    ConversationIdleReleaserOptions["idleState"];
  private readonly ensureIdleState:
    ConversationIdleReleaserOptions["ensureIdleState"];
  private readonly isBindingRestoring:
    ConversationIdleReleaserOptions["isBindingRestoring"];
  private readonly releaseIdle:
    ConversationIdleReleaserOptions["releaseIdle"];
  private readonly notifyReleased:
    ConversationIdleReleaserOptions["notifyReleased"];
  private timer: NodeJS.Timeout | undefined;
  private scanTask: Promise<void> | undefined;
  private stopped = false;
  private cancellation = new AbortController();
  private readonly releaseCancellations = new Map<string, AbortController>();
  private readonly canRelease: ConversationIdleReleaserOptions["canRelease"];
  private readonly restoreBinding: ConversationIdleReleaserOptions["restoreBinding"];

  constructor(options: ConversationIdleReleaserOptions) {
    this.logger = options.logger;
    this.idleThresholdMs = options.idleThresholdMs;
    this.scanIntervalMs = options.scanIntervalMs ?? defaultScanIntervalMs;
    this.stopTimeoutMs = options.stopTimeoutMs ?? defaultStopTimeoutMs;
    this.nowMs = options.nowMs ?? Date.now;
    this.listForegroundBindings = options.listForegroundBindings;
    this.idleState = options.idleState;
    this.ensureIdleState = options.ensureIdleState;
    this.isBindingRestoring = options.isBindingRestoring;
    this.canRelease = options.canRelease;
    this.restoreBinding = options.restoreBinding;
    this.releaseIdle = options.releaseIdle;
    this.notifyReleased = options.notifyReleased;
  }

  start(): void {
    if (
      this.idleThresholdMs <= 0
      || this.stopped
      || this.timer !== undefined
    ) {
      return;
    }
    const now = this.nowMs();
    for (const binding of this.listForegroundBindings()) {
      const state = this.idleState(binding.target);
      if (state.lastActivityAt === 0) {
        this.ensureIdleState(binding.target, now);
      }
    }
    this.timer = setInterval(() => {
      void this.scan().catch((error) => {
        this.logger.warn(
          { err: error },
          "渠道会话空闲释放扫描失败（不影响请求）",
        );
      });
    }, this.scanIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelPending();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const scanTask = this.scanTask;
    if (
      scanTask
      && !(await waitAtMost(scanTask, this.stopTimeoutMs))
    ) {
      this.logger.warn(
        { timeoutMs: this.stopTimeoutMs },
        "渠道会话空闲释放扫描停止等待超时",
      );
    }
  }

  cancelPending(threadIds?: ReadonlySet<string>): void {
    if (threadIds !== undefined) {
      for (const threadId of threadIds) this.releaseCancellations.get(threadId)?.abort();
      return;
    }
    this.cancellation.abort();
    this.cancellation = new AbortController();
  }

  scan(): Promise<void> {
    if (this.idleThresholdMs <= 0 || this.stopped) {
      return Promise.resolve();
    }
    if (this.scanTask) return this.scanTask;
    const task = this.scanOnce().finally(() => {
      this.releaseCancellations.clear();
      if (this.scanTask === task) this.scanTask = undefined;
    });
    this.scanTask = task;
    return task;
  }

  private async scanOnce(): Promise<void> {
    const scanSignal = this.cancellation.signal;
    const candidates = this.listForegroundBindings();
    for (const binding of candidates) this.releaseCancellations.set(binding.threadId, new AbortController());
    for (const binding of candidates) {
      if (this.stopped || scanSignal.aborted) return;
      const signal = AbortSignal.any([scanSignal, this.releaseCancellations.get(binding.threadId)!.signal]);
      if (signal.aborted) continue;
      const state = this.idleState(binding.target);
      const lastActivityAt = state.lastActivityAt;
      if (state.forceNew) continue;
      if (state.lastActivityAt === 0) {
        this.ensureIdleState(binding.target, this.nowMs());
        continue;
      }
      if (this.nowMs() - state.lastActivityAt < this.idleThresholdMs) {
        continue;
      }
      const canRestore = () => !this.stopped && !signal.aborted
        && this.isBindingRestoring?.(binding.threadId) !== true
        && (this.canRelease?.(binding.threadId) ?? true);
      if (!canRestore()) {
        continue;
      }
      try {
        const result = await this.releaseIdle(binding.target, {
          threadId: binding.threadId,
          lastActivityAt,
          signal,
          canRestore,
          restoreRequired: () => this.restoreBinding?.(binding.threadId),
          isCurrent: () => canRestore()
            && this.idleState(binding.target).lastActivityAt === lastActivityAt
            && !this.idleState(binding.target).forceNew,
        });
        if (this.stopped || scanSignal.aborted) {
          return;
        }
        if (signal.aborted) continue;
        if (result.status === "released" && result.threadId === binding.threadId && canRestore()) {
          this.notifyReleased(binding.target, result.threadId);
          this.logger.info(
            {
              surface: binding.target.surface,
              accountId: binding.target.accountId,
              conversationId: binding.target.conversationId,
              threadId: result.threadId,
            },
            "渠道会话已空闲解除 Thread 绑定",
          );
        }
      } catch (error) {
        if (this.stopped || scanSignal.aborted) return;
        if (signal.aborted) continue;
        this.logger.warn(
          { err: error, threadId: binding.threadId },
          "渠道会话空闲释放失败，已保留绑定供后续重试",
        );
      }
    }
  }
}

async function waitAtMost(
  task: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([
      task.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
