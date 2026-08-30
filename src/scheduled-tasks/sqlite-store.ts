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
  requireScheduledTaskDatabaseStructure,
  ScheduledTaskSchemaError,
  scheduledTaskInitialSchemaSql,
  scheduledTaskTasksDueIndexSql,
  scheduledTaskTasksTableSql,
} from "./sqlite-schema.js";
import {
  activeScheduledRunStates,
  scheduledTaskDatabaseFileName,
  scheduledTasksSchemaVersion,
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

export class ScheduledTaskStateError extends Error {
  readonly code = "scheduled-task.state.invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "ScheduledTaskStateError";
  }
}

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
    }
    this.database = new DatabaseSync(path);
    try {
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
    this.database
      .prepare(`
        INSERT INTO tasks (
          task_id, name, status, created_at, updated_at,
          surface, account_id, conversation_id, actor_id, workspace_id, prompt,
          schedule_type, schedule_json, timezone, anchor_at, next_run_at,
          model_provider, model, reasoning_effort, service_tier,
          sandbox, approval_policy, permissions
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      );
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

  listDueTasks(nowMs: number): ScheduledTask[] {
    this.requireOpen();
    this.requireTimestamp(nowMs);
    const rows = this.database
      .prepare(`
        SELECT * FROM tasks
        WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at ASC, task_id ASC
      `)
      .all(nowMs) as unknown as TaskRow[];
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

  listRunningRuns(): ScheduledRun[] {
    this.requireOpen();
    const rows = this.database
      .prepare(`
        SELECT * FROM runs
        WHERE state = 'running'
        ORDER BY scheduled_for ASC, run_id ASC
      `)
      .all() as unknown as RunRow[];
    return rows.map(runFromRow);
  }

  hasBlockingRun(taskId: string): boolean {
    this.requireOpen();
    const row = this.database
      .prepare("SELECT 1 AS found FROM runs WHERE task_id = ? AND state IN ('dispatching', 'running', 'uncertain') LIMIT 1")
      .get(taskId) as { found: number } | undefined;
    return row !== undefined;
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
      const effectiveResult = result === "claimed" && blocking
        ? blocking.state === "uncertain" ? "blocked" : "skipped_overlap"
        : result;
      const state: ScheduledRunState = effectiveResult === "claimed" ? "dispatching" : effectiveResult;
      const runId = randomUUID();
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
    this.requireOpen();
    this.requireTimestamp(nowMs);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.requireTask(taskId);
      if (task.status === "deleted" || task.status === "blocked" || task.status === "finished") {
        throw new ScheduledTaskStateError("当前任务状态不允许手动运行");
      }
      const blocking = this.database
        .prepare(`
          SELECT state FROM runs
          WHERE task_id = ? AND state IN ('dispatching', 'running', 'uncertain')
          ORDER BY CASE state WHEN 'uncertain' THEN 0 ELSE 1 END LIMIT 1
        `)
        .get(taskId) as { state: string } | undefined;
      const kind = blocking === undefined
        ? result
        : blocking.state === "uncertain" ? "blocked" : "skipped_overlap";
      const state: ScheduledRunState = kind === "claimed" ? "dispatching" : kind;
      const runId = randomUUID();
      const latest = this.database
        .prepare("SELECT MAX(scheduled_for) AS value FROM runs WHERE task_id = ?")
        .get(taskId) as { value: number | null };
      const scheduledFor = Math.max(nowMs, (latest.value ?? -1) + 1);
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
        .prepare("SELECT * FROM runs WHERE state = 'dispatching'")
        .all() as unknown as RunRow[];
      recoveredRunIds = dispatching.map((row) => row.run_id);
      for (const row of dispatching) {
        this.requireRunTimestampAtLeast(nowMs, runFromRow(row), "completed_at");
      }
      this.database
        .prepare(`
          UPDATE runs SET state = 'uncertain', completed_at = ?,
            error_category = 'gateway_crash', error_message = 'Gateway 在派发结果确认前退出'
          WHERE state = 'dispatching'
        `)
        .run(nowMs);
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

  cleanup(nowMs = Date.now()): number {
    this.requireOpen();
    this.requireTimestamp(nowMs);
    const cutoff = nowMs - retentionMs;
    let deleted = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const expired = this.database
        .prepare(`
          DELETE FROM runs
          WHERE state NOT IN ('dispatching', 'running', 'uncertain')
            AND COALESCE(completed_at, scheduled_for) < ?
        `)
        .run(cutoff);
      deleted += Number(expired.changes);
      const tasks = this.database
        .prepare("SELECT task_id FROM tasks")
        .all() as Array<{ task_id: string }>;
      for (const task of tasks) {
        const overflow = this.database
          .prepare(`
            DELETE FROM runs
            WHERE task_id = ?
              AND state NOT IN ('dispatching', 'running', 'uncertain')
              AND run_id NOT IN (
                SELECT run_id FROM runs
                WHERE task_id = ?
                ORDER BY scheduled_for DESC, run_id DESC
                LIMIT ?
              )
          `)
          .run(task.task_id, task.task_id, scheduledTaskMaximumRunsPerTask);
        deleted += Number(overflow.changes);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.rollback(error);
    }
    return deleted;
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
      const hasAnyTable = this.database
        .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' LIMIT 1")
        .get() as { found: number } | undefined;
      const metadataExists = this.database
        .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_metadata'")
        .get() as { found: number } | undefined;
      const version = metadataExists
        ? (this.database.prepare("SELECT value FROM schema_metadata WHERE name = 'schema_version'").get() as { value: number } | undefined)?.value
        : undefined;
      const pragmaVersion = readScheduledTaskUserVersion(this.database);
      if (hasAnyTable || metadataExists || pragmaVersion !== 0) {
        const foundVersion = pragmaVersion !== schemaVersion ? pragmaVersion : (version ?? 0);
        if (foundVersion !== schemaVersion) {
          throw new ScheduledTaskSchemaError(foundVersion, schemaVersion);
        }
        if (version === undefined) {
          throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error("schema_metadata 缺少 schema_version"));
        }
        requireScheduledTaskDatabaseStructure(this.database);
      } else {
        this.database.exec(scheduledTaskInitialSchemaSql);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.rollback(error);
    }
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
  readonly updateable: boolean;
}

export interface ScheduledTaskDatabaseUpgradeResult {
  readonly changed: boolean;
  readonly databasePath: string;
  readonly version: number;
  readonly backupPath: string | null;
}

export function inspectScheduledTaskDatabaseFile(
  databasePath: string,
): ScheduledTaskDatabaseInspection {
  if (databasePath === ":memory:") throw new Error("内存计划任务数据库不能检查或升级");
  const source = tryLstat(databasePath);
  if (source === undefined) {
    return {
      compatible: false,
      databasePath,
      exists: false,
      schemaVersion: null,
      targetSchemaVersion: schemaVersion,
      updateable: false,
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
    if (foundVersion === schemaVersion) {
      requireScheduledTaskDatabaseStructure(database);
      return {
        compatible: true,
        databasePath,
        exists: true,
        schemaVersion: foundVersion,
        targetSchemaVersion: schemaVersion,
        updateable: true,
      };
    }
    if (foundVersion === 1) {
      requireScheduledTaskV1Migratable(database);
    }
    return {
      compatible: false,
      databasePath,
      exists: true,
      schemaVersion: foundVersion,
      targetSchemaVersion: schemaVersion,
      updateable: foundVersion === 1,
    };
  } finally {
    database.close();
  }
}

function requireScheduledTaskV1Migratable(database: DatabaseSync): void {
  const tableNames = (database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>)
    .map((table) => table.name)
    .sort();
  if (tableNames.join(",") !== "runs,schema_metadata,tasks") {
    throw new Error("v1 计划任务数据库结构不完整，无法迁移");
  }
  const metadata = database
    .prepare("SELECT value FROM schema_metadata WHERE name = 'schema_version'")
    .get() as { value: number } | undefined;
  if (metadata?.value !== 1) {
    throw new Error("v1 计划任务数据库 schema_metadata 无效，无法迁移");
  }
  const rows = database
    .prepare("SELECT * FROM tasks ORDER BY task_id ASC")
    .all() as unknown as TaskRow[];
  for (const row of rows) {
    migrateV1TaskRow(row);
  }
}

export function upgradeScheduledTaskDatabaseFile(
  databasePath: string,
  options: { readonly allowMissing?: boolean; readonly backupPath?: string } = {},
): ScheduledTaskDatabaseUpgradeResult {
  const noChange: ScheduledTaskDatabaseUpgradeResult = {
    changed: false,
    databasePath,
    version: schemaVersion,
    backupPath: null,
  };
  const inspection = inspectScheduledTaskDatabaseFile(databasePath);
  if (!inspection.exists) {
    if (options.allowMissing === true) return noChange;
    throw new Error("计划任务数据库尚未创建，请先启动一次 Gateway");
  }
  if (inspection.compatible) return noChange;
  if (!inspection.updateable) {
    throw new Error(
      `计划任务数据库版本不支持升级：当前 ${inspection.schemaVersion ?? "unknown"}，只支持 1 → ${schemaVersion}`,
    );
  }
  const backupPath = options.backupPath
    ?? `${databasePath}.v1.${backupTimestamp()}.bak`;
  copyScheduledTaskDatabaseFile(databasePath, backupPath);
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON;");
    migrateScheduledTaskDatabaseV1ToV2(database);
  } finally {
    database.close();
  }
  return { changed: true, databasePath, version: schemaVersion, backupPath };
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

function migrateScheduledTaskDatabaseV1ToV2(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(scheduledTaskTasksTableSql("tasks_v2"));
    const rows = database
      .prepare("SELECT * FROM tasks ORDER BY task_id ASC")
      .all() as unknown as TaskRow[];
    const insert = database.prepare(`
      INSERT INTO tasks_v2 (
        task_id, name, status, created_at, updated_at,
        surface, account_id, conversation_id, actor_id, workspace_id, prompt,
        schedule_type, schedule_json, timezone, anchor_at, next_run_at,
        model_provider, model, reasoning_effort, service_tier,
        sandbox, approval_policy, permissions
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      const migrated = migrateV1TaskRow(row);
      insert.run(
        migrated.task_id, migrated.name, migrated.status, migrated.created_at, migrated.updated_at,
        migrated.surface, migrated.account_id, migrated.conversation_id, migrated.actor_id,
        migrated.workspace_id, migrated.prompt,
        migrated.schedule_type, migrated.schedule_json, migrated.timezone, migrated.anchor_at,
        migrated.next_run_at, migrated.model_provider, migrated.model, migrated.reasoning_effort,
        migrated.service_tier, migrated.sandbox, migrated.approval_policy, migrated.permissions,
      );
    }
    database.exec("DROP TABLE tasks;");
    database.exec("ALTER TABLE tasks_v2 RENAME TO tasks;");
    database.exec(scheduledTaskTasksDueIndexSql);
    database.exec(`UPDATE schema_metadata SET value = ${schemaVersion} WHERE name = 'schema_version';`);
    database.exec(`PRAGMA user_version = ${schemaVersion};`);
    requireScheduledTaskDatabaseStructure(database);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // 迁移失败后 SQLite 可能已经自动回滚。
    }
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

function backupTimestamp(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

function requirePrivateDirectory(directory: string): void {
  const entry = tryLstat(directory);
  if (entry === undefined || entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error("计划任务数据库目录无效");
  }
  if ((entry.mode & 0o777) !== 0o700) {
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

function migrateV1TaskRow(row: TaskRow): TaskRow {
  if (row.schedule_type !== "hourly") return row;
  if (row.schedule_json === null) {
    throw new Error(`计划任务 ${row.task_id} 缺少 hourly Schedule 数据，无法迁移`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.schedule_json);
  } catch (error) {
    throw new Error(`计划任务 ${row.task_id} 的 hourly Schedule 数据无效，无法迁移`, { cause: error });
  }
  if (!isRecord(parsed) || parsed.type !== "hourly") {
    throw new Error(`计划任务 ${row.task_id} 的 hourly Schedule 类型无效，无法迁移`);
  }
  if (!Number.isSafeInteger(parsed.intervalHours) || (parsed.intervalHours as number) < 1) {
    throw new Error(`计划任务 ${row.task_id} 的 hourly 间隔无效，无法迁移`);
  }
  const intervalMinutes = (parsed.intervalHours as number) * 60;
  const anchorAt = Number.isSafeInteger(parsed.anchorAt)
    ? (parsed.anchorAt as number)
    : row.anchor_at;
  if (anchorAt === null || !Number.isSafeInteger(anchorAt)) {
    throw new Error(`计划任务 ${row.task_id} 的 hourly anchor 无效，无法迁移`);
  }
  try {
    normalizeSchedule({ type: "interval", intervalMinutes, anchorAt });
  } catch (error) {
    throw new Error(
      `计划任务 ${row.task_id} 的 hourly 间隔换算后不被 v2 支持，请先调整后再升级`,
      { cause: error },
    );
  }
  return {
    ...row,
    schedule_type: "interval",
    schedule_json: JSON.stringify({
      type: "interval",
      intervalMinutes,
      anchorAt,
    }),
    anchor_at: anchorAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
