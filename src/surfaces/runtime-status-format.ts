import type {
  McpServerStatus,
  RateLimitSnapshot,
} from "../conversation-core/index.js";

import {
  formatPlanType,
  formatRateLimitState,
  formatRateLimitWindow,
} from "./account-format.js";

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

function visibleRuntimeMessage(message: string): string {
  return message.replaceAll("[REDACTED]", "[已隐藏]");
}
