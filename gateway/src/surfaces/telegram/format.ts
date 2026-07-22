import type { Thread } from "../../codex-protocol/index.js";
import type { CodexAppServerClient } from "../../codex-client/client.js";

export function splitTelegramText(text: string, limit = 4_000): string[] {
  if (!text) {
    return [];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let boundary = remaining.lastIndexOf("\n", limit);
    if (boundary < limit / 2) {
      boundary = limit;
    }
    chunks.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary).replace(/^\n/, "");
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

export function formatSessions(threads: Thread[], currentThreadId?: string): string {
  if (threads.length === 0) {
    return "当前项目没有可恢复的 Codex 会话。";
  }
  const lines = [`历史会话（${threads.length}）：`];
  threads.forEach((thread, index) => {
    const label = thread.name || preview(thread.preview) || "未命名";
    const marker = thread.id === currentThreadId ? " ← 当前" : "";
    lines.push(`${index + 1}. ${label} · ${thread.id.slice(0, 12)} · ${thread.status.type}${marker}`);
  });
  lines.push("", "恢复：/resume <序号、名称或 Thread ID>");
  return lines.join("\n");
}

function preview(value: string, limit = 48): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

export function formatModels(models: Awaited<ReturnType<CodexAppServerClient["listModels"]>>): string {
  return [
    `可用模型（${models.length}）：`,
    ...models.map((model) => `${model.isDefault ? "*" : "-"} ${model.displayName} · ${model.model}`),
  ].join("\n");
}

export function formatSkills(entries: Awaited<ReturnType<CodexAppServerClient["listSkills"]>>): string {
  const skills = entries.flatMap((entry) => entry.skills);
  return [
    `可用 Skills（${skills.length}）：`,
    ...skills.map((skill) => `- ${skill.name}${skill.enabled ? "" : "（已禁用）"}：${skill.description}`),
  ].join("\n");
}

export function formatMcpServers(servers: Awaited<ReturnType<CodexAppServerClient["listMcpServers"]>>): string {
  return [
    `MCP Servers（${servers.length}）：`,
    ...servers.map(
      (server) =>
        `- ${server.name} · auth=${server.authStatus} · tools=${Object.keys(server.tools).length}`,
    ),
  ].join("\n");
}

export function formatPlugins(result: Awaited<ReturnType<CodexAppServerClient["listPlugins"]>>): string {
  const plugins = result.marketplaces.flatMap((marketplace) => marketplace.plugins);
  return [
    `Plugins（${plugins.length}，App Server 中该接口仍在开发中）：`,
    ...plugins.map(
      (plugin) => `- ${plugin.name} · ${plugin.installed ? "已安装" : "未安装"} · ${plugin.enabled ? "已启用" : "未启用"}`,
    ),
  ].join("\n");
}

export function formatUsage(result: Awaited<ReturnType<CodexAppServerClient["accountUsage"]>>): string {
  const summary = result.summary;
  return [
    "Codex 用量摘要：",
    `累计 Tokens：${formatMetric(summary.lifetimeTokens)}`,
    `单日峰值：${formatMetric(summary.peakDailyTokens)}`,
    `最长 Turn：${formatMetric(summary.longestRunningTurnSec)} 秒`,
    `当前连续天数：${formatMetric(summary.currentStreakDays)}`,
    `最长连续天数：${formatMetric(summary.longestStreakDays)}`,
  ].join("\n");
}

export function formatPermissions(
  profiles: Awaited<ReturnType<CodexAppServerClient["listPermissionProfiles"]>>,
): string {
  return [
    "当前 Gateway 固定使用配置中的 read-only 或 workspace-write。",
    "可用 Permission Profiles：",
    ...profiles.map((profile) => `- ${profile.id} · ${profile.allowed ? "允许" : "受策略禁止"}${profile.description ? ` · ${profile.description}` : ""}`),
  ].join("\n");
}

function formatMetric(value: bigint | number | null): string {
  return value === null ? "未知" : String(value);
}
