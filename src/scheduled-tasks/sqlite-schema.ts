import type { DatabaseSync } from "node:sqlite";

import { scheduledTasksSchemaVersion } from "./types.js";

const schemaVersion = scheduledTasksSchemaVersion;

export class ScheduledTaskSchemaError extends Error {
  readonly code = "scheduled-task.schema.unsupported" as const;
  readonly foundVersion: number;
  readonly expectedVersion: number;

  constructor(foundVersion: number, expectedVersion = schemaVersion, cause?: unknown) {
    const message = cause !== undefined && foundVersion === expectedVersion
      ? `计划任务数据库 Schema ${expectedVersion} 结构不完整`
      : foundVersion === 1 && expectedVersion === schemaVersion
        ? `计划任务数据库需要显式升级：当前 Schema 1，请停止 Gateway 后运行 codexc update 或 codexc state upgrade`
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

const scheduledTaskSchemaMetadataSql = `
  CREATE TABLE schema_metadata (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  ) STRICT;
`;

const scheduledTaskRunsTableSql = `
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
`;

export const scheduledTaskTasksDueIndexSql = `
  CREATE INDEX tasks_due_idx ON tasks(status, next_run_at, task_id);
`;

const scheduledTaskRunsIndexesSql = `
  CREATE INDEX runs_task_idx ON runs(task_id, scheduled_for DESC, run_id DESC);
  CREATE INDEX runs_active_idx ON runs(task_id, state);
`;

export const scheduledTaskInitialSchemaSql = `
  ${scheduledTaskSchemaMetadataSql}
  ${scheduledTaskTasksTableSql("tasks")}
  ${scheduledTaskRunsTableSql}
  ${scheduledTaskTasksDueIndexSql}
  ${scheduledTaskRunsIndexesSql}
  INSERT INTO schema_metadata (name, value) VALUES ('schema_version', ${schemaVersion});
  PRAGMA user_version = ${schemaVersion};
`;

export function scheduledTaskTasksTableSql(tableName: string): string {
  return `
    CREATE TABLE ${tableName} (
      task_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'blocked', 'finished', 'deleted')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      surface TEXT NOT NULL,
      account_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT CHECK (
        schedule_type IS NULL OR schedule_type IN ('interval', 'once', 'monthly', 'daily', 'weekdays', 'weekly')
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
  `;
}

export function readScheduledTaskUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  return Number(row?.user_version ?? 0);
}

function indexedColumns(database: DatabaseSync, indexName: string): string[] {
  return (database.prepare(`PRAGMA index_info(${indexName})`).all() as Array<{ name: string }>)
    .map((column) => column.name);
}

export function requireScheduledTaskDatabaseStructure(database: DatabaseSync): void {
  const tableNames = (database
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
  const tableList = database
    .prepare("PRAGMA table_list")
    .all() as Array<{ name: string; strict: number }>;
  for (const table of ["schema_metadata", "tasks", "runs"] as const) {
    const entry = tableList.find((candidate) => candidate.name === table);
    if (entry?.strict !== 1) {
      throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error(`表 ${table} 必须是 STRICT`));
    }
  }
  for (const [table, columns] of Object.entries(required)) {
    const found = (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((column) => column.name)
      .sort();
    if (found.join(",") !== [...columns].sort().join(",")) {
      throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error(`表 ${table} 结构不完整`));
    }
  }
  const uniqueIndexes = database
    .prepare("PRAGMA index_list(runs)")
    .all() as Array<{ name: string; unique: number }>;
  const occurrenceIndex = uniqueIndexes.find((index) => index.unique === 1
    && indexedColumns(database, index.name).join(",") === "task_id,scheduled_for");
  if (!occurrenceIndex) {
    throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error("runs 缺少 occurrence 唯一约束"));
  }
  const runForeignKeys = database
    .prepare("PRAGMA foreign_key_list(runs)")
    .all() as Array<{ table: string; from: string; to: string }>;
  if (!runForeignKeys.some((entry) =>
    entry.table === "tasks" && entry.from === "task_id" && entry.to === "task_id"
  )) {
    throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error("runs 任务外键缺失或指向无效表"));
  }
  const runSql = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'")
    .get() as { sql: string | null } | undefined;
  if (!runSql?.sql?.includes("error_category IN")) {
    throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error("runs 错误分类约束缺失"));
  }
  if (runSql.sql.toLowerCase().includes("'pending'")) {
    throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error("runs 不支持 pending 状态"));
  }
  const metadataNames = (database
    .prepare("SELECT name FROM schema_metadata ORDER BY name")
    .all() as Array<{ name: string }>);
  if (metadataNames.length !== 1 || metadataNames[0]?.name !== "schema_version") {
    throw new ScheduledTaskSchemaError(schemaVersion, schemaVersion, new Error("schema_metadata 内容无效"));
  }
}
