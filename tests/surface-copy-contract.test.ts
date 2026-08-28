import { describe, expect, it } from "vitest";

import {
  archivedSessionCommandUsageText,
  mcpCommandUsageText,
  type ConversationCommandResult,
  type ConversationStatus,
} from "../src/application/index.js";
import { UserFacingError } from "../src/conversation-core/index.js";
import {
  conversationCommandHelpLines,
  formatConversationSessions,
  formatConversationStatus,
  formatConversationThreadSectionDeletePreview,
  formatConversationThreadSections,
} from "../src/surfaces/conversation-command-format.js";
import {
  formatPercent,
  formatPlanType,
  formatRateLimitState,
  formatRemainingRateLimitWindow,
  formatRateLimitWindow,
} from "../src/surfaces/account-format.js";
import { formatTurnInputAppended } from "../src/surfaces/input-copy.js";
import { formatSurfaceUserFacingError } from "../src/surfaces/user-facing-error-format.js";
import {
  formatCancelledInteraction,
  formatProcessedInteractionOutcome,
  interactionCancelledTitle,
  interactionOutcome,
  interactionProcessedTitle,
} from "../src/surfaces/interaction-copy.js";
import {
  formatTextFileDownloadFailed,
  formatTextFileTooLarge,
  formatUnsupportedTextFile,
} from "../src/surfaces/text-file-copy.js";
import {
  formatConfigurationChange,
  formatSessions as formatTelegramSessions,
} from "../src/surfaces/telegram/format.js";
import {
  renderFeishuConfigurationChange,
  renderFeishuCommandResult,
  renderFeishuHelp,
  renderFeishuOutput,
} from "../src/surfaces/feishu/renderer.js";
import {
  formatRuntimeAccountUpdate,
  formatRuntimeMcpOAuthCompleted,
  formatRuntimeMcpStatusUpdate,
  formatRuntimeRateLimitUpdate,
} from "../src/surfaces/runtime-status-format.js";
import {
  emptyCodexResponseText,
  formatCliInput,
  formatThreadAvailability,
} from "../src/surfaces/output-copy.js";
import {
  renderWeixinCommandResult,
  renderWeixinHelp,
} from "../src/surfaces/weixin/command-renderer.js";
import { parseSlashCommand } from "../src/surfaces/slash-command.js";

describe("shared surface copy contract", () => {
  it("explains occupied and automatically recovered Threads without exposing upstream errors", () => {
    expect(formatThreadAvailability("occupied", "thread-1234567890"))
      .toBe(
        "当前会话正在被另一个 Codex 客户端使用。Gateway 已正常启动；占用解除后会自动恢复。",
      );
    expect(formatThreadAvailability("available", "thread-1234567890"))
      .toBe("当前会话的占用已解除，Gateway 已自动恢复。");
    expect(formatThreadAvailability("occupied", "thread-1234567890", true))
      .toContain("后台会话 thread-12345");
  });

  it("reports unsupported model audio before a Turn on every surface", () => {
    const error = new UserFacingError(
      "model.input.audio.unsupported",
      "当前模型 gpt-test 不支持语音输入，请发送文字或图片",
      { model: "gpt-test" },
    );
    for (const surface of ["Telegram", "飞书", "微信"] as const) {
      expect(formatSurfaceUserFacingError(error, surface))
        .toBe("当前模型 gpt-test 不支持语音输入，请发送文字或图片");
    }
  });

  it("reports unsupported model images before a Turn on every surface", () => {
    const error = new UserFacingError(
      "model.input.image.unsupported",
      "当前模型 deepseek-v4-flash 不支持图片输入，请发送文字或切换支持图片的模型",
      { model: "deepseek-v4-flash" },
    );
    for (const surface of ["Telegram", "飞书", "微信"] as const) {
      expect(formatSurfaceUserFacingError(error, surface)).toBe(
        "当前模型 deepseek-v4-flash 不支持图片输入，请发送文字或切换支持图片的模型",
      );
    }
  });

  it("reports Plan and collaboration mode errors consistently on every surface", () => {
    const cases = [
      [
        new UserFacingError("plan.prompt.empty", "Plan 需求不能为空"),
        "Plan 需求不能为空",
      ],
      [
        new UserFacingError("collaboration-mode.unavailable", "Plan 模式服务不可用"),
        "Plan 模式服务不可用",
      ],
      [
        new UserFacingError(
          "collaboration-mode.unsupported",
          "当前 Codex App Server 不支持 Plan 模式",
        ),
        "当前 Codex App Server 不支持该协作模式",
      ],
    ] as const;
    for (const surface of ["Telegram", "飞书", "微信"] as const) {
      for (const [error, expected] of cases) {
        expect(formatSurfaceUserFacingError(error, surface)).toBe(expected);
      }
    }
  });

  it("reports Queue and pending override conflicts consistently on every surface", () => {
    const error = new UserFacingError(
      "queue.pending-overrides",
      "opaque internal fallback",
    );
    for (const surface of ["Telegram", "飞书", "微信"] as const) {
      expect(formatSurfaceUserFacingError(error, surface)).toBe(
        "Queue 与待生效的模型、思考、Fast 或 Plan 选择不能同时存在；请先让其中一方处理完成",
      );
    }
  });

  it("reports the complete MCP command usage consistently on every surface", () => {
    const error = new UserFacingError("mcp.usage", "invalid MCP command");
    for (const surface of ["Telegram", "飞书", "微信"] as const) {
      expect(formatSurfaceUserFacingError(error, surface)).toBe(mcpCommandUsageText);
    }
  });

  it("reports archived session usage consistently on every surface", () => {
    const error = new UserFacingError(
      "archived-sessions.usage",
      archivedSessionCommandUsageText,
    );
    for (const surface of ["Telegram", "飞书", "微信"] as const) {
      expect(formatSurfaceUserFacingError(error, surface))
        .toBe(archivedSessionCommandUsageText);
    }
  });

  it("explains Thread Section administrator denial consistently on every surface", () => {
    const error = new UserFacingError(
      "thread-section.admin-required",
      "opaque internal fallback",
    );
    for (const surface of ["Telegram", "飞书", "微信"] as const) {
      expect(formatSurfaceUserFacingError(error, surface)).toBe(
        "当前用户没有 Thread 分区写权限；请在 thread_sections.administrators 中配置对应渠道用户 ID，并重启 Gateway",
      );
    }
  });

  it("formats MCP OAuth completion without exposing sensitive failure details", () => {
    expect(formatRuntimeMcpOAuthCompleted({
      name: "docs",
      success: true,
      error: null,
    })).toBe([
      "## MCP OAuth",
      "- 名称：docs",
      "- 状态：登录成功",
    ].join("\n"));
    expect(formatRuntimeMcpOAuthCompleted({
      name: "github",
      success: false,
      error: "TOKEN=[REDACTED]",
    })).toBe([
      "## MCP OAuth",
      "- 名称：github",
      "- 状态：登录失败",
      "- 原因：TOKEN=[已隐藏]",
    ].join("\n"));
  });

  it("keeps account, quota, appended-input, and empty-response copy shared", () => {
    expect(formatSurfaceUserFacingError(
      new UserFacingError("provider.account.unavailable", "账户查询失败"),
      "飞书",
    )).toBe("当前提供商的账户查询失败，请检查配置或稍后重试");
    expect(formatPercent(12.34)).toBe("12.3%");
    expect(formatPlanType("self_serve_business_usage_based"))
      .toBe("Business（按量）");
    expect(formatPlanType("ent26")).toBe("Enterprise");
    expect(formatRateLimitState(null)).toBe("正常");
    expect(formatRateLimitWindow({
      usedPercent: 12,
      windowDurationMins: 10_080,
      resetsAt: null,
    })).toBe("已使用 12% · 周期 7 天");
    expect(formatRemainingRateLimitWindow({
      usedPercent: 44,
      windowDurationMins: 10_080,
      resetsAt: null,
    })).toBe("剩余 56% · 周期 7 天");
    expect(formatRemainingRateLimitWindow({
      usedPercent: 120,
      windowDurationMins: null,
      resetsAt: null,
    })).toBe("剩余 0%");
    expect(formatRemainingRateLimitWindow({
      usedPercent: 44,
      windowDurationMins: null,
      resetsAt: new Date(2026, 7, 5, 12, 34).getTime() / 1_000,
    })).toBe("剩余 56% · 重置 8月5日 12:34");
    expect(formatTurnInputAppended("text"))
      .toBe("已将补充要求追加到当前 Turn。");
    expect(formatTurnInputAppended("text", false, "补充要求：只总结错误和风险。"))
      .toBe("已将补充要求追加到当前 Turn：\n\n> 补充要求：只总结错误和风险。");
    expect(formatTurnInputAppended("file"))
      .toBe("已将文件追加到当前 Turn。");
    expect(formatTurnInputAppended("image", true))
      .toBe("已将图片和补充要求追加到当前 Turn。");
    expect(emptyCodexResponseText).toBe("Codex 返回了空消息。");
    expect(formatCliInput("继续处理"))
      .toBe("CLI 输入\n\n继续处理");
  });

  it("keeps interaction outcomes platform-neutral", () => {
    expect(interactionProcessedTitle).toBe("Codex 交互已处理");
    expect(interactionCancelledTitle).toBe("Codex 交互已取消");
    expect(formatProcessedInteractionOutcome(interactionOutcome.answered))
      .toBe("## Codex 交互已处理\n- 结果：已提交回答。");
    expect(formatProcessedInteractionOutcome(interactionOutcome.formSubmitted))
      .toBe("## Codex 交互已处理\n- 结果：已提交表单。");
    expect(formatProcessedInteractionOutcome(interactionOutcome.resolvedElsewhere))
      .toBe("## Codex 交互已处理\n- 结果：已在其他客户端处理。");
    expect(formatCancelledInteraction()).toBe("## Codex 交互已取消");
    expect(formatCancelledInteraction("Gateway 已停止"))
      .toBe("## Codex 交互已取消\n- 原因：Gateway 已停止。");
  });

  it("keeps text-file error semantics aligned while naming the platform", () => {
    for (const platform of ["Telegram", "飞书", "微信"]) {
      const label = platform === "Telegram" ? "Telegram " : platform;
      expect(formatTextFileDownloadFailed(platform))
        .toBe(platform === "Telegram"
          ? "下载 Telegram 文件失败，请重新发送"
          : `下载${platform}文件失败，请重新发送`);
      expect(formatTextFileTooLarge(platform))
        .toBe(`${label}文本文件超过 1,000,000 字节限制`);
      expect(formatUnsupportedTextFile(platform))
        .toBe(`${label}当前仅支持 UTF-8 文本文件`);
    }
  });

  it("keeps the shared command directory in Feishu and Weixin help", () => {
    for (const line of conversationCommandHelpLines) {
      const expected = line.endsWith("：")
        ? `### ${line.slice(0, -1)}`
        : line;
      expect(renderFeishuHelp()).toContain(expected);
      expect(renderWeixinHelp()).toContain(expected);
    }
    for (const help of [renderFeishuHelp(), renderWeixinHelp()]) {
      expect(help).toContain("### 快捷命令");
      expect(help).toContain("- /h → /help");
      expect(help).toContain("- /work → /workspace");
      expect(help).toContain("- /r → /resume");
    }
  });

  it("normalizes documented Surface shortcuts before channel dispatch", () => {
    expect(parseSlashCommand("/h")).toEqual({
      name: "help",
      argumentsText: "",
    });
    expect(parseSlashCommand("/work docs")).toEqual({
      name: "workspace",
      argumentsText: "docs",
    });
    expect(parseSlashCommand("/r thread-1")).toEqual({
      name: "resume",
      argumentsText: "thread-1",
    });
    expect(parseSlashCommand("/skills 5 初始化检查")).toEqual({
      name: "skill",
      argumentsText: "5 初始化检查",
    });
    expect(parseSlashCommand("/workspaceperm sandbox read-only")).toEqual({
      name: "workspaceperm",
      argumentsText: "sandbox read-only",
    });
  });

  it("keeps bounded session lists identical across all surfaces", () => {
    const result: Extract<
      ConversationCommandResult,
      { kind: "sessions" }
    > = {
      kind: "sessions",
      sessions: Array.from({ length: 21 }, (_, index) => ({
        id: `thread-${String(index + 1).padStart(12, "0")}`,
        name: null,
        preview: index === 0
          ? `第一行\n第二行 ${"长".repeat(60)}`
          : `会话 ${index + 1}`,
        isPinned: false,
        status: { type: "idle" },
      })),
      currentThreadId: "thread-000000000001",
      archived: false,
      page: 1,
      pageCount: 1,
      matchedSessionCount: 21,
      view: { page: 1, filter: "all", provider: null, sectionSelector: null, searchTerm: null },
    };
    const expected = formatConversationSessions(result);

    expect(formatTelegramSessions(
      result.sessions,
      result.currentThreadId,
      { archived: result.archived },
    )).toBe(expected);
    expect(renderFeishuCommandResult(result)).toBe(expected);
    expect(renderWeixinCommandResult(result)).toBe(expected);
    expect(expected).toContain(
      "另有 1 条未显示，请使用 /sessions search <搜索词> 缩小范围。",
    );
    expect(expected).not.toContain("21. 会话 21");
  });

  it("keeps Thread Section lists and deletion warnings platform-independent", () => {
    const section = {
      id: "section-project",
      name: "项目",
      builtIn: null,
      currentWorkspaceActiveCount: 2,
      currentWorkspaceArchivedCount: 1,
    } as const;
    const list: Extract<ConversationCommandResult, { kind: "thread-sections" }> = {
      kind: "thread-sections",
      sections: [section],
      selectors: ["2"],
      page: 1,
      pageCount: 1,
      totalSectionCount: 2,
      canManageCustomSections: true,
    };
    const preview: Extract<ConversationCommandResult, { kind: "thread-section-delete-preview" }> = {
      kind: "thread-section-delete-preview",
      preview: { section },
    };

    expect(renderFeishuCommandResult(list)).toBe(formatConversationThreadSections(list));
    expect(renderWeixinCommandResult(list)).toBe(formatConversationThreadSections(list));
    expect(renderFeishuCommandResult(preview))
      .toBe(formatConversationThreadSectionDeletePreview(preview));
    expect(renderWeixinCommandResult(preview))
      .toBe(formatConversationThreadSectionDeletePreview(preview));
    expect(formatConversationThreadSectionDeletePreview(preview))
      .toContain("其他 Workspace 中的归属也会受影响");

    const missingPage: Extract<
      ConversationCommandResult,
      { kind: "thread-sections" }
    > = {
      kind: "thread-sections",
      sections: [],
      selectors: [],
      page: 3,
      pageCount: 2,
      totalSectionCount: 9,
      canManageCustomSections: false,
    };
    const missingPageText = formatConversationThreadSections(missingPage);
    expect(missingPageText).toContain("第 3 页不存在，共 2 页");
    expect(missingPageText).toContain("返回第一页：/section list 1");
    expect(missingPageText).not.toContain("/section list 2");
    expect(renderFeishuCommandResult(missingPage)).toBe(missingPageText);
    expect(renderWeixinCommandResult(missingPage)).toBe(missingPageText);
  });

  it("keeps Pinned convenient while hiding custom Thread Section writes from readers", () => {
    const list: Extract<ConversationCommandResult, { kind: "thread-sections" }> = {
      kind: "thread-sections",
      sections: [{
        id: "section-pinned",
        name: "Pinned",
        builtIn: "pinned",
        currentWorkspaceActiveCount: 1,
        currentWorkspaceArchivedCount: 0,
      }, {
        id: "section-project",
        name: "项目",
        builtIn: null,
        currentWorkspaceActiveCount: 2,
        currentWorkspaceArchivedCount: 1,
      }],
      selectors: ["1", "2"],
      page: 1,
      pageCount: 1,
      totalSectionCount: 2,
      canManageCustomSections: false,
    };

    const rendered = formatConversationThreadSections(list);
    expect(rendered).toContain("固定：/pin · 取消固定：/unpin");
    expect(rendered).toContain("自定义分区：当前用户仅可查看和筛选");
    expect(rendered).not.toContain("/section move");
    expect(rendered).not.toContain("/section create");
    expect(rendered).not.toContain("/section delete");
  });

  it("leaves new extension task acknowledgement to the Turn lifecycle", () => {
    const results: ConversationCommandResult[] = [
      {
        kind: "outcome",
        outcome: {
          type: "skill.started",
          skillName: "review",
          turnId: "turn-1",
          steered: false,
        },
      },
      {
        kind: "outcome",
        outcome: {
          type: "plugin.started",
          pluginName: "GitHub",
          turnId: "turn-2",
          steered: false,
        },
      },
      {
        kind: "outcome",
        outcome: {
          type: "agents.started",
          roleName: "ds",
          turnId: "turn-3",
          steered: false,
        },
      },
    ];

    for (const result of results) {
      expect(renderFeishuCommandResult(result)).toBeNull();
      expect(renderWeixinCommandResult(result)).toBeNull();
    }
  });

  it("formats the complete shared status including weekly limits", () => {
    const status: ConversationStatus = {
      workspaceId: "main",
      workspaceName: "Main",
      cwd: "/workspace/main",
      threadId: "thread-1",
      model: "gpt-main",
      effort: "medium",
      serviceTier: null,
      modelPending: false,
      effortPending: false,
      fastModePending: false,
      collaborationMode: "default",
      collaborationModePending: false,
      weeklyLimit: {
        usedPercent: 12,
        windowDurationMins: 10_080,
        resetsAt: null,
      },
      tokenUsage: {
        total: {
          totalTokens: 1_000,
          inputTokens: 800,
          cachedInputTokens: 600,
          cacheWriteInputTokens: 0,
          outputTokens: 200,
          reasoningOutputTokens: 100,
        },
        last: {
          totalTokens: 100,
          inputTokens: 80,
          cachedInputTokens: 40,
          cacheWriteInputTokens: 0,
          outputTokens: 20,
          reasoningOutputTokens: 10,
        },
        modelContextWindow: 258_400,
      },
      gitBranch: "feature/shared-copy",
    };

    const rendered = formatConversationStatus(status);
    expect(rendered).toContain("Session ID：thread-1");
    expect(rendered).toContain(
      "周限：剩余 88% · 周期 7 天",
    );
    expect(rendered).not.toContain("缓存写入");
    expect(rendered).toContain("其中推理输出：100");
  });

  it("keeps platform-neutral command results identical in Feishu and Weixin", () => {
    const results: ConversationCommandResult[] = [
      {
        kind: "workspaces",
        workspaces: [{
          id: "main",
          name: "Main",
          cwd: "/workspace/main",
        }],
        currentWorkspaceId: "main",
      },
      {
        kind: "skills",
        entries: [{ name: "tdd", description: "测试驱动开发" }],
      },
      {
        kind: "mcp",
        servers: [{ name: "docs", pluginId: null, authStatus: "oAuth", toolCount: 2 }],
      },
      {
        kind: "mcp-health",
        report: {
          serverCount: 1,
          toolCount: 2,
          resourceCount: 0,
          resourceTemplateCount: 0,
          actions: [],
          notices: [],
        },
      },
      { kind: "mcp-reload" },
      {
        kind: "mcp-detail",
        selector: "docs",
        server: {
          name: "docs",
          pluginId: null,
          authStatus: "oAuth",
          toolCount: 1,
          serverTitle: "Docs",
          serverVersion: "1.0.0",
          serverDescription: null,
          tools: [{ name: "search", title: "Search", description: null, access: "readOnly" }],
          resources: [],
          resourceTemplates: [],
        },
      },
      {
        kind: "mcp-login",
        login: {
          type: "oauth",
          server: "docs",
          authorizationUrl: "https://example.test/oauth",
        },
      },
      {
        kind: "mcp-login",
        login: {
          type: "bearerToken",
          server: "token-tools",
        },
      },
      {
        kind: "mcp-resource",
        resource: {
          server: "docs",
          requestedUri: "docs://index",
          contents: [{
            kind: "text",
            uri: "docs://index",
            mimeType: "text/plain",
            text: "documentation",
            truncated: false,
          }],
          omittedContentCount: 0,
        },
      },
      {
        kind: "plugins",
        plugins: [{
          id: "github@local",
          name: "github",
          displayName: "GitHub",
          marketplaceName: "local",
          description: "GitHub tools",
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
      },
      {
        kind: "plugin-health",
        report: {
          installedCount: 1,
          enabledCount: 1,
          callableCount: 1,
          marketplaceLoadErrorCount: 0,
          issues: [],
        },
      },
      {
        kind: "plugin-detail",
        plugin: {
          id: "github@local",
          name: "github",
          displayName: "GitHub",
          marketplaceName: "local",
          description: "GitHub tools",
          enabled: true,
          available: true,
          version: "0.1.8",
          localVersion: "0.1.8",
          source: "local",
          installedAt: null,
          developerName: "OpenAI",
          category: "Developer tools",
          capabilities: ["Repository inspection"],
          authPolicy: "onUse",
          eligiblePlanTypes: [],
          disabledReason: null,
        },
      },
      {
        kind: "permissions",
        profiles: [{
          id: "workspace-write",
          allowed: true,
          description: "允许工作区写入",
        }],
      },
      {
        kind: "project-rules",
        action: "initialized",
        projectRoot: "/workspace/main",
        rulesPath: "/workspace/main/.codex/rules/default.rules",
      },
      {
        kind: "collaboration-mode",
        state: {
          mode: "plan",
          pending: true,
        },
      },
      {
        kind: "goal",
        goal: {
          threadId: "thread-1",
          objective: "完成多渠道统一",
          status: "active",
          tokenBudget: 10_000,
          tokensUsed: 100,
          timeUsedSeconds: 5,
          createdAt: 1,
          updatedAt: 2,
        },
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
      {
        kind: "usage",
        result: {
          kind: "token-usage",
          provider: "openai",
          usage: {
            summary: {
              lifetimeTokens: 1_000_000,
              peakDailyTokens: 100_000,
              longestRunningTurnSec: 60,
              currentStreakDays: 2,
              longestStreakDays: 3,
            },
            daily: [{ startDate: "2026-07-28", tokens: 100_000 }],
          },
        },
      },
      {
        kind: "limits",
        result: {
          kind: "rate-limits",
          provider: "openai",
          limits: {
            limits: [{
              limitId: "codex",
              limitName: "周限",
              primary: {
                usedPercent: 12,
                windowDurationMins: 10_080,
                resetsAt: null,
              },
              secondary: null,
              credits: null,
              individualLimit: null,
              spendControlReached: false,
              planType: "plus",
              rateLimitReachedType: null,
            }],
            resetCreditsAvailable: null,
          },
        },
      },
    ];

    for (const result of results) {
      expect(renderFeishuCommandResult(result)).toBe(
        renderWeixinCommandResult(result),
      );
    }
  });

  it("keeps Telegram and Feishu configuration lifecycle wording aligned", () => {
    const telegram = formatConfigurationChange({
      action: "restarting",
      changes: [{ code: "codex.default-model", scope: "global" }],
      addedWorkspaces: [],
    });
    const feishu = renderFeishuConfigurationChange({
      action: "restarting",
      changes: [{ code: "surface.feishu.credentials", scope: "feishu" }],
      addedWorkspaces: [],
    });

    for (const text of [
      "Gateway 配置需要重启",
      "当前 Gateway 将退出；若由系统服务托管，将自动重新启动。",
    ]) {
      expect(telegram).toContain(text);
      expect(feishu).toContain(text);
    }
    expect(feishu).toContain("变更：飞书应用凭据");
  });

  it("keeps runtime account, quota, and MCP semantics platform-neutral", () => {
    const target = {
      surface: "feishu",
      accountId: "cli_app",
      conversationId: "oc_chat",
    } as const;
    const account = {
      type: "account.updated",
      target,
      authMode: "chatgpt",
      planType: "pro",
    } as const;
    const rateLimits = {
      type: "account.rateLimits.updated",
      target,
      rateLimits: {
        limitId: "codex",
        limitName: "周限",
        primary: {
          usedPercent: 12,
          windowDurationMins: 10_080,
          resetsAt: null,
        },
        secondary: null,
        credits: null,
        individualLimit: null,
        spendControlReached: false,
        planType: "pro",
        rateLimitReachedType: null,
      },
    } as const;
    const mcp = {
      type: "mcp.status.updated",
      target,
      threadId: "thread-1",
      name: "docs",
      status: "failed",
      error: "TOKEN=[REDACTED]",
      failureReason: null,
    } as const;

    expect(renderFeishuOutput(account)).toBe(
      formatRuntimeAccountUpdate(account.authMode, account.planType),
    );
    expect(renderFeishuOutput(rateLimits)).toBe(
      formatRuntimeRateLimitUpdate(rateLimits.rateLimits),
    );
    expect(renderFeishuOutput(mcp)).toBe(
      formatRuntimeMcpStatusUpdate(mcp),
    );
  });
});
