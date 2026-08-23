import {
  chmodSync,
  copyFileSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  calculateNextRunAt,
  normalizeSchedule,
  validateIanaTimeZone,
} from "./schedule.js";
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
  type ScheduledTaskSandbox,
  type ScheduledTaskStatus,
  type ScheduledTaskStore,
  type ScheduledUncertainResolution,
  type Schedule,
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

export class ScheduledTaskSchemaError extends Error {
  readonly code = "scheduled-task.schema.unsupported" as const;
  readonly foundVersion: number;
  readonly expectedVersion: number;

  constructor(foundVersion: number, expectedVersion = schemaVersion, cause?: unknown) {
    const message = cause !== undefined && foundVersion === expectedVersion
      ? `计划任务数据库 Schema ${expectedVersion} 结构不完整`
      : `计划任务数据库 Schema 不受支持：当前 ${foundVersion}，需要 ${expectedVersion}`;
    super(
      message,
      cause === undefined ? undefined : { cause },
    );
    this.name = "ScheduledTaskSchemaError";
    this.foundVersion = foundVersion;
    this.expectedVersion = expectedVersion;
  }
}

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

interface TaskRow {
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

interface RunRow {
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
      if (source !== undefined && (source.mode & 0o777) !== 0o600) {
        throw new Error("计划任务数据库文件权限必须是 0600");
      }
    }
    this.database = new DatabaseSync(path);
    try {
      if (path !== ":memory:") chmodSync(path, 0o600);
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
        task.schedule?.type === "hourly" ? task.schedule.anchorAt : null,
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

  pauseTask(taskId: string, nowMs = Date.now()): ScheduledTask {
    this.requireTimestamp(nowMs);
    const task = this.requireTask(taskId);
    if (task.status === "paused") return task;
    if (task.status === "deleted") throw new ScheduledTaskStateError("已删除任务不能暂停");
    return this.updateTask(taskId, "paused", null, nowMs);
  }

  resumeTask(taskId: string, nowMs = Date.now()): ScheduledTask {
    this.requireTimestamp(nowMs);
    const task = this.requireTask(taskId);
    if (task.status === "active") return task;
    if (task.status === "deleted") throw new ScheduledTaskStateError("已删除任务不能恢复");
    if (!task.schedule || !task.timezone) throw new ScheduledTaskStateError("任务 Schedule 不完整");
    return this.updateTask(taskId, "active", calculateNextRunAt(task.schedule, task.timezone, nowMs), nowMs);
  }

  blockTask(taskId: string, nowMs = Date.now()): ScheduledTask {
    this.requireTimestamp(nowMs);
    const task = this.requireTask(taskId);
    if (task.status === "deleted") throw new ScheduledTaskStateError("已删除任务不能阻止");
    if (task.status === "blocked") return task;
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
      this.database
        .prepare("UPDATE tasks SET next_run_at = ?, updated_at = ? WHERE task_id = ?")
        .run(nextRunAt, nowMs, taskId);
      this.database.exec("COMMIT");
      return { kind: effectiveResult, run: this.requireRun(runId) };
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

  markCompleted(runId: string, nowMs = Date.now()): ScheduledRun {
    this.requireTimestamp(nowMs);
    const run = this.requireRun(runId);
    if (run.state !== "running") {
      throw new ScheduledTaskStateError(`Run ${runId} 不能从 ${run.state} 转为 completed`);
    }
    this.requireRunTimestampAtLeast(nowMs, run, "completed_at");
    this.database
      .prepare("UPDATE runs SET state = 'completed', completed_at = ? WHERE run_id = ? AND state = 'running'")
      .run(nowMs, runId);
    return this.requireRun(runId);
  }

  markFailed(
    runId: string,
    category: ScheduledRunErrorCategory,
    nowMs = Date.now(),
  ): ScheduledRun {
    return this.finishRun(runId, "failed", category, nowMs);
  }

  markInterrupted(runId: string, nowMs = Date.now()): ScheduledRun {
    return this.finishRun(runId, "interrupted", "interrupted", nowMs);
  }

  markUncertain(runId: string, nowMs = Date.now()): ScheduledRun {
    return this.finishRun(runId, "uncertain", "unknown", nowMs);
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
      ?? `${this.path}.v${schemaVersion}.${new Date().toISOString().replaceAll(":", "-")}.bak`;
    if (resolve(destination) === resolve(this.path)) throw new Error("备份目标不能覆盖计划任务数据库");
    const source = tryLstat(this.path);
    if (source === undefined || source.isSymbolicLink() || !source.isFile()) throw new Error("计划任务数据库源路径无效");
    if ((source.mode & 0o777) !== 0o600) throw new Error("计划任务数据库文件权限必须是 0600");
    const target = tryLstat(destination);
    if (target?.isSymbolicLink()) throw new Error("备份目标不能是符号链接");
    if (target !== undefined) throw new Error("备份目标已存在，拒绝覆盖");
    ensurePrivateDirectory(dirname(destination));
    copyFileSync(this.path, destination, fsConstants.COPYFILE_EXCL);
    chmodSync(destination, 0o600);
    return destination;
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
      const pragmaVersion = Number(
        (this.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      );
      if (hasAnyTable || metadataExists || pragmaVersion !== 0) {
        if (pragmaVersion !== schemaVersion || (version !== undefined && version !== schemaVersion)) {
          const foundVersion = pragmaVersion !== schemaVersion ? pragmaVersion : version!;
          throw new ScheduledTaskSchemaError(foundVersion, schemaVersion);
        }
        if (version === undefined) {
          throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error("schema_metadata 缺少 schema_version"));
        }
        this.requireSchemaStructure();
      } else {
        this.database.exec(`
          CREATE TABLE schema_metadata (
            name TEXT PRIMARY KEY,
            value INTEGER NOT NULL
          ) STRICT;
          CREATE TABLE tasks (
            task_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'blocked', 'deleted')),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            surface TEXT NOT NULL,
            account_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            actor_id TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            prompt TEXT NOT NULL,
            schedule_type TEXT CHECK (
              schedule_type IS NULL OR schedule_type IN ('hourly', 'daily', 'weekdays', 'weekly')
            ),
            schedule_json TEXT,
            timezone TEXT,
            anchor_at INTEGER,
            next_run_at INTEGER,
            model_provider TEXT,
            model TEXT,
            reasoning_effort TEXT,
            service_tier TEXT,
            sandbox TEXT CHECK (sandbox IS NULL OR sandbox IN ('read-only', 'workspace-write')),
            approval_policy TEXT CHECK (approval_policy IS NULL OR approval_policy = 'never'),
            permissions TEXT
          ) STRICT;
          CREATE TABLE runs (
            run_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(task_id),
            scheduled_for INTEGER NOT NULL,
            state TEXT NOT NULL CHECK (
              state IN (
                'dispatching', 'running', 'completed', 'failed', 'interrupted',
                'uncertain', 'missed', 'skipped_overlap', 'skipped_capacity', 'blocked'
              )
            ),
            thread_id TEXT,
            turn_id TEXT,
            dispatch_started_at INTEGER,
            started_at INTEGER,
            completed_at INTEGER,
            error_category TEXT CHECK (
              error_category IS NULL OR error_category IN (
                'authorization', 'workspace', 'provider', 'model', 'approval', 'capacity',
                'overlap', 'missed', 'interrupted', 'gateway_crash', 'unknown'
              )
            ),
            error_message TEXT,
            UNIQUE (task_id, scheduled_for)
          ) STRICT;
          CREATE INDEX tasks_due_idx ON tasks(status, next_run_at, task_id);
          CREATE INDEX runs_task_idx ON runs(task_id, scheduled_for DESC, run_id DESC);
          CREATE INDEX runs_active_idx ON runs(task_id, state);
          INSERT INTO schema_metadata (name, value) VALUES ('schema_version', ${schemaVersion});
          PRAGMA user_version = ${schemaVersion};
        `);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.rollback(error);
    }
  }

  private requireSchemaStructure(): void {
    const tableNames = (this.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>)
      .map((table) => table.name)
      .sort();
    if (tableNames.join(",") !== "runs,schema_metadata,tasks") {
      throw new ScheduledTaskSchemaError(
        schemaVersion,
        schemaVersion,
        new Error("计划任务数据库包含未知或缺失的表"),
      );
    }
    const required: Record<string, readonly string[]> = {
      schema_metadata: ["name", "value"],
      tasks: [
        "task_id", "name", "status", "created_at", "updated_at", "surface", "account_id",
        "conversation_id", "actor_id", "workspace_id", "prompt", "schedule_type", "schedule_json",
        "timezone", "anchor_at", "next_run_at", "model_provider", "model", "reasoning_effort",
        "service_tier", "sandbox", "approval_policy", "permissions",
      ],
      runs: [
        "run_id", "task_id", "scheduled_for", "state", "thread_id", "turn_id",
        "dispatch_started_at", "started_at", "completed_at", "error_category", "error_message",
      ],
    };
    const tableList = this.database
      .prepare("PRAGMA table_list")
      .all() as Array<{ name: string; strict: number }>;
    for (const table of ["schema_metadata", "tasks", "runs"] as const) {
      const entry = tableList.find((candidate) => candidate.name === table);
      if (entry?.strict !== 1) {
        throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error(`表 ${table} 必须是 STRICT`));
      }
    }
    for (const [table, columns] of Object.entries(required)) {
      const found = (this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((column) => column.name)
        .sort();
      if (found.join(",") !== [...columns].sort().join(",")) {
        throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error(`表 ${table} 结构不完整`));
      }
    }
    const uniqueIndexes = this.database
      .prepare("PRAGMA index_list(runs)")
      .all() as Array<{ name: string; unique: number }>;
    const occurrenceIndex = uniqueIndexes.find((index) => index.unique === 1
      && this.indexColumns(index.name).join(",") === "task_id,scheduled_for");
    if (!occurrenceIndex) {
      throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error("runs 缺少 occurrence 唯一约束"));
    }
    const runSql = this.database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'")
      .get() as { sql: string | null } | undefined;
    if (!runSql?.sql?.includes("error_category IN")) {
      throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error("runs 错误分类约束缺失"));
    }
    if (runSql.sql.toLowerCase().includes("'pending'")) {
      throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error("runs 不支持 pending 状态"));
    }
    const metadataNames = (this.database
      .prepare("SELECT name FROM schema_metadata ORDER BY name")
      .all() as Array<{ name: string }>);
    if (metadataNames.length !== 1 || metadataNames[0]?.name !== "schema_version") {
      throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error("schema_metadata 内容无效"));
    }
  }

  private indexColumns(indexName: string): string[] {
    return (this.database.prepare(`PRAGMA index_info(${indexName})`).all() as Array<{ name: string }>)
      .map((column) => column.name);
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
        UPDATE runs SET state = ?, completed_at = ?, error_category = ?, error_message = ?
        WHERE run_id = ? AND state IN ('dispatching', 'running')
      `)
      .run(state, nowMs, category, errorMessageForRun(state, category), runId);
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
  task.nextRunAt = calculateNextRunAt(task.schedule, task.timezone, nowMs);
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

function taskFromRow(row: TaskRow): ScheduledTask {
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
    || (schedule?.type === "hourly" && row.anchor_at !== schedule.anchorAt)
    || (schedule !== null && schedule.type !== "hourly" && row.anchor_at !== null)
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

function runFromRow(row: RunRow): ScheduledRun {
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
  if (value === "active" || value === "paused" || value === "blocked" || value === "deleted") return value;
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

function isScheduledRunErrorCategory(value: string): value is ScheduledRunErrorCategory {
  const values: readonly ScheduledRunErrorCategory[] = [
    "authorization", "workspace", "provider", "model", "approval", "capacity", "overlap",
    "missed", "interrupted", "gateway_crash", "unknown",
  ];
  return (values as readonly string[]).includes(value);
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

function errorMessageForCategory(category: ScheduledRunErrorCategory): string {
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

function errorMessageForRun(
  state: ScheduledRunState,
  category: ScheduledRunErrorCategory,
): string {
  return state === "uncertain" && category === "unknown"
    ? "运行结果未知，需要人工确认"
    : errorMessageForCategory(category);
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

function requirePersistedTimestamp(value: number | null, label: string): void {
  if (value === null) return;
  try {
    requireTimestamp(value);
  } catch (error) {
    throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error(`${label} 时间戳无效`, { cause: error }));
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
    if (entry !== undefined && (entry.isSymbolicLink() || !entry.isDirectory())) {
      throw new Error("计划任务数据库目录无效");
    }
    if (entry === undefined) missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const path of missing.reverse()) {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const final = tryLstat(resolve(directory));
  if (final === undefined || final.isSymbolicLink() || !final.isDirectory()) {
    throw new Error("计划任务数据库目录无效");
  }
  if ((final.mode & 0o777) !== 0o700) {
    throw new Error("计划任务数据库目录权限必须是 0700");
  }
}
