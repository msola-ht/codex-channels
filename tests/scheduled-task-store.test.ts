import { chmodSync, mkdirSync, mkdtempSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  ScheduledTaskSchemaError,
  ScheduledTaskStateError,
  SqliteScheduledTaskStore,
} from "../src/scheduled-tasks/index.js";
import { securePrivateFileSync } from "../runtime/private-file.mjs";
import {
  cleanupScheduledTaskTestFixtures,
  scheduledTaskBase as base,
  scheduledTaskDatabasePath,
  scheduledTaskInput as taskInput,
} from "./scheduled-task-test-fixture.js";

const directories: string[] = [];
const databasePath = () => scheduledTaskDatabasePath(directories);

afterEach(() => {
  cleanupScheduledTaskTestFixtures(directories);
});

describe("SqliteScheduledTaskStore", () => {
  it("creates a private database and reopens the task definition", () => {
    const { directory, path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const task = store.createTask(taskInput({ createdAt: base + 8 * 60 * 60_000 }));

    if (process.platform !== "win32") {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(task.nextRunAt).toBe(Date.parse("2026-01-01T09:00:00.000Z"));
    store.close();

    const schemaDb = new DatabaseSync(path);
    const tables = schemaDb
      .prepare("PRAGMA table_list")
      .all() as Array<{ name: string; strict: number }>;
    expect(tables.filter((table) => ["schema_metadata", "tasks", "runs"].includes(table.name)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "schema_metadata", strict: 1 }),
        expect.objectContaining({ name: "tasks", strict: 1 }),
        expect.objectContaining({ name: "runs", strict: 1 }),
      ]));
    schemaDb.close();

    const reopened = new SqliteScheduledTaskStore(path);
    expect(reopened.getTask(task.taskId)).toMatchObject({ taskId: task.taskId, prompt: "read the report" });
    reopened.close();
  });

  it("rejects a v1 database without migrating its tasks", () => {
    const { path } = databasePath();
    createV1Database(path, base, true);
    expect(() => new SqliteScheduledTaskStore(path)).toThrow(/Schema 不受支持/u);
    const database = new DatabaseSync(path, { readOnly: true });
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(database.prepare("SELECT schedule_type FROM tasks WHERE task_id = 'v1-task'").get())
      .toEqual({ schedule_type: "hourly" });
    database.close();
  });

  it("finishes a once task after its single occurrence is claimed", () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const onceAt = Date.parse("2026-09-01T09:00:00.000Z");
    const task = store.createTask(taskInput({
      taskId: "once-task",
      schedule: { type: "once", date: "2026-09-01", time: "09:00" },
      timezone: "UTC",
      createdAt: onceAt - 1,
    }));
    expect(task.nextRunAt).toBe(onceAt);
    const claim = store.claimDue(task.taskId, onceAt, "claimed", onceAt);
    expect(claim.kind).toBe("claimed");
    const after = store.getTask(task.taskId);
    expect(after!.status).toBe("finished");
    expect(after!.nextRunAt).toBeNull();
    store.close();
    const schemaDb = new DatabaseSync(path);
    expect(schemaDb.prepare("SELECT anchor_at FROM tasks WHERE task_id = ?").get(task.taskId))
      .toEqual({ anchor_at: null });
    schemaDb.close();
  });

  it("persists a relative once anchor and finishes after the delayed occurrence", () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const anchor = base;
    const task = store.createTask(taskInput({
      taskId: "relative-once",
      schedule: { type: "once", afterMinutes: 1, anchorAt: anchor },
      timezone: "UTC",
      createdAt: anchor,
    }));
    expect(task.nextRunAt).toBe(anchor + 60_000);
    const claim = store.claimDue(task.taskId, task.nextRunAt!, "claimed", task.nextRunAt!);
    expect(claim.kind).toBe("claimed");
    expect(store.getTask(task.taskId)).toMatchObject({
      status: "finished",
      nextRunAt: null,
      schedule: { type: "once", afterMinutes: 1, anchorAt: anchor },
    });
    store.close();

    const reopened = new SqliteScheduledTaskStore(path);
    expect(reopened.getTask(task.taskId)?.schedule)
      .toEqual({ type: "once", afterMinutes: 1, anchorAt: anchor });
    const schemaDb = new DatabaseSync(path);
    expect(schemaDb.prepare("SELECT anchor_at FROM tasks WHERE task_id = ?").get(task.taskId))
      .toEqual({ anchor_at: anchor });
    schemaDb.close();
    reopened.close();
  });

  it("finishes an expired paused once task when resumed", () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const onceAt = Date.parse("2026-09-01T09:00:00.000Z");
    const task = store.createTask(taskInput({
      taskId: "expired-paused-once",
      schedule: { type: "once", date: "2026-09-01", time: "09:00" },
      timezone: "UTC",
      createdAt: onceAt - 1,
    }));
    store.pauseTask(task.taskId, onceAt - 1);
    const resumed = store.resumeTask(task.taskId, onceAt + 1);
    expect(resumed.status).toBe("finished");
    expect(resumed.nextRunAt).toBeNull();
    store.close();
  });

  it("rejects unknown, incomplete, and mismatched schemas without migrating", () => {
    const unknown = databasePath();
    const unknownDb = new DatabaseSync(unknown.path);
    unknownDb.exec("CREATE TABLE unrelated (value TEXT)");
    unknownDb.close();
    if (process.platform === "win32") securePrivateFileSync(unknown.path);
    else chmodSync(unknown.path, 0o600);
    expect(() => new SqliteScheduledTaskStore(unknown.path)).toThrow(ScheduledTaskSchemaError);

    const incomplete = databasePath();
    const incompleteDb = new DatabaseSync(incomplete.path);
    incompleteDb.exec(`
      CREATE TABLE schema_metadata (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO schema_metadata VALUES ('schema_version', 2);
      CREATE TABLE tasks (task_id TEXT PRIMARY KEY);
      CREATE TABLE runs (run_id TEXT PRIMARY KEY);
      PRAGMA user_version = 2;
    `);
    incompleteDb.close();
    if (process.platform === "win32") securePrivateFileSync(incomplete.path);
    else chmodSync(incomplete.path, 0o600);
    expect(() => new SqliteScheduledTaskStore(incomplete.path))
      .toThrow(/Schema 2.*结构不完整/);

    const wrongVersion = databasePath();
    const wrongVersionDb = new DatabaseSync(wrongVersion.path);
    wrongVersionDb.exec("PRAGMA user_version = 2");
    wrongVersionDb.close();
    if (process.platform === "win32") securePrivateFileSync(wrongVersion.path);
    else chmodSync(wrongVersion.path, 0o600);
    expect(() => new SqliteScheduledTaskStore(wrongVersion.path)).toThrow(ScheduledTaskSchemaError);
  });

  const unixIt = process.platform === "win32" ? it.skip : it;

  unixIt("rejects extra columns and unsafe existing directories without changing permissions", () => {
    const valid = databasePath();
    const store = new SqliteScheduledTaskStore(valid.path);
    store.close();
    const db = new DatabaseSync(valid.path);
    db.exec("ALTER TABLE tasks ADD COLUMN unexpected TEXT");
    db.close();
    expect(() => new SqliteScheduledTaskStore(valid.path))
      .toThrow(/Schema 2.*结构不完整/);

    const unsafe = databasePath();
    chmodSync(unsafe.directory, 0o755);
    expect(() => new SqliteScheduledTaskStore(unsafe.path)).toThrow(/0700/);
    expect(statSync(unsafe.directory).mode & 0o777).toBe(0o755);

    const sharedParent = mkdtempSync(join(tmpdir(), "codexc-scheduled-parent-"));
    directories.push(sharedParent);
    chmodSync(sharedParent, 0o755);
    const privateDirectory = join(sharedParent, "private");
    const privateStore = new SqliteScheduledTaskStore(join(privateDirectory, "scheduled-tasks.sqlite3"));
    expect(statSync(privateDirectory).mode & 0o777).toBe(0o700);
    privateStore.close();
  });

  unixIt("allows a real private directory below a symlinked system ancestor but rejects a symlinked final directory", () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-scheduled-symlink-parent-"));
    directories.push(root);
    const realParent = join(root, "real-parent");
    const privateDirectory = join(realParent, "private");
    mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
    chmodSync(privateDirectory, 0o700);

    const linkedParent = join(root, "linked-parent");
    symlinkSync(realParent, linkedParent);
    const store = new SqliteScheduledTaskStore(
      join(linkedParent, "private", "scheduled-tasks.sqlite3"),
    );
    store.close();

    const linkedFinal = join(root, "linked-final");
    symlinkSync(privateDirectory, linkedFinal);
    expect(() => new SqliteScheduledTaskStore(
      join(linkedFinal, "scheduled-tasks.sqlite3"),
    )).toThrow(/目录无效/u);
  });

  it("backs up exclusively and rejects symlink targets", () => {
    const { directory, path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const destination = join(directory, "scheduled-tasks.backup.sqlite3");
    expect(store.backup(destination)).toBe(destination);
    expect(() => store.backup(destination)).toThrow(/已存在/);
    const symlink = join(directory, "scheduled-tasks.symlink.sqlite3");
    symlinkSync(path, symlink);
    expect(() => store.backup(symlink)).toThrow(/符号链接/);
    store.close();
  });

  it("enforces unattended permission boundaries and task lifecycle", () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    expect(() => store.createTask(taskInput({ sandbox: "danger-full-access" as never }))).toThrow();
    expect(() => store.createTask(taskInput({ approvalPolicy: "on-request" as never }))).toThrow();

    const task = store.createTask(taskInput({ taskId: "lifecycle" }));
    expect(store.pauseTask(task.taskId).status).toBe("paused");
    expect(store.resumeTask(task.taskId).status).toBe("active");
    expect(store.blockTask(task.taskId).status).toBe("blocked");
    expect(store.resumeTask(task.taskId, store.getTask(task.taskId)!.updatedAt + 2).status).toBe("active");
    store.close();
  });

  it("renames tasks and claims manual runs without advancing the schedule", () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const task = store.createTask(taskInput());
    const nextRunAt = task.nextRunAt;

    expect(store.renameTask(task.taskId, "Renamed", base + 1)).toMatchObject({
      name: "Renamed",
      updatedAt: base + 1,
    });
    const manual = store.claimManual(task.taskId, base + 2);
    expect(manual).toMatchObject({
      kind: "claimed",
      run: { state: "dispatching", scheduledFor: base + 2 },
    });
    expect(store.getTask(task.taskId)?.nextRunAt).toBe(nextRunAt);
    expect(store.claimManual(task.taskId, base + 3)).toMatchObject({
      kind: "skipped_overlap",
      run: { state: "skipped_overlap" },
    });
    store.close();
  });

  it("atomically claims an occurrence and rejects a duplicate claim", () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const task = store.createTask(taskInput({ schedule: { type: "interval", intervalMinutes: 60, anchorAt: base } }));
    const scheduledFor = task.nextRunAt!;
    const first = store.claimDue(task.taskId, scheduledFor, "claimed", scheduledFor);
    expect(first.kind).toBe("claimed");
    expect(first.run.state).toBe("dispatching");
    expect(() => store.claimDue(task.taskId, scheduledFor, "claimed", scheduledFor + 1)).toThrow(ScheduledTaskStateError);
    expect(store.listRuns(task.taskId)).toHaveLength(1);
    store.close();
  });

  it("keeps a tombstone and run association while clearing private task data", () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const task = store.createTask(taskInput({ taskId: "deleted-task" }));
    const run = store.claimDue(task.taskId, task.nextRunAt!, "claimed", task.nextRunAt!);
    const deleted = store.deleteTask(task.taskId, store.getTask(task.taskId)!.updatedAt + 1);

    expect(deleted).toMatchObject({
      taskId: "deleted-task",
      name: "deleted",
      status: "deleted",
      prompt: "",
      schedule: null,
      timezone: null,
      nextRunAt: null,
    });
    expect(store.listRuns(task.taskId)).toEqual([run.run]);
    expect(store.listTasks()).toEqual([]);
    expect(store.listTasks({ includeDeleted: true })).toHaveLength(1);
    store.close();
  });

  it("recovers dispatching runs but leaves running runs for authoritative recovery", () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const first = store.createTask(taskInput({ taskId: "dispatching", schedule: { type: "interval", intervalMinutes: 60, anchorAt: base } }));
    const firstRun = store.claimDue(first.taskId, first.nextRunAt!, "claimed", base + 60 * 60_000);
    const second = store.createTask(taskInput({ taskId: "running", schedule: { type: "interval", intervalMinutes: 60, anchorAt: base } }));
    const secondRun = store.claimDue(second.taskId, second.nextRunAt!, "claimed", base + 60 * 60_000);
    store.markRunning(secondRun.run.runId, base + 60 * 60_000 + 1, { threadId: "thread-1", turnId: "turn-1" });

    const recovered = store.recoverAfterCrash(base + 60 * 60_000 + 2);
    expect(recovered.map((run) => run.runId)).toEqual([firstRun.run.runId]);
    expect(store.getRun(firstRun.run.runId)?.state).toBe("uncertain");
    expect(store.getRun(secondRun.run.runId)?.state).toBe("running");
    expect(store.recoverAfterCrash(base + 60 * 60_000 + 2)).toEqual([]);
    store.close();
  });

  it("requires an explicit valid resolution before an uncertain run stops blocking", () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const task = store.createTask(taskInput({ taskId: "resolve-uncertain" }));
    const scheduledFor = task.nextRunAt!;
    const run = store.claimDue(task.taskId, scheduledFor, "claimed", scheduledFor).run;
    store.markUncertain(run.runId, scheduledFor + 1);
    expect(store.hasBlockingRun(task.taskId)).toBe(true);
    expect(() => store.resolveUncertain(run.runId, "failed", scheduledFor - 1)).toThrow(ScheduledTaskStateError);
    expect(() => store.resolveUncertain(run.runId, "completed" as never, scheduledFor + 2))
      .toThrow(ScheduledTaskStateError);
    expect(store.resolveUncertain(run.runId, "failed", scheduledFor + 2).state).toBe("failed");
    expect(store.hasBlockingRun(task.taskId)).toBe(false);
    expect(() => store.resolveUncertain(run.runId, "interrupted", scheduledFor + 3))
      .toThrow(ScheduledTaskStateError);
    store.close();
  });

  it("bounds run retention to 90 days and 200 rows per task", () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const task = store.createTask(taskInput({ taskId: "retained", schedule: { type: "interval", intervalMinutes: 60, anchorAt: base } }));
    let current = task;
    for (let index = 0; index < 201; index += 1) {
      const scheduledFor = current.nextRunAt!;
      const claimed = store.claimDue(current.taskId, scheduledFor, "claimed", scheduledFor);
      store.markRunning(claimed.run.runId, scheduledFor + 1);
      store.markCompleted(claimed.run.runId, scheduledFor + 2);
      current = store.getTask(task.taskId)!;
    }
    expect(store.cleanup(base + 201 * 60 * 60_000)).toBe(1);
    expect(store.listRuns(task.taskId)).toHaveLength(200);
    const activeOccurrence = store.getTask(task.taskId)!.nextRunAt!;
    const activeRun = store.claimDue(task.taskId, activeOccurrence, "claimed", activeOccurrence).run;
    expect(store.cleanup(activeOccurrence + 1)).toBe(1);
    expect(store.getRun(activeRun.runId)?.state).toBe("dispatching");
    store.markUncertain(activeRun.runId, activeOccurrence + 2);
    expect(store.cleanup(activeOccurrence + 3)).toBe(0);
    expect(store.getRun(activeRun.runId)?.errorMessage).not.toContain("Authorization");
    store.close();
  }, 15_000);

  it("removes terminal runs older than 90 days", () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const oldBase = base - 100 * 24 * 60 * 60_000;
    const task = store.createTask(taskInput({
      taskId: "old-run",
      createdAt: oldBase,
      schedule: { type: "interval", intervalMinutes: 60, anchorAt: oldBase },
    }));
    const run = store.claimDue(task.taskId, task.nextRunAt!, "claimed", task.nextRunAt!);
    store.markRunning(run.run.runId, task.nextRunAt! + 1);
    store.markCompleted(run.run.runId, task.nextRunAt! + 2);
    expect(store.cleanup(base)).toBe(1);
    expect(store.getRun(run.run.runId)).toBeUndefined();
    store.close();
  });

  it("requires monotonic Task and Run timestamps", () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const task = store.createTask(taskInput({ taskId: "monotonic" }));
    expect(() => store.pauseTask(task.taskId, task.updatedAt - 1)).toThrow(ScheduledTaskStateError);
    const scheduledFor = task.nextRunAt!;
    const run = store.claimDue(task.taskId, scheduledFor, "claimed", scheduledFor).run;
    expect(() => store.markRunning(run.runId, scheduledFor - 1)).toThrow(ScheduledTaskStateError);
    store.markRunning(run.runId, scheduledFor + 1);
    expect(() => store.markCompleted(run.runId, scheduledFor)).toThrow(ScheduledTaskStateError);
    store.markCompleted(run.runId, scheduledFor + 2);
    store.close();
  });

  it("finds an old blocking run without loading the 200-row display window", () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const task = store.createTask(taskInput({
      taskId: "old-active",
      schedule: { type: "interval", intervalMinutes: 60, anchorAt: base },
    }));
    const first = store.claimDue(task.taskId, task.nextRunAt!, "claimed", task.nextRunAt!);
    let current = store.getTask(task.taskId)!;
    for (let index = 0; index < 201; index += 1) {
      store.claimDue(task.taskId, current.nextRunAt!, "skipped_overlap", current.nextRunAt!);
      current = store.getTask(task.taskId)!;
    }
    expect(store.listRuns(task.taskId).some((run) => run.runId === first.run.runId)).toBe(false);
    expect(store.hasBlockingRun(task.taskId)).toBe(true);
    expect(store.countConversationActiveRuns(task)).toBe(1);
    store.close();
  });
});

function createV1Database(
  path: string,
  anchorAt: number,
  withRun = false,
  intervalHours = 1,
): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE schema_metadata (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    ) STRICT;
    INSERT INTO schema_metadata (name, value) VALUES ('schema_version', 1);
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
    PRAGMA user_version = 1;
  `);
  db.prepare(`
    INSERT INTO tasks (
      task_id, name, status, created_at, updated_at,
      surface, account_id, conversation_id, actor_id, workspace_id, prompt,
      schedule_type, schedule_json, timezone, anchor_at, next_run_at,
      model_provider, model, reasoning_effort, service_tier,
      sandbox, approval_policy, permissions
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "v1-task", "每隔一小时", "active", anchorAt, anchorAt,
    "telegram", "default", "conversation-1", "actor-1", "workspace-1", "read",
    "hourly", JSON.stringify({ type: "hourly", intervalHours, anchorAt }), "UTC",
    anchorAt, anchorAt + 60 * 60_000,
    null, null, null, null, "read-only", "never", null,
  );
  if (withRun) {
    db.prepare(`
      INSERT INTO runs (run_id, task_id, scheduled_for, state)
      VALUES (?, ?, ?, ?)
    `).run("v1-run", "v1-task", anchorAt, "completed");
  }
  db.close();
  if (process.platform === "win32") securePrivateFileSync(path);
  else chmodSync(path, 0o600);
}
