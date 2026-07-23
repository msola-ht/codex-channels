import type {
  GetAccountRateLimitsResponse,
  GetAccountTokenUsageResponse,
  ListMcpServerStatusResponse,
  McpServerStatusUpdatedNotification,
  PermissionProfileListResponse,
  PluginListResponse,
  RateLimitSnapshot,
  SkillsListResponse,
  Thread,
  ThreadTokenUsage,
} from "../../codex-protocol/index.js";
import {
  fastServiceTierId,
  isFastServiceTier,
  type ConversationStatus,
  type ModelSelectionState,
} from "../../application/index.js";
import type { TurnArtifacts } from "../../conversation-core/index.js";
import type { Workspace } from "../../policy/index.js";

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
  threads: Thread[],
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

export function formatDiff(artifacts: TurnArtifacts | undefined): string {
  const diff = artifacts?.diff;
  if (!diff?.trim()) {
    return "当前 Thread 暂无 Turn Diff。";
  }
  return [`Turn Diff · ${artifacts?.turnId ?? "未知 Turn"}`, "", diff].join("\n");
}

export function formatPlan(artifacts: TurnArtifacts | undefined): string {
  if (!artifacts?.plan) {
    return "当前 Thread 暂无计划。";
  }
  const symbols = { pending: "○", inProgress: "◐", completed: "●" } as const;
  return [
    `Turn 计划 · ${artifacts.turnId}`,
    ...(artifacts.plan.explanation ? [artifacts.plan.explanation, ""] : [""]),
    ...artifacts.plan.steps.map((entry) => `${symbols[entry.status]} ${entry.step}`),
  ].join("\n");
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

export function formatMcpStatusUpdate(update: McpServerStatusUpdatedNotification): string {
  const labels = { starting: "启动中", ready: "已就绪", failed: "启动失败", cancelled: "已取消" } as const;
  return [
    `MCP Server：${update.name} · ${labels[update.status]}`,
    ...(update.error ? [`原因：${update.error}`] : []),
  ].join("\n");
}

function preview(value: string, limit = 48): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

export function formatModels(state: ModelSelectionState): string {
  return [
    `当前模型：${state.model}${state.modelPending ? "（下一次 Turn 生效）" : ""}`,
    `思考强度：${state.effort ?? "模型默认"}`,
    `Fast 模式：${formatFastMode(state.serviceTier)}${state.serviceTierPending ? "（下一次 Turn 生效）" : ""}`,
    "",
    `可用模型（${state.models.length}）：`,
    ...state.models.map(
      (model, index) =>
        `${index + 1}. ${model.displayName} · ${model.model}${supportsFastMode(model) ? " · 支持 Fast" : ""}${model.model === state.model ? " ← 当前" : ""}`,
    ),
    "",
    "切换：/model <序号、模型 ID 或名称>",
  ].join("\n");
}

export function formatReasoningEfforts(state: ModelSelectionState): string {
  const model = state.models.find((candidate) => candidate.model === state.model);
  if (!model) {
    throw new Error(`当前模型不在可用模型列表中：${state.model}`);
  }
  return [
    `当前模型：${state.model}`,
    `当前思考强度：${state.effort ?? model.defaultReasoningEffort}${state.effortPending ? "（下一次 Turn 生效）" : ""}`,
    `Fast 模式：${formatFastMode(state.serviceTier)}${state.serviceTierPending ? "（下一次 Turn 生效）" : ""}`,
    "",
    "可用思考强度：",
    ...model.supportedReasoningEfforts.map(
      (option, index) =>
        `${index + 1}. ${option.reasoningEffort}${option.reasoningEffort === state.effort ? " ← 当前" : ""} · ${option.description}`,
    ),
    "",
    "切换：/effort <序号或档位>",
  ].join("\n");
}

export function formatFastModeState(state: ModelSelectionState): string {
  const model = state.models.find((candidate) => candidate.model === state.model);
  return [
    `当前模型：${state.model}${state.modelPending ? "（下一次 Turn 生效）" : ""}`,
    `Fast 模式：${formatFastMode(state.serviceTier)}${state.serviceTierPending ? "（下一次 Turn 生效）" : ""}`,
    `模型支持：${model && supportsFastMode(model) ? "支持 Fast" : "不支持 Fast"}`,
    "",
    "切换：/fast [on|off|status]",
  ].join("\n");
}

export function formatSkills(entries: SkillsListResponse["data"]): string {
  const skills = entries.flatMap((entry) => entry.skills);
  return [
    `可用 Skills（${skills.length}）：`,
    ...skills.map((skill) => `- ${skill.name}${skill.enabled ? "" : "（已禁用）"}：${skill.description}`),
  ].join("\n");
}

export function formatMcpServers(servers: ListMcpServerStatusResponse["data"]): string {
  return [
    `MCP Servers（${servers.length}）：`,
    ...servers.map(
      (server) =>
        `- ${server.name} · auth=${server.authStatus} · tools=${Object.keys(server.tools).length}`,
    ),
  ].join("\n");
}

export function formatPlugins(result: PluginListResponse): string {
  const plugins = result.marketplaces.flatMap((marketplace) => marketplace.plugins);
  return [
    `Plugins（${plugins.length}，App Server 中该接口仍在开发中）：`,
    ...plugins.map(
      (plugin) => `- ${plugin.name} · ${plugin.installed ? "已安装" : "未安装"} · ${plugin.enabled ? "已启用" : "未启用"}`,
    ),
  ].join("\n");
}

export function formatUsage(result: GetAccountTokenUsageResponse): string {
  const summary = result.summary;
  const daily = [...(result.dailyUsageBuckets ?? [])]
    .sort((left, right) => right.startDate.localeCompare(left.startDate))
    .slice(0, 7);
  const lines = [
    "Codex 用量摘要：",
    `累计 Tokens：${formatMillions(summary.lifetimeTokens)}`,
    `单日峰值：${formatMillions(summary.peakDailyTokens)}`,
    `最长 Turn：${formatMetric(summary.longestRunningTurnSec)} 秒`,
    `当前连续天数：${formatMetric(summary.currentStreakDays)}`,
    `最长连续天数：${formatMetric(summary.longestStreakDays)}`,
    "",
    "最近每日用量：",
  ];
  if (daily.length === 0) {
    lines.push("暂无每日数据");
  } else {
    lines.push(...daily.map((bucket) => `- ${bucket.startDate}：${formatMillions(bucket.tokens)}`));
  }
  return lines.join("\n");
}

export function formatLimits(
  result: GetAccountRateLimitsResponse,
): string {
  const configured = result.rateLimitsByLimitId
    ? Object.entries(result.rateLimitsByLimitId).filter((entry) => entry[1] !== undefined)
    : [];
  const snapshots = configured.length > 0
    ? configured
    : [[result.rateLimits.limitId ?? "codex", result.rateLimits] as const];
  const lines = ["Codex 额度："];
  const planType = snapshots.find((entry) => entry[1]?.planType)?.[1]?.planType;
  lines.push(`套餐：${planType ? formatPlanType(planType) : "未知"}`);
  for (const [fallbackId, snapshot] of snapshots) {
    if (!snapshot) {
      continue;
    }
    const label = snapshot.limitName ?? snapshot.limitId ?? fallbackId;
    lines.push("", `${label}：`);
    lines.push(`主窗口：${formatRateLimitWindow(snapshot.primary)}`);
    if (snapshot.secondary) {
      lines.push(`次窗口：${formatRateLimitWindow(snapshot.secondary)}`);
    }
    if (snapshot.credits) {
      const credits = snapshot.credits.unlimited
        ? "无限"
        : snapshot.credits.hasCredits
          ? `余额 ${snapshot.credits.balance ?? "未知"}`
          : "无可用 Credits";
      lines.push(`Credits：${credits}`);
    }
    if (snapshot.individualLimit) {
      lines.push(
        `个人限额：已用 ${snapshot.individualLimit.used} / ${snapshot.individualLimit.limit}`,
        `个人限额剩余：${formatPercent(snapshot.individualLimit.remainingPercent)}`,
        `个人限额重置：${formatResetTime(snapshot.individualLimit.resetsAt)}`,
      );
    }
    if (snapshot.spendControlReached !== null) {
      lines.push(`消费控制：${snapshot.spendControlReached ? "已达到上限" : "正常"}`);
    }
    lines.push(`限流状态：${formatRateLimitState(snapshot.rateLimitReachedType)}`);
  }
  if (result.rateLimitResetCredits) {
    lines.push("", `可用额度重置券：${result.rateLimitResetCredits.availableCount}`);
  }
  return lines.join("\n");
}

export function formatStatus(status: ConversationStatus): string {
  const lines = [
    "Codex 状态",
    `Workspace：${status.workspaceName} (${status.workspaceId})`,
    `Thread：${status.threadId ?? "尚未绑定"}`,
    `Turn：${status.turnId ?? "空闲"}`,
    `工作目录：${status.cwd}`,
    `模型：${status.model}${status.modelPending ? "（下一次 Turn 生效）" : ""}`,
    `思考强度：${status.effort ?? "模型默认"}${status.effortPending ? "（下一次 Turn 生效）" : ""}`,
    `Fast 模式：${status.threadId ? formatFastMode(status.serviceTier) : "未知"}${status.fastModePending ? "（下一次 Turn 生效）" : ""}`,
  ];
  if (status.tokenUsage) {
    const { total, last, modelContextWindow } = status.tokenUsage;
    lines.push(
      "",
      "当前 Thread 用量：",
      `累计：${formatTokenCount(total.totalTokens)}`,
      `最近 Turn：${formatTokenCount(last.totalTokens)}`,
      `输入：${formatTokenCount(total.inputTokens)}`,
      `缓存输入：${formatTokenCount(total.cachedInputTokens)}`,
      `缓存写入：${formatTokenCount(total.cacheWriteInputTokens)}`,
      `输出：${formatTokenCount(total.outputTokens)}`,
      `推理输出：${formatTokenCount(total.reasoningOutputTokens)}`,
      `模型上下文窗口容量：${modelContextWindow === null ? "未知" : formatTokenCount(modelContextWindow)}`,
    );
  } else if (status.threadId) {
    lines.push("", "当前 Thread 用量：等待 App Server 推送统计");
  }
  return lines.join("\n");
}

export function formatContextUsage(
  usage: ThreadTokenUsage,
  settings?: {
    model: string;
    effort: string | null;
    serviceTier: string | null;
    weeklyLimit?: NonNullable<RateLimitSnapshot["secondary"]>;
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
    ...(settings
      ? [
          `当前模型：${settings.model}`,
          `思考强度：${settings.effort ?? "模型默认"}`,
          `Fast 模式：${formatFastMode(settings.serviceTier)}`,
          ...(settings.weeklyLimit
            ? [`周限：${formatWeeklyLimit(settings.weeklyLimit)}`]
            : []),
        ]
      : []),
  ].join("\n");
}

export function formatWorkspaces(workspaces: Workspace[], currentWorkspaceId: string): string {
  return [
    `Workspace（${workspaces.length}）：`,
    ...workspaces.flatMap((workspace, index) => [
      `│ ${index + 1}. ${workspace.name} · ${workspace.id}${workspace.id === currentWorkspaceId ? " ← 当前" : ""}`,
      `│ ${workspace.cwd}`,
      ...(index + 1 < workspaces.length ? [""] : []),
    ]),
    "",
    "切换：/workspace <序号、ID 或名称>",
  ].join("\n");
}

export function formatStartupNotification(
  workspaces: Workspace[],
  status: Pick<ConversationStatus, "threadId" | "workspaceId" | "model" | "effort" | "serviceTier" | "modelPending" | "effortPending" | "fastModePending" | "weeklyLimit">,
  runtime: StartupRuntimeInfo,
): string {
  const currentWorkspace = workspaces.find((workspace) => workspace.id === status.workspaceId);
  if (!currentWorkspace) {
    throw new Error(`当前 Workspace 不存在：${status.workspaceId}`);
  }
  return [
    "Codex Connect 已联通",
    "App Server 已连接",
    "",
    "运行环境：",
    `│ ${formatPlatform(runtime.platform)} · ${runtime.architecture}`,
    "│ ",
    `│ Codex Connect ${runtime.gatewayVersion} · Node.js ${runtime.nodeVersion}`,
    "│ ",
    `│ ${runtime.transport}`,
    "│ ",
    `│ UA · ${formatCodexUpstreamUserAgent(runtime.codexUpstreamUserAgent)}`,
    "",
    "当前会话：",
    `│ ${currentWorkspace.name} · ${currentWorkspace.id}`,
    "│ ",
    `│ ${currentWorkspace.cwd}`,
    "│ ",
    `│ Thread · ${status.threadId ?? "尚未绑定"}`,
    "│ ",
    `│ ${status.model}${status.modelPending ? "（下一次 Turn 生效）" : ""} · ${status.effort ?? "模型默认"}${status.effortPending ? "（下一次 Turn 生效）" : ""}`,
    "│ ",
    `│ Fast 模式 · ${status.threadId ? formatFastMode(status.serviceTier) : "未知"}${status.fastModePending ? "（下一次 Turn 生效）" : ""}`,
    ...(status.weeklyLimit
      ? ["│ ", `│ 周限 · ${formatWeeklyLimit(status.weeklyLimit)}`]
      : []),
    "",
    formatWorkspaces(workspaces, status.workspaceId),
  ].join("\n");
}

export interface StartupRuntimeInfo {
  platform: NodeJS.Platform;
  architecture: string;
  gatewayVersion: string;
  nodeVersion: string;
  transport: string;
  codexUpstreamUserAgent: string | null;
}

function formatPlatform(platform: NodeJS.Platform): string {
  const labels: Partial<Record<NodeJS.Platform, string>> = {
    darwin: "macOS",
    linux: "Linux",
    win32: "Windows",
  };
  return labels[platform] ?? platform;
}

function formatCodexUpstreamUserAgent(userAgent: string | null): string {
  if (!userAgent) {
    return "App Server 未返回";
  }
  return userAgent.replace(/(\([^)]*\))\s+\S+\s+(\([^)]*\))$/, "$1 $2");
}

function supportsFastMode(model: ModelSelectionState["models"][number]): boolean {
  return fastServiceTierId(model) !== undefined;
}

function formatFastMode(serviceTier: string | null): string {
  return isFastServiceTier(serviceTier) ? "开启" : "关闭";
}

export function formatPermissions(
  profiles: PermissionProfileListResponse["data"],
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

function formatMillions(value: bigint | number | null): string {
  if (value === null) {
    return "未知";
  }
  const millions = Number(value) / 1_000_000;
  return `${millions.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} M`;
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

function formatRateLimitWindow(
  window: GetAccountRateLimitsResponse["rateLimits"]["primary"],
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
