import { describe, expect, it } from "vitest";

import {
  createStartupPresentation,
  createTurnCompletedPresentation,
  createTurnStartedPresentation,
  renderPlainLifecyclePresentation,
} from "../src/surfaces/lifecycle-presentation.js";

describe("shared Surface lifecycle presentation", () => {
  it("uses one startup field order for every Surface renderer", () => {
    const rendered = renderPlainLifecyclePresentation(
      createStartupPresentation(
        [{ id: "main", name: "Main", cwd: "/workspace/main" }],
        {
          threadId: "thread-1",
          workspaceId: "main",
          model: "gpt-test",
          effort: "medium",
          serviceTier: "priority",
          modelPending: false,
          effortPending: false,
          fastModePending: false,
          collaborationMode: "default",
          collaborationModePending: false,
          gitBranch: "feature/lifecycle",
          weeklyLimit: {
            usedPercent: 37,
            windowDurationMins: 10_080,
            resetsAt: null,
          },
        },
        {
          platform: "linux",
          architecture: "x64",
          gatewayVersion: "0.146.0",
          nodeVersion: "v22.23.1",
          transport: "Unix WebSocket",
          codexUpstreamUserAgent:
            "codex/0.146.0 (Linux; x64) private-build (gateway; 0.146.0)",
        },
      ),
    );

    expect(rendered).toBe([
      "Codex Connect 已上线",
      "",
      "App Server：已连接",
      "",
      "运行环境：",
      "系统：Linux · x64",
      "版本：Codex Connect 0.146.0 · Node.js v22.23.1",
      "连接：Unix WebSocket",
      "App Server UA：codex/0.146.0 (Linux; x64) (gateway; 0.146.0)",
      "",
      "当前会话：",
      "Workspace：Main (main)",
      "工作目录：/workspace/main",
      "Thread：thread-1",
      "Git 分支：feature/lifecycle",
      "模型：gpt-test",
      "Provider：OpenAI",
      "思考强度：medium",
      "Fast 模式：开启",
      "协作模式：Default",
      "周限：剩余 63%",
    ].join("\n"));
  });

  it("uses one Turn start and completion field order", () => {
    expect(renderPlainLifecyclePresentation(
      createTurnStartedPresentation(),
    )).toBe("已开始处理。");

    const rendered = renderPlainLifecyclePresentation(
      createTurnCompletedPresentation({
        type: "turn.completed",
        target: {
          surface: "telegram",
          accountId: "default",
          conversationId: "100",
        },
        threadId: "thread-1",
        turnId: "turn-1",
        status: "failed",
        error: "失败：[REDACTED]",
        durationMs: 65_432,
        tokenUsage: {
          total: tokenBreakdown(20_000, 15_000, 12_000),
          last: tokenBreakdown(10_000, 8_000, 6_000),
          modelContextWindow: 100_000,
        },
        model: "gpt-test",
        modelProvider: "openai",
        effort: "medium",
        serviceTier: "priority",
        contextCompactionCount: 2,
        weeklyLimit: {
          usedPercent: 37,
          windowDurationMins: 10_080,
          resetsAt: null,
        },
        goal: {
          threadId: "thread-1",
          objective: "统一生命周期",
          status: "active",
          tokenBudget: 100_000,
          tokensUsed: 12_500,
          timeUsedSeconds: 90,
          createdAt: 1,
          updatedAt: 2,
        },
        gitBranch: "feature/lifecycle",
      }),
    );

    expect(rendered).toBe([
      "本次运行 · 失败",
      "",
      "错误：失败：[已隐藏]",
      "上下文：10 K / 100 K（10%）",
      "缓存命中：75%",
      "模型：gpt-test · medium · Fast 开启",
      "Provider：OpenAI",
      "上下文压缩：2 次",
      "周限：剩余 63%",
      "Goal：进行中 · 12.5 K / 100 K",
      "Git 分支：feature/lifecycle",
      "耗时：1分5秒",
    ].join("\n"));
  });

  it("keeps Thread metrics but hides OpenAI-only fields for DeepSeek", () => {
    const rendered = renderPlainLifecyclePresentation(
      createTurnCompletedPresentation({
        type: "turn.completed",
        target: { surface: "feishu", accountId: "default", conversationId: "chat" },
        threadId: "thread-deepseek",
        turnId: "turn-deepseek",
        status: "completed",
        tokenUsage: {
          total: tokenBreakdown(30_000, 20_000, 10_000),
          last: tokenBreakdown(20_000, 16_000, 8_000),
          modelContextWindow: 1_048_576,
        },
        model: "deepseek-v4-flash",
        modelProvider: "deepseek",
        effort: "high",
        serviceTier: null,
        weeklyLimit: {
          usedPercent: 90,
          windowDurationMins: 10_080,
          resetsAt: null,
        },
      }),
    );

    expect(rendered).toContain("上下文：20 K / 1.05 M");
    expect(rendered).toContain("模型：deepseek-v4-flash · high");
    expect(rendered).toContain("Provider：DeepSeek");
    expect(rendered).not.toContain("Fast");
    expect(rendered).not.toContain("周限");
  });
});

function tokenBreakdown(
  totalTokens: number,
  inputTokens: number,
  cachedInputTokens: number,
) {
  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens: 0,
    outputTokens: totalTokens - inputTokens,
    reasoningOutputTokens: 0,
  };
}
