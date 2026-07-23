import { describe, expect, it } from "vitest";

import {
  formatContextUsage,
  formatDiff,
  formatModels,
  formatPlan,
  formatReasoningEfforts,
  formatLimits,
  formatStatus,
  formatStartupNotification,
  formatUsage,
  formatWorkspaces,
  splitTelegramText,
} from "../src/surfaces/telegram/format.js";
import type { Model } from "../src/codex-protocol/index.js";

function model(name: string, efforts: string[], defaultEffort: string, isDefault = false): Model {
  return {
    id: name,
    model: name,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: name,
    description: `${name} description`,
    hidden: false,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: `${reasoningEffort} description`,
    })),
    defaultReasoningEffort: defaultEffort,
    inputModalities: ["text"],
    supportsPersonality: true,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault,
  };
}

describe("splitTelegramText", () => {
  it("splits by Unicode code points without corrupting emoji", () => {
    const text = `${"a".repeat(3_999)}😀${"b".repeat(10)}`;
    const chunks = splitTelegramText(text, 4_000);

    expect(chunks.map((chunk) => Array.from(chunk).length)).toEqual([4_000, 10]);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
    expect(chunks.every((chunk) => !/^[\uDC00-\uDFFF]/.test(chunk))).toBe(true);
  });
});

describe("turn artifact formatting", () => {
  const artifacts = {
    threadId: "thread-1",
    turnId: "turn-1",
    diff: "diff --git a/a.ts b/a.ts",
    plan: {
      explanation: "按顺序执行",
      steps: [
        { step: "检查", status: "completed" as const },
        { step: "修改", status: "inProgress" as const },
      ],
    },
  };

  it("renders the latest diff", () => {
    expect(formatDiff(artifacts)).toContain("diff --git a/a.ts b/a.ts");
  });

  it("renders plan state symbols", () => {
    expect(formatPlan(artifacts)).toContain("● 检查");
    expect(formatPlan(artifacts)).toContain("◐ 修改");
  });
});

describe("model formatting", () => {
  const models = [
    model("gpt-main", ["low", "medium", "high"], "medium", true),
    model("gpt-fast", ["low", "high"], "low"),
  ];

  it("marks the selected model and explains how to switch", () => {
    const text = formatModels({ models, model: "gpt-fast", effort: "high", pending: true });

    expect(text).toContain("当前模型：gpt-fast（下一次 Turn 生效）");
    expect(text).toContain("2. gpt-fast · gpt-fast ← 当前");
    expect(text).toContain("/model <序号、模型 ID 或名称>");
  });

  it("only lists reasoning efforts supported by the current model", () => {
    const text = formatReasoningEfforts({
      models,
      model: "gpt-fast",
      effort: "high",
      pending: false,
    });

    expect(text).toContain("2. high ← 当前");
    expect(text).not.toContain("medium description");
    expect(text).toContain("/effort <序号或档位>");
  });
});

describe("formatWorkspaces", () => {
  it("marks the current workspace and only renders configured paths", () => {
    const text = formatWorkspaces(
      [
        { id: "main", name: "Main", cwd: "/workspace/main" },
        { id: "docs", name: "Docs", cwd: "/workspace/docs" },
      ],
      "docs",
    );

    expect(text).toContain("2. Docs · docs ← 当前");
    expect(text).toContain("/workspace/main");
    expect(text).toContain("/workspace/docs");
  });
});

describe("formatStartupNotification", () => {
  it("reports connectivity and includes the configured workspaces", () => {
    const text = formatStartupNotification(
      [
        { id: "main", name: "Main", cwd: "/workspace/main" },
        { id: "docs", name: "Docs", cwd: "/workspace/docs" },
      ],
      {
        threadId: "019f8951-eb3",
        workspaceId: "main",
        model: "gpt-main",
        effort: "high",
        modelPending: false,
        weeklyLimit: {
          usedPercent: 42,
          windowDurationMins: 10_080,
          resetsAt: null,
        },
      },
      {
        platform: "darwin",
        architecture: "arm64",
        gatewayVersion: "0.145.0",
        nodeVersion: "v24.18.0",
        transport: "Unix WebSocket",
        codexUpstreamUserAgent: "codex_connect_gateway/0.145.0 (Mac OS 15.7.7; arm64) dumb (codex_connect_gateway; 0.145.0)",
      },
    );

    expect(text).toContain("Codex Connect 已联通");
    expect(text).toContain("App Server 已连接");
    expect(text).toContain("运行环境：");
    expect(text).toContain("│ macOS · arm64");
    expect(text).toContain("│ Codex Connect 0.145.0 · Node.js v24.18.0");
    expect(text).toContain(
      "│ UA · codex_connect_gateway/0.145.0 (Mac OS 15.7.7; arm64) (codex_connect_gateway; 0.145.0)",
    );
    expect(text).toContain("│ Unix WebSocket");
    expect(text).toContain("当前会话：");
    expect(text).toContain("│ Main · main");
    expect(text).toContain("│ /workspace/main");
    expect(text).toContain("│ Thread · 019f8951-eb3");
    expect(text).toContain("│ gpt-main · high");
    expect(text).toContain("│ 周限 · 已使用 42%");
    expect(text).not.toContain("本地握手");
    expect(text).not.toContain("本地未发送请求头");
    expect(text).toContain("Workspace（2）：");
    expect(text).toContain("│ 1. Main · main ← 当前");
    expect(text).toContain("│ 2. Docs · docs");
    expect(text).toContain("│ /workspace/docs");
  });

  it("reports an unbound thread and keeps unknown platform names", () => {
    const text = formatStartupNotification(
      [{ id: "main", name: "Main", cwd: "/workspace/main" }],
      {
        workspaceId: "main",
        model: "gpt-main",
        effort: null,
        modelPending: false,
      },
      {
        platform: "freebsd",
        architecture: "x64",
        gatewayVersion: "0.145.0",
        nodeVersion: "v22.13.0",
        transport: "Unix WebSocket",
        codexUpstreamUserAgent: null,
      },
    );

    expect(text).toContain("│ freebsd · x64");
    expect(text).toContain("│ UA · App Server 未返回");
    expect(text).toContain("│ Thread · 尚未绑定");
  });
});

describe("formatUsage", () => {
  it("formats token totals in millions and shows the latest seven daily buckets", () => {
    const text = formatUsage({
      summary: {
        lifetimeTokens: 5_054_682_221n,
        peakDailyTokens: 202_768_846n,
        longestRunningTurnSec: 647n,
        currentStreakDays: 40n,
        longestStreakDays: 40n,
      },
      dailyUsageBuckets: [
        { startDate: "2026-07-15", tokens: 1_000_000n },
        { startDate: "2026-07-19", tokens: 9_000_000n },
        { startDate: "2026-07-22", tokens: 12_345_678n },
        { startDate: "2026-07-16", tokens: 2_000_000n },
        { startDate: "2026-07-21", tokens: 11_000_000n },
        { startDate: "2026-07-17", tokens: 3_000_000n },
        { startDate: "2026-07-20", tokens: 10_000_000n },
        { startDate: "2026-07-18", tokens: 4_000_000n },
      ],
    });

    expect(text).toContain("累计 Tokens：5,054.68 M");
    expect(text).toContain("单日峰值：202.77 M");
    expect(text).toContain("- 2026-07-22：12.35 M");
    expect(text).not.toContain("2026-07-15");
    expect(text.indexOf("2026-07-22")).toBeLessThan(text.indexOf("2026-07-21"));
  });

  it("reports when the account service does not return daily buckets", () => {
    const text = formatUsage({
      summary: {
        lifetimeTokens: null,
        peakDailyTokens: null,
        longestRunningTurnSec: null,
        currentStreakDays: null,
        longestStreakDays: null,
      },
      dailyUsageBuckets: null,
    });

    expect(text).toContain("累计 Tokens：未知");
    expect(text).toContain("暂无每日数据");
  });
});

describe("formatLimits", () => {
  it("shows plan, quota windows, credits, and reset credits", () => {
    const text = formatLimits({
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1_784_700_000 },
        secondary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: 1_785_000_000 },
        credits: { hasCredits: true, unlimited: true, balance: null },
        individualLimit: null,
        spendControlReached: false,
        planType: "pro",
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: { availableCount: 2n, credits: null },
    });

    expect(text).toContain("套餐：Pro");
    expect(text).toContain("主窗口：已使用 31% · 周期 5 小时");
    expect(text).toContain("次窗口：已使用 42% · 周期 7 天");
    expect(text).toContain("Credits：无限");
    expect(text).toContain("消费控制：正常");
    expect(text).toContain("限流状态：正常");
    expect(text).toContain("可用额度重置券：2");
  });
});

describe("formatStatus", () => {
  it("shows the latest App Server thread token statistics", () => {
    const text = formatStatus({
      workspaceId: "main",
      workspaceName: "Main",
      threadId: "thread-1",
      turnId: "turn-1",
      cwd: "/tmp/project",
      model: "gpt-main",
      effort: "high",
      modelPending: false,
      tokenUsage: {
        total: {
          totalTokens: 1_250_000,
          inputTokens: 1_000_000,
          cachedInputTokens: 750_000,
          cacheWriteInputTokens: 10_000,
          outputTokens: 250_000,
          reasoningOutputTokens: 50_000,
        },
        last: {
          totalTokens: 12_500,
          inputTokens: 10_000,
          cachedInputTokens: 7_500,
          cacheWriteInputTokens: 100,
          outputTokens: 2_500,
          reasoningOutputTokens: 500,
        },
        modelContextWindow: 200_000,
      },
    });

    expect(text).toContain("累计：1.25 M");
    expect(text).toContain("最近 Turn：12.5 K");
    expect(text).toContain("缓存输入：750 K");
    expect(text).toContain("模型上下文窗口容量：200 K");
    expect(text).toContain("模型：gpt-main");
    expect(text).toContain("思考强度：high");
  });

  it("explains when a bound thread has not emitted token statistics", () => {
    expect(formatStatus({
      workspaceId: "main",
      workspaceName: "Main",
      threadId: "thread-1",
      cwd: "/tmp/project",
      model: "gpt-main",
      effort: null,
      modelPending: false,
    }))
      .toContain("等待 App Server 推送统计");
  });
});

describe("formatContextUsage", () => {
  it("uses the latest context count rather than cumulative thread tokens", () => {
    expect(formatContextUsage(
      {
        total: {
          totalTokens: 1_250_000,
          inputTokens: 1_000_000,
          cachedInputTokens: 750_000,
          cacheWriteInputTokens: 0,
          outputTokens: 250_000,
          reasoningOutputTokens: 50_000,
        },
        last: {
          totalTokens: 12_500,
          inputTokens: 10_000,
          cachedInputTokens: 7_500,
          cacheWriteInputTokens: 0,
          outputTokens: 2_500,
          reasoningOutputTokens: 500,
        },
        modelContextWindow: 200_000,
      },
      {
        model: "gpt-main",
        effort: "high",
        weeklyLimit: {
          usedPercent: 42,
          windowDurationMins: 10_080,
          resetsAt: null,
        },
      },
    )).toBe([
      "上下文：12.5 K / 200 K（6.3%）",
      "当前模型：gpt-main",
      "思考强度：high",
      "周限：已使用 42%",
    ].join("\n"));
  });
});
