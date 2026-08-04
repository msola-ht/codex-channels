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
      "调试模式：关闭",
      "",
      "当前会话：",
      "Workspace：Main (main)",
      "工作目录：/workspace/main",
      "Thread：thread-1",
      "Git 分支：feature/lifecycle",
      "模型：gpt-test",
      "提供商：OpenAI 官方",
      "思考强度：medium",
      "Fast 模式：开启",
      "协作模式：Default",
      "",
      "账户状态：",
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
      "本次运行：",
      "错误：失败：[已隐藏]",
      "模型：gpt-test · medium · Fast 开启",
      "提供商：OpenAI 官方",
      "最近请求缓存命中率：75.00%",
      "总耗时：1分5秒",
      "",
      "当前会话累计：",
      "上下文：10 K / 100 K（10%）",
      "上下文压缩：2 次",
      "Goal：进行中 · 12.5 K / 100 K",
      "Git 分支：feature/lifecycle",
      "",
      "账户状态：",
      "周限：剩余 63%",
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
    expect(rendered).toContain("提供商：DeepSeek");
    expect(rendered).not.toContain("Fast");
    expect(rendered).not.toContain("周限");
  });

  it("shows output, thinking and combined generation speeds", () => {
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
        status: "completed",
        modelProvider: "deepseek",
        timing: {
          modelRequestCount: 2,
          reasoningRequestCount: 2,
          modelRequestDurationMs: 12_400,
          requestInputTokens: 20_000,
          requestCachedInputTokens: 15_000,
          ttftMs: 640,
          firstResponseLatencyMs: 920,
          nonReasoningOutputTokens: 42,
          outputTokensPerSecond: 2.1,
          outputSpeedSampleCount: 2,
          outputSpeedTimedCount: 2,
          reasoningTokens: 80,
          thinkingTokensPerSecond: 20,
          thinkingSpeedSampleCount: 2,
          thinkingSpeedTimedCount: 2,
          generationTokensPerSecond: 120,
          generationSpeedSampleCount: 2,
          generationSpeedTimedCount: 2,
          referenceCost: {
            currency: "USD",
            totalCostNanos: 350_000,
            inputCostNanos: 150_000,
            cachedInputCostNanos: 50_000,
            outputCostNanos: 150_000,
            pricedRequestCount: 2,
            requestCount: 2,
            uncachedInputPricePerMillionNanos: 140_000_000,
            cachedInputPricePerMillionNanos: 2_800_000,
            outputPricePerMillionNanos: 280_000_000,
            hasMixedPrices: false,
          },
        },
        sessionReferenceCost: {
          currency: "USD",
          totalCostNanos: 1_250_000,
          inputCostNanos: 500_000,
          cachedInputCostNanos: 200_000,
          outputCostNanos: 550_000,
          pricedRequestCount: 8,
          requestCount: 9,
          uncachedInputPricePerMillionNanos: null,
          cachedInputPricePerMillionNanos: null,
          outputPricePerMillionNanos: null,
          hasMixedPrices: true,
        },
      }),
    );

    expect(rendered).toContain("模型请求：2 次");
    expect(rendered).toContain("思考次数：2 次");
    expect(rendered).toContain("模型请求聚合耗时：12秒");
    expect(rendered).toContain("参考总价：$0.000350（已计价 2/2 次请求）");
    expect(rendered).toContain("参考总价：$0.001250（已计价 8/9 次请求）");
    expect(rendered).toContain("本次请求缓存命中率：75.00%");
    expect(rendered).toContain("最后请求首事件延迟：640毫秒");
    expect(rendered).toContain("首段回复延迟：920毫秒");
    expect(rendered).toContain("综合输出速度：2.1 token/s（不含推理 · 覆盖 2/2 次请求）");
    expect(rendered).toContain("综合思考速度：20 token/s（推理 · 覆盖 2/2 次请求）");
    expect(rendered).toContain("综合生成速度：120 token/s（含推理 · 覆盖 2/2 次请求）");
    expect(rendered).not.toContain("思考时长");
    expect(rendered).not.toContain("输出时长");
  });

  it("separates completed, interrupted and unobservable model attempts", () => {
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
        status: "completed",
        timing: {
          modelRequestCount: 62,
          completedModelRequestCount: 20,
          interruptedModelRequestCount: 42,
          incompleteModelRequestCount: 0,
          failedModelRequestCount: 0,
        },
      }),
    );

    expect(rendered).toContain("模型请求：62 次（完成 20 · 中断 42）");
  });

  it("shows a recovered model failure as an automatic retry", () => {
    const rendered = renderPlainLifecyclePresentation(
      createTurnCompletedPresentation({
        type: "turn.completed",
        target: {
          surface: "weixin",
          accountId: "default",
          conversationId: "100",
        },
        threadId: "thread-deepseek",
        turnId: "turn-deepseek",
        status: "completed",
        timing: {
          modelRequestCount: 2,
          completedModelRequestCount: 1,
          interruptedModelRequestCount: 0,
          incompleteModelRequestCount: 0,
          failedModelRequestCount: 1,
          retryableFailureModelRequestCount: 1,
          referenceCost: {
            currency: "USD",
            totalCostNanos: 915_000,
            inputCostNanos: 300_000,
            cachedInputCostNanos: 100_000,
            outputCostNanos: 515_000,
            pricedRequestCount: 1,
            requestCount: 2,
            uncachedInputPricePerMillionNanos: 140_000_000,
            cachedInputPricePerMillionNanos: 2_800_000,
            outputPricePerMillionNanos: 280_000_000,
            hasMixedPrices: false,
          },
        },
      }),
    );

    expect(rendered).toContain(
      "模型请求：2 次（完成 1 · 自动重试 1，最终成功）",
    );
    expect(rendered).toContain(
      "参考总价：$0.000915（已计价 1/1 个成功请求）",
    );
    expect(rendered).not.toContain("折合人民币");
  });

  it("converts the run reference cost with the provided exchange rate", () => {
    const rendered = renderPlainLifecyclePresentation(
      createTurnCompletedPresentation({
        type: "turn.completed",
        target: {
          surface: "weixin",
          accountId: "default",
          conversationId: "100",
        },
        threadId: "thread-deepseek",
        turnId: "turn-deepseek",
        status: "completed",
        modelProvider: "deepseek",
        timing: {
          modelRequestCount: 1,
          completedModelRequestCount: 1,
          referenceCost: {
            currency: "USD",
            totalCostNanos: 1_000_000_000,
            inputCostNanos: 600_000_000,
            cachedInputCostNanos: 100_000_000,
            outputCostNanos: 300_000_000,
            pricedRequestCount: 1,
            requestCount: 1,
            uncachedInputPricePerMillionNanos: 140_000_000,
            cachedInputPricePerMillionNanos: 2_800_000,
            outputPricePerMillionNanos: 280_000_000,
            hasMixedPrices: false,
          },
        },
        sessionReferenceCost: {
          currency: "USD",
          totalCostNanos: 2_000_000_000,
          inputCostNanos: 1_200_000_000,
          cachedInputCostNanos: 200_000_000,
          outputCostNanos: 600_000_000,
          pricedRequestCount: 2,
          requestCount: 2,
          uncachedInputPricePerMillionNanos: 140_000_000,
          cachedInputPricePerMillionNanos: 2_800_000,
          outputPricePerMillionNanos: 280_000_000,
          hasMixedPrices: false,
        },
      }, (provider) => provider === "deepseek" ? "cny" : "usd", {
        usdToCny: 7.2,
        effectiveAtMs: 1_700_000_000_000,
        source: "ecb",
      }),
    );

    expect(rendered).toContain("参考总价：¥7.200000（已计价 1/1 个成功请求）");
    expect(rendered).toContain("参考总价：¥14.400000（已计价 2/2 次请求）");
    expect(rendered).not.toContain("折合人民币");
    expect(rendered).not.toContain("$");
  });

  it("keeps a non-retryable model failure visible after a completed request", () => {
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
        status: "completed",
        timing: {
          modelRequestCount: 2,
          completedModelRequestCount: 1,
          interruptedModelRequestCount: 0,
          incompleteModelRequestCount: 0,
          failedModelRequestCount: 1,
          retryableFailureModelRequestCount: 0,
        },
      }),
    );

    expect(rendered).toContain("模型请求：2 次（完成 1 · 失败 1）");
    expect(rendered).not.toContain("自动重试");
  });

  it("omits reasoning metrics when the provider does not expose a timing stream", () => {
    const rendered = renderPlainLifecyclePresentation(
      createTurnCompletedPresentation({
        type: "turn.completed",
        target: {
          surface: "telegram",
          accountId: "default",
          conversationId: "100",
        },
        threadId: "thread-openai",
        turnId: "turn-openai",
        status: "completed",
        modelProvider: "openai",
        timing: {
          reasoningTokens: 40,
          outputTokensPerSecond: 96,
        },
      }),
    );

    expect(rendered).toContain("输出速度：96 token/s（不含推理）");
    expect(rendered).not.toContain("首字延时");
    expect(rendered).not.toContain("推理输出");
    expect(rendered).not.toContain("思考速度");
    expect(rendered).not.toContain("生成速度");
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
