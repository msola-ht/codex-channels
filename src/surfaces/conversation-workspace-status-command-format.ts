import {
  type ConversationCommandResult,
  type ConversationStatus,
  type ConversationStatusDisplay,
} from "../application/index.js";
import {
  type ThreadGoal,
  type ThreadApprovalsReviewer,
} from "../conversation-core/index.js";

import { accountQuotaFields, formatPercent } from "./account-format.js";
import { formatCodexProviderLabel, formatServiceTierSetting } from "./provider-format.js";
import { formatCacheHitRate, formatTokenCount } from "./token-format.js";
import { toStructuredMarkdownList } from "./markdown-list.js";
import { formatReasoningEffort, reasoningEffortSettingName } from "./reasoning-effort-format.js";

export function formatConversationWorkspaces(
  result: Extract<ConversationCommandResult, { kind: "workspaces" }>,
): string {
  return toStructuredMarkdownList([
    `Workspace（${result.workspaces.length}）：`,
    ...(!result.workspaces.some(workspace => workspace.id === result.currentWorkspaceId)
      ? [`原选择已失效：${result.currentWorkspaceId}。请选择下列工作区后重新发起操作。`]
      : []),
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
    "## 协作模式",
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
        "## 当前目标",
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

export function formatConversationStatus(
  status: ConversationStatus,
  formatLiteral: (value: string) => string = value => value,
  options: { view?: "overview" | "detail"; display?: ConversationStatusDisplay } = {},
): string {
  const detailed = options.view === "detail";
  // Values are metadata, never Markdown structure. Channel escaping happens once here.
  const literal = (value: string): string => formatLiteral(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " "));
  const field = (label: string, value: string): string => `- ${label}：${literal(value)}`;
  const lines = [
    detailed ? "## Codex 状态详情" : "## Codex 状态",
    "",
    "### 当前会话",
    "",
    field("工作区", status.workspaceName === status.workspaceId ? status.workspaceName : `${status.workspaceName} (${status.workspaceId})`),
    field("会话", status.threadId ? status.threadName ?? "未命名" : "尚未绑定"),
    ...(detailed && status.threadId ? [field("Session ID", status.threadId)] : []),
    field("任务状态", !status.threadId ? "尚未绑定会话" : status.sessionRestoring ? "会话尚未恢复" : status.turnId ? "运行中" : "空闲"),
    ...(detailed && status.threadId && !status.sessionRestoring && status.turnId ? [field("Turn ID", status.turnId)] : []),
    "",
    "### 模型与执行设置",
    "",
    field("模型", status.sessionRestoring ? "尚未恢复" : `${status.model}${status.modelPending ? "（下一次 Turn 生效）" : ""}`),
    field("提供商", status.sessionRestoring ? "尚未恢复" : formatCodexProviderLabel(status.modelProvider)),
    field(reasoningEffortSettingName(status.effort), status.sessionRestoring ? "尚未恢复" : `${formatReasoningEffort(status.effort)}${status.effortPending ? "（下一次 Turn 生效）" : ""}`),
    field("速度", status.sessionRestoring ? "尚未恢复" : status.threadId || status.fastModePending ? formatServiceTierSetting(status) : "未知"),
    field("协作模式", status.sessionRestoring ? "尚未恢复" : `${status.collaborationMode === "plan" ? "Plan" : "Default"}${status.collaborationModePending ? "（下一次 Turn 生效）" : ""}`),
    field("审批方式", status.sessionRestoring ? "尚未恢复" : status.threadId ? formatThreadApprovalsReviewer(status.approvalsReviewer) : "尚未绑定会话"),
  ];
  if (options.display) {
    const presets = { concise: "静默", standard: "紧凑", detailed: "详细", full: "完整", custom: "自定义" };
    const sources: Record<string, string> = { global: "全局", surface: "渠道", account: "账号", "chat-kind": "聊天类型", chat: "当前聊天" };
    lines.push("", "### 消息展示", "", field("有效模式", presets[options.display.preset]),
      field("设置来源", [...new Set(options.display.sources)].map(source => sources[source] ?? "未知").join("、") || "未知"));
  }
  if (detailed) lines.push("", "### 执行目录", "", field("工作区目录", status.cwd), field("Git 分支", status.gitBranch ?? "未检测到"));
  if (!detailed && status.threadId) {
    if (!status.executionContext) lines.push("", "执行目录尚未由 App Server 确认，可查看状态详情。");
    else if (status.executionContext.cwd !== status.cwd) lines.push("", field("执行目录与工作区不同", status.executionContext.cwd));
  }
  if (detailed && status.threadId) {
    const context = status.executionContext;
    if (!context) {
      lines.push("", "尚未取得有效的 App Server 执行上下文（可能正在恢复），不使用工作区目录代替。");
    } else {
      lines.push(field("最近确认目录", context.cwd === status.cwd ? "与工作区目录一致（App Server 已确认）" : context.cwd));
      if (context.workspaceRootsSnapshot.cwd === context.cwd
        && context.workspaceRootsSnapshot.roots.length === 1
        && context.workspaceRootsSnapshot.roots[0] === context.cwd) {
        lines.push("- 运行目录：仅上述最近确认目录");
      } else {
        if (context.workspaceRootsSnapshot.cwd !== context.cwd) {
          lines.push(field("快照对应目录", context.workspaceRootsSnapshot.cwd));
        }
        if (context.workspaceRootsSnapshot.roots.length === 0) {
          lines.push("- 运行目录：App Server 返回的列表为空");
        } else {
          lines.push("- 运行目录：", ...context.workspaceRootsSnapshot.roots.map((path, index) => `  ${field(`目录 ${index + 1}`, path)}`));
        }
      }
      lines.push("", "运行目录取最近一次新建、恢复或派生的加载快照，不是实时权限清单。");
    }
    lines.push("", "### 规则来源", "", "最近一次新建、恢复或派生的加载快照，不代表文件当前的实时加载情况。", "");
    if (status.instructionSources === undefined) {
      lines.push("尚未取得 App Server 加载清单");
    } else if (status.instructionSources.length === 0) {
      lines.push("App Server 返回的规则文件清单为空（不代表没有其他规则）");
    } else {
      lines.push(...status.instructionSources.map((path, index) => field(`文件 ${index + 1}`, path)));
    }
  }
  if (status.goal) {
    lines.push(
      "", "### 当前目标", "",
      field("目标", status.goal.objective),
      field("状态", formatGoalStatus(status.goal.status)),
      field("用量", formatGoalUsage(status.goal)),
    );
  }
  lines.push("", "### 上下文与用量", "");
  if (status.tokenUsage) {
    const { total, last, modelContextWindow } = status.tokenUsage;
    lines.push(
      `- 上下文：${formatTokenCount(last.totalTokens)}${modelContextWindow !== null && modelContextWindow > 0 ? ` / ${formatTokenCount(modelContextWindow)}（${formatPercent(Math.max(0, last.totalTokens / modelContextWindow * 100))}）` : "（窗口上限未知）"}`,
      `- 累计 Token：${formatTokenCount(total.totalTokens)}`,
      ...(detailed ? [
      `- 累计输入：${formatTokenCount(total.inputTokens)}`,
      `  - 缓存输入：${formatTokenCount(total.cachedInputTokens)}`,
      `  - 非缓存输入：${formatTokenCount(Math.max(0, total.inputTokens - total.cachedInputTokens))}`,
      ...(total.cacheWriteInputTokens > 0
        ? [`- 缓存写入：${formatTokenCount(total.cacheWriteInputTokens)}`]
        : []),
      `- 累计输出：${formatTokenCount(total.outputTokens)}`,
      ...(total.reasoningOutputTokens > 0
        ? [`  - 其中推理输出：${formatTokenCount(total.reasoningOutputTokens)}`]
        : []),
      ] : []),
      `- 缓存命中率：${formatCacheHitRate(total.inputTokens, total.cachedInputTokens)}`,
    );
  } else {
    lines.push(status.threadId ? "等待 App Server 推送统计。" : "尚未绑定会话，暂无会话用量。", "");
  }
  if (status.contextCompactionCount !== undefined) {
    lines.push(`- 上下文压缩：${status.contextCompactionCount} 次`);
  }
  const quota = accountQuotaFields(status);
  if (quota.length) lines.push("", "### 当前账户额度", "", ...quota.map(entry => `- ${literal(entry.label)}：${entry.value.split("\n").map((line, index) => index === 0 ? literal(line) : `  - ${literal(line.replace(/^\s*-\s*/u, ""))}`).join("\n")}`));
  else if (status.accountStatusUnavailable) lines.push("", "### 当前账户额度", "", "本次未能取得账户额度，请稍后重新查询。");
  lines.push("", detailed ? "返回总览：/status" : "查看详情：/status detail", "统计明细：/metrics");
  return lines.join("\n").trimEnd();
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
