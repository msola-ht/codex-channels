import {
  isFastServiceTier,
  type ConversationCommandOutcome,
  type ConversationStatus,
} from "../application/index.js";
import type { ThreadGoal } from "../conversation-core/index.js";

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
