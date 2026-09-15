import type { ConversationCommandOutcome } from "../application/index.js";

import {
  formatQueueItem,
  formatTakeoverSource,
} from "./conversation-session-command-format.js";
import {
  formatSchedule,
  formatScheduledAt,
  formatScheduledTaskStatusLabel,
  scheduledRunStateLabel,
  scheduledTaskOutcomeTitle,
} from "./conversation-scheduled-task-command-format.js";
import {
  formatConversationModel,
  formatDisplayedProvider,
  formatNextMessageModel,
} from "./conversation-model-account-command-format.js";
import { workspacePermissionLines } from "./conversation-workspace-status-command-format.js";
import { toStructuredMarkdownList } from "./markdown-list.js";

export function formatConversationCommandOutcome(
  outcome: ConversationCommandOutcome,
): string {
  switch (outcome.type) {
    case "thread.resumed":
      return outcome.transferredFrom
        ? toStructuredMarkdownList([
            formatTakeoverSource(outcome.transferredFrom),
            `Session ID：${outcome.threadId}`,
            formatConversationModel("会话模型", outcome.model),
            ...(outcome.queuePending
              ? ["Queue 中有待派发条目，已沿用该 Session 自身设置，未应用当前会话的待生效偏好。"]
              : []),
          ].join("\n"))
        : toStructuredMarkdownList([
            "已恢复 Codex Session",
            `Session ID：${outcome.threadId}`,
            formatConversationModel("会话模型", outcome.model),
            ...(outcome.queuePending
              ? ["Queue 中有待派发条目，已沿用该 Session 自身设置，未应用当前会话的待生效偏好。"]
              : []),
            ...(outcome.backgroundedThreadId
              ? [`原任务已转入后台：${outcome.backgroundedThreadId}`]
              : []),
          ].join("\n"));
    case "session.new":
      {
        const recoverableThreadId =
          outcome.backgroundedThreadId ?? outcome.previousThreadId;
        return toStructuredMarkdownList([
          ...(outcome.backgroundedThreadId
            ? [
                "新会话已准备，原任务继续在后台运行。",
                `后台 Session ID：${outcome.backgroundedThreadId}`,
              ]
            : ["已退出当前会话。"]),
          ...(recoverableThreadId
            ? [
                ...(outcome.backgroundedThreadId ? [] : [`Session ID：${recoverableThreadId}`]),
                `恢复会话：/r ${recoverableThreadId}`,
              ]
            : []),
          "发送下一条普通消息时才会创建新的 Codex Session。",
          formatNextMessageModel(outcome.nextModel),
        ].join("\n"));
      }
    case "thread.archived":
      return toStructuredMarkdownList([
        "已归档 Codex Session",
        `Session ID：${outcome.threadId}`,
        "下一条普通消息将创建新会话。",
      ].join("\n"));
    case "sessions.cleaned":
      return toStructuredMarkdownList([
        `已归档 ${outcome.archivedCount} 个会话（Turn ≤ ${outcome.maxTurns}）`,
        ...(outcome.failedCount > 0 ? [`${outcome.failedCount} 个会话因状态变化或归档失败而跳过。`] : []),
      ].join("\n"));
    case "thread.unarchived":
      return toStructuredMarkdownList([
        "已取消归档并切换会话",
        `Session ID：${outcome.threadId}`,
      ].join("\n"));
    case "thread.pin-updated":
      return toStructuredMarkdownList([
        outcome.changed
          ? outcome.pinned
            ? "已固定当前会话。"
            : "已取消固定当前会话。"
          : outcome.pinned
            ? "当前会话已处于固定状态，无需重复操作。"
            : "当前会话未固定，无需取消。若 /resume 列表仍有会话显示“固定”，请先 /resume 该会话，再执行 /unpin。",
      ].join("\n"));
    case "workspace.selected":
      return toStructuredMarkdownList([
        "已切换 Workspace",
        `Workspace：${outcome.workspace.name}`,
        `工作目录：${outcome.workspace.cwd}`,
        formatNextMessageModel(outcome.nextModel),
      ].join("\n"));
    case "workspace.permissions-updated":
      return toStructuredMarkdownList([
        "已更新工作区权限",
        `Workspace：${outcome.workspace.name}`,
        ...workspacePermissionLines(outcome.workspace),
        "",
        "权限已热加载；对新建或恢复的 Session 生效，不改变已绑定 Session。",
      ].join("\n"));
    case "turn.stop-requested":
      return outcome.stopped
        ? toStructuredMarkdownList(["已请求停止当前任务。"].join("\n"))
        : toStructuredMarkdownList(["当前没有运行中的任务。"].join("\n"));
    case "thread-queue.added":
      return toStructuredMarkdownList([
        "已写入 App Server Queue",
        formatQueueItem(outcome.item),
        "该条目由 App Server 持久保存；Gateway 重启不会清空。",
      ].join("\n"));
    case "thread-queue.updated":
      return toStructuredMarkdownList([
        "已更新 App Server Queue 条目",
        formatQueueItem(outcome.item),
      ].join("\n"));
    case "thread-queue.deleted":
      return toStructuredMarkdownList([
        outcome.deleted ? "已删除 App Server Queue 条目" : "Queue 条目已不存在",
      ].join("\n"));
    case "thread-queue.reordered":
      return toStructuredMarkdownList([
        "已重新排序 App Server Queue",
        `条目：${outcome.itemId}`,
        `位置：${outcome.position}/${outcome.totalItemCount}`,
      ].join("\n"));
    case "thread-queue.started":
      return toStructuredMarkdownList([
        "已启动 App Server Queue 条目",
        `Turn：${outcome.turnId}`,
      ].join("\n"));
    case "thread.reverted":
      return toStructuredMarkdownList([
        "已回退 Session 历史",
        `Session ID：${outcome.threadId}`,
        `边界 Turn：${outcome.beforeTurnId}`,
        "工作区文件和外部副作用不会随历史回退。",
      ].join("\n"));
    case "thread.renamed":
      return toStructuredMarkdownList([
        "会话已重命名",
        `名称：${outcome.name}`,
      ].join("\n"));
    case "thread.compaction-requested":
      return toStructuredMarkdownList([
        "已请求压缩当前 Codex Session。进度将通过标准事件返回。",
      ].join("\n"));
    case "thread.forked":
      return toStructuredMarkdownList([
        "已分叉并切换到新会话",
        `Session ID：${outcome.threadId}`,
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
    case "plugin.started":
      return outcome.steered
        ? toStructuredMarkdownList([
            "已把 Plugin 任务追加到当前任务",
            `Plugin：${outcome.pluginName}`,
          ].join("\n"))
        : toStructuredMarkdownList([
            "已使用 Plugin 开始任务",
            `Plugin：${outcome.pluginName}`,
            `Turn：${outcome.turnId}`,
          ].join("\n"));
    case "agents.started":
      return outcome.steered
        ? toStructuredMarkdownList([
            "已把子代理任务追加到当前任务",
            `角色：${outcome.roleName}`,
          ].join("\n"))
        : toStructuredMarkdownList([
            "已使用子代理开始任务",
            `角色：${outcome.roleName}`,
            `Turn：${outcome.turnId}`,
          ].join("\n"));
    case "goal.cleared":
      return toStructuredMarkdownList(["已清除当前 Session Goal。"].join("\n"));
    case "goal.updated":
      return toStructuredMarkdownList([
        "Goal 已设置",
        `目标：${outcome.goal.objective}`,
      ].join("\n"));
    case "scheduled-task.created":
    case "scheduled-task.deleted":
    case "scheduled-task.renamed":
    case "scheduled-task.paused":
    case "scheduled-task.resumed":
      return toStructuredMarkdownList([
        scheduledTaskOutcomeTitle(outcome.type),
        `名称：${outcome.task.name}`,
        `任务：${outcome.task.taskId}`,
        `状态：${formatScheduledTaskStatusLabel(outcome.task.status)}`,
        `计划：${formatSchedule(outcome.task.schedule, outcome.task.timezone)}`,
        `下次运行：${formatScheduledAt(outcome.task.nextRunAt)}`,
        `模型：${formatDisplayedProvider(outcome.task.modelProvider)}/${outcome.task.model ?? "默认"}`,
        `思考等级：${outcome.task.reasoningEffort ?? "默认"}`,
      ].join("\n"));
    case "scheduled-task.run-requested":
    case "scheduled-task.retry-requested":
      return toStructuredMarkdownList([
        outcome.type === "scheduled-task.run-requested"
          ? "已请求立即运行计划任务"
          : "已解除 uncertain Run 并请求重试",
        `Run：${outcome.run.runId}`,
        `状态：${scheduledRunStateLabel(outcome.run.state)}`,
        `计划时间：${formatScheduledAt(outcome.run.scheduledFor)}`,
        ...(outcome.run.dispatchStartedAt === null
          ? []
          : [`触发时间：${formatScheduledAt(outcome.run.dispatchStartedAt)}`]),
        ...(outcome.run.startedAt === null
          ? []
          : [`开始时间：${formatScheduledAt(outcome.run.startedAt)}`]),
        ...(outcome.run.completedAt === null
          ? []
          : [`完成时间：${formatScheduledAt(outcome.run.completedAt)}`]),
        ...(outcome.run.threadId ? [`Session ID：${outcome.run.threadId}`] : []),
      ].join("\n"));
  }
}
