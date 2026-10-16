import {
  type ConversationCommandResult,
  type ConversationStatus,
} from "../application/index.js";
import {
  usesOpenAiAccount,
  type ThreadGoal,
  type ThreadApprovalsReviewer,
} from "../conversation-core/index.js";

import { formatRemainingRateLimitWindow, formatTimezoneLine } from "./account-format.js";
import { formatCodexProviderLabel, formatModelDisplayName, formatServiceTier } from "./provider-format.js";
import { formatCacheHitRate, formatTokenCount } from "./token-format.js";
import { toStructuredMarkdownList } from "./markdown-list.js";
import { formatReasoningEffort, reasoningEffortSettingName } from "./reasoning-effort-format.js";

export function formatConversationWorkspaces(
  result: Extract<ConversationCommandResult, { kind: "workspaces" }>,
): string {
  return toStructuredMarkdownList([
    `Workspace（${result.workspaces.length}）：`,
    ...result.workspaces.flatMap((workspace, index) => [
      `${index + 1}. ${workspace.name} · ${workspace.id}${workspace.id === result.currentWorkspaceId ? " ← 当前" : ""}`,
      `工作目录：${workspace.cwd}`,
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
): string {
  const label = result.state.mode === "plan" ? "Plan" : "Default";
  return toStructuredMarkdownList([
    `协作模式：${label}${result.state.pending ? "（下一次 Turn 生效）" : ""}`,
    "",
    result.state.mode === "plan"
      ? "下一条普通消息将按 Plan 模式处理；再次发送 /plan 可切回 Default。"
      : "下一条普通消息将按 Default 模式处理；发送 /plan 可切换到 Plan。",
    "也可发送 /plan <规划需求>，直接进入 Plan 并开始规划。",
  ].join("\n"));
}

export function formatConversationGoal(
  result: Extract<ConversationCommandResult, { kind: "goal" }>,
): string {
  return result.goal
    ? toStructuredMarkdownList([
        `当前 Goal：${result.goal.objective}`,
        `状态：${formatGoalStatus(result.goal.status)}`,
        `Tokens：${formatGoalTokens(result.goal)}`,
      ].join("\n"))
    : "当前 Session 没有 Goal。使用 /goal set <目标> 设置。";
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

export function formatConversationStatus(status: ConversationStatus): string {
  const lines = [
    "Codex 状态",
    formatTimezoneLine(),
    `Workspace：${status.workspaceName} (${status.workspaceId})`,
    `Session：${status.threadId ? status.threadName ?? "未命名" : "尚未绑定"}`,
    `Session ID：${status.threadId ?? "尚未绑定"}`,
    `Turn：${status.turnId ?? "空闲"}`,
    `工作目录：${status.cwd}`,
    `Git 分支：${status.gitBranch ?? "未检测到"}`,
    `模型：${formatModelDisplayName(status.model)}${status.modelPending ? "（下一次 Turn 生效）" : ""}`,
    `提供商：${formatCodexProviderLabel(status.modelProvider)}`,
    `${reasoningEffortSettingName(status.effort)}：${formatReasoningEffort(status.effort)}${status.effortPending ? "（下一次 Turn 生效）" : ""}`,
    `速度：${status.threadId || status.fastModePending ? formatServiceTier(status.serviceTier) : "未知"}${status.fastModePending ? "（下一次 Turn 生效）" : ""}`,
    `协作模式：${status.collaborationMode === "plan" ? "Plan" : "Default"}${status.collaborationModePending ? "（下一次 Turn 生效）" : ""}`,
    ...(isAutoApprovalReviewer(status.approvalsReviewer)
      ? [`审批方式：${formatThreadApprovalsReviewer(status.approvalsReviewer)}`]
      : []),
  ];
  if (status.contextCompactionCount !== undefined) {
    lines.push(`上下文压缩：${status.contextCompactionCount} 次`);
  }
  if (status.goal) {
    lines.push(
      `Goal 状态：${formatGoalStatus(status.goal.status)}`,
      `Goal 目标：${status.goal.objective}`,
      `Goal 用量：${formatGoalUsage(status.goal)}`,
    );
  }
  if (status.tokenUsage) {
    const { total, last, modelContextWindow } = status.tokenUsage;
    lines.push(
      "",
      "当前 Session 用量：",
      `- **Token**：${formatTokenCount(total.totalTokens)}`,
      `  - 最近模型请求：${formatTokenCount(last.totalTokens)}`,
      `  - 缓存：${formatTokenCount(total.cachedInputTokens)}`,
      `  - 无缓存：${formatTokenCount(Math.max(0, total.inputTokens - total.cachedInputTokens))}`,
      `  - 缓存命中率：${formatCacheHitRate(total.inputTokens, total.cachedInputTokens)}`,
      ...(total.cacheWriteInputTokens > 0
        ? [`  - 缓存写入：${formatTokenCount(total.cacheWriteInputTokens)}`]
        : []),
      `  - 输出：${formatTokenCount(total.outputTokens)}`,
      ...(total.reasoningOutputTokens > 0
        ? [`  - 其中推理输出：${formatTokenCount(total.reasoningOutputTokens)}`]
        : []),
      `  - Codex 有效上下文窗口：${modelContextWindow === null ? "未知" : formatTokenCount(modelContextWindow)}`,
    );
  } else if (status.threadId) {
    lines.push("", "当前 Session 用量：等待 App Server 推送统计");
  }
  if (usesOpenAiAccount(status.modelProvider) && status.weeklyLimit) {
    lines.push(`周限：${formatRemainingRateLimitWindow(status.weeklyLimit)}`);
  }
  return toStructuredMarkdownList(lines.join("\n"));
}

export { formatConversationMetrics } from "./metrics-format.js";

function formatGoalStatus(status: ThreadGoal["status"]): string {
  switch (status) {
    case "active":
      return "进行中";
    case "paused":
      return "已暂停";
    case "blocked":
      return "已阻塞";
    case "usageLimited":
      return "用量受限";
    case "budgetLimited":
      return "预算已用尽";
    case "complete":
      return "已完成";
  }
}

function formatGoalUsage(goal: ThreadGoal): string {
  const tokens = goal.tokenBudget === null
    ? formatTokenCount(goal.tokensUsed)
    : `${formatTokenCount(goal.tokensUsed)} / ${formatTokenCount(goal.tokenBudget)}`;
  return `${tokens} · ${formatDuration(goal.timeUsedSeconds)}`;
}

function formatGoalTokens(goal: ThreadGoal): string {
  return goal.tokenBudget === null
    ? formatTokenCount(goal.tokensUsed)
    : `${formatTokenCount(goal.tokensUsed)} / ${formatTokenCount(goal.tokenBudget)}`;
}

function formatDuration(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(wholeSeconds / 3_600);
  const minutes = Math.floor(wholeSeconds % 3_600 / 60);
  const remainder = wholeSeconds % 60;
  return [
    ...(hours > 0 ? [`${hours}小时`] : []),
    ...(minutes > 0 ? [`${minutes}分`] : []),
    ...(remainder > 0 || (hours === 0 && minutes === 0)
      ? [`${remainder}秒`]
      : []),
  ].join("");
}
