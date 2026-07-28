import type {
  McpServerStatus,
  RateLimitSnapshot,
} from "../conversation-core/index.js";

export function formatRuntimeAccountUpdate(
  authMode: string | null,
  planType: string | null,
): string {
  return `Codex 账户状态已更新：认证=${authMode ?? "未登录"} · 套餐=${planType ? formatPlanType(planType) : "未知"}`;
}

export function formatRuntimeRateLimitUpdate(
  snapshot: RateLimitSnapshot,
): string {
  const label = snapshot.limitName ?? snapshot.limitId ?? "Codex";
  return [
    `${label} 额度提醒`,
    `主窗口：${formatRateLimitWindow(snapshot.primary)}`,
    ...(snapshot.secondary
      ? [`次窗口：${formatRateLimitWindow(snapshot.secondary)}`]
      : []),
    `状态：${formatRateLimitState(snapshot.rateLimitReachedType)}`,
  ].join("\n");
}

export function formatRuntimeMcpStatusUpdate(
  update: McpServerStatus,
): string {
  const labels = {
    starting: "启动中",
    ready: "已就绪",
    failed: "启动失败",
    cancelled: "已取消",
  } as const;
  return [
    `MCP Server：${update.name} · ${labels[update.status]}`,
    ...(update.error
      ? [`原因：${visibleRuntimeMessage(update.error)}`]
      : []),
  ].join("\n");
}

function formatRateLimitWindow(
  window: RateLimitSnapshot["primary"],
): string {
  if (window === null) {
    return "暂无数据";
  }
  return [
    `已使用 ${formatPercent(window.usedPercent)}`,
    ...(window.windowDurationMins === null
      ? []
      : [`周期 ${formatMinutes(window.windowDurationMins)}`]),
    ...(window.resetsAt === null
      ? []
      : [`重置 ${formatResetTime(window.resetsAt)}`]),
  ].join(" · ");
}

function formatPercent(value: number): string {
  return `${value.toLocaleString("zh-CN", {
    maximumFractionDigits: 1,
  })}%`;
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

function visibleRuntimeMessage(message: string): string {
  return message.replaceAll("[REDACTED]", "[已隐藏]");
}
