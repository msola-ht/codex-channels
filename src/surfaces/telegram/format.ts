import {
  fastServiceTierId,
  isFastServiceTier,
  type AccountRateLimits,
  type AccountRateLimitWindow,
  type AccountUsage,
  type InstalledSkill,
  type InstalledPlugin,
  type McpServerSummary,
  type ConversationSession,
  type ConversationStatus,
  type ModelSelectionState,
  type PermissionProfileOption,
} from "../../application/index.js";
import type {
  ConfigChange,
  GlobalConfigChangeCode,
  TelegramConfigChangeCode,
} from "../../config/index.js";
import type {
  McpServerStatus,
  RateLimitSnapshot,
  ThreadGoal,
  ThreadTokenUsage,
  TurnArtifacts,
} from "../../conversation-core/index.js";
import { formatElapsedDuration } from "../elapsed-duration.js";
import {
  createStartupPresentation,
  renderPlainLifecyclePresentation,
  type StartupRuntimeInfo as LifecycleStartupRuntimeInfo,
} from "../lifecycle-presentation.js";
import { formatConversationStatus } from "../conversation-command-format.js";
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
        `${index + 1}. ${option.effort}${option.effort === state.effort ? " ← 当前" : ""} · ${option.description}`,
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

export function formatSkills(skills: InstalledSkill[]): string {
  if (skills.length === 0) {
    return "当前没有已启用的 Skills。";
  }
  const lines = [
    `已安装 Skills（${skills.length}）：`,
    ...skills.map((skill) => `- ${skill.name}：${skill.description}`),
  ];
  lines.push("", "使用：在消息中写 $Skill名称 并说明任务。");
  return lines.join("\n");
}

export function formatMcpServers(servers: McpServerSummary[]): string {
  return [
    `MCP Servers（${servers.length}）：`,
    ...servers.map(
      (server) =>
        `- ${server.name} · auth=${server.authStatus} · tools=${server.toolCount}`,
    ),
  ].join("\n");
}

export function formatPlugins(plugins: InstalledPlugin[]): string {
  if (plugins.length === 0) {
    return "当前没有已安装 Plugins。";
  }
  return [
    `已安装 Plugins（${plugins.length}）：`,
    ...plugins.map(
      (plugin) => `- ${plugin.name} · ${plugin.enabled ? "已启用" : "未启用"}`,
    ),
  ].join("\n");
}

export function formatUsage(result: AccountUsage): string {
  const summary = result.summary;
  const daily = [...result.daily]
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
  result: AccountRateLimits,
): string {
  const lines = ["Codex 额度："];
  const planType = result.limits.find((snapshot) => snapshot.planType)?.planType;
  lines.push(`套餐：${planType ? formatPlanType(planType) : "未知"}`);
  for (const snapshot of result.limits) {
    const label = snapshot.limitName ?? snapshot.limitId;
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
  if (result.resetCreditsAvailable !== null) {
    lines.push("", `可用额度重置券：${result.resetCreditsAvailable}`);
  }
  return lines.join("\n");
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

export function formatWorkspacesAdded(workspaces: readonly Workspace[]): string {
  return [
    workspaces.length === 1 ? "Workspace 已添加" : `Workspace 已添加（${workspaces.length}）`,
    "",
    ...workspaces.flatMap((workspace, index) => [
      `│ ${workspace.name} · ${workspace.id}`,
      `│ ${workspace.cwd}`,
      ...(index + 1 < workspaces.length ? [""] : []),
    ]),
    "",
    "点击下方按钮可直接切换；发送 /workspace 可查看全部 Workspace。",
  ].join("\n");
}

export function formatConfigurationChange(
  change: SurfaceConfigurationChange,
): string {
  const changes = formatConfigChanges(change.changes);
  switch (change.action) {
    case "reloaded":
      if (change.addedWorkspaces.length > 0) {
        return [
          formatWorkspacesAdded(change.addedWorkspaces),
          "",
          `已生效：${changes}`,
        ].join("\n");
      }
      return [
        "Gateway 配置已热加载",
        "",
        `已生效：${changes}`,
      ].join("\n");
    case "restarting":
      return [
        "Gateway 配置需要重启",
        ...(changes ? ["", `变更：${changes}`] : []),
        "当前 Gateway 将退出；若由系统服务托管，将自动重新启动。",
      ].join("\n");
    case "reinstall-required":
      return [
        "Gateway 配置尚未应用",
        ...(changes ? ["", `需要重装服务：${changes}`] : []),
        "请在本机执行：",
        "  codexc service install",
      ].join("\n");
    case "reload-failed":
      return [
        "Gateway 配置热加载失败",
        "",
        "当前有效配置继续运行。请检查配置后再次保存。",
      ].join("\n");
  }
}

function formatConfigChanges(changes: readonly ConfigChange[]): string {
  return changes.map((change) => {
    switch (change.scope) {
      case "global":
      case "telegram":
        return configChangeLabel(change.code);
      default:
        throw new Error("Telegram 收到了其他 Surface 的配置变更");
    }
  }).join("、");
}

function configChangeLabel(
  code: GlobalConfigChangeCode | TelegramConfigChangeCode,
): string {
  switch (code) {
    case "codex.binary":
      return "Codex Binary";
    case "codex.socket":
      return "Codex Socket";
    case "codex.default-model":
      return "默认模型";
    case "codex.sandbox":
      return "Sandbox";
    case "network.proxy":
      return "网络代理";
    case "storage.database":
      return "State Database";
    case "approval.timeout":
      return "审批超时";
    case "display.operation-updates":
      return "操作过程显示";
    case "observability.log-level":
      return "日志级别";
    case "workspace.default":
      return "默认 Workspace";
    case "workspace.registry":
      return "Workspace";
    case "surface.telegram.token":
      return "Telegram Bot Token";
    case "surface.telegram.proxy":
      return "Telegram 代理";
    case "surface.telegram.message-format":
      return "Telegram 消息格式";
    case "surface.telegram.allowed-users":
      return "Telegram 允许用户";
  }
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

function supportsFastMode(model: ModelSelectionState["models"][number]): boolean {
  return fastServiceTierId(model) !== undefined;
}

function formatFastMode(serviceTier: string | null): string {
  return isFastServiceTier(serviceTier) ? "开启" : "关闭";
}

export function formatPermissions(
  profiles: PermissionProfileOption[],
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
