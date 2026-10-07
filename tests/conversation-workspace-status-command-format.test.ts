import { describe, expect, it } from "vitest";

import {
  formatConversationCommandOutcome,
  formatConversationStatus,
  formatConversationWorkspacePermissions,
  formatConversationAutoReview,
  formatConversationWorkspaces,
} from "../src/surfaces/conversation-command-format.js";
import { setConfiguredCustomPrimaryProviderId } from "../src/surfaces/provider-format.js";

describe("conversation workspace and status command formatting", () => {
  it("reports current Thread scope and confirmed updates without changing Workspace defaults", () => {
    const rendered = formatConversationAutoReview({ kind: "auto-review", state: { threadId: "current-thread", reviewer: "auto_review", updated: true } });
    expect(rendered).toContain("已切换当前会话审批方式");
    expect(rendered).toContain("Session ID：current-thread");
    expect(rendered).toContain("当前会话后续轮次");
    expect(rendered).toContain("/autoreview off");
    expect(rendered).not.toContain("已更新工作区");
  });
  it.each([null, "guardian_subagent"] as const)("keeps unknown or unsupported reviewer %s read-only", reviewer => {
    const rendered = formatConversationAutoReview({ kind: "auto-review", state: { threadId: "thread", reviewer, updated: false } });
    expect(rendered).toContain("只读");
    expect(rendered).not.toContain("已切换");
    expect(rendered).not.toContain("/autoreview on");
  });
  it("explains unbound current Thread queries", () => {
    expect(formatConversationAutoReview({ kind: "auto-review", state: { threadId: null, reviewer: null, updated: false } })).toContain("当前未绑定");
  });
  it.each([
    ["user", "手动审批"], ["auto_review", "自动审批"], [undefined, "跟随 Codex 默认"],
  ] as const)("shows Workspace reviewer %s separately from Thread status", (approvalsReviewer, label) => {
    const rendered = formatConversationWorkspacePermissions({ kind: "workspace-permissions", workspace: { id: "main", name: "Main", cwd: "/workspace", ...(approvalsReviewer ? { approvalsReviewer } : {}) } });
    expect(rendered).toContain(`工作区默认审批方式：${label}`);
    expect(rendered).toContain("/workspaceperm autoreview <on|off|clear>");
    expect(rendered).toContain("已加载会话保持原值");
    expect(rendered).toContain("/autoreview 修改当前会话");
    expect(rendered).not.toContain("clear 删除");
    expect(rendered).not.toContain("对新建或恢复的 Session 生效");
  });
  it.each([
    ["user", undefined], ["auto_review", "自动审批"],
    ["guardian_subagent", "自动审批"], [null, undefined], [undefined, undefined],
  ] as const)("shows reviewer %s in status only when automatic approval is enabled", (approvalsReviewer, label) => {
    const rendered = formatConversationStatus({
      threadId: "thread", workspaceId: "main", workspaceName: "Main", cwd: "/workspace",
      model: "test-model", effort: null, serviceTier: null, ...(approvalsReviewer === undefined ? {} : { approvalsReviewer }),
      modelPending: false, effortPending: false, fastModePending: false,
      collaborationMode: "default", collaborationModePending: false,
    });
    if (label === undefined) expect(rendered).not.toContain("审批方式：");
    else expect(rendered).toContain(`审批方式：${label}`);
  });
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
      update: { kind: "approval", value: "never" },
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
    expect(rendered).not.toContain("已移除工作区覆盖");
  });

  it.each(["auto_review", "user", null] as const)("renders reviewer update %s from the submitted operation", value => {
    const rendered = formatConversationCommandOutcome({
      type: "workspace.permissions-updated",
      update: { kind: "approvals-reviewer", value },
      workspace: { id: "main", name: "Main", cwd: "/workspace" },
    });
    expect(rendered).toContain("已加载会话保持原值，用 /autoreview 修改当前会话");
    if (value === null) {
      expect(rendered).toContain("已清除工作区默认审批方式覆盖");
      expect(rendered).toContain("已移除工作区覆盖");
      expect(rendered).toContain("恢复历史会话可能保留其已保存设置");
    } else {
      expect(rendered).toContain("已修改工作区默认审批方式");
      expect(rendered).not.toContain("已移除工作区覆盖");
      expect(rendered).not.toContain("恢复历史会话");
    }
    expect(rendered).not.toContain("权限已热加载");
  });

  it.each([
    { kind: "sandbox", value: "read-only" },
    { kind: "approval", value: "on-request" },
    { kind: "permissions", value: null },
  ] as const)("keeps unrelated $kind updates concise even with a reviewer override", update => {
    const rendered = formatConversationCommandOutcome({
      type: "workspace.permissions-updated", update,
      workspace: { id: "main", name: "Main", cwd: "/workspace", approvalsReviewer: "auto_review" },
    });
    expect(rendered).toContain("已更新工作区权限");
    expect(rendered).toContain("权限已热加载");
    expect(rendered).not.toContain("/autoreview");
    expect(rendered).not.toContain("已移除工作区覆盖");
    expect(rendered).not.toContain("卸载后恢复");
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
    expect(rendered).toContain(`时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
    expect(rendered).not.toContain("网关时区");
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
