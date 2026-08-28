import { visibleUpstreamMessage } from "./output-copy.js";

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

export function formatModelUsageBucket(bucket: "off-peak" | "peak"): string {
  return bucket === "peak" ? "Peak" : "Off-Peak";
}

export function formatPlanType(value: string): string {
  const names: Record<string, string> = {
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro",
    prolite: "Pro Lite",
    team: "Team",
    self_serve_business_prolite: "Business Premium",
    self_serve_business_usage_based: "Business（按量）",
    business: "Business",
    ent26: "Enterprise",
    enterprise_cbp_automation: "Enterprise（Automation）",
    enterprise_cbp_usage_based: "Enterprise（按量）",
    enterprise: "Enterprise",
    edu: "Edu",
    edu_plus: "Edu Plus",
    edu_pro: "Edu Pro",
    unknown: "未知",
  };
  return names[value] ?? value;
}

export function formatOpenAiErrorMessage(value: string): string {
  const message = visibleUpstreamMessage(value);
  if (message.includes("You've hit your usage limit")) {
    const parts = ["OpenAI 用量上限已到达"];
    if (message.includes("purchase more credits")) {
      parts.push("可访问 https://chatgpt.com/codex/settings/usage 购买更多额度");
    } else if (message.includes("Upgrade to Plus")) {
      parts.push("可升级到 Plus 后继续使用 Codex");
    } else if (message.includes("Upgrade to Pro")) {
      parts.push("可升级到 Pro 后继续使用 Codex");
    } else if (message.includes("send a request to your admin")) {
      parts.push("请联系管理员增加额度");
    } else if (message.includes("Switch to another model now")) {
      parts.push("可先切换到其他模型");
    }
    const retry = openAiRetryHint(message);
    if (retry !== null) parts.push(retry);
    return `${parts.join("；")}。`;
  }
  if (message.includes("Your workspace is out of credits. Add credits to continue.")) {
    return "工作区额度已用完，请充值后继续。";
  }
  if (message.includes("Ask your workspace owner to refill")) {
    return "工作区额度已用完，请联系工作区所有者充值后继续。";
  }
  if (message.includes("You hit your spend cap set in your workspace")) {
    return "已达到工作区消费上限，请提高消费上限后继续。";
  }
  if (message.includes("You hit your spend cap set by the owner")) {
    return "已达到工作区所有者设置的消费上限，请联系所有者提高上限后继续。";
  }
  return message;
}

function openAiRetryHint(message: string): string | null {
  const match = message.match(/(?:try again at|Try again at) ([^.]+)\./u);
  if (match?.[1]) {
    return `可在 ${match[1].trim()} 后重试`;
  }
  if (/try again later\.?/iu.test(message)) {
    return "请稍后重试";
  }
  return null;
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
    month: "long",
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
