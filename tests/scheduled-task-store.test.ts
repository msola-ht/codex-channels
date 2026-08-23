import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ScheduledTaskSchemaError,
  ScheduledTaskScheduler,
  ScheduledTaskStateError,
  ScheduledTaskStopTimeoutError,
  SqliteScheduledTaskStore,
  type CreateScheduledTaskInput,
  type ScheduledTaskExecutionPort,
} from "../src/scheduled-tasks/index.js";

const directories: string[] = [];
const base = Date.parse("2026-01-01T00:00:00.000Z");

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SqliteScheduledTaskStore", () => {
  it("creates a private v1 database and reopens the task definition", () => {
    const { directory, path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const task = store.createTask(taskInput({ createdAt: base + 8 * 60 * 60_000 }));

    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
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

  it("rejects unknown, incomplete, and mismatched schemas without migrating", () => {
    const unknown = databasePath();
    const unknownDb = new DatabaseSync(unknown.path);
    unknownDb.exec("CREATE TABLE unrelated (value TEXT)");
    unknownDb.close();
    expect(() => new SqliteScheduledTaskStore(unknown.path)).toThrow(ScheduledTaskSchemaError);

    const incomplete = databasePath();
    const incompleteDb = new DatabaseSync(incomplete.path);
    incompleteDb.exec(`
      CREATE TABLE schema_metadata (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO schema_metadata VALUES ('schema_version', 1);
      CREATE TABLE tasks (task_id TEXT PRIMARY KEY);
      CREATE TABLE runs (run_id TEXT PRIMARY KEY);
      PRAGMA user_version = 1;
    `);
    incompleteDb.close();
    expect(() => new SqliteScheduledTaskStore(incomplete.path))
      .toThrow(/Schema 1.*结构不完整/);

    const wrongVersion = databasePath();
    const wrongVersionDb = new DatabaseSync(wrongVersion.path);
    wrongVersionDb.exec("PRAGMA user_version = 2");
    wrongVersionDb.close();
    expect(() => new SqliteScheduledTaskStore(wrongVersion.path)).toThrow(ScheduledTaskSchemaError);
  });

  it("rejects extra columns and unsafe existing directories without changing permissions", () => {
    const valid = databasePath();
    const store = new SqliteScheduledTaskStore(valid.path);
    store.close();
    const db = new DatabaseSync(valid.path);
    db.exec("ALTER TABLE tasks ADD COLUMN unexpected TEXT");
    db.close();
    expect(() => new SqliteScheduledTaskStore(valid.path))
      .toThrow(/Schema 1.*结构不完整/);

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

  it("atomically claims an occurrence and rejects a duplicate claim", () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const task = store.createTask(taskInput({ schedule: { type: "hourly", intervalHours: 1, anchorAt: base } }));
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
    const first = store.createTask(taskInput({ taskId: "dispatching", schedule: { type: "hourly", intervalHours: 1, anchorAt: base } }));
    const firstRun = store.claimDue(first.taskId, first.nextRunAt!, "claimed", base + 60 * 60_000);
    const second = store.createTask(taskInput({ taskId: "running", schedule: { type: "hourly", intervalHours: 1, anchorAt: base } }));
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
    const task = store.createTask(taskInput({ taskId: "retained", schedule: { type: "hourly", intervalHours: 1, anchorAt: base } }));
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
  });

  it("removes terminal runs older than 90 days", () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const oldBase = base - 100 * 24 * 60 * 60_000;
    const task = store.createTask(taskInput({
      taskId: "old-run",
      createdAt: oldBase,
      schedule: { type: "hourly", intervalHours: 1, anchorAt: oldBase },
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
      schedule: { type: "hourly", intervalHours: 1, anchorAt: base },
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

describe("ScheduledTaskScheduler", () => {
  it("owns cleanup on the first tick and at most once per 24 hours", async () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    let now = base;
    const cleanup = vi.spyOn(store, "cleanup");
    const onError = vi.fn<(error: unknown) => void>();
    const scheduler = new ScheduledTaskScheduler(
      store,
      { execute: async () => ({ kind: "running" }) },
      { clock: { now: () => now }, onError },
    );

    await scheduler.tick();
    expect(cleanup).toHaveBeenCalledTimes(1);
    await scheduler.tick();
    expect(cleanup).toHaveBeenCalledTimes(1);
    now = base + 24 * 60 * 60_000 - 1;
    await scheduler.tick();
    expect(cleanup).toHaveBeenCalledTimes(1);
    now += 1;
    await scheduler.tick();
    expect(cleanup).toHaveBeenCalledTimes(2);

    cleanup.mockImplementation(() => {
      throw new Error("cleanup failed");
    });
    now += 24 * 60 * 60_000;
    const result = await scheduler.tick();
    expect(result.claimed).toEqual([]);
    expect(onError).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(3);
    store.close();
  });

  it("runs a recent occurrence and marks an old outage occurrence missed", async () => {
    const recent = databasePath();
    const execute = vi.fn<ScheduledTaskExecutionPort["execute"]>(async () => ({ kind: "running" }));
    const recentStore = new SqliteScheduledTaskStore(recent.path);
    const recentTask = recentStore.createTask(taskInput({
      taskId: "recent",
      createdAt: Date.parse("2026-01-01T11:56:00.000Z"),
      schedule: { type: "daily", time: "12:00" },
    }));
    const scheduler = new ScheduledTaskScheduler(recentStore, { execute }, { maxConcurrentRunsPerConversation: 3 });
    const recentResult = await scheduler.tick(Date.parse("2026-01-01T12:04:00.000Z"));
    expect(recentResult.claimed[0]?.taskId).toBe(recentTask.taskId);
    expect(recentStore.listRuns(recentTask.taskId)[0]?.state).toBe("running");
    recentStore.close();

    const outage = databasePath();
    const outageStore = new SqliteScheduledTaskStore(outage.path);
    const outageTask = outageStore.createTask(taskInput({
      taskId: "outage",
      createdAt: Date.parse("2026-01-01T08:00:00.000Z"),
      schedule: { type: "daily", time: "09:00" },
    }));
    const outageExecute = vi.fn<ScheduledTaskExecutionPort["execute"]>(async () => ({ kind: "running" }));
    const outageScheduler = new ScheduledTaskScheduler(outageStore, { execute: outageExecute });
    const outageResult = await outageScheduler.tick(Date.parse("2026-01-02T12:00:00.000Z"));
    expect(outageResult.missed.length).toBe(2);
    expect(outageStore.getTask(outageTask.taskId)?.nextRunAt).toBe(Date.parse("2026-01-03T09:00:00.000Z"));
    outageStore.close();
  });

  it("separates same-task overlap from per-Conversation capacity", async () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const taskA = store.createTask(taskInput({ taskId: "a", schedule: { type: "daily", time: "12:00" } }));
    const taskB = store.createTask(taskInput({ taskId: "b", schedule: { type: "daily", time: "12:00" } }));
    const execute = vi.fn<ScheduledTaskExecutionPort["execute"]>(async () => ({ kind: "running" }));
    const scheduler = new ScheduledTaskScheduler(store, { execute }, { maxConcurrentRunsPerConversation: 1 });
    const result = await scheduler.tick(Date.parse("2026-01-01T12:04:00.000Z"));
    expect(result.claimed).toHaveLength(1);
    expect(result.skippedCapacity).toHaveLength(1);
    expect(result.skippedCapacity[0]?.taskId).not.toBe(result.claimed[0]?.taskId);

    const nextTime = Date.parse("2026-01-02T12:04:00.000Z");
    const overlap = await scheduler.tick(nextTime);
    expect(overlap.skippedOverlap).toHaveLength(1);
    expect(overlap.skippedCapacity).toHaveLength(1);
    expect(store.getTask(taskA.taskId)?.nextRunAt).toBeGreaterThan(nextTime);
    expect(store.getTask(taskB.taskId)?.nextRunAt).toBeGreaterThan(nextTime);
    store.close();
  });

  it("turns an executor rejection into uncertain without retrying the write", async () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    store.createTask(taskInput({ taskId: "unknown-result", schedule: { type: "daily", time: "12:00" } }));
    const execute = vi.fn<ScheduledTaskExecutionPort["execute"]>(async () => {
      throw new Error("Authorization: Bearer secret");
    });
    const scheduler = new ScheduledTaskScheduler(store, { execute });
    const result = await scheduler.tick(Date.parse("2026-01-01T12:04:00.000Z"));
    expect(result.claimed[0]?.state).toBe("uncertain");
    expect(result.claimed[0]?.errorMessage).toBe("运行结果未知，需要人工确认");
    expect(result.claimed[0]?.errorMessage).not.toContain("Authorization");
    expect(execute).toHaveBeenCalledTimes(1);
    const nextScheduledFor = store.getTask("unknown-result")!.nextRunAt!;
    const blocked = await scheduler.tick(nextScheduledFor + 4 * 60_000);
    expect(blocked.blocked).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.hasBlockingRun("unknown-result")).toBe(true);
    store.close();
  });

  it("reports timer tick failures and aborts a hanging execution on bounded stop", async () => {
    const closed = databasePath();
    const closedStore = new SqliteScheduledTaskStore(closed.path);
    closedStore.close();
    const onError = vi.fn<(error: unknown) => void>();
    const closedScheduler = new ScheduledTaskScheduler(
      closedStore,
      { execute: async () => ({ kind: "running" }) },
      { pollIntervalMs: 5, onError },
    );
    closedScheduler.start();
    await delay(20);
    expect(onError).toHaveBeenCalled();
    await closedScheduler.stop();

    const pending = databasePath();
    const pendingStore = new SqliteScheduledTaskStore(pending.path);
    const task = pendingStore.createTask(taskInput({ taskId: "hanging", schedule: { type: "daily", time: "12:00" } }));
    let observedSignal: AbortSignal | undefined;
    let resolveExecution: ((result: { readonly kind: "running" }) => void) | undefined;
    const execution = new Promise<{ readonly kind: "running" }>((resolve) => {
      resolveExecution = resolve;
    });
    const scheduler = new ScheduledTaskScheduler(
      pendingStore,
      {
        execute: async (_task, _run, signal) => {
          observedSignal = signal;
          return execution;
        },
      },
      { stopTimeoutMs: 10 },
    );
    const tick = scheduler.tick(task.nextRunAt! + 4 * 60_000);
    await waitFor(() => observedSignal !== undefined);
    await expect(scheduler.stop()).rejects.toBeInstanceOf(ScheduledTaskStopTimeoutError);
    expect(observedSignal?.aborted).toBe(true);
    resolveExecution!({ kind: "running" });
    await tick;
    pendingStore.close();
  });
});

function databasePath(): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), "codexc-scheduled-tasks-"));
  chmodSync(directory, 0o700);
  directories.push(directory);
  return { directory, path: join(directory, "scheduled-tasks.sqlite3") };
}

function taskInput(overrides: Partial<CreateScheduledTaskInput> = {}): CreateScheduledTaskInput {
  return {
    taskId: "task-1",
    name: "Report",
    surface: "telegram",
    accountId: "default",
    conversationId: "conversation-1",
    actorId: "actor-1",
    workspaceId: "workspace-1",
    prompt: "read the report",
    schedule: { type: "daily", time: "09:00" },
    timezone: "UTC",
    createdAt: base,
    ...overrides,
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(1);
  }
  throw new Error("测试条件未在有限时间内满足");
}
