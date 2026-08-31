import { describe, expect, it } from "vitest";

import { toAccountThreadUsage } from "../src/codex-client/account-adapter.js";
import { CodexAppServerClient } from "../src/codex-client/client.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import type { GetAccountTokenUsageResponse } from "../src/codex-protocol/index.js";
import { appServerRateLimit, FakeTransport } from "./support/json-rpc-fixtures.js";

describe("JsonRpcClient account", () => {
    it("reads account rate limits through the stable App Server method", async () => {
      const transport = new FakeTransport();
      transport.accountRateLimitsResult = {
        rateLimits: appServerRateLimit({ planType: "ent26" }),
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
      };
      const rpc = new JsonRpcClient(transport);
      const client = new CodexAppServerClient(rpc, {
        sandbox: "workspace-write",
      });
      await client.connect();

      const result = await client.accountRateLimits();

      expect(result.limits[0]?.planType).toBe("ent26");
      expect(transport.sent.some((message) => message.method === "account/rateLimits/read")).toBe(true);
    });

    it.each([
      "self_serve_business_prolite",
      "enterprise_cbp_automation",
      "edu_plus",
      "edu_pro",
    ] as const)("accepts the Codex 0.150.1 plan type %s", async (planType) => {
      const transport = new FakeTransport();
      transport.accountRateLimitsResult = {
        rateLimits: appServerRateLimit({ planType }),
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
      };
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.accountRateLimits()).resolves.toMatchObject({
        limits: [{ planType }],
      });
    });

    it("maps account usage and multi-bucket limits to stable Application summaries", async () => {
      const transport = new FakeTransport();
      transport.accountUsageResult = {
        summary: {
          lifetimeTokens: 123,
          peakDailyTokens: 45,
          longestRunningTurnSec: 6,
          currentStreakDays: 7,
          longestStreakDays: 8,
        },
        dailyUsageBuckets: [{ startDate: "2026-07-25", tokens: 9 }],
      };
      transport.accountRateLimitsResult = {
        rateLimits: appServerRateLimit(),
        rateLimitsByLimitId: {
          codex: appServerRateLimit({
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 100 },
          }),
          other: appServerRateLimit({ limitId: "other", limitName: "Other", planType: null }),
        },
        rateLimitResetCredits: { availableCount: 2, credits: null },
      };
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.accountUsage()).resolves.toEqual({
        summary: {
          lifetimeTokens: 123,
          peakDailyTokens: 45,
          longestRunningTurnSec: 6,
          currentStreakDays: 7,
          longestStreakDays: 8,
        },
        daily: [{ startDate: "2026-07-25", tokens: 9 }],
      });
      await expect(client.accountRateLimits()).resolves.toMatchObject({
        limits: [
          {
            limitId: "codex",
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 100 },
          },
          {
            limitId: "other",
            limitName: "Other",
          },
        ],
        resetCreditsAvailable: 2,
      });
    });

    it("reads exact OpenAI Thread usage with the account usage RPC params", async () => {
      const transport = new FakeTransport();
      transport.accountUsageResult = {
        ...transport.accountUsageResult,
        threadUsage: {
          threadId: "thread-1",
          estimatedUsageCreditsMicros: 46_000_000,
          estimatedUsageUsdMicros: 1_820_000,
          groups: [{
            model: "gpt-5.4",
            reasoningEffort: "high",
            speed: "fast",
            estimatedUsageCreditsMicros: 46_000_000,
            netNewInputTokens: 80,
            cachedInputTokens: 20,
            inputTokens: 100,
            outputTokens: 40,
            totalTokens: 140,
          }],
        },
      };
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.accountThreadUsage("thread-1")).resolves.toEqual({
        kind: "available",
        threadId: "thread-1",
        estimatedUsageCreditsMicros: 46_000_000,
        estimatedUsageUsdMicros: 1_820_000,
        groups: [{
          model: "gpt-5.4",
          reasoningEffort: "high",
          speed: "fast",
          estimatedUsageCreditsMicros: 46_000_000,
          netNewInputTokens: 80,
          cachedInputTokens: 20,
          inputTokens: 100,
          outputTokens: 40,
          totalTokens: 140,
        }],
      });
      expect(transport.sent.findLast((message) => message.method === "account/usage/read"))
        .toEqual(expect.objectContaining({
          method: "account/usage/read",
          params: { threadId: "thread-1" },
        }));
    });

    it("maps missing Thread usage and rejects a mismatched Thread ID", async () => {
      const unavailableTransport = new FakeTransport();
      const unavailableClient = new CodexAppServerClient(new JsonRpcClient(unavailableTransport), {
        sandbox: "workspace-write",
      });
      await unavailableClient.connect();
      await expect(unavailableClient.accountThreadUsage("thread-1")).resolves.toEqual({
        kind: "unavailable",
      });

      const invalidTransport = new FakeTransport();
      invalidTransport.accountUsageResult = {
        ...invalidTransport.accountUsageResult,
        threadUsage: {
          threadId: "thread-other",
          estimatedUsageCreditsMicros: -1,
          estimatedUsageUsdMicros: null,
          groups: [],
        },
      };
      const invalidClient = new CodexAppServerClient(new JsonRpcClient(invalidTransport), {
        sandbox: "workspace-write",
      });
      await invalidClient.connect();
      await expect(invalidClient.accountThreadUsage("thread-1"))
        .rejects.toThrow("threadId 与请求不一致");
    });

    it.each([
      [
        "negative total",
        {
          threadId: "thread-1",
          estimatedUsageCreditsMicros: -1,
          estimatedUsageUsdMicros: null,
          groups: [],
        },
        "estimatedUsageCreditsMicros",
      ],
      [
        "fractional group metric",
        {
          threadId: "thread-1",
          estimatedUsageCreditsMicros: 1,
          estimatedUsageUsdMicros: null,
          groups: [{
            model: null,
            reasoningEffort: null,
            speed: null,
            estimatedUsageCreditsMicros: 0.5,
            netNewInputTokens: null,
            cachedInputTokens: null,
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
          }],
        },
        "group 1 estimatedUsageCreditsMicros",
      ],
      [
        "missing nullable group field",
        {
          threadId: "thread-1",
          estimatedUsageCreditsMicros: 1,
          estimatedUsageUsdMicros: null,
          groups: [{
            reasoningEffort: null,
            speed: null,
            estimatedUsageCreditsMicros: 1,
            netNewInputTokens: null,
            cachedInputTokens: null,
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
          }],
        },
        "group 1 model",
      ],
      [
        "control character",
        {
          threadId: "thread-1",
          estimatedUsageCreditsMicros: 1,
          estimatedUsageUsdMicros: null,
          groups: [{
            model: "gpt-test\nsecret",
            reasoningEffort: null,
            speed: null,
            estimatedUsageCreditsMicros: 1,
            netNewInputTokens: null,
            cachedInputTokens: null,
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
          }],
        },
        "group 1 model",
      ],
    ])("rejects unsafe Thread usage data: %s", async (_name, threadUsage, field) => {
      const transport = new FakeTransport();
      transport.accountUsageResult = {
        ...transport.accountUsageResult,
        threadUsage,
      };
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {
        sandbox: "workspace-write",
      });
      await client.connect();

      await expect(client.accountThreadUsage("thread-1")).rejects.toThrow(field);
    });

    it("rejects a Thread metric above the official i64 range", () => {
      const response: GetAccountTokenUsageResponse = {
        summary: {
          lifetimeTokens: null,
          peakDailyTokens: null,
          longestRunningTurnSec: null,
          currentStreakDays: null,
          longestStreakDays: null,
        },
        dailyUsageBuckets: null,
        threadUsage: {
          threadId: "thread-1",
          estimatedUsageCreditsMicros: 9_223_372_036_854_775_808n,
          estimatedUsageUsdMicros: null,
          groups: [],
        },
      };

      expect(() => toAccountThreadUsage(response, "thread-1"))
        .toThrow("estimatedUsageCreditsMicros");
    });

    it("fails closed when account query responses contain invalid metrics", async () => {
      const usageTransport = new FakeTransport();
      usageTransport.accountUsageResult = {
        ...usageTransport.accountUsageResult,
        summary: {
          lifetimeTokens: "secret upstream body",
          peakDailyTokens: null,
          longestRunningTurnSec: null,
          currentStreakDays: null,
          longestStreakDays: null,
        },
      };
      const usageClient = new CodexAppServerClient(new JsonRpcClient(usageTransport), {
        sandbox: "workspace-write",
      });
      await usageClient.connect();
      await expect(usageClient.accountUsage())
        .rejects.toThrow("Codex 响应缺少有效 lifetimeTokens");

      const limitsTransport = new FakeTransport();
      limitsTransport.accountRateLimitsResult = {
        rateLimits: appServerRateLimit({ planType: "future-plan" }),
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
      };
      const limitsClient = new CodexAppServerClient(new JsonRpcClient(limitsTransport), {
        sandbox: "workspace-write",
      });
      await limitsClient.connect();
      await expect(limitsClient.accountRateLimits())
        .rejects.toThrow("Codex 响应缺少有效 planType");
    });

    it("omits params for App Server methods whose generated request has no params", async () => {
      const transport = new FakeTransport();
      const rpc = new JsonRpcClient(transport);
      const client = new CodexAppServerClient(rpc, {
        sandbox: "workspace-write",
      });
      await client.connect();

      await client.accountUsage();
      await client.accountRateLimits();

      expect(transport.sent.find((message) => message.method === "account/usage/read"))
        .toEqual(expect.objectContaining({ method: "account/usage/read" }));
      expect(transport.sent.find((message) => message.method === "account/usage/read"))
        .not.toHaveProperty("params");
      expect(transport.sent.find((message) => message.method === "account/rateLimits/read"))
        .not.toHaveProperty("params");
    });
});
