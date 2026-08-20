import type {
  McpServerStatus,
  RateLimitSnapshot,
} from "../conversation-core/index.js";

import {
  formatPlanType,
  formatRateLimitState,
  formatRateLimitWindow,
} from "./account-format.js";
import { visibleUpstreamMessage } from "./output-copy.js";

export function formatRuntimeAccountUpdate(
  authMode: string | null,
  planType: string | null,
): string {
  return [
    "## Codex 账户状态已更新",
    `- 认证：${authMode ?? "未登录"}`,
    `- 套餐：${planType ? formatPlanType(planType) : "未知"}`,
  ].join("\n");
}

export function formatRuntimeRateLimitUpdate(
  snapshot: RateLimitSnapshot,
): string {
  const label = snapshot.limitName ?? snapshot.limitId ?? "Codex";
  return [
    `## ${label} 额度提醒`,
    `- 主窗口：${formatRateLimitWindow(snapshot.primary)}`,
    ...(snapshot.secondary
      ? [`- 次窗口：${formatRateLimitWindow(snapshot.secondary)}`]
      : []),
    `- 状态：${formatRateLimitState(snapshot.rateLimitReachedType)}`,
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
    "## MCP Server",
    `- 名称：${update.name}`,
    `- 状态：${labels[update.status]}`,
    ...(update.error
      ? [`- 原因：${visibleUpstreamMessage(update.error)}`]
      : []),
  ].join("\n");
}

export function formatRuntimeMcpOAuthCompleted(
  completion: {
    name: string;
    success: boolean;
    error: string | null;
  },
): string {
  return [
    "## MCP OAuth",
    `- 名称：${completion.name}`,
    `- 状态：${completion.success ? "登录成功" : "登录失败"}`,
    ...(!completion.success && completion.error
      ? [`- 原因：${visibleUpstreamMessage(completion.error)}`]
      : []),
  ].join("\n");
}
