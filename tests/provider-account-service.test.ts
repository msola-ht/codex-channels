import { describe, expect, it, vi } from "vitest";

import {
  ProviderAccountService,
  createOpenAiAccountAdapter,
  type AccountQueryPort,
  type AccountRateLimits,
  type OfficialAccountSnapshot,
  type ProviderAccountUsage,
} from "../src/application/index.js";

describe("ProviderAccountService", () => {
  it("requests login refresh for manual limits but not startup warmup and preserves caller cancellation", async () => {
    const query = {
      accountUsage: vi.fn(async () => ({ summary: {
        lifetimeTokens: 1, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null,
      }, daily: [] })),
      accountRateLimits: vi.fn(async () => emptyRateLimits()),
      accountThreadUsage: vi.fn(async () => ({ kind: "unavailable" as const })),
    } satisfies AccountQueryPort;
    const adapter = createOpenAiAccountAdapter(query);
    const accountLimits = vi.spyOn(adapter, "accountLimits");
    const service = new ProviderAccountService([adapter]);
    const manual = new AbortController();
    await service.accountLimits("openai", manual.signal);
    expect(accountLimits).toHaveBeenNthCalledWith(1, manual.signal, { refreshLogin: true });
    expect(query.accountRateLimits).toHaveBeenNthCalledWith(1, { signal: manual.signal, refreshLogin: true });

    const warmup = new AbortController();
    await service.refreshSnapshots(warmup.signal);
    expect(accountLimits).toHaveBeenNthCalledWith(2, warmup.signal, { refreshLogin: false });
    expect(query.accountRateLimits).toHaveBeenNthCalledWith(2, { signal: warmup.signal });

    manual.abort(new Error("manual refresh cancelled"));
    await expect(service.accountLimits("openai", manual.signal)).rejects.toThrow("manual refresh cancelled");
    expect(query.accountRateLimits).toHaveBeenCalledTimes(2);
  });

  it("adds credential refresh time after snapshot persistence without changing official limits", async () => {
    const limits = { ...emptyRateLimits(), accountId: "account-a" };
    const read = vi.fn().mockResolvedValue(1790131317);
    const write = vi.fn();
    const service = new ProviderAccountService([{ provider: "openai", accountUsage: async () => ({ kind: "unsupported", provider: "openai" }),
      accountLimits: async () => ({ kind: "rate-limits", provider: "openai", limits }),
    }], { writeOfficialAccountSnapshot: write }, read);
    expect(await service.accountLimits("openai")).toMatchObject({ credentialRefreshedAt: 1790131317 });
    expect(read).toHaveBeenCalledWith("account-a");
    expect(write.mock.calls[0]![0].limits).not.toHaveProperty("credentialRefreshedAt");
    await service.accountUsage("openai");
    expect(write.mock.calls.at(-1)![0].limits).not.toHaveProperty("credentialRefreshedAt");
    await service.accountLimits("other");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("does not refresh OpenAI quota age with usage or overwrite stored quotas after restart", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const write = vi.fn();
    const usage: ProviderAccountUsage = { kind: "token-usage", provider: "openai", usage: { summary: {
      lifetimeTokens: 1, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null,
    }, daily: [] } };
    const accountLimits = vi.fn(async () => ({ kind: "rate-limits" as const, provider: "openai" as const, limits: emptyRateLimits() }));
    const service = new ProviderAccountService([{ provider: "openai", accountUsage: async () => usage, accountLimits }], { writeOfficialAccountSnapshot: write });
    try {
      await service.accountUsage("openai");
      expect(write).not.toHaveBeenCalled();
      await service.accountLimits("openai");
      now.mockReturnValue(3_601_000);
      await service.accountUsage("openai");
      expect(accountLimits).toHaveBeenCalledTimes(1);
      expect(write.mock.calls.at(-1)?.[0].observedAtMs).toBe(1000);
      await service.accountLimits("openai");
      expect(write.mock.calls.at(-1)?.[0].observedAtMs).toBe(3_601_000);
    } finally { now.mockRestore(); }
  });

  it("does not let an older quota request overwrite a newer successful observation", async () => {
    const write = vi.fn();
    let finish!: (value: { kind: "rate-limits"; provider: string; limits: AccountRateLimits }) => void;
    const before = { kind: "rate-limits" as const, provider: "openai", limits: { ...emptyRateLimits(), resetCreditsAvailable: 2 } };
    const after = { ...before, limits: { ...before.limits, resetCreditsAvailable: 1 } };
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(after);
    const credentialRefreshedAt = 1790131317;
    const readCredentialRefreshTime = vi.fn().mockResolvedValue(credentialRefreshedAt);
    const service = new ProviderAccountService([{ provider: "openai", accountUsage: async () => ({ kind: "unsupported", provider: "openai" }), accountLimits: read }], { writeOfficialAccountSnapshot: write }, readCredentialRefreshTime);
    const earlier = service.accountLimits("openai");
    expect(await service.accountLimits("openai")).toMatchObject({ credentialRefreshedAt });
    finish(before);
    expect(await earlier).toMatchObject({ credentialRefreshedAt });
    expect(readCredentialRefreshTime).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0].limits).toEqual(after);
  });
  it.each(["clp-main", "openai"])("cancels %s warmup and ignores late usage and limits without reporting shutdown as failure", async provider => {
    const write = vi.fn();
    const failure = vi.fn();
    let finishUsage!: (usage: ProviderAccountUsage) => void;
    let finishLimits!: (limits: { kind: "unsupported"; provider: string }) => void;
    let outbound: AbortSignal | undefined;
    const service = new ProviderAccountService([{
      provider,
      accountUsage: signal => { outbound = signal; return new Promise(resolve => { finishUsage = resolve; }); },
      accountLimits: () => new Promise(resolve => { finishLimits = resolve; }),
    }], { writeOfficialAccountSnapshot: write });
    const controller = new AbortController();
    const warmup = service.refreshSnapshots(controller.signal, failure);
    await Promise.resolve();
    controller.abort();
    expect(outbound?.aborted).toBe(true);
    finishUsage({ kind: "quota-windows", provider, available: true, windows: [] });
    finishLimits({ kind: "unsupported", provider });
    await warmup;
    expect(write).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
  });

  it.each(["usage-first", "limits-first"])("preserves both OpenAI observations when warmup finishes %s", async order => {
    const written: OfficialAccountSnapshot[] = [];
    let finishUsage!: () => void;
    let finishLimits!: () => void;
    const usage = { kind: "token-usage" as const, provider: "openai" as const, usage: {
      summary: { lifetimeTokens: 10, peakDailyTokens: 5, longestRunningTurnSec: 1,
        currentStreakDays: 2, longestStreakDays: 3 }, daily: [],
    } };
    const limits = { kind: "rate-limits" as const, provider: "openai" as const, limits: {
      ...emptyRateLimits(), resetCreditsAvailable: 3, resetCreditExpiresAt: [1_791_173_933],
    } };
    const service = new ProviderAccountService([{
      provider: "openai",
      accountUsage: () => new Promise(resolve => { finishUsage = () => resolve(usage); }),
      accountLimits: () => new Promise(resolve => { finishLimits = () => resolve(limits); }),
    }], { writeOfficialAccountSnapshot: snapshot => { written.push(snapshot); } });
    const warmup = service.refreshSnapshots();
    if (order === "usage-first") {
      finishUsage();
      await Promise.resolve();
      finishLimits();
    } else {
      finishLimits();
      await Promise.resolve();
      finishUsage();
    }
    await warmup;
    expect(written.at(-1)).toMatchObject({ usage, limits });
    const refresh = service.accountUsage("openai");
    finishUsage();
    await refresh;
    expect(written.at(-1)).toMatchObject({ usage, limits });
  });

  it("reports each failed warmup query while keeping successful accounts independent", async () => {
    const failure = vi.fn();
    const write = vi.fn();
    const badUsage = new Error("usage fixture");
    const badLimits = new Error("limits fixture");
    const service = new ProviderAccountService([
      { provider: "clp-bad", accountUsage: async () => { throw badUsage; }, accountLimits: async () => { throw badLimits; } },
      { provider: "clp-good", accountUsage: async () => ({ kind: "quota-windows", provider: "clp-good", available: true, windows: [] }) },
    ], { writeOfficialAccountSnapshot: write });
    await service.refreshSnapshots(undefined, failure);
    expect(failure).toHaveBeenCalledWith("clp-bad", "usage", badUsage);
    expect(failure).toHaveBeenCalledWith("clp-bad", "limits", badLimits);
    expect(failure).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0].provider).toBe("clp-good");
  });

  it("does not publish a snapshot into memory when persistence fails", async () => {
    const write = vi.fn().mockImplementationOnce(() => { throw new Error("disk failure"); });
    const service = new ProviderAccountService([{
      provider: "clp-main",
      accountUsage: async () => ({ kind: "quota-windows", provider: "clp-main", available: true, windows: [] }),
      accountLimits: async () => ({ kind: "unsupported", provider: "clp-main" }),
    }], { writeOfficialAccountSnapshot: write });
    await expect(service.refreshAccountSnapshot("clp-main")).rejects.toThrow("disk failure");
    await service.accountLimits("clp-main");
    expect(write.mock.calls[1]?.[0].usage.kind).toBe("unsupported");
  });

  it("shares one provider query but lets each consumer cancel independently", async () => {
    let complete!: (usage: ProviderAccountUsage) => void;
    let upstream: AbortSignal | undefined;
    const read = vi.fn((signal?: AbortSignal) => {
      upstream = signal;
      return new Promise<ProviderAccountUsage>(resolve => { complete = resolve; });
    });
    const write = vi.fn();
    const service = new ProviderAccountService([{ provider: "clp-main", accountUsage: read }], { writeOfficialAccountSnapshot: write });
    const first = new AbortController();
    const second = new AbortController();
    const a = service.refreshAccountSnapshot("clp-main", first.signal);
    const rejected = expect(a).rejects.toMatchObject({ name: "AbortError" });
    const b = service.refreshAccountSnapshot("clp-main", second.signal);
    await Promise.resolve();
    first.abort();
    await rejected;
    expect(read).toHaveBeenCalledTimes(1);
    expect(upstream?.aborted).toBe(false);
    complete({ kind: "quota-windows", provider: "clp-main", available: true, windows: [] });
    await expect(b).resolves.toBe(true);
    expect(write).toHaveBeenCalledOnce();
  });

  it("abandons a cancelled query and rejects its late result without deleting the replacement", async () => {
    const completions: Array<(usage: ProviderAccountUsage) => void> = [];
    const read = vi.fn(() => new Promise<ProviderAccountUsage>(resolve => completions.push(resolve)));
    const write = vi.fn();
    const service = new ProviderAccountService([{ provider: "clp-main", accountUsage: read }], { writeOfficialAccountSnapshot: write });
    const controller = new AbortController();
    const old = service.refreshAccountSnapshot("clp-main", controller.signal);
    const rejected = expect(old).rejects.toThrow();
    await Promise.resolve();
    controller.abort();
    await rejected;
    const current = service.refreshAccountSnapshot("clp-main");
    await Promise.resolve();
    const usage = { kind: "quota-windows" as const, provider: "clp-main", available: true, windows: [] };
    completions[0]!(usage);
    await Promise.resolve();
    const joined = service.refreshAccountSnapshot("clp-main");
    expect(read).toHaveBeenCalledTimes(2);
    completions[1]!(usage);
    await Promise.all([current, joined]);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("passes cancellation to the exact account and discards late snapshots", async () => {
    const controller = new AbortController();
    const written = vi.fn();
    const read = vi.fn(async (signal?: AbortSignal): Promise<ProviderAccountUsage> => {
      expect(signal?.aborted).toBe(false);
      controller.abort();
      expect(signal?.aborted).toBe(true);
      return { kind: "quota-windows", provider: "clp-main", available: true, windows: [] };
    });
    const other = vi.fn();
    const service = new ProviderAccountService([
      { provider: "clp-main", accountUsage: read }, { provider: "clp-other", accountUsage: other },
    ], { writeOfficialAccountSnapshot: written });
    await expect(service.accountUsage("clp-main", undefined, controller.signal)).rejects.toThrow();
    expect(written).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
  });
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
