interface RateLimitWindowView {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export function formatRateLimitWindow(
  window: RateLimitWindowView | null,
  options: { includeDuration?: boolean } = {},
): string {
  if (window === null) {
    return "暂无数据";
  }
  return [
    `已使用 ${formatPercent(window.usedPercent)}`,
    ...(options.includeDuration === false
      || window.windowDurationMins === null
      ? []
      : [`周期 ${formatMinutes(window.windowDurationMins)}`]),
    ...(window.resetsAt === null
      ? []
      : [`重置 ${formatResetTime(window.resetsAt)}`]),
  ].join(" · ");
}

export function formatRemainingRateLimitWindow(
  window: RateLimitWindowView,
  options: { includeDuration?: boolean } = {},
): string {
  return [
    `剩余 ${formatPercent(Math.min(100, Math.max(0, 100 - window.usedPercent)))}`,
    ...(options.includeDuration === false
      || window.windowDurationMins === null
      ? []
      : [`周期 ${formatMinutes(window.windowDurationMins)}`]),
    ...(window.resetsAt === null
      ? []
      : [`重置 ${formatResetTime(window.resetsAt)}`]),
  ].join(" · ");
}

export function formatPercent(value: number): string {
  return `${value.toLocaleString("zh-CN", {
    maximumFractionDigits: 1,
  })}%`;
}

export function formatPlanType(value: string): string {
  const names: Record<string, string> = {
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro",
    prolite: "Pro Lite",
    team: "Team",
    self_serve_business_usage_based: "Business（按量）",
    business: "Business",
    ent26: "Enterprise",
    enterprise_cbp_usage_based: "Enterprise（按量）",
    enterprise: "Enterprise",
    edu: "Edu",
    unknown: "未知",
  };
  return names[value] ?? value;
}

export function formatRateLimitState(value: string | null): string {
  const states: Record<string, string> = {
    rate_limit_reached: "已达到速率限制",
    workspace_owner_credits_depleted: "Workspace Credits 已耗尽",
    workspace_member_credits_depleted: "Workspace Credits 已耗尽",
    workspace_owner_usage_limit_reached: "Workspace 用量上限已达到",
    workspace_member_usage_limit_reached: "Workspace 用量上限已达到",
  };
  return value ? (states[value] ?? value) : "正常";
}

export function formatResetTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp * 1_000));
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
