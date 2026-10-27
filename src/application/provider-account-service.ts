import { serialize } from "node:v8";
import type {
  AccountQueryPort,
  AccountThreadUsage,
  ProviderAccountAdapter,
  ProviderAccountLimits,
  ProviderAccountQueryPort,
  ProviderAccountUsage,
  OfficialAccountSnapshotWriter,
  CloudUsageQuery,
  CloudUsageReport,
} from "./account-port.js";
import { createOfficialAccountSnapshot } from "./account-snapshot.js";

export class ProviderAccountService implements ProviderAccountQueryPort {
  async cloudUsage(provider: string, query: CloudUsageQuery, signal?: AbortSignal, beforeSubmit?: () => void): Promise<CloudUsageReport | undefined> {
    signal?.throwIfAborted();
    beforeSubmit?.();
    const result = await this.adapters.get(provider)?.cloudUsage?.(query, signal, beforeSubmit);
    signal?.throwIfAborted();
    beforeSubmit?.();
    return result;
  }
  private readonly pendingUsage = new Map<string, {
    controller: AbortController; promise: Promise<ProviderAccountUsage>; consumers: number;
  }>();
  private readonly adapters = new Map<string, ProviderAccountAdapter>();
  private readonly snapshotUsage = new Map<string, ProviderAccountUsage>();
  private readonly snapshotLimits = new Map<string, ProviderAccountLimits>();
  private readonly limitsObservedAt = new Map<string, number>();
  private limitsQuerySequence = 0;
  private readonly savedLimitsSequence = new Map<string, number>();
  private readonly snapshotTails = new Map<string, Promise<void>>();
  private pendingSnapshots = 0;
  private pendingSnapshotBytes = 0;

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
    beforeSubmit?: () => void,
  ): Promise<ProviderAccountUsage> {
    signal?.throwIfAborted();
    beforeSubmit?.();
    const adapter = this.adapters.get(modelProvider);
    if (!adapter) {
      // 未注册的聚合或自定义 Provider 没有独立账户，不创建占位账户快照。
      return { kind: "unsupported", provider: modelProvider };
    }
    const accountUsage = adapter.provider === "openai" || beforeSubmit
      ? adapter.accountUsage(signal, beforeSubmit)
      : this.managedUsage(adapter, signal);
    if (!threadId || adapter.provider !== "openai" || !adapter.accountThreadUsage) {
      const result = await accountUsage;
      signal?.throwIfAborted();
      await this.persist(result, undefined, signal);
      beforeSubmit?.();
      return result;
    }
    let threadGuardFailure: { error: unknown } | undefined;
    const beforeThreadUsage = beforeSubmit ? () => {
      try { beforeSubmit(); }
      catch (error) {
        threadGuardFailure = { error };
        throw error;
      }
    } : undefined;
    const [usage, threadUsage]: [ProviderAccountUsage, AccountThreadUsage] = await Promise.all([
      accountUsage,
      adapter.accountThreadUsage(threadId, beforeThreadUsage).catch((): AccountThreadUsage => {
        if (threadGuardFailure) throw threadGuardFailure.error;
        beforeSubmit?.();
        return { kind: "failed" };
      }),
    ]);
    signal?.throwIfAborted();
    const result = usage.kind === "token-usage" ? { ...usage, threadUsage } : usage;
    await this.persist(result, undefined, signal);
    beforeSubmit?.();
    return result;
  }

  async accountLimits(modelProvider: string, signal?: AbortSignal, beforeSubmit?: () => void): Promise<ProviderAccountLimits> {
    signal?.throwIfAborted();
    beforeSubmit?.();
    const adapter = this.adapters.get(modelProvider);
    // 不支持的能力没有新的账户观测，不能覆盖进程重启前保存的状态。
    if (!adapter?.accountLimits) return { kind: "unsupported", provider: modelProvider };
    const sequence = ++this.limitsQuerySequence;
    const result = await adapter.accountLimits(signal, beforeSubmit);
    signal?.throwIfAborted();
    if (sequence >= (this.savedLimitsSequence.get(modelProvider) ?? 0)) {
      await this.persist(undefined, result, signal, sequence);
    }
    beforeSubmit?.();
    if (result.kind !== "rate-limits" || !this.readCredentialRefreshTime) return result;
    // Login metadata is presentation-only; never persist it as an official quota snapshot.
    const credentialRefreshedAt = await this.readCredentialRefreshTime(result.limits.accountId);
    signal?.throwIfAborted();
    beforeSubmit?.();
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
      ...(adapter.accountLimits ? [observe(adapter.provider, "limits", this.accountLimits(adapter.provider, signal))] : []),
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

  private async persist(
    usage: ProviderAccountUsage | undefined,
    limits?: ProviderAccountLimits,
    callerSignal?: AbortSignal,
    limitsSequence?: number,
  ): Promise<void> {
    callerSignal?.throwIfAborted();
    const writer = this.snapshotWriter;
    if (!writer) return;
    const provider = usage?.provider ?? limits?.provider;
    if (provider === undefined) throw new Error("账户快照缺少 Provider");
    const bytes = serialize([usage, limits]).byteLength;
    if (this.pendingSnapshots >= 128 || this.pendingSnapshotBytes + bytes > 4 * 1024 * 1024) throw new Error("账户快照队列已满");
    const signal = AbortSignal.any([AbortSignal.timeout(2_000), ...(callerSignal ? [callerSignal] : [])]);
    const observationAtMs = Date.now();
    this.pendingSnapshots++;
    this.pendingSnapshotBytes += bytes;
    const task = (this.snapshotTails.get(provider) ?? Promise.resolve()).then(async () => {
      signal.throwIfAborted();
      // The provider tail reserves ordering; only confirmed writes advance the watermark.
      // Recheck here because a newer in-flight write may have committed while this waited.
      if (limitsSequence !== undefined && limitsSequence < (this.savedLimitsSequence.get(provider) ?? 0)) return;
      const currentUsage = usage ?? this.snapshotUsage.get(provider) ?? { kind: "unsupported" as const, provider };
      // OpenAI 用量不能刷新额度时间，也不能在重启后用占位额度覆盖已有记录。
      if (provider === "openai" && limits === undefined && !this.limitsObservedAt.has(provider)) {
        this.snapshotUsage.set(provider, currentUsage);
        return;
      }
      const observedAtMs = provider === "openai" && limits === undefined
        ? this.limitsObservedAt.get(provider)!
        : observationAtMs;
      // 用量查询没有额度观测；只合并已成功保存的额度，不用占位值覆盖。
      const mergedLimits = limits ?? this.snapshotLimits.get(provider)
        ?? { kind: "unsupported" as const, provider };
      await writer.writeOfficialAccountSnapshot(createOfficialAccountSnapshot({
        provider,
        observedAtMs,
        usage: currentUsage,
        limits: mergedLimits,
      }), signal);
      // A dispatched write settles with its actual result even if its caller left.
      // Keep merge state aligned with the confirmed database snapshot.
      this.snapshotUsage.set(provider, currentUsage);
      this.snapshotLimits.set(provider, mergedLimits);
      if (limits !== undefined) this.limitsObservedAt.set(provider, observedAtMs);
      if (limitsSequence !== undefined) this.savedLimitsSequence.set(provider, limitsSequence);
    });
    const tail = task.catch(() => undefined).finally(() => {
      this.pendingSnapshots--;
      this.pendingSnapshotBytes -= bytes;
      if (this.snapshotTails.get(provider) === tail) this.snapshotTails.delete(provider);
    });
    this.snapshotTails.set(provider, tail);
    let cancel!: () => void;
    try {
      await Promise.race([task, new Promise<never>((_, reject) => {
        cancel = () => reject(new Error("账户快照已取消或超时"));
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      })]);
    } finally { signal.removeEventListener("abort", cancel); }
  }
}

export function createOpenAiAccountAdapter(
  query: AccountQueryPort,
): ProviderAccountAdapter {
  return {
    provider: "openai",
    async accountUsage(_signal, beforeSubmit) {
      return {
        kind: "token-usage",
        provider: "openai",
        usage: await query.accountUsage(beforeSubmit),
      };
    },
    async accountThreadUsage(threadId, beforeSubmit) {
      return await query.accountThreadUsage(threadId, beforeSubmit);
    },
    async accountLimits(signal, beforeSubmit) {
      return {
        kind: "rate-limits",
        provider: "openai",
        limits: await query.accountRateLimits({ ...(signal ? { signal } : {}), ...(beforeSubmit ? { beforeSubmit } : {}) }),
      };
    },
  };
}
