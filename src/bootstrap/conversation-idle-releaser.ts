import type { Logger } from "pino";

import type {
  ConversationIdleReleaseResult,
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
  releaseIdle: (target: ConversationTarget) => Promise<ConversationIdleReleaseResult>;
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

  scan(): Promise<void> {
    if (this.idleThresholdMs <= 0 || this.stopped) {
      return Promise.resolve();
    }
    if (this.scanTask) return this.scanTask;
    const task = this.scanOnce().finally(() => {
      if (this.scanTask === task) this.scanTask = undefined;
    });
    this.scanTask = task;
    return task;
  }

  private async scanOnce(): Promise<void> {
    for (const binding of this.listForegroundBindings()) {
      if (this.stopped) return;
      const state = this.idleState(binding.target);
      if (state.forceNew) continue;
      if (state.lastActivityAt === 0) {
        this.ensureIdleState(binding.target, this.nowMs());
        continue;
      }
      if (this.nowMs() - state.lastActivityAt < this.idleThresholdMs) {
        continue;
      }
      if (this.isBindingRestoring?.(binding.threadId) === true) {
        continue;
      }
      try {
        const result = await this.releaseIdle(binding.target);
        if (this.stopped) {
          return;
        }
        if (result.status === "released") {
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
