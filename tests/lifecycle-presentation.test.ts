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
  it.each(["feishu", "telegram", "weixin"] as const)("shows %s session performance and concise compaction separately from the current turn", surface => {
    const rendered = renderPlainLifecyclePresentation(createTurnCompletedPresentation({
      type: "turn.completed", target: { surface, accountId: "a", conversationId: "c" },
      threadId: "t", turnId: "turn", status: "completed", model: "test-model", contextCompactionCount: 14,
      timing: { performance: { requestCount: 1, responseSampleCount: 1, averageResponseTimeMs: 100, generationTokensPerSecond: 50 } },
      sessionAggregate: {
        requestOutcomes: { completed: 3, interrupted: 0, failed: 0, incomplete: 0 },
        interruptionSummary: { followedByCompletion: 0, noObservedCompletion: 0, usageUnobserved: 0 },
        requestCount: 3, unsuccessfulRequestCount: 0, inputTokens: 1000, cachedInputTokens: 900, outputTokens: 100, reasoningOutputTokens: 0,
        performance: { requestCount: 3, responseSampleCount: 2, averageResponseTimeMs: 200.4, generationTokensPerSecond: null },
        compact: { model: "test-model", hasMixedModels: false, requestCount: 2, unsuccessfulRequestCount: 0,
          inputTokens: 2000, cachedInputTokens: 0, outputTokens: 100,
          requestOutcomes: { completed: 2, interrupted: 0, failed: 0, incomplete: 0 } },
      },
    }));
    const [run, session] = rendered.split("当前会话：");
    expect(run).toContain("响应：100 ms\n");
    expect(run).toContain("速度：50.0 /s");
    expect(session).toContain("响应：200 ms\n");
    expect(session).toContain("速度：—");
    expect(session).toContain("上下文压缩：14 次");
    expect(session).toContain("压缩请求：2 次 · 2.1 K Token");
    expect(session).not.toContain("客户端中断：0");
  });
  it.each(["feishu", "telegram", "weixin"] as const)("keeps %s compaction concise with exceptions and debug details", (surface) => {
    const compact = {
      model: "test-model", hasMixedModels: false, requestCount: 1,
      unsuccessfulRequestCount: 0, inputTokens: 225_000, cachedInputTokens: 0, outputTokens: 130,
      requestOutcomes: { completed: 1, interrupted: 0, failed: 0, incomplete: 0 },
    };
    const event = {
      type: "turn.completed" as const,
      target: { surface, accountId: "default", conversationId: "100" },
      threadId: "thread", turnId: "turn", status: "completed" as const,
      model: "test-model", timing: { compact },
    };
    const line = (value: typeof compact, debug = false) => renderPlainLifecyclePresentation(
      createTurnCompletedPresentation({ ...event, timing: { compact: value } }, debug),
    ).split("\n").find((text) => text.includes("上下文压缩："));
    expect(line(compact)).toBe("上下文压缩：1 次 · 225.13 K Token");
    expect(line({ ...compact, model: "other-model" })).toContain("1 次 · other-model · 225.13 K Token");
    expect(line({ ...compact, hasMixedModels: true })).toContain("混合模型");
    expect(line({ ...compact, requestCount: 4, unsuccessfulRequestCount: 3,
      requestOutcomes: { completed: 1, interrupted: 1, failed: 1, incomplete: 1 } })).toBe(
      "上下文压缩：4 次 · 225.13 K Token · 客户端中断 1 · 其他失败 1 · 未完整观测 1",
    );
    expect(line(compact, true)).toContain("test-model · 225.13 K Token · 完成：1 · 客户端中断：0 · 其他失败：0 · 未完整观测：0");
  });
  it.each(["feishu", "telegram", "weixin"])("shows weighted turn performance in %s completion", surface => {
    const event = { type: "turn.completed" as const, target: { surface, accountId: "a", conversationId: "c" },
      threadId: "t", turnId: "turn", status: "completed" as const,
      timing: { performance: { requestCount: 3, responseSampleCount: 2, averageResponseTimeMs: 952.07, generationTokensPerSecond: null } } };
    const incomplete = renderPlainLifecyclePresentation(createTurnCompletedPresentation(event));
    expect(incomplete).toContain("响应：952 ms\n");
    expect(incomplete).toContain("速度：—");
    const complete = renderPlainLifecyclePresentation(createTurnCompletedPresentation({ ...event,
      timing: { performance: { requestCount: 2, responseSampleCount: 2, averageResponseTimeMs: 0, generationTokensPerSecond: 250 } } }));
    expect(complete).toContain("响应：0 ms\n");
    expect(complete).toContain("速度：250.0 /s");
  });
  it.each([
    [{ knownDurationMs: 71_000, missingTurnCount: 1, historyComplete: true }, "已知累计 1 min 11 s（1 轮耗时缺失）"],
    [{ knownDurationMs: 0, missingTurnCount: 1, historyComplete: false }, "已知累计 0 ms（1 轮耗时缺失；历史未补齐）"],
    [{ knownDurationMs: null, missingTurnCount: 2, historyComplete: true }, "未提供（2 轮耗时缺失）"],
    [{ knownDurationMs: 71_000, missingTurnCount: 0, historyComplete: false }, "已知累计 1 min 11 s（历史未补齐）"],
    [{ knownDurationMs: 71_000, missingTurnCount: 0, historyComplete: true }, "1 min 11 s"],
  ] as const)("shows timing completeness without hiding known durations: %j", (sessionTiming, expected) => {
    const rendered = renderPlainLifecyclePresentation(createTurnCompletedPresentation({
      type: "turn.completed", target: { surface: "feishu", accountId: "a", conversationId: "c" },
      threadId: "thread", turnId: "turn", status: "interrupted", sessionTiming,
    }));
    expect(rendered).toContain("本轮耗时：未提供");
    expect(rendered).toContain(`总耗时：${expected}`);
  });
  it("keeps whole-turn duration and unknown request performance separate from upstream TTFT", () => {
    const rendered = renderPlainLifecyclePresentation(createTurnCompletedPresentation({
      type: "turn.completed", target: { surface: "telegram", accountId: "default", conversationId: "100" },
      threadId: "thread-1", turnId: "turn-1", status: "completed", durationMs: 999_000,
      sessionDurationMs: 1_071_000,
      timing: { modelRequestCount: 2 },
      sessionAggregate: { requestCount: 3, unsuccessfulRequestCount: 0, inputTokens: 100, cachedInputTokens: null,
        requestOutcomes: { completed: 3, interrupted: 0, failed: 0, incomplete: 0 },
        interruptionSummary: { followedByCompletion: 0, noObservedCompletion: 0, usageUnobserved: 0 },
        outputTokens: 1_000, reasoningOutputTokens: 0 },
    }));
    expect(rendered).not.toContain("Token/s");
    expect(rendered).toContain("响应：—");
    expect(rendered).toContain("速度：—");
    expect(rendered).toContain("总耗时：17 min 51 s");
    expect(rendered).not.toContain("本次运行：");
    expect(rendered).toContain("当前会话：\nSession：未命名\nSession ID：thread-1\n模型请求：3 次\n请求结果：完成 3 · 中断 0 · 失败 0 · 不完整 0\nToken：1.1 K");
    expect(rendered).not.toContain("会话统计（含子代理）");
    expect(rendered).not.toContain("上游轮次首 Token");
  });
  it.each([0, 569, 720.25])("omits OpenAI TTFT %s from completion cards", (ttftMs) => {
    const event = {
      type: "turn.completed", target: { surface: "telegram", accountId: "default", conversationId: "100" },
      threadId: "thread-1", turnId: "turn-1", status: "completed", modelProvider: "openai",
      timing: { upstreamTtftMs: ttftMs },
    } as const;
    const rendered = renderPlainLifecyclePresentation(createTurnCompletedPresentation(event));
    expect(rendered).not.toContain("上游轮次首 Token");
    expect(rendered).not.toContain("性能");
    const withDuration = renderPlainLifecyclePresentation(createTurnCompletedPresentation({
      ...event, durationMs: 3156,
    }));
    expect(withDuration).toContain("本轮耗时：3.16 s");
    expect(withDuration).not.toContain("上游轮次首 Token");
    expect(rendered).toContain("本轮耗时：未提供");
    expect(renderPlainLifecyclePresentation(createTurnCompletedPresentation({ ...event,
      modelProvider: "deepseek" }))).not.toContain("上游轮次首 Token");
    expect(renderPlainLifecyclePresentation(createTurnCompletedPresentation({ ...event,
      timing: {} }))).not.toContain("上游轮次首 Token");
  });
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
        appServerTimezone: "Asia/Shanghai",
      },
    );

    expect(presentation.fields).toEqual([
      { label: "App Server", value: "已连接" },
      { label: "系统", value: "Linux · x64" },
      { label: "App Server 时区", value: "Asia/Shanghai（配置）" },
      { label: "网关时区", value: Intl.DateTimeFormat().resolvedOptions().timeZone },
      {
        label: "版本",
        value: `Codex Connect ${gatewayMetadata.version} · Codex 0.147.0`,
      },
      { label: "OpenAI 网络", value: "暂不可达；请检查网络或代理状态" },
    ]);
  });

  it("warns in the startup notice when the official OpenAI login is absent", () => {
    const status = {
      workspaceId: "main",
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
      effort: null,
      serviceTier: null,
      modelPending: false,
      effortPending: false,
      fastModePending: false,
      collaborationMode: "default" as const,
      collaborationModePending: false,
    };
    const runtime = {
      platform: "linux" as const,
      architecture: "x64",
      gatewayVersion: "0.147.0",
      nodeVersion: "v24.0.0",
      transport: "Unix WebSocket",
      codexUpstreamUserAgent: null,
    };

    const presentation = createStartupPresentation(
      [{ id: "main", name: "Main", cwd: "/workspace/main" }],
      status,
      { ...runtime, officialOpenAiAuthenticated: false },
    );
    expect(presentation.fields).toContainEqual({
      label: "OpenAI 官方",
      value: "未登录；请运行 codex login，或发送 /model 选择第三方提供商",
    });

    const authenticated = createStartupPresentation(
      [{ id: "main", name: "Main", cwd: "/workspace/main" }],
      { ...status, model: "gpt-test", modelProvider: "openai" },
      { ...runtime, officialOpenAiAuthenticated: true },
    );
    expect(authenticated.fields).not.toContainEqual(
      expect.objectContaining({ label: "OpenAI 官方" }),
    );
  });

  it("formats the thinking status with elapsed time", () => {
    const rendered = renderPlainLifecyclePresentation(
      createTurnReasoningPresentation("thread-1234567890", 15_000),
    );
    expect(rendered).toContain("思考中…");
    expect(rendered).toContain("耗时：15 s");
    expect(renderPlainLifecyclePresentation(
      createTurnReasoningPresentation(undefined, 500),
    )).toBe("思考中…");
    expect(renderPlainLifecyclePresentation(
      createTurnReasoningPresentation(undefined, 500, true),
    )).toBe("思考完成\n\n耗时：500 ms");
  });

  it("shows an actionable warning when the active OpenAI route responds abnormally", () => {
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
        openAiConnectivity: "route-warning",
      },
    );

    expect(presentation.fields).toEqual([
      { label: "App Server", value: "已连接" },
      { label: "系统", value: "Linux · x64" },
      { label: "App Server 时区", value: "跟随系统（未配置）" },
      { label: "网关时区", value: Intl.DateTimeFormat().resolvedOptions().timeZone },
      {
        label: "版本",
        value: `Codex Connect ${gatewayMetadata.version} · Codex 0.147.0`,
      },
      { label: "OpenAI 网络", value: "线路响应异常；请检查 Gateway 日志与 OpenAI Base URL" },
    ]);
  });

  it.each([
    ["recovering", "暂不可达；正在后台复检"],
    ["invalid-base-url", "Base URL 路径无效；请检查配置"],
    ["indeterminate", "检测失败；请检查 App Server 连接与 Gateway 日志"],
  ] as const)("renders the %s startup connectivity result", (openAiConnectivity, value) => {
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
        openAiConnectivity,
      },
    );

    expect(presentation.fields).toContainEqual({ label: "OpenAI 网络", value });
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

    expect(rendered).toBe("子代理开始 · review_task\n\n提供商：未提供\n模型设置：未提供\n思考强度：未提供");
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

    expect(rendered).toBe("子代理继续 · review_task\n\n提供商：未提供\n模型设置：未提供\n思考强度：未提供");
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

  it("uses a fixed actionable message for expired provider authentication", () => {
    const openai = renderPlainLifecyclePresentation(
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
        error: "untrusted auth text",
        errorCode: "unauthorized",
        modelProvider: "openai",
      }),
    );

    expect(openai).toContain(
      "错误：OpenAI 官方登录已失效，请运行 codex login；或发送 /model 选择第三方提供商后重试。",
    );
    expect(openai).not.toContain("untrusted auth text");

    const thirdParty = renderPlainLifecyclePresentation(
      createTurnCompletedPresentation({
        type: "turn.completed",
        target: {
          surface: "feishu",
          accountId: "app-1",
          conversationId: "chat-1",
        },
        threadId: "thread-2",
        turnId: "turn-2",
        status: "failed",
        error: "untrusted key text",
        errorCode: "unauthorized",
        modelProvider: "deepseek",
      }),
    );

    expect(thirdParty).toContain("当前提供商凭据已失效");
    expect(thirdParty).not.toContain("untrusted key text");
  });

  it("uses a fixed message for the Luna Reserve usage-limit trigger", () => {
    const rendered = renderPlainLifecyclePresentation(
      createTurnCompletedPresentation({
        type: "turn.completed",
        target: {
          surface: "feishu",
          accountId: "app-1",
          conversationId: "chat-1",
        },
        threadId: "thread-1",
        turnId: "turn-1",
        status: "failed",
        error: "untrusted upstream usage text",
        errorCode: "usageLimitExceeded",
      }),
    );

    expect(rendered).toContain("错误：OpenAI 普通用量已用尽。");
    expect(rendered).not.toContain("untrusted upstream usage text");

    const reserve = renderPlainLifecyclePresentation(
      createTurnCompletedPresentation({
        type: "turn.completed",
        target: {
          surface: "feishu",
          accountId: "app-1",
          conversationId: "chat-1",
        },
        threadId: "thread-reserve",
        turnId: "turn-reserve",
        status: "failed",
        error: "untrusted reserve usage text",
        errorCode: "usageLimitExceeded",
        model: "gpt-reserve",
        modelProvider: "openai",
      }),
    );
    expect(reserve).toContain("错误：Luna Reserve 用量已用尽。");
    expect(reserve).not.toContain("OpenAI 普通用量已用尽");
    expect(reserve).not.toContain("untrusted reserve usage text");

    const thirdParty = renderPlainLifecyclePresentation(
      createTurnCompletedPresentation({
        type: "turn.completed",
        target: {
          surface: "feishu",
          accountId: "app-1",
          conversationId: "chat-1",
        },
        threadId: "thread-2",
        turnId: "turn-2",
        status: "failed",
        error: "DeepSeek usage limit reached",
        errorCode: "usageLimitExceeded",
        modelProvider: "deepseek",
      }),
    );
    expect(thirdParty).toContain("错误：DeepSeek usage limit reached");
    expect(thirdParty).not.toContain("OpenAI 普通用量已用尽");
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
      "App Server 时区：跟随系统（未配置）",
      `网关时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
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
    });
    const rendered = renderPlainLifecyclePresentation(presentation);

    expect(rendered).toContain("子代理完成 · ds_annotate_probe");
    expect(rendered).toContain("deepseek-v4-flash");
    expect(rendered).toContain("思考等级：medium");
    expect(rendered).toContain("模型请求：1 次");
    expect(rendered).not.toContain("耗时");
    expect(rendered).not.toContain("速度");
  });

  it("hides unknown reasoning effort", () => {
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
        upstreamTtftMs: 3156,
        status: "completed",
        metricsStatus: "available",
        requestCount: 1,
        unsuccessfulRequestCount: 0,
        inputTokens: 20_000,
        cachedInputTokens: null,
        outputTokens: 3_000,
        reasoningOutputTokens: 0,
      }),
    );

    expect(rendered).not.toContain("思考等级");
    expect(rendered).not.toContain("上游轮次首 Token");
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
      "错误：失败：[已隐藏]",
      "模型：gpt-test · medium · Fast 开启",
      "提供商：OpenAI 官方",
      "最近请求缓存命中率：75.00%",
      "本轮耗时：1 min 5 s",
      "响应：—",
      "速度：—",
      "",
      "当前会话：",
      "当前工作区：Main (main)",
      "Session：统一生命周期",
      "Session ID：thread-1",
      "上下文：10 K / 100 K（10%）",
      "上下文压缩：2 次",
      "Goal：进行中 · 12.5 K / 100 K",
      "Git 分支：feature/lifecycle",
      "总耗时：未提供",
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

          it("keeps request and Token facts with unavailable performance placeholders", () => {
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
          requestInputTokens: 20_000,
          requestCachedInputTokens: 15_000,
          nonReasoningOutputTokens: 42,
          reasoningTokens: 80,
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
    expect(rendered).toContain("本轮耗时：未提供");
    expect(rendered).toContain("总耗时：未提供");
    expect(rendered).not.toContain("延迟");
    expect(rendered).toContain("速度：—");
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
        },
        taskAggregate: {
          requestOutcomes: { completed: 3, interrupted: 0, failed: 0, incomplete: 0 },
          interruptionSummary: { followedByCompletion: 0, noObservedCompletion: 0, usageUnobserved: 0 },
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
    expect(rendered).toContain("速度：—");
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
          requestOutcomes: { completed: 8, interrupted: 1, failed: 0, incomplete: 0 },
          interruptionSummary: { followedByCompletion: 1, noObservedCompletion: 0, usageUnobserved: 1 },
          requestCount: 9,
          unsuccessfulRequestCount: 1,
          inputTokens: 90_000,
          cachedInputTokens: 60_000,
          outputTokens: 2_000,
          reasoningOutputTokens: 500,
        },
      }),
    );

    expect(rendered).toContain("当前会话：");
    expect(rendered).toContain("模型请求：9 次");
    expect(rendered).toContain("请求结果：完成 8 · 中断 1 · 失败 0 · 不完整 0");
    expect(rendered).not.toContain("中断后同轮有成功请求");
    expect(rendered).not.toContain("未观测到后续成功");
    expect(rendered).not.toContain("中断用量未完整观测");
    expect(rendered).toContain("Token：92 K");
    expect(rendered).toContain("缓存命中率：66.67%");
    expect(rendered).toContain("Token：92 K\n  缓存命中率：66.67%");
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

  it("shows reasoning tokens in debug and keeps unavailable speed explicit", () => {
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
        },
      }, true),
    );

    expect(rendered).toContain("其中推理输出：40");
    expect(rendered).not.toContain("延时");
    expect(rendered).not.toContain("延迟");
    expect(rendered).toContain("速度：—");
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


describe("completion response usage", () => {
  it.each(["telegram", "feishu", "weixin"])("shows exact turn and session Credits on %s", surface => {
    const presentation = createTurnCompletedPresentation({
      type: "turn.completed", target: { surface, accountId: "default", conversationId: "test" },
      threadId: "thread", turnId: "turn", status: "completed", modelProvider: "openai",
      timing: { responseUsage: { amount: "0", observedRequestCount: 1, missingRequestCount: 0 } },
      sessionAggregate: { requestCount: 4, unsuccessfulRequestCount: 0, inputTokens: 1,
        requestOutcomes: { completed: 4, interrupted: 0, failed: 0, incomplete: 0 },
        interruptionSummary: { followedByCompletion: 0, noObservedCompletion: 0, usageUnobserved: 0 },
        cachedInputTokens: null, outputTokens: 1, reasoningOutputTokens: 0,
        responseUsage: { amount: "0.1234567890123456789", observedRequestCount: 3, missingRequestCount: 1 } },
    });
    expect(presentation.fields).toContainEqual({ label: "OpenAI Credits", value: "0" });
    expect(presentation.sections?.find(section => section.title === "当前会话")?.fields).toContainEqual({
      label: "OpenAI Credits", value: "0.1234567890123456789（部分，1 次请求未提供）",
    });
  });
  it("hides unavailable Credits without inventing zero usage", () => {
    const event = { type: "turn.completed", target: { surface: "telegram", accountId: "default", conversationId: "test" },
      threadId: "thread", turnId: "turn", status: "completed", modelProvider: "openai" } as const;
    expect(renderPlainLifecyclePresentation(createTurnCompletedPresentation(event))).not.toContain("OpenAI Credits");
    expect(renderPlainLifecyclePresentation(createTurnCompletedPresentation({
      ...event,
      timing: { responseUsage: { amount: null, observedRequestCount: 0, missingRequestCount: 1 } },
    }))).not.toContain("OpenAI Credits");
    expect(renderPlainLifecyclePresentation(createTurnCompletedPresentation({ ...event, modelProvider: "deepseek" }))).not.toContain("OpenAI Credits");
    const unknownProviderEvent: Parameters<typeof createTurnCompletedPresentation>[0] = { ...event };
    delete unknownProviderEvent.modelProvider;
    expect(renderPlainLifecyclePresentation(createTurnCompletedPresentation(unknownProviderEvent))).not.toContain("OpenAI Credits");
  });
});
