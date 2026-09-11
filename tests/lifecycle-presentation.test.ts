import { beforeEach, describe, expect, it } from "vitest";

import {
  createStartupPresentation,
  createSubagentContactedPresentation,
  createSubagentCompletedPresentation,
  createSubagentStartedPresentation,
  createTurnCompletedPresentation,
  createTurnReasoningPresentation,
  createTurnStartedPresentation,
  renderPlainLifecyclePresentation,
} from "../src/surfaces/lifecycle-presentation.js";
import { formatOpenAiErrorMessage } from "../src/surfaces/account-format.js";
import { setConfiguredCustomPrimaryProviderId } from "../src/surfaces/provider-format.js";
import gatewayMetadata from "../src/version.json" with { type: "json" };

describe("shared Surface lifecycle presentation", () => {
  beforeEach(() => {
    setConfiguredCustomPrimaryProviderId(undefined);
  });

  it("adds an actionable OpenAI network warning to the startup notice", () => {
    const presentation = createStartupPresentation(
      [{ id: "main", name: "Main", cwd: "/workspace/main" }],
      {
        workspaceId: "main",
        model: "gpt-test",
        modelProvider: "openai",
        effort: null,
        serviceTier: null,
        modelPending: false,
        effortPending: false,
        fastModePending: false,
        collaborationMode: "default",
        collaborationModePending: false,
      },
      {
        platform: "linux",
        architecture: "x64",
        gatewayVersion: "0.147.0",
        nodeVersion: "v24.0.0",
        transport: "Unix WebSocket",
        codexUpstreamUserAgent: null,
        openAiConnectivity: "unreachable",
      },
    );

    expect(presentation.fields).toEqual([
      { label: "App Server", value: "已连接" },
      { label: "系统", value: "Linux · x64" },
      {
        label: "版本",
        value: `Codex Connect ${gatewayMetadata.version} · Codex 0.147.0`,
      },
      { label: "OpenAI 网络", value: "连接失败；请检查代理设置" },
    ]);
  });

  it("formats the thinking status with elapsed time", () => {
    const rendered = renderPlainLifecyclePresentation(
      createTurnReasoningPresentation("thread-1234567890", 15_000),
    );
    expect(rendered).toContain("思考中…");
    expect(rendered).toContain("耗时：15秒");
    expect(renderPlainLifecyclePresentation(
      createTurnReasoningPresentation(undefined, 500),
    )).toBe("思考中…");
    expect(renderPlainLifecyclePresentation(
      createTurnReasoningPresentation(undefined, 500, true),
    )).toBe("思考完成\n\n耗时：500毫秒");
  });

  it("includes metrics center quota details in the startup card", () => {
    const presentation = createStartupPresentation(
      [{ id: "main", name: "Main", cwd: "/workspace/main" }],
      {
        workspaceId: "main", model: "gpt-test", modelProvider: "openai", effort: null,
        serviceTier: null, modelPending: false, effortPending: false, fastModePending: false,
        collaborationMode: "default", collaborationModePending: false,
      },
      {
        platform: "linux", architecture: "x64", gatewayVersion: "0.150.1", nodeVersion: "v24.0.0",
        transport: "Unix WebSocket", codexUpstreamUserAgent: null,
      },
      {
        provider: "openai", windowId: "codex", deviceCount: 3, requestCount: 12,
        totalTokens: 123_000_000, latestUsedPercentMillionths: 35_000_000,
        estimatedTotalTokens: 351_000_000, resetsAt: 1_756_650_000_000,
        observedAtMs: 1_756_000_000_000,
      },
    );
    const rendered = renderPlainLifecyclePresentation(presentation);
    expect(rendered).toContain("账户状态（额度中心）");
    expect(rendered).toContain("设备数：3 台");
    expect(rendered).toContain("请求数：12 次");
    expect(rendered).toContain("总 Token：123 M");
    expect(rendered).toContain("周限：剩余 65%");
  });

  it("shows all OpenCode Go quota windows in the startup card", () => {
    const monthlyWindow = {
      provider: "ocg-lunare",
      windowId: "monthly",
      deviceCount: 1,
      requestCount: 456,
      totalTokens: 109_733_718,
      latestUsedPercentMillionths: null,
      estimatedTotalTokens: null,
      resetsAt: 1_789_482_127,
      observedAtMs: 1_788_683_501_836,
    };
    const presentation = createStartupPresentation(
      [{ id: "main", name: "Main", cwd: "/workspace/main" }],
      {
        workspaceId: "main",
        model: "deepseek-v4-flash",
        modelProvider: "ocg-lunare",
        effort: null,
        serviceTier: null,
        modelPending: false,
        effortPending: false,
        fastModePending: false,
        collaborationMode: "default",
        collaborationModePending: false,
      },
      {
        platform: "linux",
        architecture: "x64",
        gatewayVersion: "0.150.1",
        nodeVersion: "v24.0.0",
        transport: "Unix WebSocket",
        codexUpstreamUserAgent: null,
      },
      {
        ...monthlyWindow,
        windows: [
          monthlyWindow,
          { ...monthlyWindow, windowId: "weekly", resetsAt: 1_788_739_200 },
          { ...monthlyWindow, windowId: "rolling", resetsAt: 1_788_683_809 },
        ],
      },
    );
    const rendered = renderPlainLifecyclePresentation(presentation);
    expect(rendered).toContain("5小时");
    expect(rendered).toContain("周限");
    expect(rendered).toContain("月限");
    expect(rendered.indexOf("5小时")).toBeLessThan(rendered.indexOf("周限"));
    expect(rendered.indexOf("周限")).toBeLessThan(rendered.indexOf("月限"));
  });

  it("does not warn when at least one official OpenAI route is reachable", () => {
    const presentation = createStartupPresentation(
      [{ id: "main", name: "Main", cwd: "/workspace/main" }],
      {
        workspaceId: "main",
        model: "gpt-test",
        modelProvider: "openai",
        effort: null,
        serviceTier: null,
        modelPending: false,
        effortPending: false,
        fastModePending: false,
        collaborationMode: "default",
        collaborationModePending: false,
      },
      {
        platform: "linux",
        architecture: "x64",
        gatewayVersion: "0.147.0",
        nodeVersion: "v24.0.0",
        transport: "Unix WebSocket",
        codexUpstreamUserAgent: null,
        openAiConnectivity: "partial",
      },
    );

    expect(presentation.fields).toEqual([
      { label: "App Server", value: "已连接" },
      { label: "系统", value: "Linux · x64" },
      {
        label: "版本",
        value: `Codex Connect ${gatewayMetadata.version} · Codex 0.147.0`,
      },
    ]);
  });

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

  it("renders a compact subagent follow-up notice without internal IDs", () => {
    const rendered = renderPlainLifecyclePresentation(
      createSubagentContactedPresentation({
        type: "subagent.contacted",
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

    expect(rendered).toBe("子代理继续 · review_task");
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
    expect(formatOpenAiErrorMessage(
      "Selected model is at capacity. Please try a different model.",
    )).toBe("所选模型当前容量已满，请稍后重试或改用其他模型。");
    expect(formatOpenAiErrorMessage("未知错误：foo")).toBe("未知错误：foo");
  });

  it("uses a fixed actionable message for structured policy violations", () => {
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
        error: "untrusted upstream policy text",
        errorCode: "misalignmentPolicyViolation",
      }),
    );

    expect(rendered).toContain("错误：请求因安全策略不一致而终止，请调整请求内容或目标后重试。");
    expect(rendered).not.toContain("untrusted upstream policy text");
  });

    it("uses one startup field order for every Surface renderer", () => {
    const rendered = renderPlainLifecyclePresentation(
      createStartupPresentation(
        [{ id: "main", name: "Main", cwd: "/workspace/main" }],
        {
          threadId: "thread-1",
          threadName: "发布检查",
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
      "系统：Linux · x64",
      `版本：Codex Connect ${gatewayMetadata.version} · Codex 0.146.0`,
      "",
      "运行环境：",
      "Node.js：v22.23.1",
      "连接：Unix WebSocket",
      "App Server UA：codex/0.146.0 (Linux; x64) (gateway; 0.146.0)",
      "",
      "当前会话：",
      "Workspace：Main (main)",
      "工作目录：/workspace/main",
      "Session：发布检查",
      "Session ID：thread-1",
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
      reasoningEffort: "medium",
      status: "completed",
      metricsStatus: "available",
      requestCount: 1,
      unsuccessfulRequestCount: 0,
      inputTokens: 20_000,
      cachedInputTokens: null,
      outputTokens: 3_000,
      reasoningOutputTokens: 0,
      outputTokensPerSecond: 10,
      outputSpeedSampleCount: 1,
      outputSpeedTimedCount: 1,
      elapsedMs: 12_345,
      durationMs: 5_558,
    });
    const rendered = renderPlainLifecyclePresentation(presentation);

    expect(rendered).toContain("子代理完成 · ds_annotate_probe");
    expect(rendered).toContain("deepseek-v4-flash");
    expect(rendered).toContain("思考等级：medium");
    expect(rendered).toContain("模型请求：1 次");
    expect(rendered).not.toContain("耗时");
    expect(rendered).not.toContain("速度");
  });

  it("hides unreliable output speed and unknown reasoning effort", () => {
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
        model: "gpt-test",
        modelProvider: "openai",
        reasoningEffort: null,
        status: "completed",
        metricsStatus: "available",
        requestCount: 1,
        unsuccessfulRequestCount: 0,
        inputTokens: 20_000,
        cachedInputTokens: null,
        outputTokens: 3_000,
        reasoningOutputTokens: 0,
        outputTokensPerSecond: 10,
        outputSpeedSampleCount: 1,
        outputSpeedTimedCount: 0,
        elapsedMs: 500,
        durationMs: 0,
      }),
    );

    expect(rendered).not.toContain("思考等级");
    expect(rendered).not.toContain("综合输出速度");
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
        reasoningEffort: null,
        requestCount: 0,
        unsuccessfulRequestCount: 0,
        inputTokens: 0,
        cachedInputTokens: null,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        outputTokensPerSecond: null,
        outputSpeedSampleCount: 0,
        outputSpeedTimedCount: 0,
        elapsedMs: 4_000,
        durationMs: 0,
      }),
    );

    expect(rendered).toContain("统计：暂不可用");
    expect(rendered).not.toContain("耗时");
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
        sessionName: "统一生命周期",
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
        workspaceId: "main",
        workspaceName: "Main",
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
      "",
      "当前 Session 累计：",
      "当前工作区：Main (main)",
      "Session：统一生命周期",
      "Session ID：thread-1",
      "上下文：10 K / 100 K（10%）",
      "上下文压缩：2 次",
      "Goal：进行中 · 12.5 K / 100 K",
      "Git 分支：feature/lifecycle",
      "",
      "账户状态：",
      "周限：剩余 63%",
    ].join("\n"));
  });

  it("uses the remote quota section instead of the local OpenAI weekly line", () => {
    const rendered = renderPlainLifecyclePresentation(
      createTurnCompletedPresentation({
        type: "turn.completed",
        target: { surface: "telegram", accountId: "default", conversationId: "100" },
        threadId: "thread-remote",
        turnId: "turn-remote",
        status: "completed",
        model: "gpt-test",
        modelProvider: "openai",
        weeklyLimit: { usedPercent: 37, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
        remoteQuota: {
          provider: "openai",
          windowId: "codex",
          deviceCount: 3,
          requestCount: 12,
          totalTokens: 1_200_000,
          latestUsedPercentMillionths: 37_000_000,
          estimatedTotalTokens: 3_200_000,
          resetsAt: 1_800_000_000,
          observedAtMs: 1_800_000_000_000,
        },
      }, true),
    );
    expect(rendered).toContain("设备数：3 台");
    expect(rendered).toContain("请求数：12 次");
    expect(rendered).toContain("总 Token：1.2 M");
    expect(rendered).toContain("账户状态（额度中心）：");
    expect(rendered).toContain("周限：剩余 63% · 重置");
  });

  it("keeps only the remote remaining quota summary in formal mode", () => {
    const rendered = renderPlainLifecyclePresentation(
      createTurnCompletedPresentation({
        type: "turn.completed",
        target: { surface: "telegram", accountId: "default", conversationId: "100" },
        threadId: "thread-remote",
        turnId: "turn-remote",
        status: "completed",
        modelProvider: "openai",
        remoteQuota: {
          provider: "openai",
          windowId: "codex",
          deviceCount: 3,
          requestCount: 12,
          totalTokens: 1_200_000,
          latestUsedPercentMillionths: 37_000_000,
          estimatedTotalTokens: 3_200_000,
          resetsAt: 1_800_000_000,
          observedAtMs: 1_800_000_000_000,
        },
      }),
    );
    expect(rendered).toContain("账户状态（额度中心）：");
    expect(rendered).toContain("周限：剩余 63% · 重置 ");
    expect(rendered.match(/周限：/gu)).toHaveLength(1);
    expect(rendered).not.toContain("额度中心：3 台设备");
    expect(rendered).not.toContain("本周期 Token");
  });

  it("uses the metrics center summary instead of local OpenCode Go usage", () => {
    const monthlyWindow = {
      provider: "ocg-lunare",
      windowId: "monthly",
      deviceCount: 3,
      requestCount: 12,
      totalTokens: 1_200_000,
      latestUsedPercentMillionths: null,
      estimatedTotalTokens: null,
      resetsAt: 1_800_000_000,
      observedAtMs: 1_800_000_000_000,
    };
    const weeklyWindow = {
      ...monthlyWindow,
      windowId: "weekly",
      deviceCount: 2,
      requestCount: 7,
      totalTokens: 700_000,
      resetsAt: 1_790_000_000,
    };
    const rollingWindow = {
      ...monthlyWindow,
      windowId: "rolling",
      deviceCount: 1,
      requestCount: 1,
      totalTokens: 11_000,
      resetsAt: 1_780_000_000,
    };
    const rendered = renderPlainLifecyclePresentation(
      createTurnCompletedPresentation(
        {
          type: "turn.completed",
          target: { surface: "telegram", accountId: "default", conversationId: "100" },
          threadId: "thread-ocg-center",
          turnId: "turn-ocg-center",
          status: "completed",
          model: "deepseek-v4-flash",
          modelProvider: "ocg-lunare",
          remoteQuota: {
            ...monthlyWindow,
            windows: [monthlyWindow, weeklyWindow, rollingWindow],
          },
        },
      ),
    );
    expect(rendered).toContain("账户状态（额度中心）：");
    expect(rendered).toContain("设备数：3 台");
    expect(rendered).toContain("请求数：12 次");
    expect(rendered).toContain("总 Token：1.2 M");
    expect(rendered).toContain("月限：未知");
    expect(rendered).not.toContain("剩余用量");
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

  it("labels a custom primary Provider separately from the official OpenAI account", () => {
    setConfiguredCustomPrimaryProviderId("OpenAI");
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
        model: "gpt-test",
        modelProvider: "OpenAI",
        effort: "medium",
        serviceTier: "priority",
      }),
    );

    expect(rendered).toContain("提供商：OpenAI · 自定义");
    expect(rendered).not.toContain("提供商：OpenAI 官方");
    expect(rendered).toContain("模型：gpt-test · medium · Fast 开启");
  });

          it("keeps request and Token facts while omitting performance metrics", () => {
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
          compact: {
            model: "gpt-5.6-sol",
            hasMixedModels: false,
            requestCount: 1,
            unsuccessfulRequestCount: 0,
            inputTokens: 10_000,
            cachedInputTokens: 9_000,
            outputTokens: 500,
          },
        },
      }, true),
    );

    expect(rendered).toContain("模型请求：2 次");
    expect(rendered).toContain("思考次数：2 次");
    expect(rendered).toContain("Token：20.12 K");
    expect(rendered).toContain("缓存命中率：75.00%");
    expect(rendered).not.toContain("耗时");
    expect(rendered).not.toContain("延迟");
    expect(rendered).not.toContain("速度");
  });

  it("shows parent Turn task totals separately from the parent run", () => {
    const rendered = renderPlainLifecyclePresentation(
      createTurnCompletedPresentation({
        type: "turn.completed",
        target: {
          surface: "telegram",
          accountId: "default",
          conversationId: "100",
        },
        threadId: "thread-parent",
        turnId: "turn-parent",
        status: "completed",
        modelProvider: "openai",
        timing: {
          modelRequestCount: 1,
          completedModelRequestCount: 1,
          requestInputTokens: 100,
          requestOutputTokens: 20,
          outputTokensPerSecond: 42,
          outputSpeedSampleCount: 1,
          outputSpeedTimedCount: 1,
        },
        taskAggregate: {
          requestCount: 3,
          unsuccessfulRequestCount: 0,
          inputTokens: 3_000,
          cachedInputTokens: 2_500,
          outputTokens: 300,
          reasoningOutputTokens: 100,
        },
      }),
    );

    expect(rendered).toContain("模型请求：1 次");
    expect(rendered).toContain("任务合计（含子代理）");
    expect(rendered).toContain("模型请求：3 次");
    expect(rendered).toContain("Token：3.3 K");
    expect(rendered).not.toContain("速度");
  });

  it("shows the recursive session token total in formal mode", () => {
    const rendered = renderPlainLifecyclePresentation(
      createTurnCompletedPresentation({
        type: "turn.completed",
        target: {
          surface: "telegram",
          accountId: "default",
          conversationId: "100",
        },
        threadId: "thread-session",
        turnId: "turn-session",
        status: "completed",
        modelProvider: "openai",
        timing: {
          modelRequestCount: 1,
          completedModelRequestCount: 1,
          requestInputTokens: 1_000,
          requestOutputTokens: 100,
        },
        sessionAggregate: {
          requestCount: 9,
          unsuccessfulRequestCount: 1,
          inputTokens: 90_000,
          cachedInputTokens: 60_000,
          outputTokens: 2_000,
          reasoningOutputTokens: 500,
        },
      }),
    );

    expect(rendered).toContain("当前 Session 累计：");
    expect(rendered).toContain("模型请求：9 次");
    expect(rendered).toContain("Token：92 K");
    expect(rendered).toContain("缓存命中率：66.67%");
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
          requestInputTokens: 1_100,
          requestOutputTokens: 100,
        },
      }),
    );

    expect(rendered).toContain(
      "模型请求：2 次（完成 1 · 自动重试 1，最终成功）",
    );
    expect(rendered).not.toContain("均价：");
    expect(rendered).not.toContain("折合人民币");
  });

          it("renders a completed Turn without a final response as an actionable anomaly", () => {
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
        missingFinalResponse: true,
      }),
    );

    expect(rendered).toContain("本次运行 · 无最终回复");
    expect(rendered).toContain(
      "结果：Codex 已结束本轮，但未返回最终消息。请重试；若当前上下文较高，可先使用 /compact。",
    );
    expect(rendered).not.toContain("本次运行 · 已完成");
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
        },
      }),
    );

    expect(rendered).toContain("Token：1.05 K");
    expect(rendered).not.toContain("缓存命中率");
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

  it("shows the reasoning token count in debug but omits performance fields", () => {
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
      }, true),
    );

    expect(rendered).toContain("其中推理输出：40");
    expect(rendered).not.toContain("延时");
    expect(rendered).not.toContain("延迟");
    expect(rendered).not.toContain("速度");
  });
});

 it("shows the resolved auto compact percentage on the completion card", () => {
  const rendered = renderPlainLifecyclePresentation(
    createTurnCompletedPresentation({
      type: "turn.completed",
      target: { surface: "telegram", accountId: "default", conversationId: "100" },
      threadId: "thread-a",
      turnId: "turn-a",
      status: "completed",
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
      tokenUsage: {
        total: tokenBreakdown(0, 0, 0),
        last: tokenBreakdown(0, 0, 0),
        modelContextWindow: 1_048_576,
      },
    }, false, () => 40),
  );

  expect(rendered).toContain("自动压缩：40%");
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
