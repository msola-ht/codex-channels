import {
  type ConversationCommandResult,
  type ConversationStatus,
  type ConversationStatusDisplay,
} from "../application/index.js";
import {
  type ThreadApprovalsReviewer,
  usesOpenAiAccount,
} from "../conversation-core/index.js";

import { formatPercent } from "./account-format.js";
import { formatCodexProviderLabel, formatServiceTierSetting } from "./provider-format.js";
import { formatTokenCount } from "./token-format.js";
import { toStructuredMarkdownList } from "./markdown-list.js";
import { formatReasoningEffort, reasoningEffortSettingName } from "./reasoning-effort-format.js";
import { createWorkspaceSelectionPresentation } from "./workspace-selection-presentation.js";

export function formatConversationWorkspaces(
  result: Extract<ConversationCommandResult, { kind: "workspaces" }>,
  formatLiteral: (value: string) => string = value => value,
): string {
  const view = createWorkspaceSelectionPresentation(result);
  const literal = (value: string): string => formatLiteral(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " "));
  return toStructuredMarkdownList([
    `Workspace（${view.entries.length}）：`,
    ...(!view.currentWorkspace
      ? [`原选择已失效：${literal(view.currentWorkspaceId)}。请选择下列工作区后重新发起操作。`]
      : []),
    ...view.entries.flatMap((workspace) => [
      `${workspace.position}. ${literal(workspace.name)}${workspace.isCurrent ? " · 当前" : ""}`,
      "",
      `- ID：${literal(workspace.id)}`,
      `- 工作目录：${literal(workspace.cwd)}`,
      "",
    ]),
    "",
    "切换：/workspace <序号、ID 或名称>",
  ].join("\n"));
}

export function formatConversationAutoReview(
  result: Extract<ConversationCommandResult, { kind: "auto-review" }>,
  formatCommand: (command: string) => string = (command) => command,
): string {
  const { threadId, reviewer, updated } = result.state;
  if (threadId === null) {
    return "当前未绑定 Codex 会话。发送普通消息创建会话，或用 /resume 恢复会话后，再使用 /autoreview。";
  }
  return toStructuredMarkdownList([
    updated ? "已切换当前会话审批方式" : "当前会话审批方式",
    `Session ID：${threadId}`,
    `审批方式：${formatThreadApprovalsReviewer(reviewer)}`,
    ...(reviewer === "user" || reviewer === "auto_review"
      ? [
        `切换：${formatCommand("/autoreview on")}（自动审批）或 ${formatCommand("/autoreview off")}（手动审批）`,
        "设置用于当前会话后续轮次；切换时须无运行任务或待处理交互。",
      ]
      : ["当前审批方式只读，暂不支持切换。"]),
  ].join("\n"));
}

export function formatConversationPermissions(
  result: Extract<ConversationCommandResult, { kind: "permissions" }>,
): string {
  return toStructuredMarkdownList([
    "权限查询说明",
    "- 权限由 Codex App Server 管理；本次仅查询可用的 Permission Profiles。",
    ...(result.workspace
      ? [
          `当前 Workspace：${result.workspace.name}（${result.workspace.id}）`,
        ]
      : [
          "当前 Workspace：未能从当前会话读取。",
        ]),
    "可选择的 Permission Profiles（可选择不代表当前正在使用）：",
    ...result.profiles.map(
      (profile) =>
        `- ${profile.id} · ${profile.allowed ? "可选择" : "不可选择（受策略禁止）"}${profile.description ? ` · ${profile.description}` : ""}`,
    ),
  ].join("\n"));
}

export function formatConversationArtifacts(
  result: Extract<ConversationCommandResult, { kind: "artifacts" }>,
): string {
  return result.artifacts?.diff?.trim()
    ? [
        `Turn Diff · ${result.artifacts.turnId}`,
        "",
        result.artifacts.diff,
      ].join("\n")
    : "当前 Session 暂无 Turn Diff。";
}

export function formatConversationCollaborationMode(
  result: Extract<ConversationCommandResult, { kind: "collaboration-mode" }>,
  structured = true,
): string {
  const label = result.state.mode === "plan" ? "Plan" : "Default";
  const text = [
    "协作模式",
    `协作模式：${label}${result.state.pending ? "（下一次 Turn 生效）" : ""}`,
    "",
    result.state.mode === "plan"
      ? "下一条普通消息将按 Plan 模式处理；再次发送 /plan 可切回 Default。"
      : "下一条普通消息将按 Default 模式处理；发送 /plan 可切换到 Plan。",
    "也可发送 /plan <规划需求>，直接进入 Plan 并开始规划。",
  ].join("\n");
  return structured ? toStructuredMarkdownList(text) : text;
}

export function isAutoApprovalReviewer(reviewer: ThreadApprovalsReviewer | null | undefined): boolean {
  return reviewer === "auto_review" || reviewer === "guardian_subagent";
}

export function formatThreadApprovalsReviewer(reviewer: ThreadApprovalsReviewer | null | undefined): string {
  switch (reviewer) {
    case "user": return "手动审批";
    case "auto_review":
    case "guardian_subagent": return "自动审批";
    default: return "未知";
  }
}

export function formatConversationStatus(
  status: ConversationStatus,
  formatLiteral: (value: string) => string = value => value,
  options: { display?: ConversationStatusDisplay } = {},
): string {
  // Values are metadata, never Markdown structure. Channel escaping happens once here.
  const literal = (value: string): string => formatLiteral(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " "));
  const field = (label: string, value: string): string => `- ${literal(label)}：${literal(value)}`;
  const taskState = !status.threadId ? "尚未绑定" : status.sessionRestoring ? "尚未恢复" : status.turnId ? "运行中" : "空闲";
  const setting = (value: string): string => status.sessionRestoring ? "尚未恢复" : value;
  const lines = [
    "## Codex 状态",
    "",
    field("工作区", status.workspaceName === status.workspaceId ? status.workspaceName : `${status.workspaceName} (${status.workspaceId})`),
    field("工作目录", status.cwd),
    ...(status.gitBranch ? [field("Git 分支", status.gitBranch)] : []),
    field("会话", status.threadId ? `${status.threadName ?? "未命名"} · ${taskState}` : taskState),
    ...(status.threadId ? [field("Session ID", status.threadId)] : []),
    field("模型", setting(`${status.model}${status.modelPending ? "（下一次 Turn 生效）" : ""} · ${status.modelProvider === undefined ? "提供商待选择" : formatCodexProviderLabel(status.modelProvider)}`)),
    field(reasoningEffortSettingName(status.effort), setting(`${formatReasoningEffort(status.effort)}${status.effortPending ? "（下一次 Turn 生效）" : ""}`)),
    field("速度", setting(status.threadId || status.fastModePending ? formatServiceTierSetting(status) : "未知")),
    field("协作模式", setting(`${status.collaborationMode === "plan" ? "Plan" : "Default"}${status.collaborationModePending ? "（下一次 Turn 生效）" : ""}`)),
    field("审批方式", setting(status.threadId ? formatThreadApprovalsReviewer(status.approvalsReviewer) : "尚未绑定会话")),
  ];
  if (options.display) {
    const presets = { concise: "静默", standard: "紧凑", detailed: "详细", full: "完整", custom: "自定义" };
    lines.push(field("消息模式", presets[options.display.preset]));
  }
  if (status.tokenUsage) {
    const { total, last, modelContextWindow } = status.tokenUsage;
    lines.push(
      `- 上下文：${formatTokenCount(last.totalTokens)}${modelContextWindow !== null && modelContextWindow > 0 ? ` / ${formatTokenCount(modelContextWindow)}（${formatPercent(Math.max(0, last.totalTokens / modelContextWindow * 100))}）` : "（窗口上限未知）"}`,
      `- 累计 Token：${formatTokenCount(total.totalTokens)}`,
    );
  } else {
    lines.push(field("上下文", status.threadId ? "等待 App Server 推送统计" : "尚未绑定会话，暂无用量"));
  }
  if (status.threadId) {
    if (!status.executionContext) lines.push(field("执行目录", "尚未由 App Server 确认"));
    else if (status.executionContext.cwd !== status.cwd) lines.push(field("执行目录与工作区不同", status.executionContext.cwd));
  }
  const account = status.accountStatus?.provider === status.modelProvider ? status.accountStatus : undefined;
  const quota = (usedPercent: number): string => `剩余 ${formatPercent(Math.min(100, Math.max(0, 100 - usedPercent)))}`;
  if (usesOpenAiAccount(status.modelProvider) && status.weeklyLimit && Number.isFinite(status.weeklyLimit.usedPercent)) {
    lines.push(field("账户周限", quota(status.weeklyLimit.usedPercent)));
  }
  if (!usesOpenAiAccount(status.modelProvider) && account) {
    for (const balance of account.balances) lines.push(field("账户余额", `${balance.currency === "CNY" ? "¥" : "$"}${balance.remaining}`));
    if (account.credits !== undefined) lines.push(field("账户剩余额度", `$${account.credits}`));
    for (const window of account.windows) {
      if (Number.isFinite(window.usedPercent)) lines.push(field(window.label, quota(window.usedPercent)));
    }
  }
  if (status.accountStatusUnavailable) lines.push(field("额度提示", "本次未能取得账户额度，请用 /usage 或 /limits 重查"));
  return lines.join("\n").trimEnd();
}

export { formatConversationMetrics } from "./metrics-format.js";
