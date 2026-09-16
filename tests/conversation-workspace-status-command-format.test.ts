import { describe, expect, it } from "vitest";

import {
  formatConversationCommandOutcome,
  formatConversationStatus,
  formatConversationWorkspacePermissions,
  formatConversationWorkspaces,
} from "../src/surfaces/conversation-command-format.js";
import { setConfiguredCustomPrimaryProviderId } from "../src/surfaces/provider-format.js";

describe("conversation workspace and status command formatting", () => {
  it("shows configured workspace permissions in the workspace list", () => {
    const rendered = formatConversationWorkspaces({
      kind: "workspaces",
      workspaces: [
        {
          id: "main",
          name: "Main",
          cwd: "/workspace",
          sandbox: "danger-full-access",
          approvalPolicy: "never",
        },
        {
          id: "docs",
          name: "Docs",
          cwd: "/docs",
          permissions: ":read-only",
        },
      ],
      currentWorkspaceId: "main",
    });

    expect(rendered).toContain("1. Main · main ← 当前");
    expect(rendered).toContain("- 沙箱：完全访问");
    expect(rendered).toContain("- 审批：免审批");
    expect(rendered).toContain("- 权限 Profile：:read-only");
  });

  it("shows workspace permission usage and current values", () => {
    const rendered = formatConversationWorkspacePermissions({
      kind: "workspace-permissions",
      workspace: {
        id: "main",
        name: "Main",
        cwd: "/workspace",
        sandbox: "read-only",
      },
    });

    expect(rendered).toContain("工作区权限（Main · main）");
    expect(rendered).toContain("- 沙箱：只读");
    expect(rendered).toContain("/workspaceperm approval");
    expect(rendered).toContain("/workspaceperm profile");
  });

  it("renders updated workspace permissions with the hot reload notice", () => {
    const rendered = formatConversationCommandOutcome({
      type: "workspace.permissions-updated",
      workspace: {
        id: "main",
        name: "Main",
        cwd: "/workspace",
        approvalPolicy: "never",
      },
    });

    expect(rendered).toContain("已更新工作区权限");
    expect(rendered).toContain("- 审批：免审批");
    expect(rendered).toContain("对新建或恢复的 Session 生效");
  });

  it("keeps Thread metrics and hides OpenAI-only state for DeepSeek", () => {
    const rendered = formatConversationStatus({
      threadId: "thread-deepseek",
      workspaceId: "main",
      workspaceName: "Main",
      cwd: "/workspace",
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
      effort: "high",
      serviceTier: null,
      modelPending: false,
      effortPending: false,
      fastModePending: false,
      collaborationMode: "default",
      collaborationModePending: false,
      tokenUsage: {
        total: breakdown(30_000),
        last: breakdown(20_000),
        modelContextWindow: 1_048_576,
      },
      weeklyLimit: {
        usedPercent: 90,
        windowDurationMins: 10_080,
        resetsAt: null,
      },
    });

    expect(rendered).toContain("提供商：DeepSeek");
    expect(rendered).toContain("Codex 有效上下文窗口：1.05 M");
    expect(rendered).not.toContain("Fast 模式");
    expect(rendered).not.toContain("周限");
  });

  it("marks the configured custom primary Provider in status", () => {
    setConfiguredCustomPrimaryProviderId("OpenAI");
    try {
      const rendered = formatConversationStatus({
        threadId: "thread-custom",
        workspaceId: "main",
        workspaceName: "Main",
        cwd: "/workspace",
        model: "gpt-test",
        modelProvider: "OpenAI",
        effort: "medium",
        serviceTier: "priority",
        modelPending: false,
        effortPending: false,
        fastModePending: false,
        collaborationMode: "default",
        collaborationModePending: false,
      });

      expect(rendered).toContain("提供商：OpenAI · 自定义");
      expect(rendered).not.toContain("提供商：OpenAI 官方");
      expect(rendered).toContain("Fast 模式：开启");
    } finally {
      setConfiguredCustomPrimaryProviderId(undefined);
    }
  });

});

function breakdown(totalTokens: number) {
  return {
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens,
  };
}
