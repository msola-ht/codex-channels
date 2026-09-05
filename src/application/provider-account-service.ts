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
  private readonly adapters = new Map<string, ProviderAccountAdapter>();
  private readonly snapshotUsage = new Map<string, ProviderAccountUsage>();
  private readonly snapshotLimits = new Map<string, ProviderAccountLimits>();

  constructor(
    adapters: readonly ProviderAccountAdapter[],
    private readonly snapshotWriter?: OfficialAccountSnapshotWriter,
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
  ): Promise<ProviderAccountUsage> {
    const adapter = this.adapters.get(modelProvider);
    if (!adapter) {
      const result = { kind: "unsupported" as const, provider: modelProvider };
      this.persist(result, result);
      return result;
    }
    const accountUsage = adapter.accountUsage();
    if (!threadId || adapter.provider !== "openai" || !adapter.accountThreadUsage) {
      let result: ProviderAccountUsage;
      try {
        result = await accountUsage;
      } catch (error) {
        this.persist({ kind: "unsupported", provider: modelProvider }, { kind: "unsupported", provider: modelProvider });
        throw error;
      }
      this.persist(result, { kind: "unsupported", provider: modelProvider });
      return result;
    }
    let usage: ProviderAccountUsage;
    let threadUsage: AccountThreadUsage;
    try {
      [usage, threadUsage] = await Promise.all([
        accountUsage,
        adapter.accountThreadUsage(threadId).catch((): AccountThreadUsage => ({
          kind: "failed",
        })),
      ]);
    } catch (error) {
      this.persist({ kind: "unsupported", provider: modelProvider }, { kind: "unsupported", provider: modelProvider });
      throw error;
    }
    const result = usage.kind === "token-usage" ? { ...usage, threadUsage } : usage;
    this.persist(result, { kind: "unsupported", provider: modelProvider });
    return result;
  }

  async accountLimits(modelProvider: string): Promise<ProviderAccountLimits> {
    const adapter = this.adapters.get(modelProvider);
    let result: ProviderAccountLimits;
    try {
      result = adapter?.accountLimits
        ? await adapter.accountLimits()
        : { kind: "unsupported", provider: modelProvider };
    } catch (error) {
      this.persist(
        this.snapshotUsage.get(modelProvider) ?? { kind: "unsupported", provider: modelProvider },
        { kind: "unsupported", provider: modelProvider },
      );
      throw error;
    }
    this.persist(
      this.snapshotUsage.get(modelProvider)
        ?? { kind: "unsupported", provider: modelProvider },
      result,
    );
    return result;
  }

  /** 按需预热所有已注册账户；调用方应异步触发，不阻塞主服务启动。 */
  async refreshSnapshots(): Promise<void> {
    await Promise.allSettled([...this.adapters.keys()].flatMap((provider) => [
      this.accountUsage(provider),
      this.accountLimits(provider),
    ]));
  }

  private persist(usage: ProviderAccountUsage, limits: ProviderAccountLimits): void {
    if (!this.snapshotWriter) return;
    this.snapshotUsage.set(usage.provider, usage);
    this.snapshotLimits.set(limits.provider, limits);
    const mergedUsage = this.snapshotUsage.get(usage.provider) ?? usage;
    const mergedLimits = this.snapshotLimits.get(usage.provider) ?? limits;
    this.snapshotWriter.writeOfficialAccountSnapshot(createOfficialAccountSnapshot({
      provider: mergedUsage.provider,
      observedAtMs: Date.now(),
      usage: mergedUsage,
      limits: mergedLimits,
    }));
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
    async accountLimits() {
      return {
        kind: "rate-limits",
        provider: "openai",
        limits: await query.accountRateLimits(),
      };
    },
  };
}
