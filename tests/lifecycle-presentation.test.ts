import { describe, expect, it } from "vitest";

import {
  createStartupPresentation,
  createSubagentCompletedPresentation,
  createSubagentStartedPresentation,
  createTurnCompletedPresentation,
  createTurnStartedPresentation,
  renderPlainLifecyclePresentation,
  renderStructuredLifecyclePresentation,
} from "../src/surfaces/lifecycle-presentation.js";
import {
  formatReferenceCostTotal,
} from "../src/surfaces/reference-cost-format.js";
import { formatOpenAiErrorMessage } from "../src/surfaces/account-format.js";

describe("shared Surface lifecycle presentation", () => {
  it("renders a compact subagent start notice without internal IDs", () => {
    const rendered = renderPlainLifecyclePresentation(
      createSubagentStartedPresentation({
        type: "subagent.spawned",
        target: {
          surface: "feishu",
          accountId: "default",
          conversationId: "conversation-1",
        },
        threadId: "parent-thread",
        turnId: "parent-turn",
        agentThreadId: "agent-thread-secret",
        agentPath: "/root/review_task",
      }),
    );

    expect(rendered).toBe("子代理开始 · review_task");
    expect(rendered).not.toContain("agent-thread-secret");
  });

  it("translates known OpenAI usage-limit errors to Chinese", () => {
    expect(formatOpenAiErrorMessage(
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage "
      + "to purchase more credits or try again at Aug 7th, 2026 11:37 PM.",
    )).toBe(
      "OpenAI 用量上限已到达；可访问 https://chatgpt.com/codex/settings/usage "
      + "购买更多额度；可在 Aug 7th, 2026 11:37 PM 后重试。",
    );
    expect(formatOpenAiErrorMessage(
      "Your workspace is out of credits. Add credits to continue.",
    )).toBe("工作区额度已用完，请充值后继续。");
    expect(formatOpenAiErrorMessage("未知错误：foo")).toBe("未知错误：foo");
  });

  it("appends a CNY equivalent when USD costs are rendered with a rate", () => {
    expect(formatReferenceCostTotal({
      currency: "USD",
      totalCostNanos: 1_000_000_000,
      inputCostNanos: null,
      cachedInputCostNanos: null,
      outputCostNanos: null,
      pricedRequestCount: 1,
      requestCount: 1,
      uncachedInputPricePerMillionNanos: null,
      cachedInputPricePerMillionNanos: null,
      outputPricePerMillionNanos: null,
      hasMixedPrices: false,
    }, {
      usdToCny: 7.2,
      effectiveAtMs: 1_700_000_000_000,
      source: "ecb",
    })).toBe("$1.000000（≈ ¥7.200000）");
  });

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
          debugEnabled: true,
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
      "提供商：OpenAI 官方",
      "思考等级：medium",
      "Fast 模式：开启",
      "协作模式：Default",
      "",
      "账户状态：",
      "周限：剩余 63%",
    ].join("\n"));
  });

  it("renders a compact subagent completion card with metrics", () => {
    const presentation = createSubagentCompletedPresentation({
      type: "subagent.completed",
      target: {
        surface: "telegram" as const,
        accountId: "default",
        conversationId: "100",
      },
      parentThreadId: "thread-1",
      agentThreadId: "subagent-thread-1",
      agentPath: "/root/ds_annotate_probe",
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
      status: "completed",
      metricsStatus: "available",
      requestCount: 1,
      unsuccessfulRequestCount: 0,
      pricedRequestCount: 1,
      inputTokens: 20_000,
      pricedInputTokens: 20_000,
      cachedInputTokens: null,
      outputTokens: 3_000,
      pricedOutputTokens: 3_000,
      reasoningOutputTokens: 0,
      totalCostNanos: 237_000,
      inputCostNanos: null,
      cachedInputCostNanos: null,
      outputCostNanos: null,
      pricingCurrency: "USD",
      durationMs: 5_558,
    }, () => "usd", null);
    const rendered = renderPlainLifecyclePresentation(presentation);

    expect(rendered).toContain("子代理完成 · ds_annotate_probe");
    expect(rendered).toContain("deepseek-v4-flash");
    expect(rendered).toContain("模型请求：1 次");
    expect(rendered).toContain("$0.000237");
    expect(rendered).not.toContain("耗时：6秒");
  });

  it("converts the subagent completion cost to CNY when required", () => {
    const presentation = createSubagentCompletedPresentation({
      type: "subagent.completed",
      target: {
        surface: "weixin" as const,
        accountId: "default",
        conversationId: "100",
      },
      parentThreadId: "thread-1",
      agentThreadId: "subagent-thread-1",
      agentPath: "/root/ds_annotate_probe",
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
      status: "completed",
      metricsStatus: "available",
      requestCount: 1,
      unsuccessfulRequestCount: 0,
      pricedRequestCount: 1,
      inputTokens: 20_000,
      pricedInputTokens: 20_000,
      cachedInputTokens: 15_000,
      outputTokens: 3_000,
      pricedOutputTokens: 3_000,
      reasoningOutputTokens: 500,
      totalCostNanos: 1_000_000_000,
      inputCostNanos: 600_000_000,
      cachedInputCostNanos: 100_000_000,
      outputCostNanos: 300_000_000,
      pricingCurrency: "USD",
      durationMs: 0,
    }, () => "cny", { usdToCny: 7.2, effectiveAtMs: 1_700_000_000_000, source: "ecb" });
    const rendered = renderPlainLifecyclePresentation(presentation);

    expect(rendered).toContain("¥7.200000");
  });

  it("shows subagent Token details and currency equivalents only in debug", () => {
    const event = {
      type: "subagent.completed" as const,
      target: {
        surface: "telegram" as const,
        accountId: "default",
        conversationId: "100",
      },
      parentThreadId: "thread-1",
      agentThreadId: "subagent-thread-1",
      agentPath: "/root/review",
      model: "gpt-test",
      modelProvider: "openai",
      status: "completed" as const,
      metricsStatus: "available" as const,
      requestCount: 1,
      unsuccessfulRequestCount: 0,
      pricedRequestCount: 1,
      inputTokens: 20_000,
      pricedInputTokens: 20_000,
      cachedInputTokens: 15_000,
      outputTokens: 3_000,
      pricedOutputTokens: 3_000,
      reasoningOutputTokens: 500,
      totalCostNanos: 1_000_000_000,
      inputCostNanos: 600_000_000,
      cachedInputCostNanos: 100_000_000,
      outputCostNanos: 300_000_000,
      pricingCurrency: "USD",
      durationMs: 1_000,
    };
    const exchangeRate = {
      usdToCny: 7.2,
      effectiveAtMs: 1_700_000_000_000,
      source: "ecb",
    } as const;
    const normal = renderPlainLifecyclePresentation(
      createSubagentCompletedPresentation(event, () => "usd", exchangeRate),
    );
    const debug = renderPlainLifecyclePresentation(
      createSubagentCompletedPresentation(event, () => "usd", exchangeRate, true),
    );

    expect(normal).toContain("Token：23 K");
    expect(normal).toContain("均价：约 $4,347.83/100M");
    expect(normal).not.toContain("输入：20 K");
    expect(normal).not.toContain("输入命中缓存");
    expect(normal).not.toContain("输入价格");
    expect(normal).not.toContain("≈ ¥");
    expect(normal).not.toContain("模型请求聚合耗时");
    expect(normal).not.toContain("耗时：1秒");
    expect(debug).toContain("输入命中缓存：15 K");
    expect(debug).toContain("输入未命中缓存：5 K");
    expect(debug).toContain("输出：3 K");
    expect(debug).toContain("其中推理输出：500");
    expect(debug).toContain("缓存命中率：75.00%");
    expect(debug).toContain("模型请求聚合耗时：1秒");
    expect(debug).toContain("费用：$1.000000（≈ ¥7.200000）");
    expect(debug).toContain("输入价格：$0.600000（≈ ¥4.320000）");
    expect(debug).toContain("缓存价格：$0.100000（≈ ¥0.720000）");
    expect(debug).toContain("输出价格：$0.300000（≈ ¥2.160000）");
    expect(debug).toContain("均价：约 $4,347.83/100M（≈ ¥31,304.35/100M）");
  });

  it("uses successful priced requests and their tokens after a failed retry", () => {
    const rendered = renderPlainLifecyclePresentation(
      createSubagentCompletedPresentation({
        type: "subagent.completed",
        target: {
          surface: "feishu",
          accountId: "default",
          conversationId: "chat-1",
        },
        parentThreadId: "thread-1",
        agentThreadId: "subagent-thread-1",
        agentPath: "/root/review",
        model: "gpt-test",
        modelProvider: "openai",
        status: "completed",
        metricsStatus: "available",
        requestCount: 2,
        unsuccessfulRequestCount: 1,
        pricedRequestCount: 1,
        inputTokens: 20_000,
        pricedInputTokens: 10_000,
        cachedInputTokens: null,
        outputTokens: 3_000,
        pricedOutputTokens: 1_000,
        reasoningOutputTokens: 0,
        totalCostNanos: 1_000_000_000,
        inputCostNanos: null,
        cachedInputCostNanos: null,
        outputCostNanos: null,
        pricingCurrency: "USD",
        durationMs: 1_000,
      }, () => "usd", null),
    );

    expect(rendered).toContain("费用：$1.000000");
    expect(rendered).not.toContain("计价 1/2");
    expect(rendered).toContain("均价：约 $9,090.91/100M");
  });

  it("shows unavailable subagent metrics without presenting unknown values as zero", () => {
    const rendered = renderPlainLifecyclePresentation(
      createSubagentCompletedPresentation({
        type: "subagent.completed",
        target: {
          surface: "telegram",
          accountId: "default",
          conversationId: "100",
        },
        parentThreadId: "thread-1",
        agentThreadId: "subagent-thread-1",
        agentPath: "/root/review",
        status: "completed",
        metricsStatus: "unavailable",
        model: null,
        modelProvider: null,
        requestCount: 0,
        unsuccessfulRequestCount: 0,
        pricedRequestCount: 0,
        inputTokens: 0,
        pricedInputTokens: 0,
        cachedInputTokens: null,
        outputTokens: 0,
        pricedOutputTokens: 0,
        reasoningOutputTokens: 0,
        totalCostNanos: null,
        inputCostNanos: null,
        cachedInputCostNanos: null,
        outputCostNanos: null,
        pricingCurrency: null,
        durationMs: 0,
      }),
    );

    expect(rendered).toContain("统计：暂不可用");
    expect(rendered).not.toContain("模型请求：0 次");
    expect(rendered).not.toContain("Token：0");
  });

  it("uses one Turn start and completion field order", () => {
    expect(renderPlainLifecyclePresentation(
      createTurnStartedPresentation(),
    )).toBe("已开始处理。");
    expect(renderPlainLifecyclePresentation(
      createTurnStartedPresentation(undefined, {
        kind: "plugin",
        name: "GitHub",
      }),
    )).toBe("已使用 GitHub Plugin 开始处理。");

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
      "性能",
      "  总耗时：1分5秒",
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
          compact: {
            model: "gpt-5.6-sol",
            hasMixedModels: false,
            requestCount: 1,
            unsuccessfulRequestCount: 0,
            inputTokens: 10_000,
            cachedInputTokens: 9_000,
            outputTokens: 500,
            pricingCurrency: "USD",
            pricedRequestCount: 1,
            totalCostNanos: 142_102_000,
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
      }, undefined, undefined, true),
    );

    expect(rendered).toContain("模型请求：2 次");
    expect(rendered).toContain("思考次数：2 次");
    expect(rendered).toContain("模型请求聚合耗时：12秒");
    expect(rendered).toContain("Token：20.12 K");
    expect(rendered).toContain("费用：$0.000350");
    expect(rendered).toContain("上下文压缩：1 次 · gpt-5.6-sol · 10.5 K Token · $0.142102");
    expect(rendered).toContain("总价：$0.001250（计价 8/9）");
    expect(rendered).toContain("缓存命中率：75.00%");
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
    expect(rendered).toContain("费用：$0.000915");
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

    expect(rendered).toContain("费用：¥7.200000");
    expect(rendered).toContain("总价：¥14.400000");
    expect(rendered).not.toContain("折合人民币");
    expect(rendered).not.toContain("$");
  });

  it("shows the DeepSeek average price per 100M tokens on the completion card", () => {
    const rendered = renderPlainLifecyclePresentation(
      createTurnCompletedPresentation({
        type: "turn.completed",
        target: {
          surface: "feishu",
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
          requestInputTokens: 150,
          requestCachedInputTokens: 100,
          nonReasoningOutputTokens: 40,
          reasoningTokens: 10,
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
          inputTokens: 300,
          outputTokens: 100,
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

    expect(rendered.match(/均价：约 ¥3,600,000\.00\/100M/g)?.length).toBe(2);
  });

  it("shows the OpenAI average price on the completion card", () => {
    const rendered = renderPlainLifecyclePresentation(
      createTurnCompletedPresentation({
        type: "turn.completed",
        target: {
          surface: "feishu",
          accountId: "default",
          conversationId: "100",
        },
        threadId: "thread-openai",
        turnId: "turn-openai",
        status: "completed",
        modelProvider: "openai",
        timing: {
          modelRequestCount: 1,
          completedModelRequestCount: 1,
          requestInputTokens: 150,
          nonReasoningOutputTokens: 40,
          reasoningTokens: 10,
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
          inputTokens: 300,
          outputTokens: 100,
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
      }, () => "cny", {
        usdToCny: 7.2,
        effectiveAtMs: 1_700_000_000_000,
        source: "ecb",
      }),
    );

    expect(rendered.match(/均价：约 ¥3,600,000\.00\/100M/g)?.length).toBe(2);
  });

  it("shows currency equivalents only in debug completion cards", () => {
    const event = {
      type: "turn.completed" as const,
      target: {
        surface: "feishu" as const,
        accountId: "default",
        conversationId: "100",
      },
      threadId: "thread-openai",
      turnId: "turn-openai",
      status: "completed" as const,
      modelProvider: "openai",
      timing: {
        modelRequestCount: 1,
        completedModelRequestCount: 1,
        modelRequestDurationMs: 1_000,
        requestInputTokens: 150,
        requestCachedInputTokens: 100,
        nonReasoningOutputTokens: 50,
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
    };
    const exchangeRate = {
      usdToCny: 7.2,
      effectiveAtMs: 1_700_000_000_000,
      source: "ecb",
    } as const;
    const normal = renderPlainLifecyclePresentation(
      createTurnCompletedPresentation(event, () => "usd", exchangeRate),
    );
    const debug = renderPlainLifecyclePresentation(
      createTurnCompletedPresentation(event, () => "usd", exchangeRate, true),
    );

    expect(normal).toContain("费用：$1.000000");
    expect(normal).toContain("Token：200");
    expect(normal).toContain("均价：约 $500,000.00/100M");
    expect(normal).not.toContain("输入命中缓存");
    expect(normal).not.toContain("输入价格");
    expect(normal).not.toContain("模型请求聚合耗时");
    expect(normal).not.toContain("≈ ¥");
    expect(debug).toContain("费用：$1.000000（≈ ¥7.200000）");
    expect(debug).toContain("输入命中缓存：100");
    expect(debug).toContain("输入价格：$0.600000（≈ ¥4.320000）");
    expect(debug).toContain("模型请求聚合耗时：1秒");
    expect(debug).toContain("均价：约 $500,000.00/100M（≈ ¥3,600,000.00/100M）");
  });

  it("keeps the Turn Token total when cache metrics are incomplete", () => {
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
          requestInputTokens: 1_000,
          requestOutputTokens: 50,
          referenceCost: {
            currency: "USD",
            totalCostNanos: 1_000_000_000,
            inputCostNanos: 600_000_000,
            cachedInputCostNanos: 100_000_000,
            outputCostNanos: 300_000_000,
            pricedRequestCount: 1,
            requestCount: 1,
            uncachedInputPricePerMillionNanos: null,
            cachedInputPricePerMillionNanos: null,
            outputPricePerMillionNanos: null,
            hasMixedPrices: false,
          },
        },
      }),
    );

    expect(rendered).toContain("Token：1.05 K");
    expect(rendered).toContain("均价：约 $95,238.10/100M");
    expect(rendered).not.toContain("缓存命中率");
  });

  it("omits the DeepSeek average price when pricing samples are incomplete", () => {
    const rendered = renderPlainLifecyclePresentation(
      createTurnCompletedPresentation({
        type: "turn.completed",
        target: {
          surface: "feishu",
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
          requestInputTokens: 150,
          nonReasoningOutputTokens: 40,
          reasoningTokens: 10,
          referenceCost: {
            currency: "USD",
            totalCostNanos: null,
            inputCostNanos: null,
            cachedInputCostNanos: null,
            outputCostNanos: null,
            pricedRequestCount: 0,
            requestCount: 1,
            uncachedInputPricePerMillionNanos: null,
            cachedInputPricePerMillionNanos: null,
            outputPricePerMillionNanos: null,
            hasMixedPrices: false,
          },
        },
      }, (provider) => provider === "deepseek" ? "cny" : "usd", {
        usdToCny: 7.2,
        effectiveAtMs: 1_700_000_000_000,
        source: "ecb",
      }),
    );

    expect(rendered).not.toContain("均价");
  });

  it("renders run cost details as indented subfields", () => {
    const rendered = renderStructuredLifecyclePresentation(
      createTurnCompletedPresentation({
        type: "turn.completed",
        target: {
          surface: "feishu",
          accountId: "default",
          conversationId: "chat",
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
      }, (provider) => provider === "deepseek" ? "cny" : "usd", {
        usdToCny: 7.2,
        effectiveAtMs: 1_700_000_000_000,
        source: "ecb",
      }, true),
    );

    expect(rendered).toContain("- **费用**：¥7.200000");
    expect(rendered).toContain("  - 输入价格：¥4.320000");
    expect(rendered).toContain("  - 缓存价格：¥0.720000");
    expect(rendered).toContain("  - 输出价格：¥2.160000");
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

  it("shows the reasoning token count in debug but omits unavailable timing fields for OpenAI", () => {
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
          requestInputTokens: 1_000,
          requestCachedInputTokens: 800,
          reasoningTokens: 40,
          outputTokensPerSecond: 96,
        },
      }, undefined, undefined, true),
    );

    expect(rendered).toContain("其中推理输出：40");
    expect(rendered).toContain("输出速度：96 token/s（不含推理）");
    expect(rendered).not.toContain("首字延时");
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
