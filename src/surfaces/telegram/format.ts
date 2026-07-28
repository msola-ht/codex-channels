import {
  isFastServiceTier,
  type AccountRateLimits,
  type AccountRateLimitWindow,
  type AccountUsage,
  type ConversationSession,
  type ConversationStatus,
  type ModelSelectionState,
} from "../../application/index.js";
import type {
  McpServerStatus,
  RateLimitSnapshot,
  ThreadGoal,
  ThreadTokenUsage,
} from "../../conversation-core/index.js";
import { formatElapsedDuration } from "../elapsed-duration.js";
import {
  formatSurfaceConfigurationChange,
  formatWorkspacesAdded as formatSharedWorkspacesAdded,
} from "../configuration-change-format.js";
import {
  createStartupPresentation,
  renderPlainLifecyclePresentation,
  type StartupRuntimeInfo as LifecycleStartupRuntimeInfo,
} from "../lifecycle-presentation.js";
import {
  formatConversationLimits,
  formatConversationModels,
  formatConversationStatus,
  formatConversationUsage,
} from "../conversation-command-format.js";
import type { Workspace } from "../../policy/index.js";
import type { SurfaceConfigurationChange } from "../types.js";

export function splitTelegramText(text: string, limit = 4_000): string[] {
  if (!text) {
    return [];
  }
  const chunks: string[] = [];
  let remaining = Array.from(text);
  while (remaining.length > limit) {
    let boundary = remaining.lastIndexOf("\n", limit);
    if (boundary < limit / 2) {
      boundary = limit;
    }
    chunks.push(remaining.slice(0, boundary).join(""));
    remaining = remaining.slice(boundary);
    if (remaining[0] === "\n") {
      remaining.shift();
    }
  }
  if (remaining.length > 0) {
    chunks.push(remaining.join(""));
  }
  return chunks;
}

export function formatSessions(
  threads: ConversationSession[],
  currentThreadId?: string,
  options: { archived?: boolean; searchTerm?: string } = {},
): string {
  if (threads.length === 0) {
    return options.archived
      ? "当前 Workspace 没有匹配的已归档会话。"
      : "当前 Workspace 没有匹配的可恢复会话。";
  }
  const title = options.archived ? "已归档会话" : "历史会话";
  const lines = [`${title}（${threads.length}）${options.searchTerm ? ` · 搜索：${options.searchTerm}` : ""}：`];
  threads.forEach((thread, index) => {
    const label = thread.name || preview(thread.preview) || "未命名";
    const marker = thread.id === currentThreadId ? " ← 当前" : "";
    lines.push(`${index + 1}. ${label} · ${thread.id.slice(0, 12)} · ${thread.status.type}${marker}`);
  });
  lines.push("", options.archived
    ? "恢复归档：/unarchive <序号、名称或 Thread ID>"
    : "恢复：/resume <序号、名称或 Thread ID>");
  return lines.join("\n");
}

export function formatAccountUpdate(authMode: string | null, planType: string | null): string {
  return `Codex 账户状态已更新：认证=${authMode ?? "未登录"} · 套餐=${planType ? formatPlanType(planType) : "未知"}`;
}

export function formatRateLimitUpdate(snapshot: RateLimitSnapshot): string {
  const label = snapshot.limitName ?? snapshot.limitId ?? "Codex";
  return [
    `${label} 额度提醒`,
    `主窗口：${formatRateLimitWindow(snapshot.primary)}`,
    ...(snapshot.secondary ? [`次窗口：${formatRateLimitWindow(snapshot.secondary)}`] : []),
    `状态：${formatRateLimitState(snapshot.rateLimitReachedType)}`,
  ].join("\n");
}

export function formatMcpStatusUpdate(update: McpServerStatus): string {
  const labels = { starting: "启动中", ready: "已就绪", failed: "启动失败", cancelled: "已取消" } as const;
  return [
    `MCP Server：${update.name} · ${labels[update.status]}`,
    ...(update.error
      ? [`原因：${update.error.replaceAll("[REDACTED]", "[已隐藏]")}`]
      : []),
  ].join("\n");
}

function preview(value: string, limit = 48): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

export function formatModels(state: ModelSelectionState): string {
  return formatConversationModels({ kind: "models", view: "model", state });
}

export function formatReasoningEfforts(state: ModelSelectionState): string {
  return formatConversationModels({ kind: "models", view: "effort", state });
}

export function formatFastModeState(state: ModelSelectionState): string {
  return formatConversationModels({ kind: "models", view: "fast", state });
}

export function formatUsage(result: AccountUsage): string {
  return formatConversationUsage({ kind: "usage", result });
}

export function formatLimits(
  result: AccountRateLimits,
): string {
  return formatConversationLimits({ kind: "limits", result });
}

export function formatStatus(status: ConversationStatus): string {
  return formatConversationStatus(status);
}

export function formatContextUsage(
  usage: ThreadTokenUsage,
  settings?: {
    model?: string;
    effort?: string | null;
    serviceTier?: string | null;
    durationMs?: number;
    contextCompactionCount?: number;
    weeklyLimit?: NonNullable<RateLimitSnapshot["secondary"]>;
    goal?: ThreadGoal;
    gitBranch?: string | undefined;
  },
): string {
  const current = usage.last.totalTokens;
  const capacity = usage.modelContextWindow;
  const context = capacity === null || capacity <= 0
    ? `上下文：${formatTokenCount(current)}`
    : `上下文：${formatTokenCount(current)} / ${formatTokenCount(capacity)}（${Math.max(0, current / capacity * 100).toLocaleString("zh-CN", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })}%）`;
  return [
    context,
    `缓存命中率：${formatCacheHitRate(
      usage.last.inputTokens,
      usage.last.cachedInputTokens,
    )}`,
    ...(settings?.model
      ? [
          `当前模型：${settings.model}`,
          `思考强度：${settings.effort ?? "模型默认"}`,
          `Fast 模式：${formatFastMode(settings.serviceTier ?? null)}`,
        ]
      : []),
    ...(settings?.durationMs === undefined
      ? []
      : [`对话耗时：${formatElapsedDuration(settings.durationMs)}`]),
    ...(settings?.contextCompactionCount !== undefined
      ? [`上下文压缩：${settings.contextCompactionCount} 次`]
      : []),
    ...(settings?.weeklyLimit
      ? [`周限：${formatWeeklyLimit(settings.weeklyLimit)}`]
      : []),
    ...(settings?.goal
      ? [`Goal：${formatGoalStatus(settings.goal.status)} · ${formatGoalUsage(settings.goal)}`]
      : []),
    ...(settings && "gitBranch" in settings
      ? [`Git 分支：${settings.gitBranch ?? "未检测到"}`]
      : []),
  ].join("\n");
}

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

function formatDuration(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(wholeSeconds / 3_600);
  const minutes = Math.floor(wholeSeconds % 3_600 / 60);
  const remainder = wholeSeconds % 60;
  return [
    ...(hours > 0 ? [`${hours}小时`] : []),
    ...(minutes > 0 ? [`${minutes}分`] : []),
    ...(remainder > 0 || (hours === 0 && minutes === 0) ? [`${remainder}秒`] : []),
  ].join("");
}

export function formatWorkspacesAdded(workspaces: readonly Workspace[]): string {
  return formatSharedWorkspacesAdded(workspaces, true);
}

export function formatConfigurationChange(
  change: SurfaceConfigurationChange,
): string {
  return formatSurfaceConfigurationChange(change, "telegram", true);
}

export function formatStartupNotification(
  workspaces: Workspace[],
  status: Pick<ConversationStatus, "threadId" | "workspaceId" | "model" | "effort" | "serviceTier" | "modelPending" | "effortPending" | "fastModePending" | "weeklyLimit" | "gitBranch">,
  runtime: StartupRuntimeInfo,
): string {
  return renderPlainLifecyclePresentation(
    createStartupPresentation(workspaces, status, runtime),
  );
}

export type StartupRuntimeInfo = LifecycleStartupRuntimeInfo;

function formatFastMode(serviceTier: string | null): string {
  return isFastServiceTier(serviceTier) ? "开启" : "关闭";
}

function formatTokenCount(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} K`;
  }
  return value.toLocaleString("zh-CN");
}

function formatCacheHitRate(inputTokens: number, cachedInputTokens: number): string {
  return inputTokens > 0
    ? formatPercent(Math.max(0, cachedInputTokens / inputTokens * 100))
    : "未知";
}

function formatRateLimitWindow(
  window: AccountRateLimitWindow | null,
): string {
  if (!window) {
    return "暂无数据";
  }
  const details = [`已使用 ${formatPercent(window.usedPercent)}`];
  if (window.windowDurationMins !== null) {
    details.push(`周期 ${formatMinutes(window.windowDurationMins)}`);
  }
  if (window.resetsAt !== null) {
    details.push(`重置 ${formatResetTime(window.resetsAt)}`);
  }
  return details.join(" · ");
}

function formatWeeklyLimit(
  window: NonNullable<RateLimitSnapshot["secondary"]>,
): string {
  return [
    `已使用 ${formatPercent(window.usedPercent)}`,
    ...(window.resetsAt !== null ? [`重置 ${formatResetTime(window.resetsAt)}`] : []),
  ].join(" · ");
}

function formatPercent(value: number): string {
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}%`;
}

function formatMinutes(value: number): string {
  if (value % 1_440 === 0) {
    return `${value / 1_440} 天`;
  }
  if (value % 60 === 0) {
    return `${value / 60} 小时`;
  }
  return `${value} 分钟`;
}

function formatResetTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp * 1_000));
}

function formatPlanType(value: string): string {
  const names: Record<string, string> = {
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro",
    prolite: "Pro Lite",
    team: "Team",
    self_serve_business_usage_based: "Business（按量）",
    business: "Business",
    enterprise_cbp_usage_based: "Enterprise（按量）",
    enterprise: "Enterprise",
    edu: "Edu",
    unknown: "未知",
  };
  return names[value] ?? value;
}

function formatRateLimitState(value: string | null): string {
  const states: Record<string, string> = {
    rate_limit_reached: "已达到速率限制",
    workspace_owner_credits_depleted: "Workspace Credits 已耗尽",
    workspace_member_credits_depleted: "Workspace Credits 已耗尽",
    workspace_owner_usage_limit_reached: "Workspace 用量上限已达到",
    workspace_member_usage_limit_reached: "Workspace 用量上限已达到",
  };
  return value ? (states[value] ?? value) : "正常";
}
