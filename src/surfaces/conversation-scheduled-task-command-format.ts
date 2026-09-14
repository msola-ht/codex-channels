import type {
  ConversationCommandOutcome,
  ConversationCommandResult,
} from "../application/index.js";

import { formatDisplayedProvider } from "./conversation-model-account-command-format.js";
import { toStructuredMarkdownList } from "./markdown-list.js";

export function formatConversationScheduledTasks(
  result: Extract<ConversationCommandResult, { kind: "scheduled-tasks" }>,
): string {
  const { tasks, selectors, page, pageCount, totalTaskCount } = result.result;
  if (tasks.length === 0) {
    return toStructuredMarkdownList([
      "Gateway 计划任务为空",
      `第 ${page}/${pageCount} 页 · 共 ${totalTaskCount} 项`,
      "新增：/schedule add interval <N>m|h <时区> <文本> · /schedule add once <YYYY-MM-DD> <HH:mm> <时区> <文本>",
    ].join("\n"));
  }
  return toStructuredMarkdownList([
    `Gateway 计划任务（第 ${page}/${pageCount} 页 · 共 ${totalTaskCount} 项）：`,
    ...tasks.map((task, index) => [
      `【${selectors[index] ?? "?"}】${task.name} · ${formatScheduledTaskStatusLabel(task.status)}`,
      `   ID：${task.taskId}`,
      `   计划：${formatSchedule(task.schedule, task.timezone)}`,
      `   下次运行：${formatScheduledAt(task.nextRunAt)}`,
      `   Workspace：${task.workspaceId} · 模型：${formatDisplayedProvider(task.modelProvider)}/${task.model ?? "默认"} · ${task.sandbox}`,
    ].join("\n")),
    "",
    "此处列出循环任务定义；每次执行结果与终态：/schedule runs <任务>",
    "数字序号只对最近五分钟的本会话列表有效。",
    ...(page > 1 ? [`上一页：/schedule list ${page - 1}`] : []),
    ...(page < pageCount ? [`下一页：/schedule list ${page + 1}`] : []),
  ].join("\n"));
}

export function formatConversationScheduledRuns(
  result: Extract<ConversationCommandResult, { kind: "scheduled-runs" }>,
): string {
  const { task, runs, page, pageCount, totalRunCount } = result.result;
  return toStructuredMarkdownList([
    "计划任务运行记录",
    `任务：${task.name} · ${task.taskId}`,
    `第 ${page}/${pageCount} 页 · 共 ${totalRunCount} 条`,
    "运行记录：",
    ...(runs.length === 0
      ? ["当前没有运行记录。"]
      : runs.map((run) => [
          `- 【${run.selector}】${run.runId} · ${scheduledRunStateLabel(run.state)}`,
          `  - 计划时间：${formatScheduledAt(run.scheduledFor)}`,
          ...(run.dispatchStartedAt === null
            ? []
            : [`  - 触发时间：${formatScheduledAt(run.dispatchStartedAt)}`]),
          ...(run.startedAt === null
            ? []
            : [`  - 开始时间：${formatScheduledAt(run.startedAt)}`]),
          ...(run.completedAt === null
            ? []
            : [`  - 完成时间：${formatScheduledAt(run.completedAt)}`]),
          ...(run.threadId ? [`  - Session ID：${run.threadId}`] : []),
          ...(run.errorCategory ? [`  - 分类：${run.errorCategory}`] : []),
        ].join("\n"))),
    "",
    "可用操作：",
    "uncertain Run 可使用 /schedule retry <Run ID 或列表序号>",
    ...(page > 1 ? [`上一页：/schedule runs ${task.taskId} ${page - 1}`] : []),
    ...(page < pageCount ? [`下一页：/schedule runs ${task.taskId} ${page + 1}`] : []),
  ].join("\n"));
}

export function formatConversationScheduledConfirmation(
  result: Extract<ConversationCommandResult, { kind: "scheduled-confirmation" }>,
): string {
  const { preview } = result;
  return toStructuredMarkdownList([
    preview.action === "create"
      ? "计划任务创建预览（尚未保存）"
      : "计划任务删除预览（尚未删除）",
    `名称：${preview.task.name}`,
    ...(preview.action === "delete" ? [`任务：${preview.task.taskId}`] : []),
    `计划：${formatSchedule(preview.task.schedule, preview.task.timezone)}`,
    `Workspace：${preview.task.workspaceId}`,
    `模型：${formatDisplayedProvider(preview.task.modelProvider)}/${preview.task.model ?? "默认"}`,
    `思考等级：${preview.task.reasoningEffort ?? "默认"}`,
    `下次运行：${formatScheduledAt(preview.task.nextRunAt)}`,
    `Sandbox：${preview.task.sandbox}`,
    `权限 Profile：${preview.task.permissions ?? "未配置"}`,
    "网络：沿用 Workspace 当前权限；无人值守审批一律拒绝",
    "Approval Policy：never（无人值守请求将安全拒绝）",
    "该任务将在用户不在线时由 Gateway 无人值守执行。",
    `任务预览：${preview.task.promptPreview}`,
    `确认：/schedule confirm ${preview.token}`,
    "令牌五分钟内有效且只能使用一次。",
  ].join("\n"));
}

export function scheduledTaskOutcomeTitle(type: Extract<ConversationCommandOutcome, {
  type:
    | "scheduled-task.created"
    | "scheduled-task.deleted"
    | "scheduled-task.renamed"
    | "scheduled-task.paused"
    | "scheduled-task.resumed";
}>["type"]): string {
  switch (type) {
    case "scheduled-task.created": return "已创建 Gateway 计划任务";
    case "scheduled-task.deleted": return "已删除 Gateway 计划任务";
    case "scheduled-task.renamed": return "已重命名 Gateway 计划任务";
    case "scheduled-task.paused": return "已暂停 Gateway 计划任务";
    case "scheduled-task.resumed": return "已恢复 Gateway 计划任务";
  }
}

export function formatScheduledTaskStatusLabel(
  status: "active" | "paused" | "blocked" | "finished" | "deleted",
): string {
  switch (status) {
    case "active": return "已启用";
    case "paused": return "已暂停";
    case "blocked": return "已阻止";
    case "finished": return "已完成";
    case "deleted": return "已删除";
  }
}

export function scheduledRunStateLabel(state: Extract<ConversationCommandResult, {
  kind: "scheduled-runs";
}>["result"]["runs"][number]["state"]): string {
  switch (state) {
    case "dispatching": return "正在派发";
    case "running": return "运行中";
    case "completed": return "已完成";
    case "failed": return "失败";
    case "interrupted": return "已中断";
    case "uncertain": return "结果未知";
    case "missed": return "已错过";
    case "skipped_overlap": return "重叠跳过";
    case "skipped_capacity": return "容量跳过";
    case "blocked": return "已阻止";
  }
}

export function formatSchedule(
  schedule: Extract<ConversationCommandResult, { kind: "scheduled-tasks" }>["result"]["tasks"][number]["schedule"],
  timezone: string,
): string {
  switch (schedule.type) {
    case "interval": return `每 ${formatIntervalMinutes(schedule.intervalMinutes)} · ${timezone}`;
    case "once": return "afterMinutes" in schedule
      ? `一次性 ${formatDelayMinutes(schedule.afterMinutes)}后 · ${timezone}`
      : `一次性 ${schedule.date} ${schedule.time} · ${timezone}`;
    case "monthly": return `每月 ${schedule.day} 号 ${schedule.time} · ${timezone}`;
    case "daily": return `每天 ${schedule.time} · ${timezone}`;
    case "weekdays": return `工作日 ${schedule.time} · ${timezone}`;
    case "weekly": return `每周 ${schedule.days.join(",")} ${schedule.time} · ${timezone}`;
  }
}

export function formatDelayMinutes(minutes: number): string {
  if (minutes % 60 === 0 && minutes >= 60) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function formatIntervalMinutes(minutes: number): string {
  return `每 ${formatDelayMinutes(minutes)}`;
}

export function formatScheduledAt(value: number | null): string {
  return value === null ? "无" : new Date(value).toISOString();
}
