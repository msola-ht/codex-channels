import {
  isFastServiceTier,
  type AccountRateLimits,
  type AccountUsage,
  type ConversationSession,
  type ConversationStatus,
  type ModelSelectionState,
} from "../../application/index.js";
import type {
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

function formatResetTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp * 1_000));
}
