import {
  copyFileSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  assertPrivateDirectoryAccessSync,
  assertPrivateFileAccessSync,
  securePrivateDirectorySync,
  securePrivateFileSync,
} from "../../runtime/private-file.mjs";

import {
  calculateNextRunAt,
  normalizeSchedule,
  ScheduleValidationError,
  validateIanaTimeZone,
} from "./schedule.js";
import {
  errorMessageForCategory,
  errorMessageForRun,
  isScheduledRunErrorCategory,
  runFromRow,
  scheduleAnchorAt,
  taskFromRow,
  type RunRow,
  type TaskRow,
} from "./sqlite-row-codec.js";
import {
  readScheduledTaskUserVersion,
  requireScheduledTaskDatabaseSchema,
  scheduledTaskInitialSchemaSql,
} from "./sqlite-schema.js";
import {
  activeScheduledRunStates,
  scheduledTaskDatabaseFileName,
  scheduledTasksSchemaVersion,
  ScheduledTaskStateError,
  type CreateScheduledTaskInput,
  type ScheduledRun,
  type ScheduledRunErrorCategory,
  type ScheduledRunState,
  type ScheduledTask,
  type ScheduledTaskClaimResult,
  type ScheduledTaskPermission,
  type ScheduledTaskStatus,
  type ScheduledTaskStore,
  type ScheduledUncertainResolution,
} from "./types.js";

export const scheduledTaskRetentionDays = 90 as const;
export const scheduledTaskMaximumRunsPerTask = 200 as const;
const dayMs = 24 * 60 * 60 * 1_000;
const retentionMs = scheduledTaskRetentionDays * dayMs;
const maxDateMs = 8_640_000_000_000_000;
const schemaVersion = scheduledTasksSchemaVersion;

export function scheduledTaskDatabasePath(stateDatabasePath: string): string {
  if (stateDatabasePath === ":memory:") return ":memory:";
  return join(dirname(stateDatabasePath), scheduledTaskDatabaseFileName);
}

export { ScheduledTaskSchemaError } from "./sqlite-schema.js";

export class ScheduledTaskStoreClosedError extends Error {
  readonly code = "scheduled-task.store.closed" as const;

  constructor() {
    super("计划任务数据库已关闭");
    this.name = "ScheduledTaskStoreClosedError";
  }
}

export class SqliteScheduledTaskStore implements ScheduledTaskStore {
  private readonly database: DatabaseSync;
  private closed = false;
  private cleanupCursor: {
    taskId: string;
    scheduledFor: number | undefined;
    runId: string | undefined;
    rank: number;
  } | undefined;

  constructor(readonly path: string) {
    if (path !== ":memory:") {
      const parent = dirname(path);
      ensurePrivateDirectory(parent);
      const source = tryLstat(path);
      if (source?.isSymbolicLink()) throw new Error("计划任务数据库路径不能是符号链接");
      if (source !== undefined && !source.isFile()) throw new Error("计划任务数据库路径必须是普通文件");
      if (source !== undefined && process.platform === "win32") {
        assertPrivateFileAccessSync(path);
      } else if (source !== undefined && (source.mode & 0o777) !== 0o600) {
        throw new Error("计划任务数据库文件权限必须是 0600");
      }
      if (source !== undefined) {
        const existing = new DatabaseSync(path, { readOnly: true });
        try {
          requireScheduledTaskDatabaseSchema(existing);
        } finally {
          existing.close();
        }
      }
    }
    this.database = new DatabaseSync(path);
    try {
      requireScheduledTaskDatabaseSchema(this.database);
      if (path !== ":memory:") securePrivateFileSync(path);
      this.database.exec(
        "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON;",
      );
      this.initializeSchema();
    } catch (error) {
      try {
        this.database.close();
      } catch (closeError) {
        throw new AggregateError([error, closeError], "计划任务数据库初始化和清理均失败", {
          cause: closeError,
        });
      }
      throw error;
    }
  }

  createTask(input: CreateScheduledTaskInput): ScheduledTask {
    this.requireOpen();
    const task = buildTask(input);
    const inserted = this.database
      .prepare(`
        INSERT INTO tasks (
          task_id, name, status, created_at, updated_at,
          surface, account_id, conversation_id, actor_id, workspace_id, prompt,
          schedule_type, schedule_json, timezone, anchor_at, next_run_at,
          model_provider, model, reasoning_effort, service_tier,
          sandbox, approval_policy, permissions
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM tasks
          WHERE surface = ? AND account_id = ? AND conversation_id = ? AND actor_id = ?
            AND status <> 'deleted') < 100
      `)
      .run(
        task.taskId,
        task.name,
        task.status,
        task.createdAt,
        task.updatedAt,
        task.surface,
        task.accountId,
        task.conversationId,
        task.actorId,
        task.workspaceId,
        task.prompt,
        task.schedule?.type ?? null,
        task.schedule === null ? null : JSON.stringify(task.schedule),
        task.timezone,
        task.schedule === null ? null : scheduleAnchorAt(task.schedule),
        task.nextRunAt,
        task.modelProvider,
        task.model,
        task.reasoningEffort,
        task.serviceTier,
        task.permission?.sandbox ?? null,
        task.permission?.approvalPolicy ?? null,
        task.permission?.permissions ?? null,
        task.surface,
        task.accountId,
        task.conversationId,
        task.actorId,
      );
    if (Number(inserted.changes) === 0) {
      throw new ScheduledTaskStateError("每个用户在同一会话最多创建 100 个计划任务，请先删除不再使用的任务");
    }
    return task;
  }

  getTask(taskId: string): ScheduledTask | undefined {
    this.requireOpen();
    const row = this.database
      .prepare("SELECT * FROM tasks WHERE task_id = ?")
      .get(taskId) as unknown as TaskRow | undefined;
    return row === undefined ? undefined : taskFromRow(row);
  }

  listTasks(options: Parameters<ScheduledTaskStore["listTasks"]>[0] = {}): ScheduledTask[] {
    this.requireOpen();
    const includeDeleted = options.includeDeleted === true;
    const values: string[] = [];
    const filters = includeDeleted ? [] : ["status <> 'deleted'"];
    if (options.conversation) {
      filters.push("surface = ?", "account_id = ?", "conversation_id = ?");
      values.push(
        options.conversation.surface,
        options.conversation.accountId,
        options.conversation.conversationId,
      );
    }
    if (options.actorId !== undefined) {
      filters.push("actor_id = ?");
      values.push(options.actorId);
    }
    const where = filters.length === 0 ? "" : ` WHERE ${filters.join(" AND ")}`;
    const rows = this.database
      .prepare(`SELECT * FROM tasks${where} ORDER BY created_at ASC, task_id ASC`)
      .all(...values) as unknown as TaskRow[];
    return rows.map(taskFromRow);
  }

  renameTask(taskId: string, name: string, nowMs = Date.now()): ScheduledTask {
    this.requireOpen();
    this.requireTimestamp(nowMs);
    const task = this.requireTask(taskId);
    if (task.status === "deleted") throw new ScheduledTaskStateError("已删除任务不能重命名");
    this.requireNonDecreasingTimestamp(nowMs, task.updatedAt, "Task updated_at");
    this.database
      .prepare("UPDATE tasks SET name = ?, updated_at = ? WHERE task_id = ? AND status <> 'deleted'")
      .run(requireText(name, "任务名称"), nowMs, taskId);
    return this.requireTask(taskId);
  }

  pauseTask(taskId: string, nowMs = Date.now()): ScheduledTask {
    this.requireTimestamp(nowMs);
    const task = this.requireTask(taskId);
    if (task.status === "paused") return task;
    if (task.status === "deleted") throw new ScheduledTaskStateError("已删除任务不能暂停");
    if (task.status === "finished") throw new ScheduledTaskStateError("已完成任务不能暂停");
    return this.updateTask(taskId, "paused", null, nowMs);
  }

  resumeTask(taskId: string, nowMs = Date.now()): ScheduledTask {
    this.requireTimestamp(nowMs);
    const task = this.requireTask(taskId);
    if (task.status === "active") return task;
    if (task.status === "deleted") throw new ScheduledTaskStateError("已删除任务不能恢复");
    if (task.status === "finished") throw new ScheduledTaskStateError("已完成任务不能恢复");
    if (!task.schedule || !task.timezone) throw new ScheduledTaskStateError("任务 Schedule 不完整");
    const nextRunAt = calculateNextRunAt(task.schedule, task.timezone, nowMs);
    if (nextRunAt === null) {
      return this.updateTask(taskId, "finished", null, nowMs);
    }
    return this.updateTask(taskId, "active", nextRunAt, nowMs);
  }

  blockTask(taskId: string, nowMs = Date.now()): ScheduledTask {
    this.requireTimestamp(nowMs);
    const task = this.requireTask(taskId);
    if (task.status === "deleted") throw new ScheduledTaskStateError("已删除任务不能阻止");
    if (task.status === "blocked") return task;
    if (task.status === "finished") throw new ScheduledTaskStateError("已完成任务不能阻止");
    return this.updateTask(taskId, "blocked", null, nowMs);
  }

  deleteTask(taskId: string, nowMs = Date.now()): ScheduledTask {
    this.requireTimestamp(nowMs);
    const task = this.requireTask(taskId);
    if (task.status === "deleted") return task;
    this.requireNonDecreasingTimestamp(nowMs, task.updatedAt, "Task updated_at");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(`
          UPDATE tasks SET
            name = 'deleted', status = 'deleted', updated_at = ?,
            surface = '', account_id = '', conversation_id = '', actor_id = '', workspace_id = '',
            prompt = '', schedule_type = NULL, schedule_json = NULL, timezone = NULL,
            anchor_at = NULL, next_run_at = NULL,
            model_provider = NULL, model = NULL, reasoning_effort = NULL, service_tier = NULL,
            sandbox = NULL, approval_policy = NULL, permissions = NULL
          WHERE task_id = ? AND status <> 'deleted'
        `)
        .run(nowMs, taskId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.rollback(error);
    }
    return this.requireTask(taskId);
  }

  listDueTasks(nowMs: number, limit = 100): ScheduledTask[] {
    this.requireOpen();
    this.requireTimestamp(nowMs);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("到期任务查询 limit 必须在 1 到 1000 之间");
    }
    const rows = this.database
      .prepare(`
        SELECT * FROM tasks
        WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at ASC, task_id ASC LIMIT ?
      `)
      .all(nowMs, limit) as unknown as TaskRow[];
    return rows.map(taskFromRow);
  }

  listRuns(taskId: string, options: { readonly limit?: number } = {}): ScheduledRun[] {
    this.requireOpen();
    const limit = options.limit ?? scheduledTaskMaximumRunsPerTask;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Run 查询 limit 必须在 1 到 1000 之间");
    }
    const rows = this.database
      .prepare(`
        SELECT * FROM runs WHERE task_id = ?
        ORDER BY scheduled_for DESC, run_id DESC LIMIT ?
      `)
      .all(taskId, limit) as unknown as RunRow[];
    return rows.map(runFromRow);
  }

  listRecoverableRuns(options: { readonly afterRunId?: string; readonly limit?: number } = {}): ScheduledRun[] {
    this.requireOpen();
    const limit = options.limit ?? 200;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("恢复 Run 查询 limit 必须在 1 到 1000 之间");
    }
    const rows = this.database
      .prepare(`
        SELECT * FROM runs
        WHERE state IN ('running', 'uncertain') AND run_id > ?
        ORDER BY run_id ASC LIMIT ?
      `)
      .all(options.afterRunId ?? "", limit) as unknown as RunRow[];
    return rows.map(runFromRow);
  }

  countConversationActiveRuns(conversation: {
    readonly surface: string;
    readonly accountId: string;
    readonly conversationId: string;
  }): number {
    this.requireOpen();
    const row = this.database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM runs
        INNER JOIN tasks ON tasks.task_id = runs.task_id
        WHERE tasks.status <> 'deleted'
          AND tasks.surface = ? AND tasks.account_id = ? AND tasks.conversation_id = ?
          AND runs.state IN ('dispatching', 'running', 'uncertain')
      `)
      .get(conversation.surface, conversation.accountId, conversation.conversationId) as { count: number | bigint };
    return Number(row.count);
  }

  getRun(runId: string): ScheduledRun | undefined {
    this.requireOpen();
    const row = this.database
      .prepare("SELECT * FROM runs WHERE run_id = ?")
      .get(runId) as unknown as RunRow | undefined;
    return row === undefined ? undefined : runFromRow(row);
  }

  claimDue(
    taskId: string,
    scheduledFor: number,
    result: "claimed" | "skipped_overlap" | "skipped_capacity" | "missed" | "blocked",
    nowMs: number,
  ): ScheduledTaskClaimResult {
    this.requireOpen();
    this.requireTimestamp(scheduledFor);
    this.requireTimestamp(nowMs);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.requireTask(taskId);
      if (scheduledFor > nowMs || task.status !== "active" || task.nextRunAt !== scheduledFor) {
        throw new ScheduledTaskStateError("任务 occurrence 已不可领取");
      }
      if (!task.schedule || !task.timezone) {
        throw new ScheduledTaskStateError("任务 Schedule 不完整");
      }
      const blocking = this.database
        .prepare(`
          SELECT state FROM runs
          WHERE task_id = ? AND state IN ('dispatching', 'running', 'uncertain')
          ORDER BY CASE state WHEN 'uncertain' THEN 0 ELSE 1 END LIMIT 1
        `)
        .get(taskId) as { state: string } | undefined;
      const effectiveResult = (result === "claimed" || result === "skipped_capacity") && blocking
        ? blocking.state === "uncertain" ? "blocked" : "skipped_overlap"
        : result;
      const state: ScheduledRunState = effectiveResult === "claimed" ? "dispatching" : effectiveResult;
      const runId = randomUUID();
      this.insertRun(runId, taskId, scheduledFor, state, nowMs);
      const nextRunAt = calculateNextRunAt(task.schedule, task.timezone, scheduledFor);
      this.requireNonDecreasingTimestamp(nowMs, task.updatedAt, "Task updated_at");
      if (nextRunAt === null) {
        this.database
          .prepare("UPDATE tasks SET status = 'finished', next_run_at = NULL, updated_at = ? WHERE task_id = ?")
          .run(nowMs, taskId);
      } else {
        this.database
          .prepare("UPDATE tasks SET next_run_at = ?, updated_at = ? WHERE task_id = ?")
          .run(nextRunAt, nowMs, taskId);
      }
      this.database.exec("COMMIT");
      return { kind: effectiveResult, run: this.requireRun(runId) };
    } catch (error) {
      this.rollback(error);
    }
  }

  claimManual(
    taskId: string,
    nowMs: number,
    result: "claimed" | "skipped_capacity" = "claimed",
  ): ScheduledTaskClaimResult {
    return this.claimManualOccurrence(taskId, nowMs, result);
  }

  claimRetry(runId: string, nowMs: number, result: "claimed" | "skipped_capacity" = "claimed"): ScheduledTaskClaimResult {
    return this.claimManualOccurrence(this.requireRun(runId).taskId, nowMs, result, runId);
  }

  private claimManualOccurrence(taskId: string, nowMs: number, result: "claimed" | "skipped_capacity", retryRunId?: string): ScheduledTaskClaimResult {
    this.requireOpen();
    this.requireTimestamp(nowMs);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.requireTask(taskId);
      const retry = retryRunId === undefined ? undefined : this.requireRun(retryRunId);
      if (retry && (retry.taskId !== taskId || retry.state !== "uncertain")) {
        throw new ScheduledTaskStateError("只有 uncertain Run 可以显式解除后重试");
      }
      if (task.status === "deleted" || task.status === "blocked"
        || (task.status === "finished" && !(retry && task.schedule?.type === "once"))) {
        throw new ScheduledTaskStateError("当前任务状态不允许手动运行");
      }
      const blocking = this.database
        .prepare(`
          SELECT state FROM runs
          WHERE task_id = ? AND state IN ('dispatching', 'running', 'uncertain')
            AND (? IS NULL OR run_id <> ?)
          ORDER BY CASE state WHEN 'uncertain' THEN 0 ELSE 1 END LIMIT 1
        `)
        .get(taskId, retryRunId ?? null, retryRunId ?? null) as { state: string } | undefined;
      const kind = blocking === undefined
        ? result
        : blocking.state === "uncertain" ? "blocked" : "skipped_overlap";
      const state: ScheduledRunState = kind === "claimed" ? "dispatching" : kind;
      const runId = randomUUID();
      const latest = this.database
        .prepare("SELECT MAX(scheduled_for) AS value FROM runs WHERE task_id = ?")
        .get(taskId) as { value: number | null };
      let scheduledFor = Math.max(nowMs, latest.value === null ? nowMs : latest.value + 1);
      // Automatic occurrences share one millisecond remainder: UTC anchors for
      // interval/relative once, whole seconds for local calendar/absolute once.
      // Reserve that entire class, including future occurrences, for claimDue.
      const automaticAnchor = task.schedule === null ? 0 : scheduleAnchorAt(task.schedule) ?? 0;
      const automaticRemainder = ((automaticAnchor % 1_000) + 1_000) % 1_000;
      this.requireTimestamp(scheduledFor);
      while (scheduledFor === task.nextRunAt
        || ((scheduledFor % 1_000) + 1_000) % 1_000 === automaticRemainder) {
        scheduledFor += 1;
        this.requireTimestamp(scheduledFor);
      }
      if (retry && kind === "claimed") this.resolveUncertain(retry.runId, "failed", nowMs);
      this.insertRun(runId, taskId, scheduledFor, state, nowMs);
      this.database.exec("COMMIT");
      return { kind, run: this.requireRun(runId) };
    } catch (error) {
      this.rollback(error);
    }
  }

  markRunning(
    runId: string,
    nowMs: number,
    identifiers: { readonly threadId?: string | null; readonly turnId?: string | null } = {},
  ): ScheduledRun {
    this.requireTimestamp(nowMs);
    const run = this.requireRun(runId);
    if (run.state !== "dispatching") {
      throw new ScheduledTaskStateError(`Run ${runId} 不能从 ${run.state} 转为 running`);
    }
    this.requireRunTimestampAtLeast(nowMs, run, "started_at");
    this.database
      .prepare(`
        UPDATE runs SET state = 'running', thread_id = ?, turn_id = ?, started_at = ?
        WHERE run_id = ? AND state = 'dispatching'
      `)
      .run(identifiers.threadId ?? null, identifiers.turnId ?? null, nowMs, runId);
    return this.requireRun(runId);
  }

  markApprovalRejected(runId: string): ScheduledRun {
    this.requireOpen();
    const run = this.requireRun(runId);
    if (run.state !== "dispatching" && run.state !== "running") {
      throw new ScheduledTaskStateError(
        `Run ${runId} 当前状态为 ${run.state}，不能记录无人值守审批拒绝`,
      );
    }
    this.database
      .prepare(`
        UPDATE runs SET error_category = 'approval', error_message = ?
        WHERE run_id = ? AND state IN ('dispatching', 'running')
      `)
      .run(errorMessageForCategory("approval"), runId);
    return this.requireRun(runId);
  }

  markCompleted(
    runId: string,
    nowMs = Date.now(),
    identifiers: { readonly threadId?: string | null; readonly turnId?: string | null } = {},
  ): ScheduledRun {
    this.requireTimestamp(nowMs);
    const run = this.requireRun(runId);
    if (run.state !== "running") {
      throw new ScheduledTaskStateError(`Run ${runId} 不能从 ${run.state} 转为 completed`);
    }
    // Preserve a rejection persisted during awaited terminal reconciliation.
    if (run.errorCategory === "approval") {
      return this.markFailed(runId, "approval", nowMs, identifiers);
    }
    this.requireRunTimestampAtLeast(nowMs, run, "completed_at");
    this.database
      .prepare(`
        UPDATE runs SET state = 'completed', thread_id = ?, turn_id = ?, completed_at = ?
        WHERE run_id = ? AND state = 'running'
      `)
      .run(
        identifiers.threadId === undefined ? run.threadId : identifiers.threadId,
        identifiers.turnId === undefined ? run.turnId : identifiers.turnId,
        nowMs,
        runId,
      );
    return this.requireRun(runId);
  }

  markFailed(
    runId: string,
    category: ScheduledRunErrorCategory,
    nowMs = Date.now(),
    identifiers: { readonly threadId?: string | null; readonly turnId?: string | null } = {},
  ): ScheduledRun {
    return this.finishRun(runId, "failed", category, nowMs, identifiers);
  }

  markInterrupted(
    runId: string,
    nowMs = Date.now(),
    identifiers: { readonly threadId?: string | null; readonly turnId?: string | null } = {},
  ): ScheduledRun {
    return this.finishRun(runId, "interrupted", "interrupted", nowMs, identifiers);
  }

  markUncertain(
    runId: string,
    nowMs = Date.now(),
    identifiers: { readonly threadId?: string | null; readonly turnId?: string | null } = {},
  ): ScheduledRun {
    return this.finishRun(runId, "uncertain", "unknown", nowMs, identifiers);
  }

  resolveUncertain(
    runId: string,
    resolution: ScheduledUncertainResolution,
    nowMs = Date.now(),
  ): ScheduledRun {
    this.requireOpen();
    this.requireTimestamp(nowMs);
    if (resolution !== "failed" && resolution !== "interrupted") {
      throw new ScheduledTaskStateError("Uncertain Run 解除方式无效");
    }
    const run = this.requireRun(runId);
    if (run.state !== "uncertain") {
      throw new ScheduledTaskStateError(`Run ${runId} 当前状态为 ${run.state}，不能解除 uncertain`);
    }
    this.requireRunTimestampAtLeast(nowMs, run, "completed_at");
    const category = resolution === "interrupted" ? "interrupted" : "unknown";
    this.database
      .prepare(`
        UPDATE runs SET state = ?, completed_at = ?, error_category = ?, error_message = ?
        WHERE run_id = ? AND state = 'uncertain'
      `)
      .run(resolution, nowMs, category, errorMessageForRun(resolution, category), runId);
    return this.requireRun(runId);
  }

  recoverAfterCrash(nowMs = Date.now()): ScheduledRun[] {
    this.requireOpen();
    this.requireTimestamp(nowMs);
    this.database.exec("BEGIN IMMEDIATE");
    let recoveredRunIds: string[] = [];
    try {
      const dispatching = this.database
        .prepare("SELECT * FROM runs WHERE state = 'dispatching' ORDER BY run_id LIMIT 200")
        .all() as unknown as RunRow[];
      recoveredRunIds = dispatching.map((row) => row.run_id);
      for (const row of dispatching) {
        this.requireRunTimestampAtLeast(nowMs, runFromRow(row), "completed_at");
      }
      if (recoveredRunIds.length > 0) this.database
        .prepare(`
          UPDATE runs SET state = 'uncertain', completed_at = ?,
            error_category = 'gateway_crash', error_message = 'Gateway 在派发结果确认前退出'
          WHERE state = 'dispatching' AND run_id IN (${recoveredRunIds.map(() => "?").join(",")})
        `)
        .run(nowMs, ...recoveredRunIds);
      this.database.exec("COMMIT");
    } catch (error) {
      this.rollback(error);
    }
    if (recoveredRunIds.length === 0) return [];
    const placeholders = recoveredRunIds.map(() => "?").join(",");
    const rows = this.database
      .prepare(`SELECT * FROM runs WHERE run_id IN (${placeholders})`)
      .all(...recoveredRunIds) as unknown as RunRow[];
    return rows.map(runFromRow);
  }

  cleanup(nowMs = Date.now()): { deleted: number; complete: boolean } {
    this.requireOpen();
    this.requireTimestamp(nowMs);
    const cutoff = nowMs - retentionMs;
    let deleted = 0;
    let inspected = 0;
    let visited = 0;
    let cursor = this.cleanupCursor && { ...this.cleanupCursor };
    let complete = false;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      // Walk the existing tasks PK and runs_task_idx with keyset cursors.
      // LIMIT bounds rows inspected as well as deleted; no OFFSET or full scan.
      while (inspected < 200 && visited < 16) {
        if (!cursor) {
          const first = this.database.prepare("SELECT task_id FROM tasks ORDER BY task_id LIMIT 1")
            .get() as { task_id: string } | undefined;
          if (!first) { complete = true; break; }
          cursor = { taskId: first.task_id, scheduledFor: undefined, runId: undefined, rank: 0 };
        }
        visited += 1;
        const remaining = 200 - inspected;
        const rows = (cursor.scheduledFor === undefined
          ? this.database.prepare(`SELECT run_id, scheduled_for, completed_at, state FROM runs
              WHERE task_id = ? ORDER BY scheduled_for DESC, run_id DESC LIMIT ?`)
            .all(cursor.taskId, remaining)
          : this.database.prepare(`SELECT run_id, scheduled_for, completed_at, state FROM runs
              WHERE task_id = ? AND (scheduled_for, run_id) < (?, ?)
              ORDER BY scheduled_for DESC, run_id DESC LIMIT ?`)
            .all(cursor.taskId, cursor.scheduledFor, cursor.runId!, remaining)) as Array<{
              run_id: string; scheduled_for: number; completed_at: number | null; state: string;
            }>;
        for (const row of rows) {
          inspected += 1;
          cursor.rank += 1;
          cursor.scheduledFor = row.scheduled_for;
          cursor.runId = row.run_id;
          if (!["dispatching", "running", "uncertain"].includes(row.state)
            && ((row.completed_at ?? row.scheduled_for) < cutoff || cursor.rank > scheduledTaskMaximumRunsPerTask)) {
            deleted += Number(this.database.prepare("DELETE FROM runs WHERE run_id = ?").run(row.run_id).changes);
          }
        }
        if (rows.length === remaining) break;
        const next = this.database.prepare("SELECT task_id FROM tasks WHERE task_id > ? ORDER BY task_id LIMIT 1")
          .get(cursor.taskId) as { task_id: string } | undefined;
        if (!next) { cursor = undefined; complete = true; break; }
        cursor = { taskId: next.task_id, scheduledFor: undefined, runId: undefined, rank: 0 };
      }
      this.database.exec("COMMIT");
      this.cleanupCursor = cursor;
    } catch (error) {
      this.rollback(error);
    }
    return { deleted, complete };
  }

  backup(destinationPath?: string): string {
    this.requireOpen();
    if (this.path === ":memory:") throw new Error("内存数据库不能备份");
    const destination = destinationPath
      ?? `${this.path}.v${schemaVersion}.${backupTimestamp()}.bak`;
    return copyScheduledTaskDatabaseFile(this.path, destination);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private initializeSchema(): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (requireScheduledTaskDatabaseSchema(this.database) === "empty") {
        this.database.exec(scheduledTaskInitialSchemaSql);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.rollback(error);
    }
  }

  private insertRun(
    runId: string,
    taskId: string,
    scheduledFor: number,
    state: ScheduledRunState,
    nowMs: number,
  ): void {
    this.database
      .prepare(`
        INSERT INTO runs (
          run_id, task_id, scheduled_for, state,
          thread_id, turn_id, dispatch_started_at, started_at, completed_at,
          error_category, error_message
        ) VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?)
      `)
      .run(
        runId,
        taskId,
        scheduledFor,
        state,
        state === "dispatching" ? nowMs : null,
        state === "dispatching" ? null : nowMs,
        errorCategoryForState(state),
        errorMessageForState(state),
      );
  }

  private updateTask(
    taskId: string,
    status: Exclude<ScheduledTaskStatus, "deleted">,
    nextRunAt: number | null,
    nowMs: number,
  ): ScheduledTask {
    this.requireOpen();
    this.requireTimestamp(nowMs);
    const task = this.requireTask(taskId);
    this.requireNonDecreasingTimestamp(nowMs, task.updatedAt, "Task updated_at");
    this.database
      .prepare("UPDATE tasks SET status = ?, next_run_at = ?, updated_at = ? WHERE task_id = ? AND status <> 'deleted'")
      .run(status, nextRunAt, nowMs, taskId);
    return this.requireTask(taskId);
  }

  private requireRunTimestampAtLeast(nowMs: number, run: ScheduledRun, label: string): void {
    const lowerBound = Math.max(run.dispatchStartedAt ?? -maxDateMs, run.startedAt ?? -maxDateMs);
    if (nowMs < lowerBound) {
      throw new ScheduledTaskStateError(`${label} 不能早于 Run 已有时间戳`);
    }
  }

  private requireNonDecreasingTimestamp(nowMs: number, previousMs: number, label: string): void {
    if (nowMs < previousMs) {
      throw new ScheduledTaskStateError(`${label} 不能倒退`);
    }
  }

  private finishRun(
    runId: string,
    state: "failed" | "interrupted" | "uncertain",
    category: ScheduledRunErrorCategory,
    nowMs: number,
    identifiers: { readonly threadId?: string | null; readonly turnId?: string | null },
  ): ScheduledRun {
    this.requireTimestamp(nowMs);
    if (!isScheduledRunErrorCategory(category)) {
      throw new ScheduledTaskStateError("Run 错误分类无效");
    }
    const run = this.requireRun(runId);
    if (!activeScheduledRunStates.includes(run.state as (typeof activeScheduledRunStates)[number])) {
      throw new ScheduledTaskStateError(`Run ${runId} 当前状态为 ${run.state}`);
    }
    this.requireRunTimestampAtLeast(nowMs, run, "completed_at");
    this.database
      .prepare(`
        UPDATE runs SET state = ?, thread_id = ?, turn_id = ?, completed_at = ?,
          error_category = ?, error_message = ?
        WHERE run_id = ? AND state IN ('dispatching', 'running')
      `)
      .run(
        state,
        identifiers.threadId === undefined ? run.threadId : identifiers.threadId,
        identifiers.turnId === undefined ? run.turnId : identifiers.turnId,
        nowMs,
        category,
        errorMessageForRun(state, category),
        runId,
      );
    return this.requireRun(runId);
  }

  private requireTask(taskId: string): ScheduledTask {
    const task = this.getTask(taskId);
    if (!task) throw new ScheduledTaskStateError(`任务不存在：${taskId}`);
    return task;
  }

  private requireRun(runId: string): ScheduledRun {
    const run = this.getRun(runId);
    if (!run) throw new ScheduledTaskStateError(`Run 不存在：${runId}`);
    return run;
  }

  private rollback(error: unknown): never {
    try {
      this.database.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "计划任务数据库事务失败且回滚失败", {
        cause: rollbackError,
      });
    }
    throw error;
  }

  private requireTimestamp(value: number): void {
    if (!Number.isSafeInteger(value) || value < -maxDateMs || value > maxDateMs) {
      throw new RangeError("时间戳必须是 JS Date 可表示范围内的安全整数 UTC epoch 毫秒");
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new ScheduledTaskStoreClosedError();
  }
}

export interface ScheduledTaskDatabaseInspection {
  readonly compatible: boolean;
  readonly databasePath: string;
  readonly exists: boolean;
  readonly schemaVersion: number | null;
  readonly targetSchemaVersion: number;
}

export function inspectScheduledTaskDatabaseFile(
  databasePath: string,
): ScheduledTaskDatabaseInspection {
  if (databasePath === ":memory:") throw new Error("内存计划任务数据库不能检查");
  const source = tryLstat(databasePath);
  if (source === undefined) {
    return {
      compatible: false,
      databasePath,
      exists: false,
      schemaVersion: null,
      targetSchemaVersion: schemaVersion,
    };
  }
  if (source.isSymbolicLink() || !source.isFile()) throw new Error("计划任务数据库源路径无效");
  if (process.platform === "win32") {
    assertPrivateFileAccessSync(databasePath);
  } else if ((source.mode & 0o777) !== 0o600) {
    throw new Error("计划任务数据库文件权限必须是 0600");
  }
  requirePrivateDirectory(dirname(databasePath));
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const foundVersion = readScheduledTaskUserVersion(database);
    if (foundVersion === schemaVersion || foundVersion === 0) {
      requireScheduledTaskDatabaseSchema(database);
      return {
        compatible: true,
        databasePath,
        exists: true,
        schemaVersion: foundVersion,
        targetSchemaVersion: schemaVersion,
      };
    }
    return {
      compatible: false,
      databasePath,
      exists: true,
      schemaVersion: foundVersion,
      targetSchemaVersion: schemaVersion,
    };
  } finally {
    database.close();
  }
}

function copyScheduledTaskDatabaseFile(sourcePath: string, destinationPath: string): string {
  if (resolve(destinationPath) === resolve(sourcePath)) throw new Error("备份目标不能覆盖计划任务数据库");
  const source = tryLstat(sourcePath);
  if (source === undefined || source.isSymbolicLink() || !source.isFile()) throw new Error("计划任务数据库源路径无效");
  if (process.platform === "win32") {
    assertPrivateFileAccessSync(sourcePath);
  } else if ((source.mode & 0o777) !== 0o600) {
    throw new Error("计划任务数据库文件权限必须是 0600");
  }
  const target = tryLstat(destinationPath);
  if (target?.isSymbolicLink()) throw new Error("备份目标不能是符号链接");
  if (target !== undefined) throw new Error("备份目标已存在，拒绝覆盖");
  ensurePrivateDirectory(dirname(destinationPath));
  copyFileSync(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
  securePrivateFileSync(destinationPath);
  return destinationPath;
}

function backupTimestamp(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

function requirePrivateDirectory(directory: string): void {
  const entry = tryLstat(directory);
  if (entry === undefined || entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error("计划任务数据库目录无效");
  }
  if (process.platform === "win32") {
    assertPrivateDirectoryAccessSync(directory);
  } else if ((entry.mode & 0o777) !== 0o700) {
    throw new Error("计划任务数据库目录权限必须是 0700");
  }
}

function buildTask(input: CreateScheduledTaskInput): ScheduledTask {
  const nowMs = input.createdAt ?? Date.now();
  requireTimestamp(nowMs);
  const taskId = input.taskId?.trim() || randomUUID();
  const task = {
    taskId: requireText(taskId, "Task ID"),
    name: requireText(input.name, "任务名称"),
    status: "active" as const,
    createdAt: nowMs,
    updatedAt: nowMs,
    surface: requireText(input.surface, "Surface"),
    accountId: requireText(input.accountId, "Account ID"),
    conversationId: requireText(input.conversationId, "Conversation ID"),
    actorId: requireText(input.actorId, "Actor ID"),
    workspaceId: requireText(input.workspaceId, "Workspace ID"),
    prompt: requireText(input.prompt, "Prompt"),
    schedule: normalizeSchedule(input.schedule),
    timezone: validateIanaTimeZone(input.timezone),
    nextRunAt: null as number | null,
    modelProvider: normalizeNullableText(input.modelProvider),
    model: normalizeNullableText(input.model),
    reasoningEffort: normalizeNullableText(input.reasoningEffort),
    serviceTier: normalizeNullableText(input.serviceTier),
    permission: normalizePermission(input),
  } satisfies ScheduledTask;
  const nextRunAt = calculateNextRunAt(task.schedule, task.timezone, nowMs);
  if (nextRunAt === null) {
    throw new ScheduleValidationError("一次性计划时间已过去，请选择未来时间");
  }
  task.nextRunAt = nextRunAt;
  return Object.freeze(task);
}

function normalizePermission(input: CreateScheduledTaskInput): ScheduledTaskPermission {
  if (input.approvalPolicy !== undefined && input.approvalPolicy !== "never") {
    throw new Error("计划任务 Approval Policy 必须是 never");
  }
  const sandbox = input.sandbox ?? "read-only";
  if (sandbox !== "read-only" && sandbox !== "workspace-write") {
    throw new Error("计划任务只允许 read-only 或 workspace-write Sandbox");
  }
  return Object.freeze({
    sandbox,
    approvalPolicy: "never",
    permissions: normalizeNullableText(input.permissions),
  });
}

function errorCategoryForState(state: ScheduledRunState): ScheduledRunErrorCategory | null {
  if (state === "skipped_overlap") return "overlap";
  if (state === "skipped_capacity") return "capacity";
  if (state === "missed") return "missed";
  if (state === "blocked") return "authorization";
  return null;
}

function errorMessageForState(state: ScheduledRunState): string | null {
  if (state === "skipped_overlap") return "上一次运行仍在执行";
  if (state === "skipped_capacity") return "Conversation 后台容量不足";
  if (state === "missed") return "错过了有限补跑窗口";
  if (state === "blocked") return "任务当前未获授权运行";
  return null;
}

function normalizeNullableText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} 不能为空`);
  if (value.includes("\u0000")) throw new Error(`${label} 含有非法字符`);
  return value.trim();
}

function requireTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < -maxDateMs || value > maxDateMs) {
    throw new RangeError("时间戳必须是 JS Date 可表示范围内的安全整数 UTC epoch 毫秒");
  }
}

function tryLstat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Ensure the final database directory is private without changing existing path components. */
function ensurePrivateDirectory(directory: string): void {
  const missing: string[] = [];
  let current = resolve(directory);
  while (true) {
    const entry = tryLstat(current);
    if (entry !== undefined) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error("计划任务数据库目录无效");
      }
      break;
    }
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const path of missing.reverse()) {
    mkdirSync(path, { mode: 0o700 });
    securePrivateDirectorySync(path);
  }
  const final = tryLstat(resolve(directory));
  if (final === undefined || final.isSymbolicLink() || !final.isDirectory()) {
    throw new Error("计划任务数据库目录无效");
  }
  if (process.platform === "win32") {
    assertPrivateDirectoryAccessSync(resolve(directory));
  } else if ((final.mode & 0o777) !== 0o700) {
    throw new Error("计划任务数据库目录权限必须是 0700");
  }
}
