import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ScheduledTaskScheduler,
  ScheduledTaskStopTimeoutError,
  SqliteScheduledTaskStore,
  type ScheduledTaskExecutionPort,
  type ScheduledTaskExecutionResult,
} from "../src/scheduled-tasks/index.js";
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

describe("ScheduledTaskScheduler", () => {
  it("dispatches an explicit manual run and records capacity rejection", async () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const taskA = store.createTask(taskInput({ taskId: "manual-a" }));
    const taskB = store.createTask(taskInput({ taskId: "manual-b" }));
    const execute = vi.fn<ScheduledTaskExecutionPort["execute"]>(async () => ({ kind: "running" }));
    const scheduler = new ScheduledTaskScheduler(
      store,
      { execute },
      { maxConcurrentRunsPerConversation: 1 },
    );

    const [first, second] = await Promise.all([
      scheduler.runTaskNow(taskA.taskId, base + 10),
      scheduler.runTaskNow(taskB.taskId, base + 11),
    ]);
    expect(first).toMatchObject({ taskId: taskA.taskId, state: "running" });
    expect(second).toMatchObject({ taskId: taskB.taskId, state: "skipped_capacity" });
    expect(execute).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("does not claim or dispatch a manual run when stopping during capacity inspection", async () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const task = store.createTask(taskInput({ taskId: "manual-stop" }));
    let resolveCapacity!: (value: number) => void;
    const capacity = new Promise<number>((resolve) => {
      resolveCapacity = resolve;
    });
    const execute = vi.fn<ScheduledTaskExecutionPort["execute"]>(async () => ({ kind: "running" }));
    const availableCapacity = vi.fn(async () => await capacity);
    const scheduler = new ScheduledTaskScheduler(store, { execute, availableCapacity });

    const running = scheduler.runTaskNow(task.taskId, base + 10);
    await waitFor(() => availableCapacity.mock.calls.length === 1);
    const stopping = scheduler.stop();
    resolveCapacity(1);

    await expect(running).rejects.toThrow("计划任务调度器正在停止");
    await expect(stopping).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(store.listRuns(task.taskId)).toEqual([]);
    store.close();
  });

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

  it("terminalizes a preflight failure without claiming a started Turn", async () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    const task = store.createTask(taskInput({ schedule: { type: "daily", time: "12:00" } }));
    const scheduler = new ScheduledTaskScheduler(store, {
      execute: async () => ({ kind: "failed", category: "authorization", blockTask: true }),
    });

    const result = await scheduler.tick(Date.parse("2026-01-01T12:04:00.000Z"));

    expect(result.claimed[0]).toMatchObject({
      state: "failed",
      startedAt: null,
      threadId: null,
      turnId: null,
    });
    expect(store.getTask(task.taskId)?.status).toBe("blocked");
    store.close();
  });

  it("retains a created Thread identifier when Turn start fails before running", async () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    store.createTask(taskInput({ schedule: { type: "daily", time: "12:00" } }));
    const scheduler = new ScheduledTaskScheduler(store, {
      execute: async () => ({ kind: "failed", category: "unknown", threadId: "thread-created" }),
    });

    const result = await scheduler.tick(Date.parse("2026-01-01T12:04:00.000Z"));

    expect(result.claimed[0]).toMatchObject({
      state: "failed",
      threadId: "thread-created",
      turnId: null,
      startedAt: null,
    });
    store.close();
  });

  it("persists identifiers on an uncertain write result", async () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    store.createTask(taskInput({ schedule: { type: "daily", time: "12:00" } }));
    const scheduler = new ScheduledTaskScheduler(store, {
      execute: async () => ({
        kind: "uncertain",
        threadId: "thread-uncertain",
        turnId: "turn-uncertain",
      }),
    });

    const result = await scheduler.tick(Date.parse("2026-01-01T12:04:00.000Z"));

    expect(result.claimed[0]).toMatchObject({
      state: "uncertain",
      threadId: "thread-uncertain",
      turnId: "turn-uncertain",
      startedAt: null,
    });
    store.close();
  });

  it("keeps completed Runs on the running path and tolerates a raced terminal callback", async () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    store.createTask(taskInput({ schedule: { type: "daily", time: "12:00" } }));
    const scheduler = new ScheduledTaskScheduler(store, {
      execute: async () => ({ kind: "completed", threadId: "thread-1", turnId: "turn-1" }),
      onRunStateChanged: (run) => {
        if (run.state === "running") store.markCompleted(run.runId, run.startedAt! + 1);
      },
    });

    const result = await scheduler.tick(Date.parse("2026-01-01T12:04:00.000Z"));

    expect(result.claimed[0]).toMatchObject({
      state: "completed",
      startedAt: expect.any(Number),
      completedAt: expect.any(Number),
    });
    store.close();
  });

  it("serializes dispatches within one Conversation while other Conversations run in parallel", async () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    store.createTask(taskInput({
      taskId: "same-a",
      createdAt: base,
      schedule: { type: "daily", time: "12:00" },
    }));
    store.createTask(taskInput({
      taskId: "same-b",
      createdAt: base + 1,
      schedule: { type: "daily", time: "12:00" },
    }));
    store.createTask(taskInput({
      taskId: "other",
      createdAt: base + 2,
      conversationId: "conversation-2",
      schedule: { type: "daily", time: "12:00" },
    }));
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const scheduler = new ScheduledTaskScheduler(store, {
      execute: async (task) => {
        started.push(task.taskId);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await delay(task.taskId === "same-a" ? 15 : 1);
        active -= 1;
        return { kind: "running" };
      },
    });

    const result = await scheduler.tick(Date.parse("2026-01-01T12:04:00.000Z"));

    expect(result.claimed).toHaveLength(3);
    expect(started.indexOf("same-a")).toBeLessThan(started.indexOf("same-b"));
    expect(maximumActive).toBeGreaterThan(1);
    store.close();
  });

  it("reserves reported background capacity before dispatching a Conversation group", async () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    for (const [index, taskId] of ["capacity-a", "capacity-b", "capacity-c"].entries()) {
      store.createTask(taskInput({
        taskId,
        createdAt: base + index,
        schedule: { type: "daily", time: "12:00" },
      }));
    }
    const execute = vi.fn<ScheduledTaskExecutionPort["execute"]>(async () => ({ kind: "running" }));
    const scheduler = new ScheduledTaskScheduler(store, {
      availableCapacity: () => 1,
      execute,
    });

    const result = await scheduler.tick(Date.parse("2026-01-01T12:04:00.000Z"));

    expect(result.claimed).toHaveLength(1);
    expect(result.skippedCapacity).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("records the actual response time instead of the tick start time", async () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    store.createTask(taskInput({ schedule: { type: "daily", time: "12:00" } }));
    const tickAt = Date.parse("2026-01-01T12:04:00.000Z");
    let current = tickAt;
    const scheduler = new ScheduledTaskScheduler(
      store,
      {
        execute: async () => {
          current += 5_000;
          return { kind: "running" };
        },
      },
      { clock: { now: () => current } },
    );

    const result = await scheduler.tick(tickAt);

    expect(result.claimed[0]?.startedAt).toBe(tickAt + 5_000);
    store.close();
  });

  it("does not start already claimed Conversation jobs after stop begins", async () => {
    const { path } = databasePath();
    const store = new SqliteScheduledTaskStore(path);
    for (const [index, taskId] of ["stop-a", "stop-b", "stop-c"].entries()) {
      store.createTask(taskInput({
        taskId,
        createdAt: base + index,
        schedule: { type: "daily", time: "12:00" },
      }));
    }
    let firstSignal: AbortSignal | undefined;
    const execute = vi.fn<ScheduledTaskExecutionPort["execute"]>(async (_task, _run, signal) => {
      firstSignal = signal;
      return await new Promise<ScheduledTaskExecutionResult>((resolve) => {
        signal.addEventListener("abort", () => resolve({ kind: "interrupted" }), { once: true });
      });
    });
    const scheduler = new ScheduledTaskScheduler(store, { execute }, { stopTimeoutMs: 100 });
    const tick = scheduler.tick(Date.parse("2026-01-01T12:04:00.000Z"));
    await waitFor(() => firstSignal !== undefined);

    await scheduler.stop();
    const result = await tick;

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.claimed.map(({ state }) => state)).toEqual([
      "interrupted",
      "interrupted",
      "interrupted",
    ]);
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
