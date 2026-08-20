import { describe, expect, it } from "vitest";

import type {
  ConversationCommandOutcome,
  ConversationCommandResult,
  ModelSelectionState,
} from "../src/application/index.js";
import {
  isCriticalOutputEvent,
  UserFacingError,
  type OutputEvent,
} from "../src/conversation-core/index.js";
import {
  renderFeishuCommandResult,
  renderFeishuOutput,
  renderFeishuStartupNotification,
} from "../src/surfaces/feishu/index.js";
import { renderFeishuUserFacingError } from "../src/surfaces/feishu/renderer.js";

const target = {
  surface: "feishu",
  accountId: "cli_app",
  conversationId: "oc_chat",
} as const;

describe("Feishu output renderer", () => {
  it("renders a compact subagent start notice", () => {
    expect(renderFeishuOutput({
      type: "subagent.spawned",
      target,
      threadId: "parent-thread",
      turnId: "parent-turn",
      agentThreadId: "agent-thread-secret",
      agentPath: "/root/review_task",
    })).toBe("## 子代理开始 · review_task");
  });

  it("renders the thinking status with elapsed time", () => {
    expect(renderFeishuOutput({
      type: "turn.reasoning",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      summary: "",
      elapsedMs: 15_000,
    })).toBe("## 思考中…\n\n---\n**耗时：** 15秒");
  });

  it("distinguishes a batch image limit from a single-image limit", () => {
    expect(renderFeishuUserFacingError(new UserFacingError(
      "image.too-large",
      "opaque",
      { scope: "batch" },
    ))).toBe("图片总大小超过 20 MiB 限制");
  });

  it("renders a startup notification without the upstream build token", () => {
    const rendered = renderFeishuStartupNotification(
      [{ id: "main", name: "Main", cwd: "/workspace" }],
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
        gitBranch: "feature/weixin-surface",
        weeklyLimit: {
          usedPercent: 37,
          windowDurationMins: 10_080,
          resetsAt: null,
        },
      },
      {
        platform: "darwin",
        architecture: "arm64",
        gatewayVersion: "0.146.0",
        nodeVersion: "v24.0.0",
        transport: "Unix WebSocket",
        codexUpstreamUserAgent:
          "codex-cli/0.146.0 (macOS 15.0) build-secret (arm64)",
        debugEnabled: true,
      },
    );

    expect(rendered).toBe([
      "## Codex Connect 已上线",
      "",
      "- App Server：已连接",
      "",
      "### 运行环境",
      "- 系统：macOS · arm64",
      "- 版本：Codex Connect 0.146.0 · Node.js v24.0.0",
      "- 连接：Unix WebSocket",
      "- App Server UA：codex-cli/0.146.0 (macOS 15.0) (arm64)",
      "",
      "### 当前会话",
      "- Workspace：Main (main)",
      "- 工作目录：/workspace",
      "- Thread：thread-1",
      "- Git 分支：feature/weixin-surface",
      "- 模型：gpt-test",
      "- 提供商：OpenAI 官方",
      "- 思考等级：medium",
      "- Fast 模式：开启",
      "- 协作模式：Default",
      "",
      "### 账户状态",
      "- 周限：剩余 63%",
    ].join("\n"));
    expect(rendered).not.toContain("build-secret");
  });

  it("renders every platform-independent command result kind as plain text", () => {
    const results: ConversationCommandResult[] = [
      {
        kind: "outcome",
        outcome: { type: "turn.stop-requested", stopped: false },
      },
      {
        kind: "sessions",
        sessions: [],
        archived: false,
        page: 1,
        pageCount: 1,
        matchedSessionCount: 0,
        view: { page: 1, filter: "all", provider: null, sectionSelector: null, searchTerm: null },
      },
      {
        kind: "status",
        status: {
          workspaceId: "main",
          workspaceName: "Main",
          cwd: "/workspace",
          model: "gpt-test",
          effort: null,
          serviceTier: null,
          modelPending: false,
          effortPending: false,
          fastModePending: false,
          collaborationMode: "default",
          collaborationModePending: false,
        },
      },
      {
        kind: "workspaces",
        workspaces: [{ id: "main", name: "Main", cwd: "/workspace" }],
        currentWorkspaceId: "main",
      },
      {
        kind: "models",
        view: "fast",
        state: {
          models: [{
            id: "gpt-test",
            model: "gpt-test",
            displayName: "GPT Test",
            supportedReasoningEfforts: [{
              effort: "medium",
              description: "平衡",
            }],
            defaultReasoningEffort: "medium",
            serviceTiers: [{ id: "priority", name: "Fast" }],
            defaultServiceTier: "default",
            isDefault: true,
            inputModalities: ["text", "image"],
          }],
          model: "gpt-test",
          effort: "medium",
          serviceTier: "priority",
          pending: false,
          modelPending: false,
          effortPending: false,
          serviceTierPending: false,
        },
      },
      { kind: "skills", entries: [] },
      { kind: "mcp", servers: [] },
      {
        kind: "plugins",
        plugins: [],
        selectors: [],
        loadErrorCount: 0,
        totalPluginCount: 0,
        matchedPluginCount: 0,
        page: 1,
        pageCount: 1,
        searchTerm: null,
      },
      {
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
        },
      },
      {
        kind: "limits",
        result: {
          kind: "rate-limits",
          provider: "openai",
          limits: { limits: [], resetCreditsAvailable: null },
        },
      },
      { kind: "permissions", profiles: [] },
      {
        kind: "project-rules",
        action: "checked",
        projectRoot: "/workspace",
        rulesPath: "/workspace/.codex/rules/default.rules",
      },
      {
        kind: "artifacts",
        view: "diff",
        artifacts: undefined,
      },
      { kind: "goal", goal: null },
    ];

    expect(results.map((result) => result.kind)).toEqual([
      "outcome",
      "sessions",
      "status",
      "workspaces",
      "models",
      "skills",
      "mcp",
      "plugins",
      "usage",
      "limits",
      "permissions",
      "project-rules",
      "artifacts",
      "goal",
    ]);
    expect(results.map((result) => renderFeishuCommandResult(result))).toEqual([
      "## 当前没有运行中的任务。",
      "当前 Workspace 没有匹配的可恢复会话。",
      expect.stringContaining("Thread：尚未绑定"),
      expect.stringContaining("Main · main ← 当前"),
      expect.stringContaining("Fast 模式：开启"),
      "当前没有已启用的 Skills。",
      "## MCP Servers（0）",
      "当前没有已安装的 Plugin。",
      expect.stringContaining("OpenAI Codex 账户用量摘要"),
      expect.stringContaining("Codex 额度"),
      expect.stringContaining("可用 Permission Profiles"),
      expect.stringContaining("项目规则检查通过"),
      "当前 Thread 暂无 Turn Diff。",
      "当前 Thread 没有 Goal。使用 /goal set <目标> 设置。",
    ]);
  });

  it("preserves detailed status and account limit fields", () => {
    const status = renderFeishuCommandResult({
      kind: "status",
      status: {
        threadId: "thread-1",
        turnId: "turn-1",
        workspaceId: "main",
        workspaceName: "Main",
        cwd: "/workspace",
        gitBranch: "feature/weixin-surface",
        model: "gpt-test",
        effort: "medium",
        serviceTier: "priority",
        modelPending: false,
        effortPending: false,
        fastModePending: false,
        collaborationMode: "default",
        collaborationModePending: false,
        tokenUsage: {
          total: {
            totalTokens: 1_000,
            inputTokens: 800,
            cachedInputTokens: 600,
            cacheWriteInputTokens: 50,
            outputTokens: 200,
            reasoningOutputTokens: 100,
          },
          last: {
            totalTokens: 100,
            inputTokens: 80,
            cachedInputTokens: 40,
            cacheWriteInputTokens: 5,
            outputTokens: 20,
            reasoningOutputTokens: 10,
          },
          modelContextWindow: 258_400,
        },
        weeklyLimit: {
          usedPercent: 37,
          windowDurationMins: 10_080,
          resetsAt: 1_800_000_000,
        },
      },
    });
    expect(status).toContain("输入命中缓存：600");
    expect(status).toContain("输入未命中缓存：200");
    expect(status).toContain("缓存命中率：75.00%");
    expect(status).toContain("缓存写入：50");
    expect(status).toContain("Git 分支：feature/weixin-surface");
    expect(status).toContain("周限：剩余 63%");

    const limits = renderFeishuCommandResult({
      kind: "limits",
      result: {
        kind: "rate-limits",
        provider: "openai",
        limits: {
          limits: [{
            limitId: "codex",
            limitName: "Codex",
            primary: null,
            secondary: null,
            credits: null,
            individualLimit: {
              limit: "100",
              used: "25",
              remainingPercent: 75,
              resetsAt: 1_800_000_000,
            },
            spendControlReached: false,
            planType: "pro",
            rateLimitReachedType: "workspace_member_usage_limit_reached",
          }],
          resetCreditsAvailable: null,
        },
      },
    });
    expect(limits).toContain("套餐：Pro");
    expect(limits).toContain("个人限额：已用 25 / 100");
    expect(limits).toContain("个人限额剩余：75%");
    expect(limits).toContain("消费控制：正常");
    expect(limits).toContain("限流状态：Workspace 用量上限已达到");
  });

  it("formats usage token totals in millions", () => {
    const rendered = renderFeishuCommandResult({
      kind: "usage",
      result: {
        kind: "token-usage",
        provider: "openai",
        usage: {
          summary: {
            lifetimeTokens: 6_439_124_350,
            peakDailyTokens: 389_153_809,
            longestRunningTurnSec: 1_138,
            currentStreakDays: 45,
            longestStreakDays: 45,
          },
          daily: [{
            startDate: "2026-07-26",
            tokens: 128_021_979,
          }],
        },
      },
    });

    expect(rendered).toContain("累计 Tokens：6,439.12 M");
    expect(rendered).toContain("单日峰值：389.15 M");
    expect(rendered).toContain("2026-07-26：128.02 M");
    expect(rendered).toContain("最长 Turn：18分58秒");
  });

  it("renders detailed context after a completed Turn", () => {
    const rendered = renderFeishuOutput({
      type: "turn.completed",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      durationMs: 65_432,
      tokenUsage: {
        total: {
          totalTokens: 1_000,
          inputTokens: 800,
          cachedInputTokens: 600,
          cacheWriteInputTokens: 50,
          outputTokens: 200,
          reasoningOutputTokens: 100,
        },
        last: {
          totalTokens: 100,
          inputTokens: 80,
          cachedInputTokens: 40,
          cacheWriteInputTokens: 5,
          outputTokens: 20,
          reasoningOutputTokens: 10,
        },
        modelContextWindow: 200,
      },
      model: "gpt-test",
      modelProvider: "openai",
      effort: "medium",
      serviceTier: "priority",
      gitBranch: "feature/weixin-surface",
      contextCompactionCount: 2,
      weeklyLimit: {
        usedPercent: 37,
        windowDurationMins: 10_080,
        resetsAt: null,
      },
    });

    expect(rendered).toBe([
      "## 本次运行 · 已完成",
      "",
      "### 本次运行",
      "- 模型：gpt-test · medium · Fast 开启",
      "- 提供商：OpenAI 官方",
      "- **性能**",
      "  - 总耗时：1分5秒",
      "",
      "### 当前会话累计",
      "- 上下文：100 / 200（50%）",
      "- 上下文压缩：2 次",
      "- Git 分支：feature/weixin-surface",
      "",
      "### 账户状态",
      "- 周限：剩余 63%",
    ].join("\n"));
  });

  it("renders every command outcome with its distinguishing data", () => {
    const cases: Array<{
      outcome: ConversationCommandOutcome;
      expected: string;
    }> = [
      {
        outcome: {
          type: "thread.resumed",
          threadId: "thread-resumed",
          model: { model: "gpt-test", modelProvider: "openai" },
        },
        expected: "Thread：thread-resumed",
      },
      {
        outcome: {
          type: "thread.resumed",
          threadId: "thread-transferred",
          transferredFrom: "telegram",
          model: { model: "gpt-test", modelProvider: "openai" },
        },
        expected: "已从 Telegram 接管 Codex Thread",
      },
      {
        outcome: {
          type: "session.new",
          nextModel: { model: "gpt-test", modelProvider: "openai" },
        },
        expected: "下一条普通消息将创建新的 Codex Thread",
      },
      {
        outcome: { type: "thread.archived", threadId: "thread-archived" },
        expected: "Thread：thread-archived",
      },
      {
        outcome: {
          type: "thread.unarchived",
          threadId: "thread-unarchived",
        },
        expected: "Thread：thread-unarchived",
      },
      {
        outcome: {
          type: "workspace.selected",
          workspace: { id: "main", name: "Main", cwd: "/workspace" },
          nextModel: { model: "gpt-test", modelProvider: "openai" },
        },
        expected: "工作目录：/workspace",
      },
      {
        outcome: { type: "turn.stop-requested", stopped: true },
        expected: "已请求停止当前任务",
      },
      {
        outcome: { type: "turn.follow-up-queued", position: 3 },
        expected: "当前第 3 条",
      },
      {
        outcome: { type: "thread.renamed", name: "新名称" },
        expected: "名称：新名称",
      },
      {
        outcome: { type: "thread.pin-updated", pinned: true, changed: true },
        expected: "已固定当前会话",
      },
      {
        outcome: { type: "thread.pin-updated", pinned: false, changed: true },
        expected: "已取消固定当前会话",
      },
      {
        outcome: { type: "thread.pin-updated", pinned: true, changed: false },
        expected: "当前会话已处于固定状态",
      },
      {
        outcome: { type: "thread.pin-updated", pinned: false, changed: false },
        expected: "当前会话未固定",
      },
      {
        outcome: { type: "thread.compaction-requested" },
        expected: "已请求压缩当前 Codex Thread",
      },
      {
        outcome: { type: "thread.forked", threadId: "thread-forked" },
        expected: "Thread：thread-forked",
      },
      {
        outcome: { type: "review.started", turnId: "turn-review" },
        expected: "Turn：turn-review",
      },
      {
        outcome: { type: "goal.cleared" },
        expected: "已清除当前 Thread Goal",
      },
      {
        outcome: {
          type: "goal.updated",
          goal: {
            threadId: "thread-1",
            objective: "完成飞书接入",
            status: "active",
            tokenBudget: 10_000,
            tokensUsed: 100,
            timeUsedSeconds: 5,
            createdAt: 1,
            updatedAt: 2,
          },
        },
        expected: "目标：完成飞书接入",
      },
    ];

    for (const entry of cases) {
      expect(renderFeishuCommandResult({
        kind: "outcome",
        outcome: entry.outcome,
      })).toContain(entry.expected);
    }
  });

  it("renders populated command collections, model views, artifacts, and goal", () => {
    const sessions = renderFeishuCommandResult({
      kind: "sessions",
      sessions: [{
        id: "thread-1234567890",
        name: "会话名称",
        preview: "预览",
        isPinned: true,
        status: { type: "idle" },
      }],
      currentThreadId: "thread-1234567890",
      archived: false,
      page: 1,
      pageCount: 1,
      matchedSessionCount: 1,
      view: { page: 1, filter: "all", provider: null, sectionSelector: null, searchTerm: "会话" },
    });
    expect(sessions).toContain("固定 · 会话名称 · thread-12345 · idle ← 当前");

    expect(renderFeishuCommandResult({
      kind: "skills",
      entries: [{ name: "tdd", description: "测试驱动开发" }],
    })).toContain("1. tdd：测试驱动开发");
    expect(renderFeishuCommandResult({
      kind: "mcp",
      servers: [{ name: "docs", authStatus: "oAuth", toolCount: 2 }],
    })).toContain("1. docs · auth=oAuth · tools=2");
    expect(renderFeishuCommandResult({
      kind: "plugins",
      plugins: [{
        id: "github@local",
        name: "github",
        displayName: "GitHub",
        marketplaceName: "local",
        description: null,
        enabled: true,
        available: true,
        version: null,
        localVersion: null,
        source: "local",
        installedAt: null,
        developerName: null,
        category: null,
        capabilities: [],
        authPolicy: "onUse",
        eligiblePlanTypes: [],
        disabledReason: null,
      }],
      selectors: ["1"],
      loadErrorCount: 0,
      totalPluginCount: 1,
      matchedPluginCount: 1,
      page: 1,
      pageCount: 1,
      searchTerm: null,
    })).toContain("1. GitHub · github@local · 已启用");
    expect(renderFeishuCommandResult({
      kind: "permissions",
      profiles: [{
        id: "workspace-write",
        allowed: true,
        description: "允许工作区写入",
      }],
    })).toContain("- workspace-write · 允许 · 允许工作区写入");
    expect(renderFeishuCommandResult({
      kind: "project-rules",
      action: "initialized",
      projectRoot: "/workspace",
      rulesPath: "/workspace/.codex/rules/default.rules",
    })).toContain("重启 Codex/App Server 后生效");

    const state: ModelSelectionState = {
      models: [{
        id: "gpt-test",
        model: "gpt-test",
        displayName: "GPT Test",
        supportedReasoningEfforts: [{
          effort: "medium",
          description: "平衡",
        }],
        defaultReasoningEffort: "medium",
        serviceTiers: [{ id: "priority", name: "Fast" }],
        defaultServiceTier: "default",
        isDefault: true,
        inputModalities: ["text", "image"],
      }],
      model: "gpt-test",
      effort: "medium",
      serviceTier: "priority",
      pending: false,
      modelPending: false,
      effortPending: false,
      serviceTierPending: false,
    };
    for (const [view, expected] of [
      ["model", "模型列表（1）"],
      ["effort", "可用思考等级"],
      ["fast", "模型支持：支持 Fast"],
    ] as const) {
      expect(renderFeishuCommandResult({
        kind: "models",
        view,
        state,
      })).toContain(expected);
    }

    expect(renderFeishuCommandResult({
      kind: "artifacts",
      view: "diff",
      artifacts: {
        threadId: "thread-1",
        turnId: "turn-1",
        diff: "+新增",
      },
    })).toContain("+新增");
    expect(renderFeishuCommandResult({
      kind: "collaboration-mode",
      state: {
        mode: "plan",
        pending: true,
      },
    })).toContain("协作模式：Plan（下一次 Turn 生效）");
    expect(renderFeishuCommandResult({
      kind: "goal",
      goal: {
        threadId: "thread-1",
        objective: "完成飞书接入",
        status: "active",
        tokenBudget: 10_000,
        tokensUsed: 100,
        timeUsedSeconds: 5,
        createdAt: 1,
        updatedAt: 2,
      },
    })).toContain("Tokens：100 / 10 K");
  });

  it("bounds session rows and normalizes long multi-line previews", () => {
    const sessions = renderFeishuCommandResult({
      kind: "sessions",
      sessions: Array.from({ length: 21 }, (_, index) => ({
        id: `thread-${String(index + 1).padStart(12, "0")}`,
        name: null,
        preview: index === 0
          ? `第一行\n第二行 ${"长".repeat(60)}`
          : `会话 ${index + 1}`,
        isPinned: false,
        status: { type: "idle" as const },
      })),
      archived: false,
      page: 1,
      pageCount: 1,
      matchedSessionCount: 21,
      view: { page: 1, filter: "all", provider: null, sectionSelector: null, searchTerm: null },
    });

    expect(sessions).toContain(
      `1. 第一行 第二行 ${"长".repeat(39)}… · thread-00000 · idle`,
    );
    expect(sessions).not.toContain("第一行\n第二行");
    expect(sessions).toContain(
      "另有 1 条未显示，请使用 /sessions search <搜索词> 缩小范围。",
    );
    expect(sessions).not.toContain("21. 会话 21");
  });

  it("annotates session rows with the model when known", () => {
    const sessions = renderFeishuCommandResult({
      kind: "sessions",
      sessions: [{
        id: "thread-1234567890",
        name: "会话名称",
        preview: "预览",
        isPinned: true,
        status: { type: "idle" },
        model: "gpt-test",
      }],
      currentThreadId: "thread-1234567890",
      archived: false,
      page: 1,
      pageCount: 1,
      matchedSessionCount: 1,
      view: { page: 1, filter: "all", provider: null, sectionSelector: null, searchTerm: null },
    });

    expect(sessions).toContain(
      "固定 · 会话名称 · 模型：gpt-test · thread-12345 · idle ← 当前",
    );
  });

  it("renders completed assistant content for the CardKit boundary", () => {
    const event: OutputEvent = {
      type: "text.completed",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      text: "任务已完成。",
    };

    expect(renderFeishuOutput(event)).toBe("任务已完成。");
  });

  it("uses a visible fallback for a blank completed message", () => {
    const event: OutputEvent = {
      type: "text.completed",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      text: " \n ",
    };

    expect(renderFeishuOutput(event)).toBe("Codex 返回了空消息。");
  });

  it("renders structured visual completion details with the recognition model", () => {
    expect(renderFeishuOutput({
      type: "vision.completed",
      target,
      provider: "BLTCY",
      model: "gpt-5.6-luna",
      elapsedMs: 18_000,
      usage: {
        inputTokens: 9_433,
        outputTokens: 483,
        totalTokens: 9_916,
      },
    }, undefined, undefined, true)).toBe([
      "## 图片识别完成",
      "- API 提供商：BLTCY",
      "- 调用模型：gpt-5.6-luna",
      "- 视觉 API 耗时：18秒",
      "- **Token**：9,916",
      "  - 输出：483",
      "",
      "- 正在交给当前模型处理。",
    ].join("\n"));
  });

  it("renders every critical output event and ignores non-critical progress", () => {
    const criticalEvents: OutputEvent[] = [
      {
        type: "user.message",
        target,
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "user-1",
        text: "继续处理",
      },
      {
        type: "text.completed",
        target,
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "assistant-1",
        text: "已处理",
      },
      {
        type: "operation.updated",
        target,
        threadId: "thread-1",
        turnId: "turn-1",
        operation: {
          itemId: "command-1",
          kind: "command",
          status: "completed",
        },
      },
      {
        type: "turn.completed",
        target,
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
      },
      {
        type: "thread.status",
        target,
        threadId: "thread-1",
        status: "idle",
      },
      {
        type: "connection.lost",
        target,
        threadId: "thread-1",
        message: "upstream secret",
      },
      {
        type: "account.updated",
        target,
        authMode: "chatgpt",
        planType: "pro",
      },
      {
        type: "account.rateLimits.updated",
        target,
        rateLimits: {
          limitId: null,
          limitName: null,
          primary: null,
          secondary: null,
          credits: null,
          individualLimit: null,
          spendControlReached: null,
          planType: null,
          rateLimitReachedType: null,
        },
      },
      {
        type: "mcp.status.updated",
        target,
        threadId: "thread-1",
        name: "example",
        status: "failed",
        error: "upstream secret",
        failureReason: null,
      },
      {
        type: "warning",
        target,
        threadId: "thread-1",
        message: "upstream secret",
      },
    ];
    const progressEvents: OutputEvent[] = [
      {
        type: "vision.started",
        target,
        imageCount: 2,
      },
      {
        type: "turn.started",
        target,
        threadId: "thread-1",
        turnId: "turn-1",
      },
      {
        type: "text.delta",
        target,
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "assistant-1",
        text: "处理中",
      },
      {
        type: "operation.updated",
        target,
        threadId: "thread-1",
        turnId: "turn-1",
        operation: {
          itemId: "command-1",
          kind: "command",
          status: "running",
        },
      },
    ];

    expect(criticalEvents.every(isCriticalOutputEvent)).toBe(true);
    expect(criticalEvents
      .filter((event) => event.type !== "operation.updated")
      .map((event) => renderFeishuOutput(event))
      .every((text) => Boolean(text?.trim()))).toBe(true);
    expect(renderFeishuOutput(criticalEvents[2]!)).toBeNull();
    expect(progressEvents.some(isCriticalOutputEvent)).toBe(false);
    expect(progressEvents.map((event) => renderFeishuOutput(event))).toEqual([
      "## 视觉识别中\n- 图片：2 张\n- 状态：已发送至视觉 API",
      "## 已开始处理。",
      null,
      null,
    ]);
  });

  it("shows sanitized upstream error and warning details", () => {
    const events: OutputEvent[] = [
      {
        type: "turn.completed",
        target,
        threadId: "thread-1",
        turnId: "turn-1",
        status: "failed",
        error: "模型请求失败，token=[REDACTED]",
      },
      {
        type: "connection.lost",
        target,
        threadId: "thread-1",
        message: "Codex App Server 连接已断开，正在恢复连接",
      },
      {
        type: "mcp.status.updated",
        target,
        threadId: "thread-1",
        name: "example",
        status: "failed",
        error: "登录失败，cookie=[REDACTED]",
        failureReason: null,
      },
      {
        type: "warning",
        target,
        message: "配置无效，password=[REDACTED]",
      },
    ];

    const rendered = events.map((event) => renderFeishuOutput(event)).join("\n");
    expect(rendered).toContain("模型请求失败，token=[已隐藏]");
    expect(rendered).toContain("Codex App Server 连接已断开，正在恢复连接");
    expect(rendered).toContain("登录失败，cookie=[已隐藏]");
    expect(rendered).toContain("配置无效，password=[已隐藏]");
  });

  it("renders a connection restore notice", () => {
    expect(renderFeishuOutput({
      type: "connection.restored",
      target,
      threadId: "thread-1",
      message: "Codex App Server 已重新连接，会话已恢复",
    })).toBe("Codex 连接已恢复：Codex App Server 已重新连接，会话已恢复");
  });
});
