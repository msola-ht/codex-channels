import { describe, expect, it, vi } from "vitest";
import { withQuotaTokenEstimates } from "../runtime/quota-token-estimate.mjs";

import {
  ProviderAccountService,
  createOpenAiAccountAdapter,
  type AccountQueryPort,
  type AccountRateLimits,
  type OfficialAccountSnapshot,
  type ProviderAccountUsage,
} from "../src/application/index.js";

describe("ProviderAccountService", () => {
  it("persists missing subscription across failures and restart, then replaces it on recovery", async () => {
    const normal: ProviderAccountUsage = { kind: "quota-windows", provider: "ocg-main", available: true, windows: [] };
    const missing: ProviderAccountUsage = { kind: "subscription-required", provider: "ocg-main" };
    const usage = vi.fn<() => Promise<ProviderAccountUsage>>()
      .mockResolvedValueOnce(normal).mockResolvedValueOnce(missing)
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(normal);
    const written: OfficialAccountSnapshot[] = [];
    const writer = { writeOfficialAccountSnapshot: (snapshot: OfficialAccountSnapshot) => { written.push(snapshot); } };
    const adapters = [{ provider: "ocg-main", accountUsage: usage }];
    const service = new ProviderAccountService(adapters, writer);
    await service.accountUsage("ocg-main");
    await service.refreshAccountSnapshot("ocg-main");
    expect(written.at(-1)).toMatchObject({ available: false, usage: missing });
    await expect(service.accountUsage("ocg-main")).rejects.toThrow("timeout");
    const restarted = new ProviderAccountService(adapters, writer);
    await restarted.refreshSnapshots();
    await expect(restarted.accountLimits("ocg-main")).resolves.toEqual({ kind: "unsupported", provider: "ocg-main" });
    expect(written).toHaveLength(2);
    expect(written.at(-1)?.usage).toEqual(missing);
    await restarted.refreshAccountSnapshot("ocg-main");
    expect(written.at(-1)).toMatchObject({ available: true, usage: normal });
  });
  it("persists official quota before enrichment and isolates an estimate failure", async () => {
    const provider = "clp-main";
    const quota = { kind: "quota-windows" as const, provider, available: true,
      windows: [{ windowId: "weekly", label: "7天", usedPercent: 12, resetsAt: 9999999999, status: null }] };
    const written: OfficialAccountSnapshot[] = [];
    const estimate = { status: "ready" as const, tokensPerPercent: 1000, observedDeltaPercent: 2, intervalCount: 1, requestCount: 2 };
    const read = vi.fn(() => {
      expect(written.at(-1)?.usage).toEqual(quota);
      return [{ windowId: "weekly", resetsAt: 9999999999, tokenEstimate: estimate }];
    });
    const service = new ProviderAccountService([{ provider, accountUsage: async () => quota }], {
      writeOfficialAccountSnapshot: snapshot => { written.push(snapshot); },
    }, windows => withQuotaTokenEstimates(windows, read));
    await expect(service.accountUsage(provider)).resolves.toMatchObject({ windows: [{ tokenEstimate: estimate }] });
    read.mockImplementationOnce(() => { throw new Error("fixture metrics failure"); });
    await expect(service.accountUsage(provider)).resolves.toMatchObject({ available: true, windows: [{ tokenEstimate: { status: "unavailable" } }] });
    expect(written.every(snapshot => JSON.stringify(snapshot.usage) === JSON.stringify(quota))).toBe(true);
  });

  it("routes OpenAI account queries and keeps unknown providers unsupported", async () => {
    const usage = { summary: {
      lifetimeTokens: 10,
      peakDailyTokens: 5,
      longestRunningTurnSec: 1,
      currentStreakDays: 2,
      longestStreakDays: 3,
    }, daily: [] };
    const limits = emptyRateLimits();
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

  it("does not request limits from an account adapter that only provides usage", async () => {
    const usage = vi.fn(async () => ({
      kind: "balance" as const,
      provider: "deepseek",
      available: true,
      balances: [],
    }));
    const writeOfficialAccountSnapshot = vi.fn();
    const service = new ProviderAccountService(
      [{ provider: "deepseek", accountUsage: usage }],
      { writeOfficialAccountSnapshot },
    );

    await service.refreshSnapshots();

    expect(usage).toHaveBeenCalledOnce();
    expect(writeOfficialAccountSnapshot).toHaveBeenCalledOnce();
  });

  it("keeps the last successful snapshot when a refresh fails", async () => {
    const refreshFailure = new Error("refresh failed");
    const usage = vi.fn()
      .mockResolvedValueOnce({
        kind: "balance" as const,
        provider: "deepseek",
        available: true,
        balances: [],
      })
      .mockRejectedValueOnce(refreshFailure);
    const writeOfficialAccountSnapshot = vi.fn();
    const service = new ProviderAccountService(
      [{ provider: "deepseek", accountUsage: usage }],
      { writeOfficialAccountSnapshot },
    );

    await expect(service.refreshAccountSnapshot("deepseek")).resolves.toBe(true);
    await expect(service.refreshAccountSnapshot("deepseek")).rejects.toBe(refreshFailure);
    await expect(service.refreshAccountSnapshot("missing")).resolves.toBe(false);

    expect(writeOfficialAccountSnapshot).toHaveBeenCalledOnce();
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
        accountRateLimits: async () => emptyRateLimits(),
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
        accountRateLimits: async () => emptyRateLimits(),
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
        accountRateLimits: async () => emptyRateLimits(),
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

function emptyRateLimits(): AccountRateLimits {
  return {
    limits: [],
    ordinaryUsageLimit: {
      limitId: "codex",
      limitName: null,
      normalModelSlug: null,
      primary: null,
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: null,
      rateLimitReachedType: null,
    },
    resetCreditsAvailable: null,
    accountId: null,
    ordinaryUsageAllowed: null,
    lunaReserve: null,
    unsupportedUpsellPresent: false,
  };
}
