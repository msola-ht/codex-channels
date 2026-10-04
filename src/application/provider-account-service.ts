import type {
  AccountQueryPort,
  AccountThreadUsage,
  ProviderAccountAdapter,
  ProviderAccountLimits,
  ProviderAccountQueryPort,
  ProviderAccountUsage,
  OfficialAccountSnapshotWriter,
} from "./account-port.js";
import { createOfficialAccountSnapshot } from "./account-snapshot.js";

export class ProviderAccountService implements ProviderAccountQueryPort {
  private readonly pendingUsage = new Map<string, {
    controller: AbortController; promise: Promise<ProviderAccountUsage>; consumers: number;
  }>();
  private readonly adapters = new Map<string, ProviderAccountAdapter>();
  private readonly snapshotUsage = new Map<string, ProviderAccountUsage>();
  private readonly snapshotLimits = new Map<string, ProviderAccountLimits>();
  private readonly limitsObservedAt = new Map<string, number>();
  private limitsQuerySequence = 0;
  private readonly savedLimitsSequence = new Map<string, number>();

  constructor(
    adapters: readonly ProviderAccountAdapter[],
    private readonly snapshotWriter?: OfficialAccountSnapshotWriter,
    private readonly readCredentialRefreshTime?: (accountId: string | null) => Promise<number | null>,
  ) {
    for (const adapter of adapters) {
      if (!adapter.provider || this.adapters.has(adapter.provider)) {
        throw new Error(`Provider 账户适配器重复或无效：${adapter.provider || "<empty>"}`);
      }
      this.adapters.set(adapter.provider, adapter);
    }
  }

  async accountUsage(
    modelProvider: string,
    threadId?: string,
    signal?: AbortSignal,
  ): Promise<ProviderAccountUsage> {
    signal?.throwIfAborted();
    const adapter = this.adapters.get(modelProvider);
    if (!adapter) {
      const result = { kind: "unsupported" as const, provider: modelProvider };
      this.persist(result, result);
      return result;
    }
    const accountUsage = adapter.provider === "openai"
      ? adapter.accountUsage(signal)
      : this.managedUsage(adapter, signal);
    if (!threadId || adapter.provider !== "openai" || !adapter.accountThreadUsage) {
      const result = await accountUsage;
      signal?.throwIfAborted();
      this.persist(result);
      return result;
    }
    const [usage, threadUsage]: [ProviderAccountUsage, AccountThreadUsage] = await Promise.all([
      accountUsage,
      adapter.accountThreadUsage(threadId).catch((): AccountThreadUsage => ({
        kind: "failed",
      })),
    ]);
    signal?.throwIfAborted();
    const result = usage.kind === "token-usage" ? { ...usage, threadUsage } : usage;
    this.persist(result);
    return result;
  }

  async accountLimits(modelProvider: string, signal?: AbortSignal, options: { refreshLogin?: boolean } = { refreshLogin: true }): Promise<ProviderAccountLimits> {
    signal?.throwIfAborted();
    const adapter = this.adapters.get(modelProvider);
    // 不支持的能力没有新的账户观测，不能覆盖进程重启前保存的状态。
    if (!adapter?.accountLimits) return { kind: "unsupported", provider: modelProvider };
    const sequence = ++this.limitsQuerySequence;
    const result = await adapter.accountLimits(signal, options);
    signal?.throwIfAborted();
    if (sequence >= (this.savedLimitsSequence.get(modelProvider) ?? 0)) {
      this.persist(
        this.snapshotUsage.get(modelProvider)
          ?? { kind: "unsupported", provider: modelProvider },
        result,
      );
      this.savedLimitsSequence.set(modelProvider, sequence);
    }
    if (result.kind !== "rate-limits" || !this.readCredentialRefreshTime) return result;
    // Login metadata is presentation-only; never persist it as an official quota snapshot.
    const credentialRefreshedAt = await this.readCredentialRefreshTime(result.limits.accountId);
    signal?.throwIfAborted();
    return { ...result, credentialRefreshedAt };
  }

  /** 按需预热所有已注册账户；调用方应异步触发，不阻塞主服务启动。 */
  async refreshSnapshots(
    signal?: AbortSignal,
    onFailure?: (provider: string, operation: "usage" | "limits", error: unknown) => void,
  ): Promise<void> {
    const observe = async (provider: string, operation: "usage" | "limits", query: Promise<unknown>): Promise<void> => {
      try { await query; }
      catch (error) {
        if (!signal?.aborted) onFailure?.(provider, operation, error);
      }
    };
    await Promise.all([...this.adapters.values()].flatMap((adapter) => [
      observe(adapter.provider, "usage", this.accountUsage(adapter.provider, undefined, signal)),
      ...(adapter.accountLimits ? [observe(adapter.provider, "limits", this.accountLimits(adapter.provider, signal, { refreshLogin: false }))] : []),
    ]));
  }

  /** 刷新单个已注册账户；未知 Provider 不创建无效快照。 */
  async refreshAccountSnapshot(modelProvider: string, signal?: AbortSignal): Promise<boolean> {
    if (!this.adapters.has(modelProvider)) return false;
    await this.accountUsage(modelProvider, undefined, signal);
    return true;
  }

  private managedUsage(adapter: ProviderAccountAdapter, signal?: AbortSignal): Promise<ProviderAccountUsage> {
    signal?.throwIfAborted();
    let pending = this.pendingUsage.get(adapter.provider);
    if (!pending) {
      const controller = new AbortController();
      pending = { controller, promise: Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return adapter.accountUsage(controller.signal);
      }), consumers: 0 };
      this.pendingUsage.set(adapter.provider, pending);
      const owned = pending;
      const clear = (): void => {
        if (this.pendingUsage.get(adapter.provider) === owned) this.pendingUsage.delete(adapter.provider);
      };
      void pending.promise.then(clear, clear);
    }
    const shared = pending;
    shared.consumers += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, value?: ProviderAccountUsage): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", cancel);
        shared.consumers -= 1;
        if (shared.consumers === 0) {
          if (this.pendingUsage.get(adapter.provider) === shared) this.pendingUsage.delete(adapter.provider);
          shared.controller.abort();
        }
        if (value === undefined) reject(error instanceof Error ? error : new Error("账户查询失败", { cause: error }));
        else resolve(value);
      };
      const cancel = (): void => finish(signal?.reason);
      signal?.addEventListener("abort", cancel, { once: true });
      void shared.promise.then(value => finish(undefined, value), error => finish(error));
      if (signal?.aborted) cancel();
    });
  }

  private persist(usage: ProviderAccountUsage, limits?: ProviderAccountLimits): void {
    if (!this.snapshotWriter) return;
    // OpenAI 用量不能刷新额度时间，也不能在重启后用占位额度覆盖已有记录。
    if (usage.provider === "openai" && limits === undefined && !this.limitsObservedAt.has(usage.provider)) {
      this.snapshotUsage.set(usage.provider, usage);
      return;
    }
    const observedAtMs = usage.provider === "openai" && limits === undefined
      ? this.limitsObservedAt.get(usage.provider)!
      : Date.now();
    const mergedUsage = usage;
    // 用量查询没有额度观测；只合并已成功保存的额度，不用占位值覆盖。
    const mergedLimits = limits ?? this.snapshotLimits.get(usage.provider)
      ?? { kind: "unsupported" as const, provider: usage.provider };
    this.snapshotWriter.writeOfficialAccountSnapshot(createOfficialAccountSnapshot({
      provider: mergedUsage.provider,
      observedAtMs,
      usage: mergedUsage,
      limits: mergedLimits,
    }));
    this.snapshotUsage.set(usage.provider, usage);
    this.snapshotLimits.set(usage.provider, mergedLimits);
    if (limits !== undefined) this.limitsObservedAt.set(usage.provider, observedAtMs);
  }
}

export function createOpenAiAccountAdapter(
  query: AccountQueryPort,
): ProviderAccountAdapter {
  return {
    provider: "openai",
    async accountUsage() {
      return {
        kind: "token-usage",
        provider: "openai",
        usage: await query.accountUsage(),
      };
    },
    async accountThreadUsage(threadId) {
      return await query.accountThreadUsage(threadId);
    },
    async accountLimits(signal, options) {
      return {
        kind: "rate-limits",
        provider: "openai",
        limits: await query.accountRateLimits({ ...(signal ? { signal } : {}), ...(options?.refreshLogin ? { refreshLogin: true } : {}) }),
      };
    },
  };
}
