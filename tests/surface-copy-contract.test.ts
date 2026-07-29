import { describe, expect, it } from "vitest";

import type {
  ConversationCommandResult,
  ConversationStatus,
} from "../src/application/index.js";
import {
  conversationCommandHelpLines,
  formatConversationStatus,
} from "../src/surfaces/conversation-command-format.js";
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
import { formatConfigurationChange } from "../src/surfaces/telegram/format.js";
import {
  renderFeishuConfigurationChange,
  renderFeishuCommandResult,
  renderFeishuHelp,
  renderFeishuOutput,
} from "../src/surfaces/feishu/renderer.js";
import {
  formatRuntimeAccountUpdate,
  formatRuntimeMcpStatusUpdate,
  formatRuntimeRateLimitUpdate,
} from "../src/surfaces/runtime-status-format.js";
import {
  renderWeixinCommandResult,
  renderWeixinHelp,
} from "../src/surfaces/weixin/command-renderer.js";

describe("shared surface copy contract", () => {
  it("keeps interaction outcomes platform-neutral", () => {
    expect(interactionProcessedTitle).toBe("Codex 交互已处理");
    expect(interactionCancelledTitle).toBe("Codex 交互已取消");
    expect(formatProcessedInteractionOutcome(interactionOutcome.answered))
      .toBe("Codex 交互已处理：已提交回答。");
    expect(formatProcessedInteractionOutcome(interactionOutcome.formSubmitted))
      .toBe("Codex 交互已处理：已提交表单。");
    expect(formatProcessedInteractionOutcome(interactionOutcome.resolvedElsewhere))
      .toBe("Codex 交互已处理：已在其他客户端处理。");
    expect(formatCancelledInteraction()).toBe("Codex 交互已取消。");
    expect(formatCancelledInteraction("Gateway 已停止"))
      .toBe("Codex 交互已取消：Gateway 已停止。");
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
      expect(renderFeishuHelp()).toContain(line);
      expect(renderWeixinHelp()).toContain(line);
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
      gitBranch: "feature/shared-copy",
    };

    expect(formatConversationStatus(status)).toContain(
      "周限：已使用 12% · 周期 7 天",
    );
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
        servers: [{ name: "docs", authStatus: "oAuth", toolCount: 2 }],
      },
      {
        kind: "plugins",
        result: [{ name: "github", enabled: true }],
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
      {
        kind: "limits",
        result: {
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
