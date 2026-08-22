import type {
  AccountQueryPort,
  AccountThreadUsage,
  ProviderAccountAdapter,
  ProviderAccountLimits,
  ProviderAccountQueryPort,
  ProviderAccountUsage,
} from "./account-port.js";

export class ProviderAccountService implements ProviderAccountQueryPort {
  private readonly adapters = new Map<string, ProviderAccountAdapter>();

  constructor(adapters: readonly ProviderAccountAdapter[]) {
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
      return { kind: "unsupported", provider: modelProvider };
    }
    const accountUsage = adapter.accountUsage();
    if (!threadId || adapter.provider !== "openai" || !adapter.accountThreadUsage) {
      return await accountUsage;
    }
    const [usage, threadUsage] = await Promise.all([
      accountUsage,
      adapter.accountThreadUsage(threadId).catch((): AccountThreadUsage => ({
        kind: "failed",
      })),
    ]);
    return usage.kind === "token-usage"
      ? { ...usage, threadUsage }
      : usage;
  }

  async accountLimits(modelProvider: string): Promise<ProviderAccountLimits> {
    const adapter = this.adapters.get(modelProvider);
    return adapter?.accountLimits
      ? await adapter.accountLimits()
      : { kind: "unsupported", provider: modelProvider };
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
