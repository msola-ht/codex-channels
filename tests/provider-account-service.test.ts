import { describe, expect, it, vi } from "vitest";

import {
  ProviderAccountService,
  createOpenAiAccountAdapter,
  type AccountQueryPort,
} from "../src/application/index.js";

describe("ProviderAccountService", () => {
  it("routes OpenAI account queries and keeps unknown providers unsupported", async () => {
    const usage = { summary: {
      lifetimeTokens: 10,
      peakDailyTokens: 5,
      longestRunningTurnSec: 1,
      currentStreakDays: 2,
      longestStreakDays: 3,
    }, daily: [] };
    const limits = { limits: [], resetCreditsAvailable: null };
    const query = {
      accountUsage: vi.fn(async () => usage),
      accountRateLimits: vi.fn(async () => limits),
      accountThreadUsage: vi.fn(async () => ({ kind: "unavailable" as const })),
    } satisfies AccountQueryPort;
    const service = new ProviderAccountService([
      createOpenAiAccountAdapter(query),
    ]);

    await expect(service.accountUsage("openai")).resolves.toEqual({
      kind: "token-usage",
      provider: "openai",
      usage,
    });
    await expect(service.accountLimits("openai")).resolves.toEqual({
      kind: "rate-limits",
      provider: "openai",
      limits,
    });
    await expect(service.accountUsage("future-provider")).resolves.toEqual({
      kind: "unsupported",
      provider: "future-provider",
    });
    await expect(service.accountLimits("future-provider")).resolves.toEqual({
      kind: "unsupported",
      provider: "future-provider",
    });
  });

  it("can asynchronously prewarm all registered account sources", async () => {
    const usage = vi.fn(async () => ({
      kind: "unsupported" as const,
      provider: "deepseek",
    }));
    const limits = vi.fn(async () => ({
      kind: "unsupported" as const,
      provider: "deepseek",
    }));
    const service = new ProviderAccountService([{ provider: "deepseek", accountUsage: usage, accountLimits: limits }]);
    await service.refreshSnapshots();
    expect(usage).toHaveBeenCalledOnce();
    expect(limits).toHaveBeenCalledOnce();
  });

  it("rejects duplicate provider registrations", () => {
    const adapter = {
      provider: "duplicate",
      accountUsage: async () => ({ kind: "unsupported" as const, provider: "duplicate" }),
    };
    expect(() => new ProviderAccountService([adapter, adapter]))
      .toThrow("Provider 账户适配器重复或无效");
  });

  it("keeps the account summary when the optional OpenAI Thread query fails", async () => {
    const usage = {
      summary: {
        lifetimeTokens: 1,
        peakDailyTokens: null,
        longestRunningTurnSec: null,
        currentStreakDays: null,
        longestStreakDays: null,
      },
      daily: [],
    };
    const accountThreadUsage = vi.fn(async () => {
      throw new Error("thread usage unavailable");
    });
    const service = new ProviderAccountService([
      createOpenAiAccountAdapter({
        accountUsage: async () => usage,
        accountRateLimits: async () => ({ limits: [], resetCreditsAvailable: null }),
        accountThreadUsage,
      }),
    ]);

    await expect(service.accountUsage("openai", "thread-1")).resolves.toEqual({
      kind: "token-usage",
      provider: "openai",
      usage,
      threadUsage: { kind: "failed" },
    });
    expect(accountThreadUsage).toHaveBeenCalledWith("thread-1");
  });

  it("keeps the account summary as the required OpenAI usage result", async () => {
    const accountThreadUsage = vi.fn(async () => ({ kind: "unavailable" as const }));
    const accountFailure = new Error("account usage unavailable");
    const service = new ProviderAccountService([
      createOpenAiAccountAdapter({
        accountUsage: async () => Promise.reject(accountFailure),
        accountRateLimits: async () => ({ limits: [], resetCreditsAvailable: null }),
        accountThreadUsage,
      }),
    ]);

    await expect(service.accountUsage("openai", "thread-1")).rejects.toBe(accountFailure);
    expect(accountThreadUsage).toHaveBeenCalledWith("thread-1");
  });

  it("does not query OpenAI Thread usage without a current Thread", async () => {
    const accountThreadUsage = vi.fn(async () => ({ kind: "unavailable" as const }));
    const service = new ProviderAccountService([
      createOpenAiAccountAdapter({
        accountUsage: async () => ({
          summary: {
            lifetimeTokens: null,
            peakDailyTokens: null,
            longestRunningTurnSec: null,
            currentStreakDays: null,
            longestStreakDays: null,
          },
          daily: [],
        }),
        accountRateLimits: async () => ({ limits: [], resetCreditsAvailable: null }),
        accountThreadUsage,
      }),
    ]);

    await expect(service.accountUsage("openai")).resolves.toMatchObject({
      kind: "token-usage",
      provider: "openai",
    });
    expect(accountThreadUsage).not.toHaveBeenCalled();
  });

  it("does not call a third-party adapter's optional Thread query", async () => {
    const accountThreadUsage = vi.fn();
    const service = new ProviderAccountService([{
      provider: "deepseek",
      accountUsage: async () => ({
        kind: "balance" as const,
        provider: "deepseek",
        available: true,
        balances: [],
      }),
      accountThreadUsage,
    }]);

    await expect(service.accountUsage("deepseek", "thread-1")).resolves.toEqual({
      kind: "balance",
      provider: "deepseek",
      available: true,
      balances: [],
    });
    expect(accountThreadUsage).not.toHaveBeenCalled();
  });
});
