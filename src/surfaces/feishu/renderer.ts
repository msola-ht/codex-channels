import type {
  AccountRateLimitWindow,
  AccountUsage,
  ConversationCommandResult,
  ConversationStatus,
  ModelSelectionState,
} from "../../application/index.js";
import {
  fastServiceTierId,
  isFastServiceTier,
} from "../../application/index.js";
import type {
  OutputEvent,
  ThreadGoal,
  UserFacingError,
} from "../../conversation-core/index.js";
import {
  conversationCommandHelpLines,
  formatConversationCommandOutcome,
  formatConversationStatus,
} from "../conversation-command-format.js";
import { formatSurfaceConfigurationChange } from "../configuration-change-format.js";
import {
  createStartupPresentation,
  createTurnCompletedPresentation,
  createTurnStartedPresentation,
  type LifecyclePresentation,
  type StartupRuntimeInfo as LifecycleStartupRuntimeInfo,
} from "../lifecycle-presentation.js";
import { formatSurfaceUserFacingError } from "../user-facing-error-format.js";
import {
  formatCodexWarning,
  formatConnectionLost,
} from "../output-copy.js";
import type { SurfaceConfigurationChange } from "../types.js";
import type { FeishuInboxMessage } from "./inbox.js";

const maximumFeishuSessionEntries = 20;
const maximumFeishuSessionLabelCharacters = 48;

export type FeishuStartupRuntimeInfo = LifecycleStartupRuntimeInfo;

export function renderFeishuStartupNotification(
  workspaces: ReadonlyArray<{ id: string; name: string; cwd: string }>,
  status: Pick<
    ConversationStatus,
    | "threadId"
    | "workspaceId"
    | "model"
    | "effort"
    | "serviceTier"
    | "modelPending"
    | "effortPending"
    | "fastModePending"
    | "weeklyLimit"
    | "gitBranch"
  >,
  runtime: FeishuStartupRuntimeInfo,
): string {
  return renderFeishuLifecyclePresentation(
    createStartupPresentation(workspaces, status, runtime),
  );
}

export function renderFeishuHelp(): string {
  return [
    "飞书 Codex 命令",
    "",
    "普通文本会发送到当前 Codex Thread。",
    "",
    ...conversationCommandHelpLines,
    "/whoami",
    "/feishu <status|doctor|revoke>",
    "/start · /help",
  ].join("\n");
}

export function renderFeishuIdentity(
  message: Pick<FeishuInboxMessage, "actorId" | "target">,
): string {
  return [
    "飞书身份",
    `用户 Open ID：${message.actorId}`,
    `Chat ID：${message.target.conversationId}`,
    `App ID：${message.target.accountId}`,
  ].join("\n");
}

export function renderFeishuCommandResult(
  result: ConversationCommandResult,
): string {
  switch (result.kind) {
    case "outcome":
      return formatConversationCommandOutcome(result.outcome);
    case "sessions":
      return renderFeishuSessions(result);
    case "status":
      return formatConversationStatus(result.status);
    case "workspaces":
      return [
        `Workspace（${result.workspaces.length}）：`,
        ...result.workspaces.flatMap((workspace, index) => [
          `${index + 1}. ${workspace.name} · ${workspace.id}${workspace.id === result.currentWorkspaceId ? " ← 当前" : ""}`,
          workspace.cwd,
        ]),
        "",
        "切换：/workspace <序号、ID 或名称>",
      ].join("\n");
    case "models":
      return renderFeishuModels(result.view, result.state);
    case "skills":
      return result.entries.length === 0
        ? "当前没有已启用的 Skills。"
        : [
            `已安装 Skills（${result.entries.length}）：`,
            ...result.entries.map(
              (skill) => `- ${skill.name}：${skill.description}`,
            ),
            "",
            "使用：在消息中写 $Skill名称 并说明任务。",
          ].join("\n");
    case "mcp":
      return [
        `MCP Servers（${result.servers.length}）：`,
        ...result.servers.map(
          (server) =>
            `- ${server.name} · auth=${server.authStatus} · tools=${server.toolCount}`,
        ),
      ].join("\n");
    case "plugins":
      return result.result.length === 0
        ? "当前没有已安装 Plugins。"
        : [
            `已安装 Plugins（${result.result.length}）：`,
            ...result.result.map(
              (plugin) =>
                `- ${plugin.name} · ${plugin.enabled ? "已启用" : "未启用"}`,
            ),
          ].join("\n");
    case "usage":
      return renderFeishuUsage(result.result);
    case "limits":
      return renderFeishuLimits(result);
    case "permissions":
      return [
        "当前 Gateway 固定使用配置中的 read-only 或 workspace-write。",
        "可用 Permission Profiles：",
        ...result.profiles.map(
          (profile) =>
            `- ${profile.id} · ${profile.allowed ? "允许" : "受策略禁止"}${profile.description ? ` · ${profile.description}` : ""}`,
        ),
      ].join("\n");
    case "project-rules":
      return [
        result.action === "initialized"
          ? "项目规则已生成并检查通过"
          : "项目规则检查通过",
        `Workspace：${result.projectRoot}`,
        `规则文件：${result.rulesPath}`,
        ...(result.action === "initialized"
          ? ["重启 Codex/App Server 后生效；Gateway 无需重启。"]
          : []),
      ].join("\n");
    case "artifacts":
      if (result.view === "diff") {
        return result.artifacts?.diff?.trim()
          ? [
              `Turn Diff · ${result.artifacts.turnId}`,
              "",
              result.artifacts.diff,
            ].join("\n")
          : "当前 Thread 暂无 Turn Diff。";
      }
      if (!result.artifacts?.plan) {
        return "当前 Thread 暂无计划。";
      }
      return [
        `Turn 计划 · ${result.artifacts.turnId}`,
        ...(result.artifacts.plan.explanation
          ? [result.artifacts.plan.explanation, ""]
          : []),
        ...result.artifacts.plan.steps.map(
          (step) =>
            `${planStatusSymbol(step.status)} ${step.step}`,
        ),
      ].join("\n");
    case "goal":
      return result.goal
        ? [
            `当前 Goal：${result.goal.objective}`,
            `状态：${goalStatusLabel(result.goal.status)}`,
            `Tokens：${formatGoalTokens(result.goal)}`,
          ].join("\n")
        : "当前 Thread 没有 Goal。使用 /goal set <目标> 设置。";
  }
}

export function renderFeishuConfigurationChange(
  change: SurfaceConfigurationChange,
): string {
  return formatSurfaceConfigurationChange(change, "feishu");
}

export function renderFeishuUserFacingError(
  error: UserFacingError,
): string {
  return formatSurfaceUserFacingError(error, "飞书");
}

export function renderFeishuOutput(event: OutputEvent): string | null {
  switch (event.type) {
    case "turn.started":
      return renderFeishuLifecyclePresentation(
        createTurnStartedPresentation(),
      );
    case "text.delta":
      return null;
    case "user.message":
      return `CLI 输入\n${event.text}`;
    case "text.completed":
      return event.text.trim() ? event.text : "Codex 返回了空消息。";
    case "operation.updated":
      return null;
    case "turn.completed":
      return renderFeishuTurnCompleted(event);
    case "thread.status":
      return `Thread 状态：${threadStatusLabel(event.status)}`;
    case "connection.lost":
      return formatConnectionLost(visibleUpstreamMessage(event.message));
    case "account.updated":
      return `Codex 账户状态已更新：认证=${event.authMode ?? "未登录"} · 套餐=${event.planType ?? "未知"}`;
    case "account.rateLimits.updated":
      return "Codex 额度状态已更新。";
    case "mcp.status.updated":
      return [
        `MCP Server：${event.name} · ${mcpStatusLabel(event.status)}`,
        ...(event.error ? [`原因：${visibleUpstreamMessage(event.error)}`] : []),
      ].join("\n");
    case "warning":
      return formatCodexWarning(visibleUpstreamMessage(event.message));
  }
}

function renderFeishuTurnCompleted(
  event: Extract<OutputEvent, { type: "turn.completed" }>,
): string {
  return renderFeishuLifecyclePresentation(
    createTurnCompletedPresentation(event),
  );
}

function renderFeishuLifecyclePresentation(
  presentation: LifecyclePresentation,
): string {
  return [
    `**${presentation.title}**`,
    ...(presentation.fields.length > 0
      ? [
          "",
          ...presentation.fields.map(
            ({ label, value }) => `- **${label}：** ${value}`,
          ),
        ]
      : []),
    ...(presentation.sections ?? []).flatMap((section) => [
      "",
      `**${section.title}**`,
      ...section.fields.map(
        ({ label, value }) => `- **${label}：** ${value}`,
      ),
    ]),
  ].join("\n");
}

function visibleUpstreamMessage(message: string): string {
  return message.replaceAll("[REDACTED]", "[已隐藏]");
}

function renderFeishuSessions(
  result: Extract<ConversationCommandResult, { kind: "sessions" }>,
): string {
  if (result.sessions.length === 0) {
    return result.archived
      ? "当前 Workspace 没有匹配的已归档会话。"
      : "当前 Workspace 没有匹配的可恢复会话。";
  }
  const visibleSessions = result.sessions.slice(
    0,
    maximumFeishuSessionEntries,
  );
  const hiddenCount = result.sessions.length - visibleSessions.length;
  return [
    `${result.archived ? "已归档会话" : "历史会话"}（${result.sessions.length}）${result.searchTerm ? ` · 搜索：${result.searchTerm}` : ""}：`,
    ...visibleSessions.map((session, index) => {
      const label = formatFeishuSessionLabel(
        session.name ?? session.preview,
      );
      return `${index + 1}. ${label} · ${session.id.slice(0, 12)} · ${session.status.type}${session.id === result.currentThreadId ? " ← 当前" : ""}`;
    }),
    ...(hiddenCount > 0
      ? [
          "",
          `另有 ${hiddenCount} 条未显示，请使用 /${result.archived ? "archived" : "sessions"} <搜索词> 缩小范围。`,
        ]
      : []),
    "",
    result.archived
      ? "恢复归档：/unarchive <序号、名称或 Thread ID>"
      : "恢复：/resume <序号、名称或 Thread ID>",
  ].join("\n");
}

function formatFeishuSessionLabel(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    return "未命名";
  }
  return normalized.length > maximumFeishuSessionLabelCharacters
    ? `${normalized.slice(0, maximumFeishuSessionLabelCharacters - 1)}…`
    : normalized;
}

function renderFeishuModels(
  view: "model" | "effort" | "fast",
  state: ModelSelectionState,
): string {
  const current = state.models.find((model) => model.model === state.model);
  const fast = isFastServiceTier(state.serviceTier, current) ? "开启" : "关闭";
  if (view === "fast") {
    return [
      `当前模型：${state.model}${state.modelPending ? "（下一次 Turn 生效）" : ""}`,
      `Fast 模式：${fast}${state.serviceTierPending ? "（下一次 Turn 生效）" : ""}`,
      `模型支持：${current && fastServiceTierId(current) ? "支持 Fast" : "不支持 Fast"}`,
      "",
      "切换：/fast [on|off|status]",
    ].join("\n");
  }
  if (view === "effort") {
    return [
      `当前模型：${state.model}`,
      `当前思考强度：${state.effort ?? current?.defaultReasoningEffort ?? "模型默认"}${state.effortPending ? "（下一次 Turn 生效）" : ""}`,
      `Fast 模式：${fast}${state.serviceTierPending ? "（下一次 Turn 生效）" : ""}`,
      "",
      "可用思考强度：",
      ...(current?.supportedReasoningEfforts ?? []).map(
        (option, index) =>
          `${index + 1}. ${option.effort}${option.effort === state.effort ? " ← 当前" : ""} · ${option.description}`,
      ),
      "",
      "切换：/effort <序号或档位>",
    ].join("\n");
  }
  return [
    `当前模型：${state.model}${state.modelPending ? "（下一次 Turn 生效）" : ""}`,
    `思考强度：${state.effort ?? "模型默认"}`,
    `Fast 模式：${fast}${state.serviceTierPending ? "（下一次 Turn 生效）" : ""}`,
    "",
    `可用模型（${state.models.length}）：`,
    ...state.models.map(
      (model, index) =>
        `${index + 1}. ${model.displayName} · ${model.model}${fastServiceTierId(model) ? " · 支持 Fast" : ""}${model.model === state.model ? " ← 当前" : ""}`,
    ),
    "",
    "切换：/model <序号、模型 ID 或名称>",
  ].join("\n");
}

function renderFeishuUsage(result: AccountUsage): string {
  const daily = [...result.daily]
    .sort((left, right) => right.startDate.localeCompare(left.startDate))
    .slice(0, 7);
  return [
    "Codex 用量摘要：",
    `累计 Tokens：${formatMillions(result.summary.lifetimeTokens)}`,
    `单日峰值：${formatMillions(result.summary.peakDailyTokens)}`,
    `最长 Turn：${formatMetric(result.summary.longestRunningTurnSec)} 秒`,
    `当前连续天数：${formatMetric(result.summary.currentStreakDays)}`,
    `最长连续天数：${formatMetric(result.summary.longestStreakDays)}`,
    "",
    "最近每日用量：",
    ...(daily.length === 0
      ? ["暂无每日数据"]
      : daily.map((entry) => `- ${entry.startDate}：${formatMillions(entry.tokens)}`)),
  ].join("\n");
}

function renderFeishuLimits(
  result: Extract<ConversationCommandResult, { kind: "limits" }>,
): string {
  const planType = result.result.limits.find(
    (limit) => limit.planType,
  )?.planType;
  return [
    "Codex 额度：",
    `套餐：${planType ? formatPlanType(planType) : "未知"}`,
    ...result.result.limits.flatMap((limit) => [
      "",
      `${limit.limitName ?? limit.limitId}：`,
      `主窗口：${formatRateLimitWindow(limit.primary)}`,
      ...(limit.secondary
        ? [`次窗口：${formatRateLimitWindow(limit.secondary)}`]
        : []),
      ...(limit.credits
        ? [`Credits：${limit.credits.unlimited
          ? "无限"
          : limit.credits.hasCredits
            ? `余额 ${limit.credits.balance ?? "未知"}`
            : "无可用 Credits"}`]
        : []),
      ...(limit.individualLimit
        ? [
            `个人限额：已用 ${limit.individualLimit.used} / ${limit.individualLimit.limit}`,
            `个人限额剩余：${formatPercent(limit.individualLimit.remainingPercent)}`,
            `个人限额重置：${formatResetTime(limit.individualLimit.resetsAt)}`,
          ]
        : []),
      ...(limit.spendControlReached === null
        ? []
        : [`消费控制：${limit.spendControlReached ? "已达到上限" : "正常"}`]),
      `限流状态：${formatRateLimitState(limit.rateLimitReachedType)}`,
    ]),
    ...(result.result.resetCreditsAvailable === null
      ? []
      : ["", `可用额度重置券：${result.result.resetCreditsAvailable}`]),
  ].join("\n");
}

function formatRateLimitWindow(
  window: AccountRateLimitWindow | null,
): string {
  if (window === null) {
    return "暂无数据";
  }
  return [
    `已使用 ${window.usedPercent.toLocaleString("zh-CN", {
      maximumFractionDigits: 1,
    })}%`,
    ...(window.windowDurationMins === null
      ? []
      : [`周期 ${window.windowDurationMins} 分钟`]),
    ...(window.resetsAt === null
      ? []
      : [`重置 ${new Date(window.resetsAt * 1_000).toLocaleString("zh-CN")}`]),
  ].join(" · ");
}

function formatPercent(value: number): string {
  return `${value.toLocaleString("zh-CN", {
    maximumFractionDigits: 1,
  })}%`;
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

function formatMetric(value: bigint | number | null): string {
  return value === null ? "未知" : String(value);
}

function formatMillions(value: bigint | number | null): string {
  if (value === null) {
    return "未知";
  }
  return `${(Number(value) / 1_000_000).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} M`;
}

function formatTokenCount(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString("zh-CN", {
      maximumFractionDigits: 2,
    })} M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toLocaleString("zh-CN", {
      maximumFractionDigits: 2,
    })} K`;
  }
  return value.toLocaleString("zh-CN");
}

function goalStatusLabel(status: ThreadGoal["status"]): string {
  const labels = {
    active: "进行中",
    paused: "已暂停",
    blocked: "已阻塞",
    usageLimited: "用量受限",
    budgetLimited: "预算已用尽",
    complete: "已完成",
  } as const;
  return labels[status];
}

function formatGoalTokens(goal: ThreadGoal): string {
  return goal.tokenBudget === null
    ? formatTokenCount(goal.tokensUsed)
    : `${formatTokenCount(goal.tokensUsed)} / ${formatTokenCount(goal.tokenBudget)}`;
}

function planStatusSymbol(
  status: "pending" | "inProgress" | "completed",
): string {
  const symbols = {
    pending: "○",
    inProgress: "◐",
    completed: "●",
  } as const;
  return symbols[status];
}

function threadStatusLabel(status: string): string {
  return status === "active"
    ? "运行中"
    : status === "idle"
      ? "空闲"
      : "未知";
}

function mcpStatusLabel(
  status: Extract<OutputEvent, { type: "mcp.status.updated" }>["status"],
): string {
  const labels = {
    starting: "启动中",
    ready: "已就绪",
    failed: "启动失败",
    cancelled: "已取消",
  } as const;
  return labels[status];
}
