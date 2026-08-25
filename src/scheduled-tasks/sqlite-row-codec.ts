import {
  normalizeSchedule,
  validateIanaTimeZone,
} from "./schedule.js";
import { ScheduledTaskSchemaError } from "./sqlite-schema.js";
import {
  scheduledTasksSchemaVersion,
  type Schedule,
  type ScheduledRun,
  type ScheduledRunErrorCategory,
  type ScheduledRunState,
  type ScheduledTask,
  type ScheduledTaskSandbox,
  type ScheduledTaskStatus,
} from "./types.js";

const maxDateMs = 8_640_000_000_000_000;
const schemaVersion = scheduledTasksSchemaVersion;

export interface TaskRow {
  task_id: string;
  name: string;
  status: string;
  created_at: number;
  updated_at: number;
  surface: string;
  account_id: string;
  conversation_id: string;
  actor_id: string;
  workspace_id: string;
  prompt: string;
  schedule_type: string | null;
  schedule_json: string | null;
  timezone: string | null;
  anchor_at: number | null;
  next_run_at: number | null;
  model_provider: string | null;
  model: string | null;
  reasoning_effort: string | null;
  service_tier: string | null;
  sandbox: string | null;
  approval_policy: string | null;
  permissions: string | null;
}

export interface RunRow {
  run_id: string;
  task_id: string;
  scheduled_for: number;
  state: string;
  thread_id: string | null;
  turn_id: string | null;
  dispatch_started_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  error_category: string | null;
  error_message: string | null;
}

export function scheduleAnchorAt(schedule: Schedule): number | null {
  if (schedule.type === "interval") return schedule.anchorAt;
  if (schedule.type === "once" && "afterMinutes" in schedule) return schedule.anchorAt;
  return null;
}

export function taskFromRow(row: TaskRow): ScheduledTask {
  requirePersistedTimestamp(row.created_at, "created_at");
  requirePersistedTimestamp(row.updated_at, "updated_at");
  if (row.updated_at < row.created_at) {
    throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error("Task 时间戳倒退"));
  }
  if (row.next_run_at !== null) requirePersistedTimestamp(row.next_run_at, "next_run_at");
  let schedule: Schedule | null;
  try {
    schedule = row.schedule_json === null
      ? null
      : normalizeSchedule(JSON.parse(row.schedule_json) as Schedule);
  } catch (error) {
    throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error("任务 Schedule 数据无效", { cause: error }));
  }
  let timezone: string | null;
  try {
    timezone = row.timezone === null ? null : validateIanaTimeZone(row.timezone);
  } catch (error) {
    throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error("任务时区数据无效", { cause: error }));
  }
  if (
    (schedule === null && (row.schedule_type !== null || row.timezone !== null || row.next_run_at !== null))
    || (schedule !== null && (row.schedule_type !== schedule.type || timezone === null))
    || (schedule !== null && scheduleAnchorAt(schedule) !== row.anchor_at)
    || (row.sandbox === null && (row.approval_policy !== null || row.permissions !== null))
  ) {
    throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error("任务 Schedule 结构不一致"));
  }
  return Object.freeze({
    taskId: row.task_id,
    name: row.name,
    status: parseTaskStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    surface: row.surface,
    accountId: row.account_id,
    conversationId: row.conversation_id,
    actorId: row.actor_id,
    workspaceId: row.workspace_id,
    prompt: row.prompt,
    schedule,
    timezone,
    nextRunAt: row.next_run_at,
    modelProvider: row.model_provider,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    serviceTier: row.service_tier,
    permission: row.sandbox === null
      ? null
      : Object.freeze({
          sandbox: parseSandbox(row.sandbox),
          approvalPolicy: parseApprovalPolicy(row.approval_policy),
          permissions: row.permissions,
        }),
  });
}

export function runFromRow(row: RunRow): ScheduledRun {
  const state = parseRunState(row.state);
  const errorCategory = row.error_category === null ? null : parseErrorCategory(row.error_category);
  requirePersistedTimestamp(row.scheduled_for, "scheduled_for");
  requirePersistedTimestamp(row.dispatch_started_at, "dispatch_started_at");
  requirePersistedTimestamp(row.started_at, "started_at");
  requirePersistedTimestamp(row.completed_at, "completed_at");
  if (row.started_at !== null && row.dispatch_started_at !== null && row.started_at < row.dispatch_started_at) {
    throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error("Run started_at 时间戳倒退"));
  }
  const terminalLowerBound = row.started_at ?? row.dispatch_started_at;
  if (row.completed_at !== null && terminalLowerBound !== null && row.completed_at < terminalLowerBound) {
    throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error("Run completed_at 时间戳倒退"));
  }
  if (state === "dispatching" && (row.dispatch_started_at === null || row.started_at !== null || row.completed_at !== null)) {
    throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error("dispatching Run 时间戳结构无效"));
  }
  if (state === "running" && (row.dispatch_started_at === null || row.started_at === null || row.completed_at !== null)) {
    throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error("running Run 时间戳结构无效"));
  }
  if (state !== "dispatching" && state !== "running" && row.completed_at === null) {
    throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error("终态 Run 缺少 completed_at"));
  }
  return Object.freeze({
    runId: row.run_id,
    taskId: row.task_id,
    scheduledFor: row.scheduled_for,
    state,
    threadId: row.thread_id,
    turnId: row.turn_id,
    dispatchStartedAt: row.dispatch_started_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorCategory,
    errorMessage: errorCategory === null ? null : errorMessageForRun(state, errorCategory),
  });
}

function parseTaskStatus(value: string): ScheduledTaskStatus {
  if (
    value === "active"
    || value === "paused"
    || value === "blocked"
    || value === "finished"
    || value === "deleted"
  ) return value;
  throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion);
}

function parseSandbox(value: string): ScheduledTaskSandbox {
  if (value === "read-only" || value === "workspace-write") return value;
  throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion);
}

function parseApprovalPolicy(value: string | null): "never" {
  if (value === "never") return value;
  throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion);
}

function parseRunState(value: string): ScheduledRunState {
  const states: readonly ScheduledRunState[] = [
    "dispatching", "running", "completed", "failed", "interrupted", "uncertain",
    "missed", "skipped_overlap", "skipped_capacity", "blocked",
  ];
  if ((states as readonly string[]).includes(value)) return value as ScheduledRunState;
  throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion);
}

function parseErrorCategory(value: string): ScheduledRunErrorCategory {
  if (isScheduledRunErrorCategory(value)) return value;
  throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion);
}

export function isScheduledRunErrorCategory(value: string): value is ScheduledRunErrorCategory {
  const values: readonly ScheduledRunErrorCategory[] = [
    "authorization", "workspace", "provider", "model", "approval", "capacity", "overlap",
    "missed", "interrupted", "gateway_crash", "unknown",
  ];
  return (values as readonly string[]).includes(value);
}

export function errorMessageForCategory(category: ScheduledRunErrorCategory): string {
  switch (category) {
    case "authorization": return "任务当前未获授权运行";
    case "workspace": return "Workspace 不可用";
    case "provider": return "Provider 不可用";
    case "model": return "模型不可用";
    case "approval": return "无人值守审批被拒绝";
    case "capacity": return "Conversation 后台容量不足";
    case "overlap": return "上一次运行仍在执行";
    case "missed": return "错过了有限补跑窗口";
    case "interrupted": return "运行被中断";
    case "gateway_crash": return "Gateway 在派发结果确认前退出";
    case "unknown": return "运行失败";
  }
}

export function errorMessageForRun(
  state: ScheduledRunState,
  category: ScheduledRunErrorCategory,
): string {
  return state === "uncertain" && category === "unknown"
    ? "运行结果未知，需要人工确认"
    : errorMessageForCategory(category);
}

function requireTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < -maxDateMs || value > maxDateMs) {
    throw new RangeError("时间戳必须是 JS Date 可表示范围内的安全整数 UTC epoch 毫秒");
  }
}

function requirePersistedTimestamp(value: number | null, label: string): void {
  if (value === null) return;
  try {
    requireTimestamp(value);
  } catch (error) {
    throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error(`${label} 时间戳无效`, { cause: error }));
  }
}
