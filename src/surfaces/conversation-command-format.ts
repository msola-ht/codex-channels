import {
  fastServiceTierId,
  isFastServiceTier,
  type AccountRateLimitWindow,
  type ConversationCommandName,
  type ConversationCommandOutcome,
  type ConversationCommandResult,
  type ConversationStatus,
} from "../application/index.js";
import type { ThreadGoal } from "../conversation-core/index.js";

export const conversationCommandDescriptions = {
  resume: "列出或恢复 Codex 会话",
  sessions: "搜索可恢复会话",
  archived: "搜索已归档会话",
  new: "下一条消息创建新会话",
  archive: "归档当前会话",
  unarchive: "恢复已归档会话",
  status: "查看当前状态",
  workspace: "列出或切换 Workspace",
  stop: "停止当前任务",
  queue: "排到下一 Turn",
  rename: "命名当前会话",
  compact: "压缩当前上下文",
  fork: "分叉当前会话",
  review: "启动代码审查",
  model: "查看或切换模型",
  effort: "查看或切换思考强度",
  fast: "查看或切换 Fast 模式",
  skills: "列出 Skills",
  mcp: "列出 MCP Servers",
  plugins: "列出 Plugins",
  usage: "查看账号用量",
  limits: "查看套餐与额度",
  permissions: "查看权限配置",
  rules: "生成或检查项目规则",
  diff: "查看当前 Turn Diff",
  plan: "查看当前 Turn 计划",
  goal: "查看或管理 Goal",
} satisfies Record<ConversationCommandName, string>;

export const conversationCommandHelpLines = [
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
] as const;

export function formatConversationCommandOutcome(
  outcome: ConversationCommandOutcome,
): string {
  switch (outcome.type) {
    case "thread.resumed":
      return `已恢复 Codex Thread\nThread：${outcome.threadId}`;
    case "session.new":
      return "已退出当前会话，下一条普通消息将创建新的 Codex Thread。";
    case "thread.archived":
      return `已归档 Codex Thread\nThread：${outcome.threadId}\n下一条普通消息将创建新会话。`;
    case "thread.unarchived":
      return `已取消归档并切换会话\nThread：${outcome.threadId}`;
    case "workspace.selected":
      return `已切换 Workspace\nWorkspace：${outcome.workspace.name}\n工作目录：${outcome.workspace.cwd}`;
    case "turn.stop-requested":
      return outcome.stopped
        ? "已请求停止当前任务。"
        : "当前没有运行中的任务。";
    case "turn.follow-up-queued":
      return `已排到下一 Turn，当前第 ${outcome.position} 条。队列仅保存在内存，Gateway 重启会清空。`;
    case "thread.renamed":
      return `会话已重命名\n名称：${outcome.name}`;
    case "thread.compaction-requested":
      return "已请求压缩当前 Codex Thread。进度将通过标准事件返回。";
    case "thread.forked":
      return `已分叉并切换到新会话\nThread：${outcome.threadId}`;
    case "review.started":
      return `已启动 Codex Review\nTurn：${outcome.turnId}`;
    case "goal.cleared":
      return "已清除当前 Thread Goal。";
    case "goal.updated":
      return `Goal 已设置\n目标：${outcome.goal.objective}`;
  }
}

export function formatConversationWorkspaces(
  result: Extract<ConversationCommandResult, { kind: "workspaces" }>,
): string {
  return [
    `Workspace（${result.workspaces.length}）：`,
    ...result.workspaces.flatMap((workspace, index) => [
      `${index + 1}. ${workspace.name} · ${workspace.id}${workspace.id === result.currentWorkspaceId ? " ← 当前" : ""}`,
      workspace.cwd,
    ]),
    "",
    "切换：/workspace <序号、ID 或名称>",
  ].join("\n");
}

export function formatConversationSkills(
  result: Extract<ConversationCommandResult, { kind: "skills" }>,
): string {
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
}

export function formatConversationMcp(
  result: Extract<ConversationCommandResult, { kind: "mcp" }>,
): string {
  return [
    `MCP Servers（${result.servers.length}）：`,
    ...result.servers.map(
      (server) =>
        `- ${server.name} · auth=${server.authStatus} · tools=${server.toolCount}`,
    ),
  ].join("\n");
}

export function formatConversationPlugins(
  result: Extract<ConversationCommandResult, { kind: "plugins" }>,
): string {
  return result.result.length === 0
    ? "当前没有已安装 Plugins。"
    : [
        `已安装 Plugins（${result.result.length}）：`,
        ...result.result.map(
          (plugin) =>
            `- ${plugin.name} · ${plugin.enabled ? "已启用" : "未启用"}`,
        ),
      ].join("\n");
}

export function formatConversationPermissions(
  result: Extract<ConversationCommandResult, { kind: "permissions" }>,
): string {
  return [
    "当前 Gateway 固定使用配置中的 read-only 或 workspace-write。",
    "可用 Permission Profiles：",
    ...result.profiles.map(
      (profile) =>
        `- ${profile.id} · ${profile.allowed ? "允许" : "受策略禁止"}${profile.description ? ` · ${profile.description}` : ""}`,
    ),
  ].join("\n");
}

export function formatConversationProjectRules(
  result: Extract<ConversationCommandResult, { kind: "project-rules" }>,
): string {
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
}

export function formatConversationArtifacts(
  result: Extract<ConversationCommandResult, { kind: "artifacts" }>,
): string {
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
  const symbols = { pending: "○", inProgress: "◐", completed: "●" } as const;
  return [
    `Turn 计划 · ${result.artifacts.turnId}`,
    ...(result.artifacts.plan.explanation
      ? [result.artifacts.plan.explanation, ""]
      : []),
    ...result.artifacts.plan.steps.map(
      (step) => `${symbols[step.status]} ${step.step}`,
    ),
  ].join("\n");
}

export function formatConversationGoal(
  result: Extract<ConversationCommandResult, { kind: "goal" }>,
): string {
  return result.goal
    ? [
        `当前 Goal：${result.goal.objective}`,
        `状态：${formatGoalStatus(result.goal.status)}`,
        `Tokens：${formatGoalTokens(result.goal)}`,
      ].join("\n")
    : "当前 Thread 没有 Goal。使用 /goal set <目标> 设置。";
}

export function formatConversationModels(
  result: Extract<ConversationCommandResult, { kind: "models" }>,
): string {
  const { state } = result;
  const current = state.models.find((model) => model.model === state.model);
  const fast = isFastServiceTier(state.serviceTier, current) ? "开启" : "关闭";
  if (result.view === "fast") {
    return [
      `当前模型：${state.model}${state.modelPending ? "（下一次 Turn 生效）" : ""}`,
      `Fast 模式：${fast}${state.serviceTierPending ? "（下一次 Turn 生效）" : ""}`,
      `模型支持：${current && fastServiceTierId(current) ? "支持 Fast" : "不支持 Fast"}`,
      "",
      "切换：/fast [on|off|status]",
    ].join("\n");
  }
  if (result.view === "effort") {
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

export function formatConversationUsage(
  result: Extract<ConversationCommandResult, { kind: "usage" }>,
): string {
  const daily = [...result.result.daily]
    .sort((left, right) => right.startDate.localeCompare(left.startDate))
    .slice(0, 7);
  return [
    "Codex 用量摘要：",
    `累计 Tokens：${formatMillions(result.result.summary.lifetimeTokens)}`,
    `单日峰值：${formatMillions(result.result.summary.peakDailyTokens)}`,
    `最长 Turn：${formatMetric(result.result.summary.longestRunningTurnSec)} 秒`,
    `当前连续天数：${formatMetric(result.result.summary.currentStreakDays)}`,
    `最长连续天数：${formatMetric(result.result.summary.longestStreakDays)}`,
    "",
    "最近每日用量：",
    ...(daily.length === 0
      ? ["暂无每日数据"]
      : daily.map(
          (entry) => `- ${entry.startDate}：${formatMillions(entry.tokens)}`,
        )),
  ].join("\n");
}

export function formatConversationLimits(
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
      `主窗口：${formatAccountLimitWindow(limit.primary)}`,
      ...(limit.secondary
        ? [`次窗口：${formatAccountLimitWindow(limit.secondary)}`]
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

export function formatConversationStatus(status: ConversationStatus): string {
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
      `Goal 状态：${formatGoalStatus(status.goal.status)}`,
      `Goal 目标：${status.goal.objective}`,
      `Goal 用量：${formatGoalUsage(status.goal)}`,
    );
  }
  if (status.tokenUsage) {
    const { total, last, modelContextWindow } = status.tokenUsage;
    lines.push(
      "",
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
    lines.push("", "当前 Thread 用量：等待 App Server 推送统计");
  }
  if (status.weeklyLimit) {
    lines.push(`周限：${formatRateLimitWindow(status.weeklyLimit)}`);
  }
  return lines.join("\n");
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

function formatGoalTokens(goal: ThreadGoal): string {
  return goal.tokenBudget === null
    ? formatTokenCount(goal.tokensUsed)
    : `${formatTokenCount(goal.tokensUsed)} / ${formatTokenCount(goal.tokenBudget)}`;
}

function formatDuration(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(wholeSeconds / 3_600);
  const minutes = Math.floor(wholeSeconds % 3_600 / 60);
  const remainder = wholeSeconds % 60;
  return [
    ...(hours > 0 ? [`${hours}小时`] : []),
    ...(minutes > 0 ? [`${minutes}分`] : []),
    ...(remainder > 0 || (hours === 0 && minutes === 0)
      ? [`${remainder}秒`]
      : []),
  ].join("");
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
    ? `${Math.max(
        0,
        cachedInputTokens / inputTokens * 100,
      ).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}%`
    : "未知";
}

function formatRateLimitWindow(window: AccountRateLimitWindow | null): string {
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

function formatAccountLimitWindow(
  window: AccountRateLimitWindow | null,
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

function formatResetTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp * 1_000));
}
