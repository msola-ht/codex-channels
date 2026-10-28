import type { ConversationCommandOutcome } from "../application/index.js";

import {
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
  formatNextMessageModel,
} from "./conversation-model-account-command-format.js";
import { formatDisplayedProvider } from "./provider-format.js";
import { toStructuredMarkdownList as structuredMarkdownList } from "./markdown-list.js";
import { formatReasoningEffort, reasoningEffortSettingName } from "./reasoning-effort-format.js";

export function formatConversationCommandOutcome(
  outcome: ConversationCommandOutcome,
  formatLiteral: (value: string) => string = value => value,
  structured = true,
): string {
  const literal = (value: string): string => formatLiteral(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " "));
  const field = (value: string): string => structured ? `- ${value}` : value;
  const toStructuredMarkdownList = structured ? structuredMarkdownList : (value: string): string => value;
  switch (outcome.type) {
    case "thread.resumed":
      return outcome.transferredFrom
        ? toStructuredMarkdownList([
            formatTakeoverSource(outcome.transferredFrom),
            field(`Session ID：${literal(outcome.threadId)}`),
            field(literal(formatConversationModel("会话模型", outcome.model))),
            ...(outcome.queuePending
              ? ["Queue 中有待派发条目，已沿用该 Session 自身设置，未应用当前会话的待生效偏好。"]
              : []),
          ].join("\n"))
        : toStructuredMarkdownList([
            "已恢复 Codex Session",
            field(`Session ID：${literal(outcome.threadId)}`),
            field(literal(formatConversationModel("会话模型", outcome.model))),
            ...(outcome.queuePending
              ? ["Queue 中有待派发条目，已沿用该 Session 自身设置，未应用当前会话的待生效偏好。"]
              : []),
            ...(outcome.backgroundedThreadId
              ? [field(`原会话已保留为后台会话：${literal(outcome.backgroundedThreadId)}`)]
              : []),
          ].join("\n"));
    case "session.new":
      {
        const recoverableThreadId =
          outcome.backgroundedThreadId ?? outcome.previousThreadId;
        return toStructuredMarkdownList([
          ...(outcome.backgroundedThreadId
            ? [
                "新会话已准备，原会话尚不满足释放条件，已保留在后台。",
                field(`后台 Session ID：${literal(outcome.backgroundedThreadId)}`),
              ]
            : ["已退出当前会话。"]),
          ...(recoverableThreadId
            ? [
                ...(outcome.backgroundedThreadId ? [] : [field(`Session ID：${literal(recoverableThreadId)}`)]),
                field(`恢复会话：/r ${literal(recoverableThreadId)}`),
              ]
            : []),
          "发送下一条普通消息时才会创建新的 Codex Session。",
          field(literal(formatNextMessageModel(outcome.nextModel))),
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
        field(`Workspace：${literal(outcome.workspace.name)}`),
        field(`工作目录：${literal(outcome.workspace.cwd)}`),
        field(literal(formatNextMessageModel(outcome.nextModel))),
      ].join("\n"));
    case "turn.stop-requested":
      return outcome.stopped
        ? toStructuredMarkdownList(["已请求停止当前任务。"].join("\n"))
        : toStructuredMarkdownList(["当前没有运行中的任务。"].join("\n"));
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
        field(`名称：${literal(outcome.name)}`),
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
        `模型：${formatDisplayedProvider(outcome.task.modelProvider)}/${outcome.task.model || "默认"}`,
        `${reasoningEffortSettingName(outcome.task.reasoningEffort)}：${formatReasoningEffort(outcome.task.reasoningEffort, "默认")}`,
      ].join("\n"));
    case "scheduled-task.run-requested":
    case "scheduled-task.retry-requested":
      return toStructuredMarkdownList([
        outcome.type === "scheduled-task.run-requested"
          ? "已请求立即运行计划任务"
          : outcome.run.dispatchStartedAt === null
            ? "重试未执行，原 uncertain Run 仍保留"
            : "已解除原 uncertain Run 并领取重试 Run",
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
