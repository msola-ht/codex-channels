import type { Logger } from "pino";

import type { ConversationBinding } from "../storage/index.js";

const defaultGlobalIdleGraceMs = 60_000;

export interface ProviderIdleReleaserOptions {
  logger: Logger;
  listConnectedProviders: () => readonly string[];
  closeProvider: (provider: string) => Promise<void>;
  listBindings: () => readonly ConversationBinding[];
  /** Grace window before connected Provider Clients are closed. */
  gracePeriodMs?: number;
  /** Called after the grace window and before the Clients are closed. */
  notifyBeforeClose?: (providers: readonly string[]) => void;
}

export class ProviderIdleReleaser {
  private readonly logger: Logger;
  private readonly listConnectedProviders:
    ProviderIdleReleaserOptions["listConnectedProviders"];
  private readonly closeProvider: ProviderIdleReleaserOptions["closeProvider"];
  private readonly listBindings: () => readonly ConversationBinding[];
  private readonly gracePeriodMs: number;
  private readonly notifyBeforeClose:
    ProviderIdleReleaserOptions["notifyBeforeClose"];
  private readonly launching = new Set<string>();
  private readonly activeOperations = new Map<string, number>();
  private graceTimer: NodeJS.Timeout | undefined;
  private graceTask: Promise<void> | undefined;
  private resolveGraceTask: (() => void) | undefined;
  private graceNotify = false;
  private graceGeneration = 0;
  private closeTask: Promise<void> | undefined;
  private stopped = false;

  constructor(options: ProviderIdleReleaserOptions) {
    this.logger = options.logger;
    this.listConnectedProviders = options.listConnectedProviders;
    this.closeProvider = options.closeProvider;
    this.listBindings = options.listBindings;
    this.gracePeriodMs = options.gracePeriodMs ?? defaultGlobalIdleGraceMs;
    if (!Number.isSafeInteger(this.gracePeriodMs) || this.gracePeriodMs < 0) {
      throw new RangeError("Provider Client 空闲释放宽限期必须是非负整数毫秒");
    }
    this.notifyBeforeClose = options.notifyBeforeClose;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelGrace();
    const closeTask = this.closeTask;
    if (closeTask) await closeTask;
  }

  markLaunching(provider: string): void {
    if (this.stopped) return;
    this.launching.add(provider);
  }

  finishLaunching(provider: string): void {
    this.launching.delete(provider);
    void this.closeIfIdle().catch((error) => {
      this.logger.warn(
        { err: error, provider },
        "Provider 启动完成后的全局 Client 空闲检查失败",
      );
    });
  }

  runActivity<T>(provider: string, operation: () => Promise<T>): Promise<T> {
    return this.runProviderOperation(provider, operation);
  }

  runOperation<T>(provider: string, operation: () => Promise<T>): Promise<T> {
    return this.runProviderOperation(provider, operation);
  }

  /**
   * Schedule a global Client close after the grace window when idle.
   *
   * `notify` marks the round as caused by an automatic conversation release,
   * so the optional pre-close notification is only sent for that round.
   */
  closeIfIdle(notify = false): Promise<void> {
    if (this.stopped) return this.closeTask ?? Promise.resolve();
    if (this.closeTask) return this.closeTask;
    if (!this.isGloballyIdle()) {
      this.cancelGrace();
      return Promise.resolve();
    }
    const providers = [...this.listConnectedProviders()];
    if (providers.length === 0) {
      this.cancelGrace();
      return Promise.resolve();
    }
    if (this.graceTask) {
      if (notify) {
        this.graceNotify = true;
      }
      return this.graceTask;
    }
    return this.scheduleGrace(notify);
  }

  private scheduleGrace(notify: boolean): Promise<void> {
    let resolve!: () => void;
    const task = new Promise<void>((done) => {
      resolve = done;
    });
    this.graceTask = task;
    this.resolveGraceTask = resolve;
    this.graceNotify = notify;
    const generation = ++this.graceGeneration;
    this.graceTimer = setTimeout(() => {
      if (this.stopped || generation !== this.graceGeneration) return;
      this.graceTimer = undefined;
      this.graceTask = undefined;
      this.resolveGraceTask = undefined;
      const notifyNow = this.graceNotify;
      this.graceNotify = false;
      const closeTask = this.closeAfterGrace(notifyNow).finally(() => {
        if (this.closeTask === closeTask) this.closeTask = undefined;
        resolve();
      });
      this.closeTask = closeTask;
      if (notifyNow) {
        void this.closeTask.catch((error) => {
          this.logger.warn(
            { err: error },
            "全局空闲释放通知轮次失败",
          );
        });
      }
    }, this.gracePeriodMs);
    this.graceTimer.unref?.();
    return task;
  }

  private isGloballyIdle(): boolean {
    return this.listBindings().length === 0
      && this.activeOperations.size === 0
      && this.launching.size === 0;
  }

  private cancelGrace(): void {
    this.graceGeneration += 1;
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
    const resolve = this.resolveGraceTask;
    this.graceTask = undefined;
    this.resolveGraceTask = undefined;
    this.graceNotify = false;
    resolve?.();
  }

  private async closeAfterGrace(notify: boolean): Promise<void> {
    if (this.stopped || !this.isGloballyIdle()) return;
    const currentProviders = [...this.listConnectedProviders()];
    if (currentProviders.length === 0) return;
    if (notify && this.notifyBeforeClose) {
      try {
        this.notifyBeforeClose(currentProviders);
      } catch (error) {
        this.logger.warn(
          { err: error, providers: currentProviders },
          "全局空闲释放通知失败，继续关闭 Provider Client",
        );
      }
    }
    this.logger.info(
      { providers: currentProviders },
      "Provider Client 将在全局空闲宽限期结束后关闭",
    );
    await this.closeConnectedProviders(currentProviders);
  }

  private async closeConnectedProviders(providers: readonly string[]): Promise<void> {
    for (const provider of providers) {
      if (this.stopped) return;
      try {
        await this.closeProvider(provider);
        this.logger.info(
          { provider },
          "Provider Client 已因 Gateway 全局空闲关闭",
        );
      } catch (error) {
        this.logger.warn(
          { err: error, provider },
          "Provider Client 空闲关闭失败，将在后续全局空闲检查重试",
        );
      }
    }
  }

  private async runProviderOperation<T>(
    provider: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    while (true) {
      const closeTask = this.closeTask;
      if (!closeTask) break;
      await closeTask.catch(() => undefined);
    }
    this.cancelGrace();
    this.activeOperations.set(
      provider,
      (this.activeOperations.get(provider) ?? 0) + 1,
    );
    try {
      return await operation();
    } finally {
      const remaining = (this.activeOperations.get(provider) ?? 1) - 1;
      if (remaining === 0) this.activeOperations.delete(provider);
      else this.activeOperations.set(provider, remaining);
      if (!this.stopped && this.isGloballyIdle()) {
        void this.closeIfIdle().catch((error) => {
          this.logger.warn(
            { err: error, provider },
            "Provider 操作结束后的全局 Client 空闲检查失败",
          );
        });
      }
    }
  }
}
