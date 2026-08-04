import {
  fastServiceTierId,
  isFastServiceTier,
  type ConversationCommandName,
  type ConversationCommandOutcome,
  type ConversationCommandResult,
  type ConversationStatus,
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
  formatElapsedSeconds,
} from "./elapsed-duration.js";
import { toStructuredMarkdownList } from "./markdown-list.js";
import { formatCodexProviderLabel } from "./provider-format.js";
import {
  formatCacheHitRate,
  formatTokenCount,
} from "./token-format.js";

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
  "workspace-perm": "查看或修改当前工作区权益",
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
      "/status · /workspace [序号|ID|名称] · /workspace-perm",
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

export { toStructuredMarkdownList } from "./markdown-list.js";

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

function formatSessionLabel(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return "未命名";
  }
  return normalized.length > maximumSessionLabelCharacters
    ? `${normalized.slice(0, maximumSessionLabelCharacters - 1)}…`
    : normalized;
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
    case "workspace.entitlements-updated":
      return toStructuredMarkdownList([
        "已更新工作区权益",
        `Workspace：${outcome.workspace.name}`,
        ...workspaceEntitlementLines(outcome.workspace),
        "",
        "权益已热加载；对新建或恢复的 Thread 生效，不改变已绑定 Thread。",
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
      ...workspaceEntitlementLines(workspace),
    ]),
    "",
    "切换：/workspace <序号、ID 或名称>",
  ].join("\n"));
}

export function formatConversationWorkspaceEntitlements(
  result: Extract<
    ConversationCommandResult,
    { kind: "workspace-entitlements" }
  >,
): string {
  const entitlementLines = workspaceEntitlementLines(result.workspace);
  return toStructuredMarkdownList([
    `工作区权益（${result.workspace.name} · ${result.workspace.id}）：`,
    ...(entitlementLines.length > 0
      ? entitlementLines
      : ["未配置（使用全局默认）"]),
    "",
    "修改：",
    "- /workspace-perm sandbox <read-only|workspace-write|danger-full-access|clear>",
    "- /workspace-perm approval <untrusted|on-request|never|clear>",
    "- /workspace-perm profile <Profile ID|clear>",
    "权益热加载后对新建或恢复的 Thread 生效，不改变已绑定 Thread。",
  ].join("\n"));
}

function workspaceEntitlementLines(
  workspace: Extract<ConversationCommandResult, { kind: "workspaces" }>["workspaces"][number],
): string[] {
  const lines: string[] = [];
  if (workspace.sandbox !== undefined) {
    lines.push(`  - 沙箱：${workspaceSandboxLabel(workspace.sandbox)}`);
  }
  if (workspace.approvalPolicy !== undefined) {
    lines.push(`  - 审批：${workspaceApprovalPolicyLabel(workspace.approvalPolicy)}`);
  }
  if (workspace.permissions !== undefined) {
    lines.push(`  - 权限 Profile：${workspace.permissions}`);
  }
  return lines;
}

function workspaceSandboxLabel(
  sandbox: "read-only" | "workspace-write" | "danger-full-access",
): string {
  return ({
    "read-only": "只读",
    "workspace-write": "工作区写",
    "danger-full-access": "完全访问",
  } as const)[sandbox];
}

function workspaceApprovalPolicyLabel(
  policy: "untrusted" | "on-request" | "never",
): string {
  return ({
    untrusted: "不信任",
    "on-request": "按需审批",
    never: "免审批",
  } as const)[policy];
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
      `- **Token**：${formatTokenCount(total.totalTokens)}`,
      `  - 最近模型请求：${formatTokenCount(last.totalTokens)}`,
      `  - 输入命中缓存：${formatTokenCount(total.cachedInputTokens)}`,
      `  - 输入未命中缓存：${formatTokenCount(Math.max(0, total.inputTokens - total.cachedInputTokens))}`,
      `  - 缓存命中率：${formatCacheHitRate(total.inputTokens, total.cachedInputTokens)}`,
      ...(total.cacheWriteInputTokens > 0
        ? [`  - 缓存写入：${formatTokenCount(total.cacheWriteInputTokens)}`]
        : []),
      `  - 输出：${formatTokenCount(total.outputTokens)}`,
      `  - 其中推理输出：${formatTokenCount(total.reasoningOutputTokens)}`,
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

export { formatConversationMetrics } from "./metrics-format.js";

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
