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

  it("rejects duplicate provider registrations", () => {
    const adapter = {
      provider: "duplicate",
      accountUsage: async () => ({ kind: "unsupported" as const, provider: "duplicate" }),
    };
    expect(() => new ProviderAccountService([adapter, adapter]))
      .toThrow("Provider 账户适配器重复或无效");
  });
});
