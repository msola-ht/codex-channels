import {
  fastServiceTierId,
  isFastServiceTier,
  type AccountRateLimitWindow,
  type ConversationCommandResult,
  type ConversationStatus,
  type ModelSelectionState,
} from "../../application/index.js";
import type {
  OutputEvent,
  ThreadGoal,
  UserFacingError,
} from "../../conversation-core/index.js";
import { formatConversationCommandOutcome } from "../conversation-command-format.js";
import { formatElapsedDuration } from "../elapsed-duration.js";

const maximumSessionEntries = 20;
const maximumSessionLabelCharacters = 48;

export interface WeixinStartupRuntimeInfo {
  platform: NodeJS.Platform;
  architecture: string;
  gatewayVersion: string;
  nodeVersion: string;
  transport: string;
  codexUpstreamUserAgent: string | null;
}

export function renderWeixinStartupNotification(
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
  runtime: WeixinStartupRuntimeInfo,
): string {
  const workspace = workspaces.find(({ id }) => id === status.workspaceId);
  if (!workspace) {
    throw new Error(`当前 Workspace 不存在：${status.workspaceId}`);
  }
  return [
    "Codex Connect 已上线",
    "App Server：已连接",
    "运行环境：",
    `${platformLabel(runtime.platform)} · ${runtime.architecture}`,
    `Codex Connect ${runtime.gatewayVersion} · Node.js ${runtime.nodeVersion}`,
    runtime.transport,
    `UA：${formatUpstreamUserAgent(runtime.codexUpstreamUserAgent)}`,
    "当前会话：",
    `${workspace.name} · ${workspace.id}`,
    workspace.cwd,
    `Thread：${status.threadId ?? "尚未绑定"}`,
    `Git 分支：${status.gitBranch ?? "未检测到"}`,
    `模型：${status.model}${status.modelPending ? "（下一次 Turn 生效）" : ""}`,
    `思考强度：${status.effort ?? "模型默认"}${status.effortPending ? "（下一次 Turn 生效）" : ""}`,
    `Fast 模式：${status.threadId ? (isFastServiceTier(status.serviceTier) ? "开启" : "关闭") : "未知"}${status.fastModePending ? "（下一次 Turn 生效）" : ""}`,
    ...(status.weeklyLimit
      ? [`周限：${formatRateLimitWindow(status.weeklyLimit)}`]
      : []),
  ].join("\n");
}

export function renderWeixinHelp(): string {
  return [
    "微信 Codex 命令",
    "普通文本会发送到当前 Codex Thread。",
    "/resume [序号|名称|Thread ID]",
    "/sessions [搜索词] · /archived [搜索词]",
    "/new",
    "/archive · /unarchive <序号|名称|Thread ID>",
    "/status",
    "/workspace [序号|ID|名称]",
    "/stop · /queue <描述>",
    "/rename <名称> · /compact · /fork",
    "/review [branch <分支>|commit <SHA>|custom <说明>]",
    "/model [序号|模型 ID|名称]",
    "/effort [序号|档位] · /fast [on|off|status]",
    "/skills · /mcp · /plugins",
    "/usage · /limits · /permissions",
    "/rules <init|check>",
    "/diff · /plan",
    "/goal [set <目标>|clear]",
    "/whoami",
    "/start · /help",
  ].join("\n");
}

export function renderWeixinIdentity(message: {
  actorId: string;
  target: {
    accountId: string;
    conversationId: string;
  };
}): string {
  return [
    "微信身份",
    `用户 ID：${message.actorId}`,
    `会话 ID：${message.target.conversationId}`,
    `账号 ID：${message.target.accountId}`,
  ].join("\n");
}

export function renderWeixinTurnCompleted(
  event: Extract<OutputEvent, { type: "turn.completed" }>,
): string {
  const lines = [`本次运行 · ${turnStatusLabel(event.status)}`];
  if (event.error) {
    lines.push(`错误：${event.error.replaceAll("[REDACTED]", "[已隐藏]")}`);
  }
  if (event.tokenUsage) {
    const current = event.tokenUsage.last.totalTokens;
    const capacity = event.tokenUsage.modelContextWindow;
    lines.push(
      capacity === null || capacity <= 0
        ? `上下文：${formatTokenCount(current)}`
        : `上下文：${formatTokenCount(current)} / ${formatTokenCount(capacity)}（${formatPercent(Math.max(0, current / capacity * 100))}）`,
      `缓存命中：${formatCacheHitRate(
        event.tokenUsage.last.inputTokens,
        event.tokenUsage.last.cachedInputTokens,
      )}`,
    );
  }
  if (event.model) {
    lines.push(
      `模型：${event.model} · ${event.effort ?? "模型默认"} · Fast ${isFastServiceTier(event.serviceTier ?? null) ? "开启" : "关闭"}`,
    );
  }
  if (event.contextCompactionCount !== undefined) {
    lines.push(`上下文压缩：${event.contextCompactionCount} 次`);
  }
  if (event.weeklyLimit) {
    lines.push(`周限：${formatRateLimitWindow(event.weeklyLimit)}`);
  }
  if (event.goal) {
    lines.push(
      `Goal：${goalStatusLabel(event.goal.status)} · ${formatGoalTokens(event.goal)}`,
    );
  }
  if (Object.hasOwn(event, "gitBranch")) {
    lines.push(`Git 分支：${event.gitBranch ?? "未检测到"}`);
  }
  if (event.durationMs !== undefined) {
    lines.push(`耗时：${formatElapsedDuration(event.durationMs)}`);
  }
  return lines.join("\n");
}

export function renderWeixinCommandResult(
  result: ConversationCommandResult,
): string {
  switch (result.kind) {
    case "outcome":
      return formatConversationCommandOutcome(result.outcome);
    case "sessions":
      return renderSessions(result);
    case "status":
      return renderStatus(result.status);
    case "workspaces":
      return [
        `Workspace（${result.workspaces.length}）：`,
        ...result.workspaces.flatMap((workspace, index) => [
          `${index + 1}. ${workspace.name} · ${workspace.id}${workspace.id === result.currentWorkspaceId ? " ← 当前" : ""}`,
          workspace.cwd,
        ]),
        "切换：/workspace <序号、ID 或名称>",
      ].join("\n");
    case "models":
      return renderModels(result.view, result.state);
    case "skills":
      return result.entries.length === 0
        ? "当前没有已启用的 Skills。"
        : [
            `已安装 Skills（${result.entries.length}）：`,
            ...result.entries.map(
              (skill) => `- ${skill.name}：${skill.description}`,
            ),
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
      return renderUsage(result.result);
    case "limits":
      return renderLimits(result);
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
          ? [result.artifacts.plan.explanation]
          : []),
        ...result.artifacts.plan.steps.map(
          (step) => `${planStatusSymbol(step.status)} ${step.step}`,
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

export function renderWeixinUserFacingError(
  error: UserFacingError,
): string {
  switch (error.code) {
    case "command.unsupported":
      return "不支持该微信命令，请发送 /help 查看可用命令";
    case "message.empty":
      return "消息不能为空";
    case "conversation.name.invalid":
      return "会话名称必须为 1–64 个字符";
    case "conversation.missing":
      return "当前还没有 Codex Thread";
    case "conversation.busy":
      return "当前任务运行中，请先使用 /stop 停止当前任务";
    case "image.path.invalid":
      return "本地图片路径必须是绝对路径";
    case "image.too-large":
      return error.details.scope === "batch"
        ? "图片总大小超过 20 MiB 限制"
        : "图片超过 10 MiB 限制";
    case "image.too-many":
      return "一次最多处理 4 张图片";
    case "image.unsupported":
      return "微信当前不支持图片输入";
    case "session.selector.required":
      return `用法：/${errorDetail(error, "command", "resume")} <序号、名称或 Thread ID>`;
    case "session.selector.ambiguous":
      return "会话选择不唯一";
    case "session.selector.not-found":
      return "找不到指定会话";
    case "thread.bound":
      return "该 Codex Thread 已绑定到其他会话";
    case "goal.empty":
      return "目标不能为空";
    case "goal.usage":
      return "用法：/goal [set <目标>|clear]";
    case "queue.usage":
      return "用法：/queue <描述>";
    case "queue.inactive":
      return "当前没有运行中的任务，请直接发送普通消息";
    case "queue.full":
      return "下一 Turn 队列已满，最多 10 条";
    case "queue.thread-changed":
      return "排队消息所属会话已切换，队列已清空";
    case "workspace.missing":
      return `Workspace 不存在或未获授权：${errorDetail(error, "workspaceId", "未知")}`;
    case "workspace.selector.required":
      return "用法：/workspace <序号、ID 或名称>";
    case "workspace.selector.ambiguous":
      return "Workspace 选择不唯一";
    case "workspace.selector.not-found":
      return "找不到指定 Workspace";
    case "model.current.missing":
      return `当前模型不在可用模型列表中：${errorDetail(error, "model", "未知")}`;
    case "model.selector.required":
      return "用法：/model <序号、模型 ID 或名称>";
    case "model.selector.ambiguous":
      return "模型选择不唯一";
    case "model.selector.not-found":
      return "找不到指定模型";
    case "effort.unsupported": {
      const options = error.details.options;
      return `当前模型不支持该思考强度，可选：${Array.isArray(options) ? options.join("、") : "无"}`;
    }
    case "fast.usage":
      return "用法：/fast [on|off|status]";
    case "fast.unsupported":
      return `当前模型不支持 Fast 模式：${errorDetail(error, "model", "未知")}`;
    case "review.usage":
      return "用法：/review [branch <分支>|commit <SHA>|custom <说明>]";
    case "rules.usage":
      return "用法：/rules <init|check>";
    case "rules.exists":
      return "当前 Workspace 已有项目规则；微信不提供强制覆盖，请在终端中处理";
    case "rules.missing":
      return "当前 Workspace 尚未生成项目规则，请先使用 /rules init";
    case "rules.unsafe-path":
      return "项目规则路径包含符号链接，已拒绝写入";
    case "rules.check-failed":
      return "项目规则检查失败，请在终端运行 codexc rules check 查看详情";
    case "rules.unavailable":
      return "项目规则服务当前不可用";
    default:
      return "Gateway 无法完成请求，请稍后重试";
  }
}

export function formatWeixinCommandText(text: string): string {
  return text.replace(/(?:\r?\n)+/gu, "\n\n");
}

function renderSessions(
  result: Extract<ConversationCommandResult, { kind: "sessions" }>,
): string {
  if (result.sessions.length === 0) {
    return result.archived
      ? "当前 Workspace 没有匹配的已归档会话。"
      : "当前 Workspace 没有匹配的可恢复会话。";
  }
  const sessions = result.sessions.slice(0, maximumSessionEntries);
  const hiddenCount = result.sessions.length - sessions.length;
  return [
    `${result.archived ? "已归档会话" : "历史会话"}（${result.sessions.length}）${result.searchTerm ? ` · 搜索：${result.searchTerm}` : ""}：`,
    ...sessions.map(
      (session, index) =>
        `${index + 1}. ${sessionLabel(session.name ?? session.preview)} · ${session.id.slice(0, 12)} · ${session.status.type}${session.id === result.currentThreadId ? " ← 当前" : ""}`,
    ),
    ...(hiddenCount > 0
      ? [`另有 ${hiddenCount} 条未显示，请使用搜索词缩小范围。`]
      : []),
    result.archived
      ? "恢复归档：/unarchive <序号、名称或 Thread ID>"
      : "恢复：/resume <序号、名称或 Thread ID>",
  ].join("\n");
}

function sessionLabel(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return "未命名";
  }
  return normalized.length > maximumSessionLabelCharacters
    ? `${normalized.slice(0, maximumSessionLabelCharacters - 1)}…`
    : normalized;
}

function renderStatus(
  status: Extract<
    ConversationCommandResult,
    { kind: "status" }
  >["status"],
): string {
  const lines = [
    "Codex 状态",
    `Workspace：${status.workspaceName} (${status.workspaceId})`,
    `Thread：${status.threadId ?? "尚未绑定"}`,
    `Turn：${status.turnId ?? "空闲"}`,
    `工作目录：${status.cwd}`,
    `Git 分支：${status.gitBranch ?? "未检测到"}`,
    `模型：${status.model}${status.modelPending ? "（下一次 Turn 生效）" : ""}`,
    `思考强度：${status.effort ?? "模型默认"}${status.effortPending ? "（下一次 Turn 生效）" : ""}`,
    `Fast 模式：${status.threadId ? (isFastServiceTier(status.serviceTier) ? "开启" : "关闭") : "未知"}${status.fastModePending ? "（下一次 Turn 生效）" : ""}`,
  ];
  if (status.contextCompactionCount !== undefined) {
    lines.push(`上下文压缩：${status.contextCompactionCount} 次`);
  }
  if (status.goal) {
    lines.push(
      `Goal 状态：${goalStatusLabel(status.goal.status)}`,
      `Goal 目标：${status.goal.objective}`,
      `Goal Tokens：${formatGoalTokens(status.goal)}`,
    );
  }
  if (status.tokenUsage) {
    const { total, last, modelContextWindow } = status.tokenUsage;
    lines.push(
      "当前 Thread 用量：",
      `累计：${formatTokenCount(total.totalTokens)}`,
      `最近 Turn：${formatTokenCount(last.totalTokens)}`,
      `输入：${formatTokenCount(total.inputTokens)}`,
      `缓存输入：${formatTokenCount(total.cachedInputTokens)}`,
      `缓存命中率：${formatCacheHitRate(total.inputTokens, total.cachedInputTokens)}`,
      `缓存写入：${formatTokenCount(total.cacheWriteInputTokens)}`,
      `输出：${formatTokenCount(total.outputTokens)}`,
      `推理输出：${formatTokenCount(total.reasoningOutputTokens)}`,
      `模型上下文窗口容量：${modelContextWindow === null ? "未知" : formatTokenCount(modelContextWindow)}`,
    );
  } else if (status.threadId) {
    lines.push("当前 Thread 用量：等待 App Server 推送统计");
  }
  if (status.weeklyLimit) {
    lines.push(`周限：${formatRateLimitWindow(status.weeklyLimit)}`);
  }
  return lines.join("\n");
}

function renderModels(
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
      "切换：/fast [on|off|status]",
    ].join("\n");
  }
  if (view === "effort") {
    return [
      `当前模型：${state.model}`,
      `当前思考强度：${state.effort ?? current?.defaultReasoningEffort ?? "模型默认"}${state.effortPending ? "（下一次 Turn 生效）" : ""}`,
      `Fast 模式：${fast}${state.serviceTierPending ? "（下一次 Turn 生效）" : ""}`,
      "可用思考强度：",
      ...(current?.supportedReasoningEfforts ?? []).map(
        (option, index) =>
          `${index + 1}. ${option.effort}${option.effort === state.effort ? " ← 当前" : ""} · ${option.description}`,
      ),
      "切换：/effort <序号或档位>",
    ].join("\n");
  }
  return [
    `当前模型：${state.model}${state.modelPending ? "（下一次 Turn 生效）" : ""}`,
    `思考强度：${state.effort ?? "模型默认"}`,
    `Fast 模式：${fast}${state.serviceTierPending ? "（下一次 Turn 生效）" : ""}`,
    `可用模型（${state.models.length}）：`,
    ...state.models.map(
      (model, index) =>
        `${index + 1}. ${model.displayName} · ${model.model}${fastServiceTierId(model) ? " · 支持 Fast" : ""}${model.model === state.model ? " ← 当前" : ""}`,
    ),
    "切换：/model <序号、模型 ID 或名称>",
  ].join("\n");
}

function renderUsage(
  result: Extract<ConversationCommandResult, { kind: "usage" }>["result"],
): string {
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
    "最近每日用量：",
    ...(daily.length === 0
      ? ["暂无每日数据"]
      : daily.map(
          (entry) => `- ${entry.startDate}：${formatMillions(entry.tokens)}`,
        )),
  ].join("\n");
}

function renderLimits(
  result: Extract<ConversationCommandResult, { kind: "limits" }>,
): string {
  const planType = result.result.limits.find(
    (limit) => limit.planType,
  )?.planType;
  return [
    "Codex 额度：",
    `套餐：${planType ? formatPlanType(planType) : "未知"}`,
    ...result.result.limits.flatMap((limit) => [
      `${limit.limitName ?? limit.limitId}：`,
      `主窗口：${limit.primary ? formatRateLimitWindow(limit.primary) : "暂无数据"}`,
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
      : [`可用额度重置券：${result.result.resetCreditsAvailable}`]),
  ].join("\n");
}

function errorDetail(
  error: UserFacingError,
  key: string,
  fallback: string,
): string {
  const value = error.details[key];
  return typeof value === "string" ? value : fallback;
}

function formatRateLimitWindow(window: AccountRateLimitWindow): string {
  return [
    `已使用 ${formatPercent(window.usedPercent)}`,
    ...(window.windowDurationMins === null
      ? []
      : [`周期 ${window.windowDurationMins} 分钟`]),
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
  return value === null
    ? "未知"
    : `${(Number(value) / 1_000_000).toLocaleString("zh-CN", {
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

function formatCacheHitRate(
  inputTokens: number,
  cachedInputTokens: number,
): string {
  return inputTokens > 0
    ? formatPercent(Math.max(0, cachedInputTokens / inputTokens * 100))
    : "未知";
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

function turnStatusLabel(
  status: Extract<OutputEvent, { type: "turn.completed" }>["status"],
): string {
  const labels = {
    completed: "已完成",
    interrupted: "已停止",
    failed: "失败",
    inProgress: "运行中",
  } as const;
  return labels[status];
}

function platformLabel(platform: NodeJS.Platform): string {
  const labels: Partial<Record<NodeJS.Platform, string>> = {
    darwin: "macOS",
    linux: "Linux",
    win32: "Windows",
  };
  return labels[platform] ?? platform;
}

function formatUpstreamUserAgent(userAgent: string | null): string {
  if (!userAgent) {
    return "App Server 未返回";
  }
  return userAgent.replace(/(\([^)]*\))\s+\S+\s+(\([^)]*\))$/u, "$1 $2");
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
