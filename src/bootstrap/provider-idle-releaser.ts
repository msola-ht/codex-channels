import type { Logger } from "pino";

import type { ConversationBinding } from "../storage/index.js";

const defaultGlobalIdleGraceMs = 60_000;
const defaultCheckIntervalMs = 60_000;
const defaultStopTimeoutMs = 5_000;

export interface ProviderIdleReleaserOptions {
  logger: Logger;
  listConnectedProviders: () => readonly string[];
  closeProvider: (provider: string) => Promise<void>;
  /** Stop the App Server process after its Client was closed. */
  releaseProvider?: (provider: string) => Promise<void>;
  /** Service-managed running instances that are not leased. */
  listReleasableAppServers?: () => Promise<readonly string[]>;
  listBindings: () => readonly ConversationBinding[];
  /** Grace window before connected Provider Clients are closed. */
  gracePeriodMs?: number;
  /** Bound for waiting on an in-flight close when the Gateway stops. */
  stopTimeoutMs?: number;
  /** Called after the grace window and before Clients and App Servers are stopped. */
  notifyBeforeClose?: (providers: readonly string[]) => void;
}

export class ProviderIdleReleaser {
  private readonly logger: Logger;
  private readonly listConnectedProviders:
    ProviderIdleReleaserOptions["listConnectedProviders"];
  private readonly closeProvider: ProviderIdleReleaserOptions["closeProvider"];
  private readonly releaseProvider:
    ProviderIdleReleaserOptions["releaseProvider"];
  private readonly listReleasableAppServers:
    ProviderIdleReleaserOptions["listReleasableAppServers"];
  private readonly listBindings: () => readonly ConversationBinding[];
  private readonly gracePeriodMs: number;
  private readonly stopTimeoutMs: number;
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
  private checkTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(options: ProviderIdleReleaserOptions) {
    this.logger = options.logger;
    this.listConnectedProviders = options.listConnectedProviders;
    this.closeProvider = options.closeProvider;
    this.releaseProvider = options.releaseProvider;
    this.listReleasableAppServers = options.listReleasableAppServers;
    this.listBindings = options.listBindings;
    this.gracePeriodMs = options.gracePeriodMs ?? defaultGlobalIdleGraceMs;
    if (!Number.isSafeInteger(this.gracePeriodMs) || this.gracePeriodMs < 0) {
      throw new RangeError("Provider Client 空闲释放宽限期必须是非负整数毫秒");
    }
    this.stopTimeoutMs = options.stopTimeoutMs ?? defaultStopTimeoutMs;
    if (!Number.isSafeInteger(this.stopTimeoutMs) || this.stopTimeoutMs < 0) {
      throw new RangeError("Provider Client 空闲释放停止等待上限必须是非负整数毫秒");
    }
    this.notifyBeforeClose = options.notifyBeforeClose;
  }

  start(): void {
    if (this.stopped || this.checkTimer) return;
    this.checkTimer = setInterval(() => {
      void this.closeIfIdle().catch((error) => {
        this.logger.warn({ err: error }, "全局空闲复检失败");
      });
    }, defaultCheckIntervalMs);
    this.checkTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
    this.cancelGrace();
    const closeTask = this.closeTask;
    if (closeTask && !(await waitAtMost(closeTask, this.stopTimeoutMs))) {
      this.logger.warn(
        { timeoutMs: this.stopTimeoutMs },
        "Provider 空闲释放停止等待超时",
      );
    }
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
    const connectedProviders = [...this.listConnectedProviders()];
    const candidates = new Set(connectedProviders);
    if (this.listReleasableAppServers) {
      try {
        for (const provider of await this.listReleasableAppServers()) {
          candidates.add(provider);
        }
      } catch (error) {
        this.logger.warn(
          { err: error },
          "无法读取可释放 App Server 列表，仅处理已连接 Client",
        );
      }
    }
    if (candidates.size === 0) return;
    const providers = [...candidates];
    if (notify && this.notifyBeforeClose) {
      try {
        this.notifyBeforeClose(providers);
      } catch (error) {
        this.logger.warn(
          { err: error, providers },
          "全局空闲释放通知失败，继续关闭 Client 与 App Server",
        );
      }
    }
    this.logger.info(
      { providers },
      "全局空闲释放轮次开始处理 App Server",
    );
    const failedCloses = await this.closeConnectedProviders(connectedProviders);
    await this.releaseAppServers(
      providers.filter((provider) => !failedCloses.has(provider)),
    );
  }

  private async closeConnectedProviders(
    providers: readonly string[],
  ): Promise<Set<string>> {
    const failed = new Set<string>();
    for (const provider of providers) {
      if (this.stopped) break;
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
        failed.add(provider);
      }
    }
    return failed;
  }

  private async releaseAppServers(providers: readonly string[]): Promise<void> {
    if (!this.releaseProvider) return;
    await Promise.all(providers.map(async (provider) => {
      if (this.stopped) return;
      try {
        await this.releaseProvider?.(provider);
      } catch (error) {
        this.logger.warn(
          { err: error, provider },
          "App Server 空闲停止失败，进程保持运行",
        );
      }
    }));
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

async function waitAtMost(task: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
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
    if (timer) clearTimeout(timer);
  }
}
