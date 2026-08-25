import type { Logger } from "pino";

import {
  conversationTargetKey,
  type ConversationTarget,
} from "../conversation-core/index.js";
import type { ConversationBinding } from "../storage/index.js";

const defaultIdleThresholdMs = 5 * 60 * 1_000;
const defaultScanIntervalMs = 60 * 1_000;
const maximumRecentTargets = 8;

export function providerIdleReleaseMessage(label: string): string {
  return `${label} 的渠道会话实例已空闲停止；第三方子代理不受影响。`
    + "再次选择该账户、恢复 Thread 或使用对应 Remote TUI 时将自动启动。";
}

export interface ProviderIdleReleaserOptions {
  logger: Logger;
  isAccountProvider: (provider: string) => boolean;
  listRunningProviders: () => Promise<readonly string[]>;
  releaseProvider: (provider: string) => Promise<boolean>;
  providerForThread: (threadId: string) => string | undefined;
  listBindings: () => readonly ConversationBinding[];
  notify: (provider: string, targets: readonly ConversationTarget[]) => void;
  idleThresholdMs?: number;
  scanIntervalMs?: number;
  nowMs?: () => number;
}

export class ProviderIdleReleaser {
  private readonly logger: Logger;
  private readonly isAccountProvider: (provider: string) => boolean;
  private readonly listRunningProviders: () => Promise<readonly string[]>;
  private readonly releaseProvider: (provider: string) => Promise<boolean>;
  private readonly providerForThread: (threadId: string) => string | undefined;
  private readonly listBindings: () => readonly ConversationBinding[];
  private readonly notify: (
    provider: string,
    targets: readonly ConversationTarget[],
  ) => void;
  private readonly idleThresholdMs: number;
  private readonly scanIntervalMs: number;
  private readonly nowMs: () => number;
  private readonly lastActivityAt = new Map<string, number>();
  private readonly launching = new Set<string>();
  private readonly recentTargets = new Map<string, ConversationTarget[]>();
  private readonly activeOperations = new Map<string, number>();
  private readonly providerReleases = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private scanTask: Promise<void> | undefined;
  private stopped = false;

  constructor(options: ProviderIdleReleaserOptions) {
    this.logger = options.logger;
    this.isAccountProvider = options.isAccountProvider;
    this.listRunningProviders = options.listRunningProviders;
    this.releaseProvider = options.releaseProvider;
    this.providerForThread = options.providerForThread;
    this.listBindings = options.listBindings;
    this.notify = options.notify;
    this.idleThresholdMs = options.idleThresholdMs ?? defaultIdleThresholdMs;
    this.scanIntervalMs = options.scanIntervalMs ?? defaultScanIntervalMs;
    this.nowMs = options.nowMs ?? Date.now;
  }

  start(): void {
    if (this.stopped || this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.scan().catch((error) => {
        this.logger.warn(
          { err: error },
          "OpenCode Go 账户空闲扫描失败（不影响请求）",
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
    await this.scanTask;
  }

  touch(provider: string | undefined, target?: ConversationTarget): void {
    if (provider === undefined) return;
    if (!this.isAccountProvider(provider)) return;
    this.lastActivityAt.set(provider, this.nowMs());
    if (!target) return;
    const targets = this.recentTargets.get(provider) ?? [];
    const key = conversationTargetKey(target);
    if (!targets.some((candidate) => conversationTargetKey(candidate) === key)) {
      targets.push(target);
      if (targets.length > maximumRecentTargets) targets.shift();
      this.recentTargets.set(provider, targets);
    }
  }

  markLaunching(provider: string): void {
    if (!this.isAccountProvider(provider)) return;
    this.launching.add(provider);
    this.touch(provider);
  }

  finishLaunching(provider: string): void {
    this.launching.delete(provider);
  }

  runActivity<T>(provider: string, operation: () => Promise<T>): Promise<T> {
    if (!this.isAccountProvider(provider)) return operation();
    return this.runProviderOperation(provider, operation, true);
  }

  runOperation<T>(provider: string, operation: () => Promise<T>): Promise<T> {
    if (!this.isAccountProvider(provider)) return operation();
    return this.runProviderOperation(provider, operation, false);
  }

  scan(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.scanTask) return this.scanTask;
    const task = this.scanOnce().finally(() => {
      if (this.scanTask === task) this.scanTask = undefined;
    });
    this.scanTask = task;
    return task;
  }

  private async scanOnce(): Promise<void> {
    let running: readonly string[];
    try {
      running = await this.listRunningProviders();
    } catch (error) {
      this.logger.warn(
        { err: error },
        "无法读取 App Server 监管拓扑，跳过本轮账户空闲扫描",
      );
      return;
    }
    if (this.stopped) return;
    for (const provider of running) {
      if (this.stopped) return;
      if (!this.isAccountProvider(provider)) continue;
      await this.tryRelease(provider);
    }
  }

  private async tryRelease(provider: string): Promise<void> {
    if ((this.activeOperations.get(provider) ?? 0) > 0) return;
    if (this.providerReleases.has(provider)) return;
    const task = this.releaseIfIdle(provider).finally(() => {
      if (this.providerReleases.get(provider) === task) {
        this.providerReleases.delete(provider);
      }
    });
    this.providerReleases.set(provider, task);
    await task;
  }

  private async releaseIfIdle(provider: string): Promise<void> {
    if (
      this.stopped
      || this.launching.has(provider)
    ) {
      return;
    }
    if (this.hasBindings(provider)) {
      this.touch(provider);
      return;
    }
    const lastActivityAt = this.lastActivityAt.get(provider) ?? 0;
    if (this.nowMs() - lastActivityAt < this.idleThresholdMs) return;
    try {
      const released = await this.releaseProvider(provider);
      if (!released) return;
      const targets = this.recentTargets.get(provider) ?? [];
      this.lastActivityAt.delete(provider);
      this.recentTargets.delete(provider);
      if (this.stopped) return;
      this.notify(provider, targets);
      this.logger.info(
        { provider },
        "OpenCode Go 账户隔离 App Server 已空闲停止",
      );
    } catch (error) {
      this.logger.warn(
        { err: error, provider },
        "OpenCode Go 账户隔离 App Server 空闲释放失败",
      );
    }
  }

  private async runProviderOperation<T>(
    provider: string,
    operation: () => Promise<T>,
    refreshActivity: boolean,
  ): Promise<T> {
    while (true) {
      const release = this.providerReleases.get(provider);
      if (!release) break;
      await release.catch(() => undefined);
    }
    this.activeOperations.set(
      provider,
      (this.activeOperations.get(provider) ?? 0) + 1,
    );
    if (refreshActivity) this.touch(provider);
    try {
      return await operation();
    } finally {
      const remaining = (this.activeOperations.get(provider) ?? 1) - 1;
      if (remaining === 0) this.activeOperations.delete(provider);
      else this.activeOperations.set(provider, remaining);
    }
  }

  private hasBindings(provider: string): boolean {
    return this.listBindings().some(
      (binding) => this.providerForThread(binding.threadId) === provider,
    );
  }
}
