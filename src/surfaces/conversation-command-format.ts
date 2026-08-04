import {
  fastServiceTierId,
  isFastServiceTier,
  type ConversationCommandName,
  type ConversationCommandOutcome,
  type ConversationCommandResult,
  type ConversationStatus,
  type DisplayPriceCurrency,
  type ExchangeRateSnapshot,
} from "../application/index.js";
import {
  usesOpenAiAccount,
  type ThreadGoal,
} from "../conversation-core/index.js";

import {
  formatPercent,
  formatPlanType,
  formatRateLimitState,
  formatRemainingRateLimitWindow,
  formatRateLimitWindow,
  formatResetTime,
} from "./account-format.js";
import {
  formatElapsedDuration,
  formatElapsedSeconds,
  formatTokensPerSecond,
} from "./elapsed-duration.js";
import {
  formatCodexProviderLabel,
  formatProviderLabel,
} from "./provider-format.js";
import {
  formatExchangeRateLine,
  formatReferenceCostBreakdown,
  formatReferenceCostTotal,
  toDisplayReferenceCost,
  type ReferenceCostDisplay,
} from "./reference-cost-format.js";

const maximumSessionEntries = 20;
const maximumSessionLabelCharacters = 48;

export const conversationCommandDescriptions = {
  resume: "列出或恢复 Codex 会话",
  sessions: "搜索可恢复会话",
  archived: "搜索已归档会话",
  new: "下一条消息创建新会话",
  archive: "归档当前会话",
  unarchive: "恢复已归档会话",
  pin: "固定当前会话",
  unpin: "取消固定当前会话",
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
  skill: "查看或调用 Skill",
  mcp: "列出 MCP Servers",
  plugins: "列出 Plugins",
  usage: "查看账号用量",
  metrics: "查看会话、聚合或异常请求指标",
  limits: "查看套餐与额度",
  permissions: "查看权限配置",
  rules: "生成或检查项目规则",
  diff: "查看当前 Turn Diff",
  plan: "切换 Plan 模式或直接开始规划",
  goal: "查看或管理 Goal",
} satisfies Record<ConversationCommandName, string>;

export const conversationCommandHelpSections = [
  {
    title: "会话：",
    lines: [
      "/resume [序号|名称|Thread ID]",
      "/sessions [搜索词] · /archived [搜索词]",
      "/new · /archive · /unarchive <序号|名称|Thread ID>",
      "/pin · /unpin",
      "/rename <名称> · /compact · /fork",
    ],
  },
  {
    title: "运行与项目：",
    lines: [
      "/status · /workspace [序号|ID|名称]",
      "/stop · /queue <描述>",
      "/review [branch <分支>|commit <SHA>|custom <说明>]",
      "/rules <init|check> · /diff",
      "/plan [规划需求] · /goal [set <目标>|clear]",
    ],
  },
  {
    title: "模型与能力：",
    lines: [
      "/model [序号|模型 ID|名称]",
      "/effort [序号|档位] · /fast [on|off|status]",
      "/skill [名称或序号 任务]",
      "/mcp · /plugins",
      "/usage · /metrics [session|global|providers|models|errors] [24h|7d|30d]",
      "/limits · /permissions",
    ],
  },
  {
    title: "快捷命令：",
    lines: [
      "/h → /help",
      "/work → /workspace",
      "/r → /resume",
    ],
  },
] as const;

export const conversationCommandHelpLines = conversationCommandHelpSections
  .flatMap((section) => [
    section.title,
    ...section.lines.map((line) => `- ${line}`),
    "",
  ]);

export function formatConversationSessions(
  result: Extract<ConversationCommandResult, { kind: "sessions" }>,
): string {
  if (result.sessions.length === 0) {
    return result.archived
      ? "当前 Workspace 没有匹配的已归档会话。"
      : "当前 Workspace 没有匹配的可恢复会话。";
  }
  const visibleSessions = result.sessions.slice(0, maximumSessionEntries);
  const hiddenCount = result.sessions.length - visibleSessions.length;
  const searchCommand = result.archived ? "archived" : "sessions";
  const backgroundThreadIds = new Set(result.backgroundThreadIds ?? []);
  return toStructuredMarkdownList([
    `${result.archived ? "已归档会话" : "历史会话"}（${result.sessions.length}）${result.searchTerm ? ` · 搜索：${result.searchTerm}` : ""}：`,
    ...visibleSessions.map(
      (session, index) =>
        `${index + 1}. ${session.isPinned ? "固定 · " : ""}${formatSessionLabel(session.name ?? session.preview)}${session.model ? ` · 模型：${session.model}` : ""} · ${session.id.slice(0, 12)} · ${session.status.type}${session.id === result.currentThreadId ? " ← 当前" : backgroundThreadIds.has(session.id) ? " · 后台运行" : ""}`,
    ),
    ...(hiddenCount > 0
      ? [
          "",
          `另有 ${hiddenCount} 条未显示，请使用 /${searchCommand} <搜索词> 缩小范围。`,
        ]
      : []),
    "",
    result.archived
      ? "恢复归档：/unarchive <序号、名称或 Thread ID>"
      : "恢复：/resume <序号、名称或 Thread ID>",
  ].join("\n"));
}

export function formatConversationCommandOutcome(
  outcome: ConversationCommandOutcome,
): string {
  switch (outcome.type) {
    case "thread.resumed":
      return outcome.transferredFrom
        ? toStructuredMarkdownList([
            formatTakeoverSource(outcome.transferredFrom),
            `Thread：${outcome.threadId}`,
          ].join("\n"))
        : toStructuredMarkdownList([
            "已恢复 Codex Thread",
            `Thread：${outcome.threadId}`,
            ...(outcome.backgroundedThreadId
              ? [`原任务已转入后台：${outcome.backgroundedThreadId}`]
              : []),
          ].join("\n"));
    case "session.new":
      return outcome.backgroundedThreadId
        ? toStructuredMarkdownList([
            "已切换到新会话，原任务继续在后台运行。",
            `后台 Thread：${outcome.backgroundedThreadId}`,
            "下一条普通消息将创建新的 Codex Thread。",
          ].join("\n"))
        : toStructuredMarkdownList([
            "已退出当前会话，下一条普通消息将创建新的 Codex Thread。",
          ].join("\n"));
    case "thread.archived":
      return toStructuredMarkdownList([
        "已归档 Codex Thread",
        `Thread：${outcome.threadId}`,
        "下一条普通消息将创建新会话。",
      ].join("\n"));
    case "thread.unarchived":
      return toStructuredMarkdownList([
        "已取消归档并切换会话",
        `Thread：${outcome.threadId}`,
      ].join("\n"));
    case "thread.pin-updated":
      return toStructuredMarkdownList([
        outcome.pinned ? "已固定当前会话。" : "已取消固定当前会话。",
      ].join("\n"));
    case "workspace.selected":
      return toStructuredMarkdownList([
        "已切换 Workspace",
        `Workspace：${outcome.workspace.name}`,
        `工作目录：${outcome.workspace.cwd}`,
      ].join("\n"));
    case "turn.stop-requested":
      return outcome.stopped
        ? toStructuredMarkdownList(["已请求停止当前任务。"].join("\n"))
        : toStructuredMarkdownList(["当前没有运行中的任务。"].join("\n"));
    case "turn.follow-up-queued":
      return toStructuredMarkdownList([
        `已排到下一 Turn，当前第 ${outcome.position} 条。队列仅保存在内存，Gateway 重启会清空。`,
      ].join("\n"));
    case "thread.renamed":
      return toStructuredMarkdownList([
        "会话已重命名",
        `名称：${outcome.name}`,
      ].join("\n"));
    case "thread.compaction-requested":
      return toStructuredMarkdownList([
        "已请求压缩当前 Codex Thread。进度将通过标准事件返回。",
      ].join("\n"));
    case "thread.forked":
      return toStructuredMarkdownList([
        "已分叉并切换到新会话",
        `Thread：${outcome.threadId}`,
      ].join("\n"));
    case "review.started":
      return toStructuredMarkdownList([
        "已启动 Codex Review",
        `Turn：${outcome.turnId}`,
      ].join("\n"));
    case "plan.started":
      return toStructuredMarkdownList([
        "已进入 Plan 模式并开始规划",
        `Turn：${outcome.turnId}`,
      ].join("\n"));
    case "skill.started":
      return outcome.steered
        ? toStructuredMarkdownList([
            "已把 Skill 追加到当前任务",
            `Skill：${outcome.skillName}`,
          ].join("\n"))
        : toStructuredMarkdownList([
            "已使用 Skill 开始任务",
            `Skill：${outcome.skillName}`,
            `Turn：${outcome.turnId}`,
          ].join("\n"));
    case "goal.cleared":
      return toStructuredMarkdownList(["已清除当前 Thread Goal。"].join("\n"));
    case "goal.updated":
      return toStructuredMarkdownList([
        "Goal 已设置",
        `目标：${outcome.goal.objective}`,
      ].join("\n"));
  }
}

function formatTakeoverSource(surface: string): string {
  switch (surface) {
    case "telegram":
      return "已从 Telegram 接管 Codex Thread";
    case "feishu":
      return "已从飞书接管 Codex Thread";
    case "weixin":
      return "已从微信接管 Codex Thread";
    default:
      return "已从其他渠道接管 Codex Thread";
  }
}

export function formatConversationWorkspaces(
  result: Extract<ConversationCommandResult, { kind: "workspaces" }>,
): string {
  return toStructuredMarkdownList([
    `Workspace（${result.workspaces.length}）：`,
    ...result.workspaces.flatMap((workspace, index) => [
      `${index + 1}. ${workspace.name} · ${workspace.id}${workspace.id === result.currentWorkspaceId ? " ← 当前" : ""}`,
      workspace.cwd,
    ]),
    "",
    "切换：/workspace <序号、ID 或名称>",
  ].join("\n"));
}

export function formatConversationSkills(
  result: Extract<ConversationCommandResult, { kind: "skills" }>,
): string {
  return result.entries.length === 0
    ? "当前没有已启用的 Skills。"
    : toStructuredMarkdownList([
        `已安装 Skills（${result.entries.length}）：`,
        ...result.entries.map(
          (skill, index) => `${index + 1}. ${skill.name}：${skill.description}`,
        ),
        "",
        "使用：/skill <名称或序号> <任务>",
      ].join("\n"));
}

export function formatConversationMcp(
  result: Extract<ConversationCommandResult, { kind: "mcp" }>,
): string {
  return toStructuredMarkdownList([
    `MCP Servers（${result.servers.length}）：`,
    ...result.servers.map(
      (server) =>
        `- ${server.name} · auth=${server.authStatus} · tools=${server.toolCount}`,
    ),
  ].join("\n"));
}

export function formatConversationPlugins(
  result: Extract<ConversationCommandResult, { kind: "plugins" }>,
): string {
  return result.result.length === 0
    ? "当前没有已安装 Plugins。"
    : toStructuredMarkdownList([
        `已安装 Plugins（${result.result.length}）：`,
        ...result.result.map(
          (plugin) =>
            `- ${plugin.name} · ${plugin.enabled ? "已启用" : "未启用"}`,
        ),
      ].join("\n"));
}

export function formatConversationPermissions(
  result: Extract<ConversationCommandResult, { kind: "permissions" }>,
): string {
  return toStructuredMarkdownList([
    "当前 Gateway 固定使用配置中的 read-only 或 workspace-write。",
    "可用 Permission Profiles：",
    ...result.profiles.map(
      (profile) =>
        `- ${profile.id} · ${profile.allowed ? "允许" : "受策略禁止"}${profile.description ? ` · ${profile.description}` : ""}`,
    ),
  ].join("\n"));
}

export function formatConversationProjectRules(
  result: Extract<ConversationCommandResult, { kind: "project-rules" }>,
): string {
  return toStructuredMarkdownList([
    result.action === "initialized"
      ? "项目规则已生成并检查通过"
      : "项目规则检查通过",
    `Workspace：${result.projectRoot}`,
    `规则文件：${result.rulesPath}`,
    ...(result.action === "initialized"
      ? ["重启 Codex/App Server 后生效；Gateway 无需重启。"]
      : []),
  ].join("\n"));
}

export function formatConversationArtifacts(
  result: Extract<ConversationCommandResult, { kind: "artifacts" }>,
): string {
  return result.artifacts?.diff?.trim()
    ? [
        `Turn Diff · ${result.artifacts.turnId}`,
        "",
        result.artifacts.diff,
      ].join("\n")
    : "当前 Thread 暂无 Turn Diff。";
}

export function formatConversationCollaborationMode(
  result: Extract<ConversationCommandResult, { kind: "collaboration-mode" }>,
): string {
  const label = result.state.mode === "plan" ? "Plan" : "Default";
  return toStructuredMarkdownList([
    `协作模式：${label}${result.state.pending ? "（下一次 Turn 生效）" : ""}`,
    "",
    result.state.mode === "plan"
      ? "下一条普通消息将按 Plan 模式处理；再次发送 /plan 可切回 Default。"
      : "下一条普通消息将按 Default 模式处理；发送 /plan 可切换到 Plan。",
    "也可发送 /plan <规划需求>，直接进入 Plan 并开始规划。",
  ].join("\n"));
}

export function formatConversationGoal(
  result: Extract<ConversationCommandResult, { kind: "goal" }>,
): string {
  return result.goal
    ? toStructuredMarkdownList([
        `当前 Goal：${result.goal.objective}`,
        `状态：${formatGoalStatus(result.goal.status)}`,
        `Tokens：${formatGoalTokens(result.goal)}`,
      ].join("\n"))
    : "当前 Thread 没有 Goal。使用 /goal set <目标> 设置。";
}

export function formatConversationModels(
  result: Extract<ConversationCommandResult, { kind: "models" }>,
): string {
  const { state } = result;
  const current = state.models.find((model) => model.model === state.model);
  const fast = isFastServiceTier(state.serviceTier, current) ? "开启" : "关闭";
  const providerSwitchNotice = state.providerPending
    ? ["提供商切换将在下一条消息中创建新 Thread；当前 Thread 会保留，可通过 /resume 恢复。", ""]
    : [];
  if (result.view === "fast") {
    return toStructuredMarkdownList([
      `当前模型：${state.model}${state.modelPending ? "（下一次 Turn 生效）" : ""}`,
      `Fast 模式：${fast}${state.serviceTierPending ? "（下一次 Turn 生效）" : ""}`,
      `模型支持：${current && fastServiceTierId(current) ? "支持 Fast" : "不支持 Fast"}`,
      "",
      "切换：/fast [on|off|status]",
    ].join("\n"));
  }
  if (result.view === "effort") {
    return toStructuredMarkdownList([
      `当前模型：${state.model}`,
      `当前思考强度：${state.effort ?? current?.defaultReasoningEffort ?? "模型默认"}${state.effortPending ? "（下一次 Turn 生效）" : ""}`,
      ...(current && fastServiceTierId(current)
        ? [`Fast 模式：${fast}${state.serviceTierPending ? "（下一次 Turn 生效）" : ""}`]
        : []),
      "",
      ...providerSwitchNotice,
      "可用思考强度：",
      ...(current?.supportedReasoningEfforts ?? []).map(
        (option, index) =>
          `${index + 1}. ${option.effort}${option.effort === state.effort ? " ← 当前" : ""} · ${option.description}`,
      ),
      "",
      "切换：/effort <序号或档位>",
    ].join("\n"));
  }
  return toStructuredMarkdownList([
    `当前模型：${state.model}${state.modelPending ? "（下一次 Turn 生效）" : ""}`,
    `思考强度：${state.effort ?? "模型默认"}`,
    ...(current && fastServiceTierId(current)
      ? [`Fast 模式：${fast}${state.serviceTierPending ? "（下一次 Turn 生效）" : ""}`]
      : []),
    "",
    ...providerSwitchNotice,
    `模型列表（${state.models.length}）：`,
    ...state.models.map(
      (model, index) =>
        `${index + 1}. ${model.displayName} · ${model.model}${model.available === false ? ` · 暂不可用${model.unavailableReason ? `（${model.unavailableReason}）` : ""}` : ""}${fastServiceTierId(model) ? " · 支持 Fast" : ""}${model.model === state.model ? " ← 当前" : ""}`,
    ),
    "",
    "切换：/model <序号、模型 ID 或名称>",
  ].join("\n"));
}

export function formatConversationUsage(
  result: Extract<ConversationCommandResult, { kind: "usage" }>,
): string {
  if (result.result.kind === "unsupported") {
    return `${formatCodexProviderLabel(result.result.provider)} 暂不支持账户用量查询。当前 Thread 的 Token 与上下文仍可通过 /status 查看。`;
  }
  if (result.result.kind === "balance") {
    return toStructuredMarkdownList([
      `${formatCodexProviderLabel(result.result.provider)} 账户余额：`,
      `API 可用：${result.result.available ? "是" : "否"}`,
      ...(result.result.balances.length === 0
        ? ["暂无余额信息"]
        : result.result.balances.flatMap((balance) => [
            "",
            `${balance.currency}：`,
            `总余额：${balance.totalBalance}`,
            `赠金余额：${balance.grantedBalance}`,
            `充值余额：${balance.toppedUpBalance}`,
          ])),
    ].join("\n"));
  }
  const daily = [...result.result.usage.daily]
    .sort((left, right) => right.startDate.localeCompare(left.startDate))
    .slice(0, 7);
  return toStructuredMarkdownList([
    "OpenAI Codex 账户用量摘要：",
    `累计 Tokens：${formatMillions(result.result.usage.summary.lifetimeTokens)}`,
    `单日峰值：${formatMillions(result.result.usage.summary.peakDailyTokens)}`,
    `最长 Turn：${formatAccountDuration(result.result.usage.summary.longestRunningTurnSec)}`,
    `当前连续天数：${formatMetric(result.result.usage.summary.currentStreakDays)}`,
    `最长连续天数：${formatMetric(result.result.usage.summary.longestStreakDays)}`,
    "",
    "最近每日用量：",
    ...(daily.length === 0
      ? ["暂无每日数据"]
      : daily.map(
          (entry) => `- ${entry.startDate}：${formatMillions(entry.tokens)}`,
        )),
  ].join("\n"));
}

export function formatConversationLimits(
  result: Extract<ConversationCommandResult, { kind: "limits" }>,
): string {
  if (result.result.kind === "unsupported") {
    return `${formatCodexProviderLabel(result.result.provider)} 暂不支持账户限额查询。可使用 /usage 查看该提供商已接入的账户信息。`;
  }
  const planType = result.result.limits.limits.find(
    (limit) => limit.planType,
  )?.planType;
  return toStructuredMarkdownList([
    "OpenAI Codex 额度：",
    `套餐：${planType ? formatPlanType(planType) : "未知"}`,
    ...result.result.limits.limits.flatMap((limit) => [
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
    ...(result.result.limits.resetCreditsAvailable === null
      ? []
      : ["", `可用额度重置券：${result.result.limits.resetCreditsAvailable}`]),
  ].join("\n"));
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
    `提供商：${formatCodexProviderLabel(status.modelProvider)}`,
    `思考强度：${status.effort ?? "模型默认"}${status.effortPending ? "（下一次 Turn 生效）" : ""}`,
    ...(usesOpenAiAccount(status.modelProvider)
      ? [`Fast 模式：${status.threadId ? (isFastServiceTier(status.serviceTier) ? "开启" : "关闭") : "未知"}${status.fastModePending ? "（下一次 Turn 生效）" : ""}`]
      : []),
    `协作模式：${status.collaborationMode === "plan" ? "Plan" : "Default"}${status.collaborationModePending ? "（下一次 Turn 生效）" : ""}`,
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
      "- **Token**",
      `  - 累计：${formatTokenCount(total.totalTokens)}`,
      `  - 最近模型请求：${formatTokenCount(last.totalTokens)}`,
      `  - 输入命中缓存：${formatTokenCount(total.cachedInputTokens)}`,
      `  - 输入未命中缓存：${formatTokenCount(Math.max(0, total.inputTokens - total.cachedInputTokens))}`,
      `  - 缓存命中率：${formatCacheHitRate(total.inputTokens, total.cachedInputTokens)}`,
      ...(total.cacheWriteInputTokens > 0
        ? [`  - 缓存写入：${formatTokenCount(total.cacheWriteInputTokens)}`]
        : []),
      `  - 输出：${formatTokenCount(total.outputTokens)}`,
      `  - 其中推理输出：${formatTokenCount(total.reasoningOutputTokens)}`,
      `  - 合计：${formatTokenCount(total.inputTokens + total.outputTokens)}`,
      `  - Codex 有效上下文窗口：${modelContextWindow === null ? "未知" : formatTokenCount(modelContextWindow)}`,
    );
  } else if (status.threadId) {
    lines.push("", "当前 Thread 用量：等待 App Server 推送统计");
  }
  if (usesOpenAiAccount(status.modelProvider) && status.weeklyLimit) {
    lines.push(`周限：${formatRemainingRateLimitWindow(status.weeklyLimit)}`);
  }
  return toStructuredMarkdownList(lines.join("\n"));
}

export function formatConversationMetrics(
  result: Extract<ConversationCommandResult, { kind: "metrics" }>,
  priceCurrency?: (
    provider: string | null | undefined,
  ) => DisplayPriceCurrency,
  exchangeRate?: ExchangeRateSnapshot | null,
): string {
  const summary = result.summary;
  if (summary === null) {
    return "当前会话尚未绑定 Thread，暂无请求指标。";
  }
  if ("view" in summary) {
    if (summary.view === "errors") {
      return formatErrorMetricsReport(summary);
    }
    return formatAggregateMetricsReport(summary, priceCurrency, exchangeRate);
  }
  const currency = priceCurrency?.(summary.modelProvider) ?? "usd";
  const lines = [
    "## 请求指标",
    `Thread：${formatThreadId(summary.threadId)}`,
    ...(exchangeRate ? formatExchangeRateLine(exchangeRate) : []),
  ];
  if (summary.latestTurn) {
    const turn = summary.latestTurn;
    lines.push(
      "",
      "### 最近运行聚合",
      `模型请求：${turn.requestCount} 次${turn.unsuccessfulRequestCount > 0 ? `（异常 ${turn.unsuccessfulRequestCount} 次）` : ""}`,
      `模型请求聚合耗时：${formatElapsedDuration(turn.requestDurationMs)}`,
      `- **Token**：${formatTokenCount(turn.inputTokens + turn.outputTokens)}`,
      ...(turn.cachedInputTokens === null
        ? ["  - 缓存：上游未提供完整数据"]
        : [
            `  - 输入命中缓存：${formatTokenCount(turn.cachedInputTokens)}`,
            `  - 输入未命中缓存：${formatTokenCount(Math.max(0, turn.inputTokens - turn.cachedInputTokens))}`,
            `  - 缓存命中率：${formatCacheHitRate(turn.inputTokens, turn.cachedInputTokens)}`,
          ]),
      `  - 输出：${formatTokenCount(turn.outputTokens)}`,
      ...(turn.reasoningOutputTokens > 0
        ? [`  - 其中推理输出：${formatTokenCount(turn.reasoningOutputTokens)}`]
        : []),
      ...(turn.outputTokensPerSecond === null
        ? []
        : [`  - ${formatAggregateOutputSpeed(
            turn.outputTokensPerSecond,
            turn.outputSpeedTimedCount,
            turn.outputSpeedSampleCount,
          )}`]),
      ...formatReferenceCost({
        currency: turn.pricingCurrency,
        totalCostNanos: turn.totalCostNanos,
        inputCostNanos: turn.inputCostNanos,
        cachedInputCostNanos: turn.cachedInputCostNanos,
        outputCostNanos: turn.outputCostNanos,
        pricedRequestCount: turn.pricedRequestCount,
        requestCount: turn.requestCount,
        uncachedInputPricePerMillionNanos:
          turn.uncachedInputPricePerMillionNanos,
        cachedInputPricePerMillionNanos:
          turn.cachedInputPricePerMillionNanos,
        outputPricePerMillionNanos: turn.outputPricePerMillionNanos,
        hasMixedPrices: turn.hasMixedPrices,
      }, currency, exchangeRate),
    );
  } else {
    lines.push("", "### 最近运行聚合", "暂无已记录请求");
  }
  if (summary.threadAggregate) {
    const aggregate = summary.threadAggregate;
    lines.push(
      "",
      "### 当前会话指标累计",
      `Turn：${aggregate.turnCount} 次`,
      `模型请求：${aggregate.requestCount} 次${aggregate.unsuccessfulRequestCount > 0 ? `（异常 ${aggregate.unsuccessfulRequestCount} 次）` : ""}`,
      `模型请求累计耗时：${formatElapsedDuration(aggregate.requestDurationMs)}`,
      `- **Token**：${formatTokenCount(aggregate.inputTokens + aggregate.outputTokens)}`,
      ...(aggregate.cachedInputTokens === null
        ? ["  - 缓存：上游未提供完整数据"]
        : [
            `  - 输入命中缓存：${formatTokenCount(aggregate.cachedInputTokens)}`,
            `  - 输入未命中缓存：${formatTokenCount(Math.max(0, aggregate.inputTokens - aggregate.cachedInputTokens))}`,
            `  - 缓存命中率：${formatCacheHitRate(aggregate.inputTokens, aggregate.cachedInputTokens)}`,
          ]),
      `  - 输出：${formatTokenCount(aggregate.outputTokens)}`,
      ...(aggregate.reasoningOutputTokens > 0
        ? [`  - 其中推理输出：${formatTokenCount(aggregate.reasoningOutputTokens)}`]
        : []),
      ...(aggregate.outputTokensPerSecond === null
        ? []
        : [`  - ${formatAggregateOutputSpeed(
            aggregate.outputTokensPerSecond,
            aggregate.outputSpeedTimedCount,
            aggregate.outputSpeedSampleCount,
          )}`]),
      ...formatReferenceCost(toReferenceCostDisplay(aggregate), currency, exchangeRate),
    );
  }
  if (summary.latestDirectApi) {
    const direct = summary.latestDirectApi;
    lines.push(
      "",
      "### 最近直接 API",
      `API 提供商：${formatProviderLabel(direct.providerName ?? direct.provider)}`,
      `调用模型：${direct.model ?? "未知"}`,
      `状态：${formatRequestStatus(direct.status)}${direct.httpStatus === null ? "" : ` · HTTP ${direct.httpStatus}`}`,
      ...(direct.requestDurationMs === null
        ? []
        : [`耗时：${formatElapsedDuration(direct.requestDurationMs)}`]),
      ...(direct.inputTokens === null ? [] : [`输入：${formatTokenCount(direct.inputTokens)}`]),
      ...(direct.cachedInputTokens === null
        ? []
        : [`  - 命中缓存：${formatTokenCount(direct.cachedInputTokens)}`]),
      ...(direct.outputTokens === null ? [] : [`输出：${formatTokenCount(direct.outputTokens)}`]),
      ...(direct.reasoningOutputTokens === null || direct.reasoningOutputTokens === 0
        ? []
        : [`  - 其中推理输出：${formatTokenCount(direct.reasoningOutputTokens)}`]),
      ...(direct.totalTokens === null ? [] : [`总计：${formatTokenCount(direct.totalTokens)}`]),
      ...(direct.totalCostNanos === null
        ? []
        : [
            ...formatReferenceCost({
              currency: direct.pricingCurrency,
              totalCostNanos: direct.totalCostNanos,
              inputCostNanos: direct.inputCostNanos,
              cachedInputCostNanos: direct.cachedInputCostNanos,
              outputCostNanos: direct.outputCostNanos,
              pricedRequestCount: 1,
              requestCount: 1,
              uncachedInputPricePerMillionNanos:
                direct.uncachedInputPricePerMillionNanos,
              cachedInputPricePerMillionNanos:
                direct.cachedInputPricePerMillionNanos,
              outputPricePerMillionNanos: direct.outputPricePerMillionNanos,
              hasMixedPrices: false,
            }, currency, exchangeRate),
          ]),
    );
  }
  return toStructuredMarkdownList(lines.join("\n"));
}

function formatErrorMetricsReport(
  report: Extract<NonNullable<Extract<
    ConversationCommandResult,
    { kind: "metrics" }
  >["summary"]>, { view: "errors" }>,
): string {
  const failureRate = report.requestCount === 0
    ? 0
    : report.unsuccessfulRequestCount / report.requestCount * 100;
  const lines = [
    "## 请求指标 · 异常请求",
    `范围：最近 ${formatMetricsRange(report.range)}`,
    "",
    `模型请求：${report.requestCount} 次`,
    `异常请求：${report.unsuccessfulRequestCount} 次`,
    `异常率：${formatPercent(failureRate)}`,
  ];
  if (report.groups.length === 0) {
    lines.push("", "本时间范围未记录异常请求。");
    return toStructuredMarkdownList(lines.join("\n"));
  }
  lines.push(
    "",
    "### 异常明细",
    ...report.groups.map((group, index) => {
      const provider = group.providerName
        ? formatProviderLabel(group.providerName)
        : formatCodexProviderLabel(group.provider);
      const status = formatRequestStatus(group.status);
      const httpStatus = group.httpStatus === null
        ? ""
        : ` · HTTP ${group.httpStatus}`;
      return `${index + 1}. ${provider} / ${group.model ?? "未知模型"} · ${formatMetricsErrorType(group.errorType)} · ${status}${httpStatus} · ${group.requestCount} 次 · 最近发生：${formatMetricOccurredAt(group.lastOccurredAtMs)}`;
    }),
  );
  const hidden = report.totalGroupCount - report.groups.length;
  if (hidden > 0) {
    lines.push(`仅显示出现次数最高的 ${report.groups.length} 项，另有 ${hidden} 项。`);
  }
  return toStructuredMarkdownList(lines.join("\n"));
}

export function toStructuredMarkdownList(text: string): string {
  const output: string[] = [];
  let firstContent = true;
  let fenced = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      output.push("");
      continue;
    }
    if (/^```/u.test(trimmed)) {
      fenced = !fenced;
      output.push(line);
      continue;
    }
    if (fenced) {
      output.push(line);
      continue;
    }
    if (firstContent) {
      firstContent = false;
      if (/^#{1,6}\s+/u.test(trimmed)) {
        output.push(trimmed);
        continue;
      }
      output.push(`## ${stripTrailingColon(trimmed)}`);
      continue;
    }
    if (/^#{1,6}\s+/u.test(trimmed)) {
      output.push(trimmed);
      continue;
    }
    if (/^\s{2,}[-*+]\s+/u.test(line)) {
      output.push(line);
      continue;
    }
    if (/^\s*[-*+]\s+/u.test(line) || /^\s*\d+[.)]\s+/u.test(line)) {
      output.push(line);
      continue;
    }
    if (trimmed.endsWith("：")) {
      output.push(`### ${stripTrailingColon(trimmed)}`);
      continue;
    }
    output.push(`- ${trimmed}`);
  }
  return output.join("\n");
}

function stripTrailingColon(value: string): string {
  return value.endsWith("：") ? value.slice(0, -1) : value;
}

function formatThreadId(threadId: string): string {
  return threadId.length > 12
    ? `${threadId.slice(0, 12)}…`
    : threadId;
}

function formatMetricsErrorType(value: string | null): string {
  if (value === null) return "未提供错误类型";
  const knownLabel = {
    websocket_closed: "WebSocket 提前关闭",
    upstream_request_error: "上游请求失败",
    upstream_response_error: "上游响应失败",
    client_request_error: "客户端请求失败",
    client_disconnected: "客户端提前断开",
    response_not_observed: "响应结果未完整观测",
    http_error: "HTTP 请求失败",
  }[value];
  if (knownLabel !== undefined) return knownLabel;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
    ? value
    : "其他错误";
}

function formatMetricOccurredAt(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatAggregateMetricsReport(
  report: Extract<NonNullable<Extract<
    ConversationCommandResult,
    { kind: "metrics" }
  >["summary"]>, { view: "global" | "providers" | "models" }>,
  priceCurrency?: (
    provider: string | null | undefined,
  ) => DisplayPriceCurrency,
  exchangeRate?: ExchangeRateSnapshot | null,
): string {
  const viewName = {
    global: "全局",
    providers: "按提供商",
    models: "按模型",
  }[report.view];
  const lines = [
    `## 请求指标 · ${viewName}`,
    `范围：最近 ${formatMetricsRange(report.range)}`,
    ...(exchangeRate ? formatExchangeRateLine(exchangeRate) : []),
  ];
  if (report.aggregate === null) {
    lines.push("", "本时间范围暂无已记录请求。");
    return toStructuredMarkdownList(lines.join("\n"));
  }
  lines.push(
    "",
    "### 本时间范围累计",
    ...formatMetricsAggregate(
      report.aggregate,
      priceCurrency?.(null) ?? "usd",
      exchangeRate,
    ),
  );
  if (report.view !== "global" && report.groups.length > 0) {
    const groupView = report.view === "providers" ? "providers" : "models";
    lines.push(
      "",
      groupView === "providers" ? "### 提供商明细" : "### 模型明细",
      ...report.groups.map((group, index) => formatMetricsGroup(
        group,
        index,
        groupView,
        priceCurrency?.(group.provider) ?? "usd",
        exchangeRate,
      )),
    );
    const hidden = report.totalGroupCount - report.groups.length;
    if (hidden > 0) {
      lines.push(`仅显示请求量最高的 ${report.groups.length} 项，另有 ${hidden} 项。`);
    }
  }
  return toStructuredMarkdownList(lines.join("\n"));
}

function formatMetricsAggregate(
  aggregate: {
  requestCount: number;
  unsuccessfulRequestCount: number;
  requestDurationMs: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number;
  outputTokensPerSecond: number | null;
  outputSpeedSampleCount: number;
  outputSpeedTimedCount: number;
  ttftAverageMs: number | null;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  ttftSampleCount: number;
  pricingCurrency: string | null;
  pricedRequestCount: number;
  totalCostNanos: number | null;
  inputCostNanos: number | null;
  cachedInputCostNanos: number | null;
  outputCostNanos: number | null;
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
  hasMixedPrices: boolean;
  },
  currency: DisplayPriceCurrency,
  exchangeRate?: ExchangeRateSnapshot | null,
): string[] {
  return [
    `模型请求：${aggregate.requestCount} 次${aggregate.unsuccessfulRequestCount > 0 ? `（异常 ${aggregate.unsuccessfulRequestCount} 次）` : ""}`,
    `模型请求累计耗时：${formatElapsedDuration(aggregate.requestDurationMs)}`,
    `- **Token**：${formatTokenCount(aggregate.inputTokens + aggregate.outputTokens)}`,
    ...(aggregate.cachedInputTokens === null
      ? ["  - 缓存：上游未提供完整数据"]
      : [
          `  - 输入命中缓存：${formatTokenCount(aggregate.cachedInputTokens)}`,
          `  - 输入未命中缓存：${formatTokenCount(Math.max(0, aggregate.inputTokens - aggregate.cachedInputTokens))}`,
          `  - 缓存命中率：${formatCacheHitRate(aggregate.inputTokens, aggregate.cachedInputTokens)}`,
        ]),
    `  - 输出：${formatTokenCount(aggregate.outputTokens)}`,
    ...(aggregate.reasoningOutputTokens > 0
      ? [`  - 其中推理输出：${formatTokenCount(aggregate.reasoningOutputTokens)}`]
      : []),
    ...(aggregate.outputTokensPerSecond === null
      ? []
      : [`  - ${formatAggregateOutputSpeed(
          aggregate.outputTokensPerSecond,
          aggregate.outputSpeedTimedCount,
          aggregate.outputSpeedSampleCount,
        )}`]),
    ...(aggregate.ttftAverageMs === null || aggregate.ttftP50Ms === null || aggregate.ttftP95Ms === null
      ? []
      : [
          `  - 首段回复延迟：平均 ${formatMetricLatency(aggregate.ttftAverageMs)} · P50 ${formatMetricLatency(aggregate.ttftP50Ms)} · P95 ${formatMetricLatency(aggregate.ttftP95Ms)}（覆盖 ${aggregate.ttftSampleCount}/${aggregate.requestCount} 次请求）`,
        ]),
    ...formatReferenceCost(toReferenceCostDisplay(aggregate), currency, exchangeRate),
  ];
}

function formatMetricsGroup(
  group: {
    provider: string | null;
    providerName?: string;
    model: string | null;
    aggregate: Parameters<typeof formatMetricsAggregate>[0];
  },
  index: number,
  view: "providers" | "models",
  currency: DisplayPriceCurrency,
  exchangeRate?: ExchangeRateSnapshot | null,
): string {
  const provider = group.providerName
    ? formatProviderLabel(group.providerName)
    : group.provider === null
      ? "未知提供商"
      : formatCodexProviderLabel(group.provider);
  const label = view === "models"
    ? `${provider} / ${group.model ?? "未知模型"}`
    : provider;
  const aggregate = group.aggregate;
  const cache = aggregate.cachedInputTokens === null
    ? "（缓存未知）"
    : `（命中 ${formatTokenCount(aggregate.cachedInputTokens)} · 未命中 ${formatTokenCount(Math.max(0, aggregate.inputTokens - aggregate.cachedInputTokens))} · ${formatCacheHitRate(aggregate.inputTokens, aggregate.cachedInputTokens)}）`;
  const speed = aggregate.outputTokensPerSecond === null
    ? "速度未知"
    : `${formatTokensPerSecond(aggregate.outputTokensPerSecond)}`;
  const latency = aggregate.ttftP50Ms === null || aggregate.ttftP95Ms === null
    ? "首段延迟未知"
    : `首段 P50/P95 ${formatMetricLatency(aggregate.ttftP50Ms)}/${formatMetricLatency(aggregate.ttftP95Ms)}`;
  const reasoning = aggregate.reasoningOutputTokens > 0
    ? `（其中推理 ${formatTokenCount(aggregate.reasoningOutputTokens)}）`
    : "";
  const referenceCost = toReferenceCostDisplay(aggregate);
  const cost = aggregate.pricedRequestCount === 0
    ? "参考总价未知"
    : `参考总价：${formatReferenceCostTotal(
        toDisplayReferenceCost(referenceCost, currency, exchangeRate ?? null),
      )}`;
  return [
    `${index + 1}. ${label}`,
    `  - 请求：${aggregate.requestCount} 次${aggregate.unsuccessfulRequestCount > 0 ? `（异常 ${aggregate.unsuccessfulRequestCount} 次）` : ""}`,
    `  - 输入：${formatTokenCount(aggregate.inputTokens)} ${cache}`,
    `  - 输出：${formatTokenCount(aggregate.outputTokens)}${reasoning}`,
    `  - 合计：${formatTokenCount(aggregate.inputTokens + aggregate.outputTokens)}`,
    `  - 速度：${speed}`,
    `  - ${latency}`,
    `  - ${cost}`,
    ...formatReferenceCostBreakdown(
      toDisplayReferenceCost(referenceCost, currency, exchangeRate ?? null),
    ).map((line) => `    - ${line}`),
  ].join("\n");
}

function formatReferenceCost(
  value: ReferenceCostDisplay,
  currency: DisplayPriceCurrency,
  exchangeRate?: ExchangeRateSnapshot | null,
): string[] {
  const display = toDisplayReferenceCost(value, currency, exchangeRate ?? null);
  return [
    `- **费用**：${formatReferenceCostTotal(display)}`,
    ...formatReferenceCostBreakdown(display).map((line) => `  - ${line}`),
  ];
}

function toReferenceCostDisplay(value: {
  requestCount: number;
  pricingCurrency: string | null;
  pricedRequestCount: number;
  totalCostNanos: number | null;
  inputCostNanos: number | null;
  cachedInputCostNanos: number | null;
  outputCostNanos: number | null;
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
  hasMixedPrices: boolean;
}): ReferenceCostDisplay {
  return {
    currency: value.pricingCurrency,
    totalCostNanos: value.totalCostNanos,
    inputCostNanos: value.inputCostNanos,
    cachedInputCostNanos: value.cachedInputCostNanos,
    outputCostNanos: value.outputCostNanos,
    pricedRequestCount: value.pricedRequestCount,
    requestCount: value.requestCount,
    uncachedInputPricePerMillionNanos:
      value.uncachedInputPricePerMillionNanos,
    cachedInputPricePerMillionNanos:
      value.cachedInputPricePerMillionNanos,
    outputPricePerMillionNanos: value.outputPricePerMillionNanos,
    hasMixedPrices: value.hasMixedPrices,
  };
}

function formatMetricsRange(range: "24h" | "7d" | "30d"): string {
  return { "24h": "24 小时", "7d": "7 天", "30d": "30 天" }[range];
}

function formatMetricLatency(value: number): string {
  const rounded = Math.round(value);
  return rounded < 1_000
    ? `${rounded}毫秒`
    : formatElapsedDuration(rounded);
}

function formatAggregateOutputSpeed(
  outputTokensPerSecond: number,
  timedCount: number,
  sampleCount: number,
): string {
  return `综合输出速度：${formatTokensPerSecond(outputTokensPerSecond)}（不含推理 · 覆盖 ${timedCount}/${sampleCount} 次请求）`;
}

function formatSessionLabel(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return "未命名";
  }
  return normalized.length > maximumSessionLabelCharacters
    ? `${normalized.slice(0, maximumSessionLabelCharacters - 1)}…`
    : normalized;
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

function formatRequestStatus(
  status: "completed" | "failed" | "incomplete" | "unknown",
): string {
  switch (status) {
    case "completed": return "已完成";
    case "failed": return "失败";
    case "incomplete": return "未完成";
    case "unknown": return "未知";
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
      ).toLocaleString("zh-CN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}%`
    : "未知";
}

function formatAccountLimitWindow(
  window: Parameters<typeof formatRateLimitWindow>[0],
): string {
  return formatRateLimitWindow(window);
}

function formatMetric(value: bigint | number | null): string {
  return value === null ? "未知" : String(value);
}

function formatAccountDuration(value: bigint | number | null): string {
  return value === null ? "未知" : formatElapsedSeconds(value);
}

function formatMillions(value: bigint | number | null): string {
  return value === null
    ? "未知"
    : `${(Number(value) / 1_000_000).toLocaleString("zh-CN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })} M`;
}
