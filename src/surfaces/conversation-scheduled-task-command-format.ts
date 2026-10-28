import type {
  ConversationCommandOutcome,
  ConversationCommandResult,
} from "../application/index.js";

import { formatDisplayedProvider } from "./provider-format.js";
import { toStructuredMarkdownList } from "./markdown-list.js";
import { formatReasoningEffort, reasoningEffortSettingName } from "./reasoning-effort-format.js";
import { formatModelSettingLiteral } from "./conversation-model-account-command-format.js";

export function formatConversationScheduledTasks(
  result: Extract<ConversationCommandResult, { kind: "scheduled-tasks" }>,
  selectionMode: "snapshot" | "id" = "snapshot",
  interaction: "text" | "buttons" = "text",
  formatLiteral: (value: string) => string = value => value,
): string {
  const { tasks, selectors, page, pageCount, totalTaskCount } = result.result;
  const literal = (value: string) => formatModelSettingLiteral(value, formatLiteral);
  if (tasks.length === 0) {
    return toStructuredMarkdownList([
      "Gateway 计划任务为空",
      `第 ${page}/${pageCount} 页 · 共 ${totalTaskCount} 项`,
      interaction === "buttons" ? "点击填写计划需求，说明运行时间、时区与任务内容。"
        : "新增：/schedule add interval <N>m|h <时区> <文本> · /schedule add once <YYYY-MM-DD> <HH:mm> <时区> <文本>",
    ].join("\n"));
  }
  return toStructuredMarkdownList([
    `Gateway 计划任务（第 ${page}/${pageCount} 页 · 共 ${totalTaskCount} 项）：`,
    ...tasks.map((task, index) => [
      `${selectionMode === "snapshot" ? `【${selectors[index] ?? "?"}】` : ""}${literal(task.name)} · ${formatScheduledTaskStatusLabel(task.status)}`,
      `   ID：${task.taskId}`,
      `   计划：${formatSchedule(task.schedule, task.timezone)}`,
      `   下次运行：${formatScheduledAt(task.nextRunAt)}`,
      `   Workspace：${literal(task.workspaceId)} · 模型：${literal(formatDisplayedProvider(task.modelProvider))}/${literal(task.model || "默认")} · ${task.sandbox}`,
      "",
    ].join("\n")),
    "",
    interaction === "buttons" ? "选择任务查看每次执行结果与终态。" : "此处列出任务定义；每次执行结果与终态：/schedule runs <任务>",
    ...(interaction === "text" ? [
      "立即运行：/schedule run <任务>",
      "暂停／恢复计划：/schedule pause <任务> · /schedule resume <任务>",
      "重命名：/schedule rename <任务> <新名称>",
      "删除预览：/schedule delete <任务>",
      "暂停、删除不会停止已运行任务。",
    ] : []),
    selectionMode === "snapshot"
      ? "数字序号只对最近五分钟的本会话列表有效。"
      : "schedule_task 的 selector 必须使用完整任务 ID；本次查询不更新 /schedule 的数字选择快照。",
    ...(page > 1 ? [`上一页：/schedule list ${page - 1}`] : []),
    ...(page < pageCount ? [`下一页：/schedule list ${page + 1}`] : []),
  ].join("\n"));
}

export function formatConversationScheduledRuns(
  result: Extract<ConversationCommandResult, { kind: "scheduled-runs" }>,
  selectionMode: "snapshot" | "id" = "snapshot",
  interaction: "text" | "buttons" = "text",
  formatLiteral: (value: string) => string = value => value,
): string {
  const { task, runs, page, pageCount, totalRunCount } = result.result;
  const literal = (value: string) => formatModelSettingLiteral(value, formatLiteral);
  return toStructuredMarkdownList([
    "计划任务运行记录",
    `任务：${literal(task.name)} · ${task.taskId}`,
    ...(interaction === "text" ? [
      `状态：${formatScheduledTaskStatusLabel(task.status)}`,
      `计划：${formatSchedule(task.schedule, task.timezone)}`,
      `下次运行：${formatScheduledAt(task.nextRunAt)}`,
    ] : []),
    `第 ${page}/${pageCount} 页 · 共 ${totalRunCount} 条`,
    "运行记录：",
    ...(runs.length === 0
      ? ["当前没有运行记录。"]
      : runs.map((run) => [
          `- ${selectionMode === "snapshot" ? `【${run.selector}】` : ""}${run.runId} · ${scheduledRunStateLabel(run.state)}`,
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
    ...(interaction === "text" ? [
      `立即运行：/schedule run ${task.taskId}`,
      task.status === "paused" ? `恢复计划：/schedule resume ${task.taskId}` : `暂停计划：/schedule pause ${task.taskId}`,
      `重命名：/schedule rename ${task.taskId} <新名称>`,
      `删除预览：/schedule delete ${task.taskId}`,
      "返回列表：/schedule list",
      "暂停、删除不会停止已运行任务。",
    ] : []),
    interaction === "buttons" ? "结果未知的运行可点击重试；未列出的项使用 /schedule retry 后填写完整 Run ID。" : selectionMode === "snapshot"
      ? "uncertain Run 可使用 /schedule retry <Run ID 或列表序号>"
      : "uncertain Run 可使用 schedule_task action=retry，selector 必须为完整 Run ID；本次查询不更新 /schedule 的数字选择快照。",
    ...(page > 1 ? [`上一页：/schedule runs ${task.taskId} ${page - 1}`] : []),
    ...(page < pageCount ? [`下一页：/schedule runs ${task.taskId} ${page + 1}`] : []),
  ].join("\n"));
}

export function formatConversationScheduledConfirmation(
  result: Extract<ConversationCommandResult, { kind: "scheduled-confirmation" }>,
  formatLiteral: (value: string) => string = value => value,
): string {
  const { preview } = result;
  const literal = (value: string) => formatModelSettingLiteral(value, formatLiteral);
  return toStructuredMarkdownList([
    preview.action === "create"
      ? "计划任务创建预览（尚未保存）"
      : "计划任务删除预览（尚未删除）",
    `名称：${literal(preview.task.name)}`,
    ...(preview.action === "delete" ? [`任务：${preview.task.taskId}`] : []),
    `计划：${formatSchedule(preview.task.schedule, preview.task.timezone)}`,
    `Workspace：${literal(preview.task.workspaceId)}`,
    `模型：${literal(formatDisplayedProvider(preview.task.modelProvider))}/${literal(preview.task.model || "默认")}`,
    `${reasoningEffortSettingName(preview.task.reasoningEffort)}：${formatReasoningEffort(preview.task.reasoningEffort, "默认")}`,
    `下次运行：${formatScheduledAt(preview.task.nextRunAt)}`,
    `Sandbox：${preview.task.sandbox}`,
    `权限 Profile：${literal(preview.task.permissions ?? "未配置")}`,
    "网络：沿用目标 App Server 的项目配置；无人值守审批一律拒绝",
    "Approval Policy：never（无人值守请求将安全拒绝）",
    "该任务将在用户不在线时由 Gateway 无人值守执行。",
    `任务摘要：${literal(preview.task.promptPreview)}`,
    "返回列表：/schedule list（不会撤销确认码）",
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
    case "interval": return `${formatIntervalMinutes(schedule.intervalMinutes)} · ${timezone}`;
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
  return value === null ? "无" : `${new Date(value).toISOString()}（UTC）`;
}
