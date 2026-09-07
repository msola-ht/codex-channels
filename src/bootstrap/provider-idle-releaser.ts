import type { Logger } from "pino";

import type { ConversationBinding } from "../storage/index.js";

export interface ProviderIdleReleaserOptions {
  logger: Logger;
  listConnectedProviders: () => readonly string[];
  closeProvider: (provider: string) => Promise<void>;
  listBindings: () => readonly ConversationBinding[];
}

export class ProviderIdleReleaser {
  private readonly logger: Logger;
  private readonly listConnectedProviders:
    ProviderIdleReleaserOptions["listConnectedProviders"];
  private readonly closeProvider: ProviderIdleReleaserOptions["closeProvider"];
  private readonly listBindings: () => readonly ConversationBinding[];
  private readonly launching = new Set<string>();
  private readonly activeOperations = new Map<string, number>();
  private closeTask: Promise<void> | undefined;
  private stopped = false;

  constructor(options: ProviderIdleReleaserOptions) {
    this.logger = options.logger;
    this.listConnectedProviders = options.listConnectedProviders;
    this.closeProvider = options.closeProvider;
    this.listBindings = options.listBindings;
  }

  async stop(): Promise<void> {
    this.stopped = true;
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

  /** Close every connected Provider Client when the Gateway is globally idle. */
  closeIfIdle(): Promise<void> {
    if (this.stopped || this.closeTask) {
      return this.closeTask ?? Promise.resolve();
    }
    if (
      this.listBindings().length > 0
      || this.activeOperations.size > 0
      || this.launching.size > 0
    ) {
      return Promise.resolve();
    }
    const providers = [...this.listConnectedProviders()];
    if (providers.length === 0) return Promise.resolve();

    const task = this.closeConnectedProviders(providers).finally(() => {
      if (this.closeTask === task) this.closeTask = undefined;
    });
    this.closeTask = task;
    return task;
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
    }
  }
}
