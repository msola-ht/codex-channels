import { describe, expect, it, vi } from "vitest";
import { toAccountRateLimits } from "../src/codex-client/account-adapter.js";

vi.mock("../runtime/opencode-go-accounts.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/opencode-go-accounts.mjs")>();
  return {
    ...actual,
    opencodeGoProviderDisplayName: (provider: string) => provider === "ocg-main"
      ? "ocg-user@example.com"
      : provider,
  };
});

import {
  formatConversationLimits,
  formatConversationModels,
  formatConversationUsage,
} from "../src/surfaces/conversation-command-format.js";

describe("conversation model and account command formatting", () => {
  it("groups reset credit expiry dates and preserves undisclosed and nonexpiring credits", () => {
    const limits = toAccountRateLimits({
      ordinaryUsageAllowed: true,
      rateLimits: {
        limitId: "codex", limitName: null, normalModelSlug: null,
        primary: null, secondary: null, credits: null, individualLimit: null,
        spendControlReached: null, planType: null, rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: {
        availableCount: 5n,
        credits: [2_000_000, null, 2_000_000].map((expiresAt, index) => ({
          id: `credit-${index}`,
          resetType: "codexRateLimits",
          status: "available",
          grantedAt: 1_000_000,
          expiresAt,
          title: null,
          description: null,
        })),
      },
      accountId: null,
      rateLimitUpsell: null,
    });
    expect(limits.resetCreditExpiresAt).toEqual([2_000_000, null, 2_000_000]);
    const render = () => formatConversationLimits({
      kind: "limits",
      result: { kind: "rate-limits", provider: "openai", limits },
    });
    expect(render()).toContain("可用额度重置券：5");
    expect(render()).toContain("：2 张");
    expect(render()).toContain("无到期时间：1 张");
    expect(render()).toContain("其余 2 张：服务端未提供明细");
    limits.resetCreditExpiresAt = null;
    expect(render()).toContain("重置券到期时间：服务端未提供明细");
    limits.resetCreditsAvailable = 0n;
    expect(render()).not.toContain("重置券到期时间");
  });

  it("warns that a pending Provider switch starts a new recoverable Thread", () => {
    const rendered = formatConversationModels({
      kind: "models",
      view: "model",
      state: {
        models: [{
          id: "deepseek-v4-flash",
          model: "deepseek-v4-flash",
          displayName: "DeepSeek-V4-Flash",
          provider: "deepseek",
          supportedReasoningEfforts: [{ effort: "high", description: "High" }],
          defaultReasoningEffort: "high",
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault: false,
          inputModalities: ["text"],
        }],
        model: "deepseek-v4-flash",
        modelProvider: "deepseek",
        effort: "high",
        serviceTier: null,
        pending: true,
        modelPending: true,
        effortPending: false,
        serviceTierPending: false,
        providerPending: true,
      },
    });

    expect(rendered).toContain("下一条消息中创建新 Session");
    expect(rendered).toContain("当前 Session 会保留");
    expect(rendered).toContain("下一条消息模型：deepseek-v4-flash · Provider：deepseek");
  });

  it("prompts for reasoning effort after selecting a model with multiple choices", () => {
    const rendered = formatConversationModels({
      kind: "models",
      view: "effort",
      nextSelection: "effort",
      state: {
        models: [{
          id: "gpt-test",
          model: "gpt-test",
          displayName: "GPT Test",
          supportedReasoningEfforts: [
            { effort: "medium", description: "平衡" },
            { effort: "high", description: "深入" },
          ],
          defaultReasoningEffort: "medium",
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault: true,
          inputModalities: ["text"],
        }],
        model: "gpt-test",
        modelProvider: "openai",
        effort: "medium",
        serviceTier: null,
        pending: true,
        modelPending: true,
        effortPending: true,
        serviceTierPending: false,
      },
    });

    expect(rendered).toContain("模型已选择，请继续选择思考等级");
    expect(rendered).toContain("切换：/effort <序号或档位>");
  });

  it("renders providers first for plain-text model selection", () => {
    const rendered = formatConversationModels({
      kind: "models",
      view: "model",
      state: {
        models: [
          {
            id: "gpt-test",
            model: "gpt-test",
            displayName: "GPT Test",
            provider: "openai",
            supportedReasoningEfforts: [{ effort: "medium", description: "平衡" }],
            defaultReasoningEffort: "medium",
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: true,
            inputModalities: ["text"],
          },
          {
            id: "deepseek-v4",
            model: "deepseek-v4",
            displayName: "DeepSeek V4",
            provider: "deepseek",
            supportedReasoningEfforts: [{ effort: "high", description: "深入" }],
            defaultReasoningEffort: "high",
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: false,
            inputModalities: ["text"],
          },
        ],
        model: "gpt-test",
        modelProvider: "openai",
        effort: "medium",
        serviceTier: null,
        pending: false,
        modelPending: false,
        effortPending: false,
        serviceTierPending: false,
      },
    });

    expect(rendered).toContain("### 可用提供商");
    expect(rendered).toContain("当前 Provider：OpenAI 官方");
    expect(rendered).toContain("1. OpenAI 官方 ← 当前 · 1 个模型");
    expect(rendered).toContain("2. DeepSeek · 1 个模型");
    expect(rendered).toContain("下一步：/model <提供商序号或 ID>");
    expect(rendered).not.toContain("模型列表（2）");
  });

  it("renders DeepSeek balance instead of OpenAI account usage", () => {
    const rendered = formatConversationUsage({
      kind: "usage",
      result: {
        kind: "balance",
        provider: "deepseek",
        available: true,
        balances: [{
          currency: "CNY",
          totalBalance: "110.00",
          grantedBalance: "10.00",
          toppedUpBalance: "100.00",
        }],
      },
    });

    expect(rendered).toContain("DeepSeek 账户余额");
    expect(rendered).toContain("总余额：110.00");
    expect(rendered).not.toContain("累计 Tokens");
  });

  it("renders OpenAI Thread official estimates after the account summary", () => {
    const groups = Array.from({ length: 9 }, (_, index) => ({
      model: index === 0 ? "gpt-5.4" : null,
      reasoningEffort: index === 0 ? "high" : null,
      speed: index === 0 ? "fast" : null,
      estimatedUsageCreditsMicros: index === 0 ? 46_000_000 : 1_000_000,
      netNewInputTokens: index === 0 ? 80 : 0,
      cachedInputTokens: index === 0 ? 20 : 0,
      inputTokens: index === 0 ? 100 : 0,
      outputTokens: index === 0 ? 40 : 0,
      totalTokens: index === 0 ? 140 : 0,
    }));
    const rendered = formatConversationUsage({
      kind: "usage",
      result: {
        kind: "token-usage",
        provider: "openai",
        usage: {
          summary: {
            lifetimeTokens: 123,
            peakDailyTokens: 45,
            longestRunningTurnSec: 6,
            currentStreakDays: 7,
            longestStreakDays: 8,
          },
          daily: [],
        },
        threadUsage: {
          kind: "available",
          threadId: "thread-secret",
          estimatedUsageCreditsMicros: 46_000_000,
          estimatedUsageUsdMicros: 1_820_000,
          groups,
        },
      },
    });

    expect(rendered).toContain("OpenAI Codex 账户用量摘要");
    expect(rendered).toContain("当前 Session 官方估算");
    expect(rendered).toContain("Credits：46");
    expect(rendered).toContain("估算费用：$1.82");
    expect(rendered).toContain("计费 Token：输入 100 · 缓存 20 · 输出 40");
    expect(rendered).toContain("gpt-5.4 · high · fast：46 Credits");
    expect(rendered).toContain("尚未展示 1 组");
    expect(rendered).toContain("官方估算可能延迟更新；本地请求明细与子代理累计请查看 /metrics");
    expect(rendered).not.toContain("thread-secret");
  });

  it("renders isolated unavailable and failed Thread estimate states", () => {
    const usage = {
      summary: {
        lifetimeTokens: 123,
        peakDailyTokens: null,
        longestRunningTurnSec: null,
        currentStreakDays: null,
        longestStreakDays: null,
      },
      daily: [],
    };
    const unavailable = formatConversationUsage({
      kind: "usage",
      result: {
        kind: "token-usage",
        provider: "openai",
        usage,
        threadUsage: { kind: "unavailable" },
      },
    });
    expect(unavailable).toContain("累计 Tokens");
    expect(unavailable).toContain("当前 Session 的官方计费估算不可用");
    expect(unavailable).toContain("仅向部分 Business/Enterprise 工作区开放");

    const failed = formatConversationUsage({
      kind: "usage",
      result: {
        kind: "token-usage",
        provider: "openai",
        usage,
        threadUsage: { kind: "failed" },
      },
    });
    expect(failed).toContain("累计 Tokens");
    expect(failed).toContain("当前 Session 官方估算暂时无法查询，请稍后重试 /usage");
  });

  it("omits unavailable official dollars and only sums complete Token fields", () => {
    const rendered = formatConversationUsage({
      kind: "usage",
      result: {
        kind: "token-usage",
        provider: "openai",
        usage: {
          summary: {
            lifetimeTokens: null,
            peakDailyTokens: null,
            longestRunningTurnSec: null,
            currentStreakDays: null,
            longestStreakDays: null,
          },
          daily: [],
        },
        threadUsage: {
          kind: "available",
          threadId: "thread-1",
          estimatedUsageCreditsMicros: 1,
          estimatedUsageUsdMicros: null,
          groups: [{
            model: null,
            reasoningEffort: null,
            speed: null,
            estimatedUsageCreditsMicros: 1,
            netNewInputTokens: null,
            cachedInputTokens: 2,
            inputTokens: null,
            outputTokens: 3,
            totalTokens: null,
          }],
        },
      },
    });

    expect(rendered).not.toContain("估算费用");
    expect(rendered).toContain("计费 Token：缓存 2 · 输出 3");
    expect(rendered).not.toContain("计费 Token：输入");
    expect(rendered).toContain("其他 · 其他 · 其他：0.000001 Credits");
  });

  it("renders OpenCode Go quota windows instead of OpenAI account usage", () => {
    const rendered = formatConversationUsage({
      kind: "usage",
      result: {
        kind: "quota-windows",
        provider: "ocg-main",
        available: true,
        windows: [
          {
            windowId: "rolling",
            label: "5小时",
            usedPercent: 0,
            resetsAt: 1_784_800_000,
            status: "ok",
            localTokens: 123_400,
          },
          {
            windowId: "monthly",
            label: "月度",
            usedPercent: 12.5,
            resetsAt: null,
            status: "ok",
          },
        ],
      },
    });

    expect(rendered).toContain("ocg-user@example.com 账户用量");
    expect(rendered).toContain("5小时：已用 0% · 本地 Token 约 123.4 K");
    expect(rendered).toContain("月度：已用 12.5% · 重置 未知");
    expect(rendered).not.toContain("总额");
    expect(rendered).not.toContain("累计 Tokens");
  });

  it("fails closed for unregistered Provider account capabilities", () => {
    expect(formatConversationUsage({
      kind: "usage",
      result: { kind: "unsupported", provider: "future-provider" },
    })).toContain("future-provider 仅提供模型请求，不提供账户余额/额度查询");
    expect(formatConversationLimits({
      kind: "limits",
      result: { kind: "unsupported", provider: "future-provider" },
    })).toContain("future-provider 仅提供模型请求，不提供账户限额查询");
  });

  it("renders weekly allowance estimates as local rounded samples", () => {
    const rendered = formatConversationLimits({
      kind: "limits",
      result: {
        kind: "rate-limits",
        provider: "openai",
        limits: {
          limits: [{
            limitId: "codex",
            limitName: "Codex",
            normalModelSlug: null,
            primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 2_000_000 },
            secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 2_000_000 },
            credits: null,
            individualLimit: null,
            spendControlReached: false,
            planType: "plus",
            rateLimitReachedType: null,
          }],
          ordinaryUsageLimit: {
            limitId: "codex",
            limitName: "Codex",
            normalModelSlug: null,
            primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 2_000_000 },
            secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 2_000_000 },
            credits: null,
            individualLimit: null,
            spendControlReached: false,
            planType: "plus",
            rateLimitReachedType: null,
          },
          resetCreditsAvailable: null,
          accountId: null,
          ordinaryUsageAllowed: null,
          lunaReserve: null,
          unsupportedUpsellPresent: false,
        },
        weeklyEstimates: [{
          limitId: "codex",
          startAtMs: 1_000,
          endAtMs: 2_000,
          usedPercent: 20,
          remainingPercent: 80,
          observedDeltaPercent: 2,
          intervalCount: 2,
          requestCount: 40,
          unsuccessfulRequestCount: 2,
          inputTokensPerPercent: 90_000,
          outputTokensPerPercent: 10_000,
          totalTokensPerPercent: 100_000,
          remainingTokens: 8_000_000,
        }],
      },
    });

    expect(rendered).toContain("周限估算（本机代理样本）");
    expect(rendered).toContain("观测变化 2%（2 个区间）");
    expect(rendered).toContain("每 1%：约 100 K Token");
    expect(rendered).toContain("剩余 80%：约 8 M Token");
  });

});
