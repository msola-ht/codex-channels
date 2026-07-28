import {
  isFastServiceTier,
  type AccountRateLimitWindow,
  type ConversationCommandName,
  type ConversationCommandOutcome,
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
