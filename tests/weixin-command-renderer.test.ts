import { describe, expect, it } from "vitest";

import type {
  ConversationCommandResult,
} from "../src/application/index.js";
import {
  formatWeixinCommandText,
  renderWeixinCommandResult,
  renderWeixinStartupNotification,
  renderWeixinTurnCompleted,
} from "../src/surfaces/weixin/index.js";

describe("Weixin command renderer", () => {
  it("keeps compact lines while preserving intentional paragraphs", () => {
    expect(formatWeixinCommandText(
      "标题\r\n字段一：值一\n字段二：值二\n\n\n段落二",
      { structuredFields: true },
    )).toBe("**标题**\n- 字段一：值一\n- 字段二：值二\n\n段落二");
  });

  it("renders shared command sections and fields as compact Markdown lists", () => {
    expect(formatWeixinCommandText([
      "OpenAI Codex 额度：",
      "套餐：Pro",
      "",
      "GPT-5.3-Codex-Spark：",
      "主窗口：已使用 0% · 周期 7 天",
      "限流状态：正常",
      "",
      "codex：",
      "主窗口：已使用 17% · 周期 7 天",
      "Credits：无可用 Credits",
      "消费控制：正常",
      "限流状态：正常",
    ].join("\n"), { structuredFields: true })).toBe([
      "**OpenAI Codex 额度**",
      "- 套餐：Pro",
      "",
      "**GPT-5.3-Codex-Spark**",
      "- 主窗口：已使用 0% · 周期 7 天",
      "- 限流状态：正常",
      "",
      "**codex**",
      "- 主窗口：已使用 17% · 周期 7 天",
      "- Credits：无可用 Credits",
      "- 消费控制：正常",
      "- 限流状态：正常",
    ].join("\n"));
  });

  it("renders a leading command title before structured fields", () => {
    expect(formatWeixinCommandText([
      "Codex 状态",
      "Workspace：Main",
      "Thread：thread-1",
    ].join("\n"), { structuredFields: true })).toBe([
      "**Codex 状态**",
      "- Workspace：Main",
      "- Thread：thread-1",
    ].join("\n"));
  });

  it("renders isolated command fields as list items", () => {
    expect(formatWeixinCommandText([
      "协作模式：Plan",
      "",
      "下一条普通消息将按 Plan 模式处理。",
      "切换：/plan",
    ].join("\n"), { structuredFields: true })).toBe([
      "- 协作模式：Plan",
      "",
      "下一条普通消息将按 Plan 模式处理。  ",
      "- 切换：/plan",
    ].join("\n"));
  });

  it("leaves structured-looking non-command notifications unchanged", () => {
    expect(formatWeixinCommandText(
      "操作失败：请求暂时不可用\n错误代码：temporary",
    )).toBe(
      "操作失败：请求暂时不可用  \n错误代码：temporary",
    );
  });

  it("does not change copied code inside fenced blocks", () => {
    expect(formatWeixinCommandText(
      "命令：\n```sh\nprintf 'a'\nprintf 'b'\n```\n完成",
      { structuredFields: true },
    )).toBe(
      "**命令**\n```sh\nprintf 'a'\nprintf 'b'\n```\n完成",
    );
  });

  it("renders every shared command result kind as text", () => {
    const results: ConversationCommandResult[] = [
      {
        kind: "outcome",
        outcome: { type: "turn.stop-requested", stopped: false },
      },
      {
        kind: "sessions",
        sessions: [],
        archived: false,
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
      { kind: "plugins", result: [] },
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

    expect(results.map((result) => renderWeixinCommandResult(result))).toEqual([
      "## 当前没有运行中的任务。",
      "当前 Workspace 没有匹配的可恢复会话。",
      expect.stringContaining("Thread：尚未绑定"),
      expect.stringContaining("Main · main ← 当前"),
      expect.stringContaining("Fast 模式：开启"),
      "当前没有已启用的 Skills。",
      "## MCP Servers（0）",
      "当前没有已安装 Plugins。",
      expect.stringContaining("OpenAI Codex 账户用量摘要"),
      expect.stringContaining("Codex 额度"),
      expect.stringContaining("可用 Permission Profiles"),
      expect.stringContaining("项目规则检查通过"),
      "当前 Thread 暂无 Turn Diff。",
      "当前 Thread 没有 Goal。使用 /goal set <目标> 设置。",
    ]);
  });

  it("renders startup state and detailed Turn completion statistics", () => {
    const startup = renderWeixinStartupNotification(
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
      },
      {
        platform: "linux",
        architecture: "x64",
        gatewayVersion: "0.146.0",
        nodeVersion: "v22.23.1",
        transport: "Unix WebSocket",
        codexUpstreamUserAgent:
          "codex_connect_gateway/0.146.0 (Linux; x64) private-build-token (codex_connect_gateway; 0.146.0)",
        debugEnabled: true,
      },
    );
    expect(startup).toContain("Codex Connect 已上线");
    expect(startup).toContain("- App Server：已连接");
    expect(startup).toContain("- 系统：Linux · x64");
    expect(startup).not.toContain("private-build-token");

    const rendered = renderWeixinTurnCompleted({
      type: "turn.completed",
      target: {
        surface: "weixin",
        accountId: "bot-fixture@im.bot",
        conversationId: "actor-fixture@im.wechat",
      },
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      durationMs: 65_432,
      tokenUsage: {
        total: {
          totalTokens: 20_000,
          inputTokens: 15_000,
          cachedInputTokens: 12_000,
          cacheWriteInputTokens: 0,
          outputTokens: 5_000,
          reasoningOutputTokens: 1_000,
        },
        last: {
          totalTokens: 10_000,
          inputTokens: 8_000,
          cachedInputTokens: 6_000,
          cacheWriteInputTokens: 0,
          outputTokens: 2_000,
          reasoningOutputTokens: 500,
        },
        modelContextWindow: 100_000,
      },
      model: "gpt-test",
      effort: "medium",
      serviceTier: "priority",
      contextCompactionCount: 2,
      gitBranch: "feature/weixin-surface",
    });

    expect(rendered).toContain("本次运行 · 已完成");
    expect(rendered).toContain("- 上下文：10 K / 100 K（10%）");
    expect(rendered).toContain("最近请求缓存命中率：75.00%");
    expect(rendered).toContain("模型：gpt-test · medium · Fast 开启");
    expect(rendered).toContain("上下文压缩：2 次");
    expect(rendered).toContain("Git 分支：feature/weixin-surface");
    expect(rendered).toContain("耗时：1分5秒");
  });
});
