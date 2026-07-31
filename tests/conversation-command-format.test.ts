import { describe, expect, it } from "vitest";

import {
  formatConversationLimits,
  formatConversationModels,
  formatConversationStatus,
  formatConversationUsage,
} from "../src/surfaces/conversation-command-format.js";

describe("provider-aware conversation command formatting", () => {
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

    expect(rendered).toContain("下一条消息中创建新 Thread");
    expect(rendered).toContain("当前 Thread 会保留");
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

  it("fails closed for unregistered Provider account capabilities", () => {
    expect(formatConversationUsage({
      kind: "usage",
      result: { kind: "unsupported", provider: "future-provider" },
    })).toContain("future-provider 暂不支持账户用量查询");
    expect(formatConversationLimits({
      kind: "limits",
      result: { kind: "unsupported", provider: "future-provider" },
    })).toContain("future-provider 暂不支持账户限额查询");
  });

  it("keeps Thread metrics and hides OpenAI-only state for DeepSeek", () => {
    const rendered = formatConversationStatus({
      threadId: "thread-deepseek",
      workspaceId: "main",
      workspaceName: "Main",
      cwd: "/workspace",
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
      effort: "high",
      serviceTier: null,
      modelPending: false,
      effortPending: false,
      fastModePending: false,
      collaborationMode: "default",
      collaborationModePending: false,
      tokenUsage: {
        total: breakdown(30_000),
        last: breakdown(20_000),
        modelContextWindow: 1_048_576,
      },
      weeklyLimit: {
        usedPercent: 90,
        windowDurationMins: 10_080,
        resetsAt: null,
      },
    });

    expect(rendered).toContain("Provider：DeepSeek");
    expect(rendered).toContain("模型上下文窗口容量：1.05 M");
    expect(rendered).not.toContain("Fast 模式");
    expect(rendered).not.toContain("周限");
  });
});

function breakdown(totalTokens: number) {
  return {
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens,
  };
}
