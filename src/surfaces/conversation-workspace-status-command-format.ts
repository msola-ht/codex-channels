import {
  isFastServiceTier,
  type ConversationCommandResult,
  type ConversationStatus,
} from "../application/index.js";
import {
  usesOpenAiAccount,
  type ThreadGoal,
} from "../conversation-core/index.js";

import { formatRemainingRateLimitWindow } from "./account-format.js";
import { formatCodexProviderLabel, supportsFastMode } from "./provider-format.js";
import { formatCacheHitRate, formatTokenCount } from "./token-format.js";
import { toStructuredMarkdownList } from "./markdown-list.js";

export function formatConversationWorkspaces(
  result: Extract<ConversationCommandResult, { kind: "workspaces" }>,
): string {
  return toStructuredMarkdownList([
    `Workspace（${result.workspaces.length}）：`,
    ...result.workspaces.flatMap((workspace, index) => [
      `${index + 1}. ${workspace.name} · ${workspace.id}${workspace.id === result.currentWorkspaceId ? " ← 当前" : ""}`,
      workspace.cwd,
      ...workspacePermissionLines(workspace),
    ]),
    "",
    "切换：/workspace <序号、ID 或名称>",
  ].join("\n"));
}

export function formatConversationWorkspacePermissions(
  result: Extract<
    ConversationCommandResult,
    { kind: "workspace-permissions" }
  >,
): string {
  const permissionLines = workspacePermissionLines(result.workspace);
  return toStructuredMarkdownList([
    `工作区权限（${result.workspace.name} · ${result.workspace.id}）：`,
    ...(permissionLines.length > 0
      ? permissionLines
      : ["未配置（使用全局默认）"]),
    "",
    "修改：",
    "- /workspaceperm sandbox <read-only|workspace-write|danger-full-access|clear>",
    "- /workspaceperm approval <untrusted|on-request|never|clear>",
    "- /workspaceperm profile <Profile ID|clear>",
    "权限热加载后对新建或恢复的 Session 生效，不改变已绑定 Session。",
  ].join("\n"));
}

export function workspacePermissionLines(
  workspace: Extract<ConversationCommandResult, { kind: "workspaces" }>["workspaces"][number],
): string[] {
  const lines: string[] = [];
  if (workspace.sandbox !== undefined) {
    lines.push(`  - 沙箱：${workspaceSandboxLabel(workspace.sandbox)}`);
  }
  if (workspace.approvalPolicy !== undefined) {
    lines.push(`  - 审批：${workspaceApprovalPolicyLabel(workspace.approvalPolicy)}`);
  }
  if (workspace.permissions !== undefined) {
    lines.push(`  - 权限 Profile：${workspace.permissions}`);
  }
  return lines;
}

function workspaceSandboxLabel(
  sandbox: "read-only" | "workspace-write" | "danger-full-access",
): string {
  return ({
    "read-only": "只读",
    "workspace-write": "工作区写",
    "danger-full-access": "完全访问",
  } as const)[sandbox];
}

function workspaceApprovalPolicyLabel(
  policy: "untrusted" | "on-request" | "never",
): string {
  return ({
    untrusted: "不信任",
    "on-request": "按需审批",
    never: "免审批",
  } as const)[policy];
}

export function formatConversationPermissions(
  result: Extract<ConversationCommandResult, { kind: "permissions" }>,
): string {
  return toStructuredMarkdownList([
    "权限查询说明",
    "- 本次为只读查询，不会修改当前 Workspace 权限；需要调整请使用 /workspaceperm。",
    ...(result.workspace
      ? [
          `当前 Workspace：${result.workspace.name}（${result.workspace.id}）`,
          `- 沙箱：${result.workspace.sandbox ?? "跟随 Gateway 默认"}`,
          `- 审批：${result.workspace.approvalPolicy ?? "跟随默认"}`,
          `- Profile：${result.workspace.permissions ?? "未配置"}`,
        ]
      : [
          "当前 Workspace 权限：未能从当前会话读取；Gateway 默认模式为配置中的 read-only 或 workspace-write。",
        ]),
    "- 沙盒网络：跟随 Codex 用户默认设置（当前 Workspace 无独立覆盖）。",
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

export function formatConversationStatus(status: ConversationStatus): string {
  const lines = [
    "Codex 状态",
    `Workspace：${status.workspaceName} (${status.workspaceId})`,
    `Session：${status.threadId ? status.threadName ?? "未命名" : "尚未绑定"}`,
    `Session ID：${status.threadId ?? "尚未绑定"}`,
    `Turn：${status.turnId ?? "空闲"}`,
    `工作目录：${status.cwd}`,
    `Git 分支：${status.gitBranch ?? "未检测到"}`,
    `模型：${status.model}${status.modelPending ? "（下一次 Turn 生效）" : ""}`,
    `提供商：${formatCodexProviderLabel(status.modelProvider)}`,
    `思考等级：${status.effort ?? "模型默认"}${status.effortPending ? "（下一次 Turn 生效）" : ""}`,
    ...(supportsFastMode(status.modelProvider)
      ? [`Fast 模式：${status.threadId ? (isFastServiceTier(status.serviceTier) ? "开启" : "关闭") : "未知"}${status.fastModePending ? "（下一次 Turn 生效）" : ""}`]
      : []),
    `协作模式：${status.collaborationMode === "plan" ? "Plan" : "Default"}${status.collaborationModePending ? "（下一次 Turn 生效）" : ""}`,
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
      `  - 输入命中缓存：${formatTokenCount(total.cachedInputTokens)}`,
      `  - 输入未命中缓存：${formatTokenCount(Math.max(0, total.inputTokens - total.cachedInputTokens))}`,
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
