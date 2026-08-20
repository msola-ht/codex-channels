import type { Logger } from "pino";

import type { ConversationTarget } from "../conversation-core/index.js";
import type { ConversationBinding } from "../storage/index.js";

const defaultIdleThresholdMs = 5 * 60 * 1_000;
const defaultScanIntervalMs = 60 * 1_000;
const maximumRecentTargets = 8;

export interface ProviderIdleReleaserOptions {
  logger: Logger;
  isAccountProvider: (provider: string) => boolean;
  listRunningProviders: () => Promise<readonly string[]>;
  releaseProvider: (provider: string) => Promise<boolean>;
  providerForThread: (threadId: string) => string | undefined;
  listBindings: () => readonly ConversationBinding[];
  defaultRoleProvider: () => string | undefined;
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
  private readonly defaultRoleProvider: () => string | undefined;
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
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(options: ProviderIdleReleaserOptions) {
    this.logger = options.logger;
    this.isAccountProvider = options.isAccountProvider;
    this.listRunningProviders = options.listRunningProviders;
    this.releaseProvider = options.releaseProvider;
    this.providerForThread = options.providerForThread;
    this.listBindings = options.listBindings;
    this.defaultRoleProvider = options.defaultRoleProvider;
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

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
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

  async scan(): Promise<void> {
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
    const defaultProvider = this.defaultRoleProvider();
    const nowMs = this.nowMs();
    for (const provider of running) {
      if (
        !this.isAccountProvider(provider)
        || this.launching.has(provider)
        || provider === defaultProvider
      ) {
        continue;
      }
      if (this.hasBindings(provider)) {
        this.touch(provider);
        continue;
      }
      const lastActivityAt = this.lastActivityAt.get(provider) ?? 0;
      if (nowMs - lastActivityAt < this.idleThresholdMs) continue;
      try {
        const released = await this.releaseProvider(provider);
        if (released) {
          const targets = this.recentTargets.get(provider) ?? [];
          this.notify(provider, targets);
          this.lastActivityAt.delete(provider);
          this.recentTargets.delete(provider);
          this.logger.info(
            { provider },
            "OpenCode Go 账户隔离 App Server 已空闲停止",
          );
        }
      } catch (error) {
        this.logger.warn(
          { err: error, provider },
          "OpenCode Go 账户隔离 App Server 空闲释放失败",
        );
      }
    }
  }

  private hasBindings(provider: string): boolean {
    return this.listBindings().some(
      (binding) => this.providerForThread(binding.threadId) === provider,
    );
  }
}

function conversationTargetKey(target: ConversationTarget): string {
  return JSON.stringify([target.surface, target.accountId, target.conversationId]);
}
