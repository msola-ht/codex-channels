import { describe, expect, it } from "vitest";

import {
  formatLimits,
  formatStatus,
  formatUsage,
  formatWorkspaces,
  splitTelegramText,
} from "../src/surfaces/telegram/format.js";

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
  });

  it("explains when a bound thread has not emitted token statistics", () => {
    expect(formatStatus({
      workspaceId: "main",
      workspaceName: "Main",
      threadId: "thread-1",
      cwd: "/tmp/project",
    }))
      .toContain("等待 App Server 推送统计");
  });
});
