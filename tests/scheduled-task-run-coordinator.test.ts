import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { secureTestDirectory } from "./support/windows-fixtures.js";

import { ScheduledTaskRunCoordinator } from "../src/bootstrap/scheduled-task-run-coordinator.js";
import { MemoryBindingStore } from "../src/storage/index.js";
import {
  SqliteScheduledTaskStore,
  type CreateScheduledTaskInput,
} from "../src/scheduled-tasks/index.js";
import {
  SessionRouter,
  type ThreadLifecyclePort,
  type ThreadSession,
  type ThreadSnapshot,
} from "../src/session-routing/index.js";
import { WorkspaceRegistry } from "../src/policy/index.js";
import type { ThreadHistoryPort, ThreadTurnSummary } from "../src/application/index.js";

const target = {
  surface: "telegram" as const,
  accountId: "default",
  conversationId: "chat-1",
};
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function taskInput(): CreateScheduledTaskInput {
  return {
    taskId: "task-1",
    name: "nightly",
    surface: target.surface,
    accountId: target.accountId,
    conversationId: target.conversationId,
    actorId: "actor-1",
    workspaceId: "main",
    prompt: "read report",
    schedule: { type: "daily", time: "09:00" },
    timezone: "UTC",
    createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
    modelProvider: "openai",
    model: "gpt-main",
    sandbox: "read-only",
    approvalPolicy: "never",
  };
}

function thread(id: string): ThreadSnapshot {
  return {
    id,
    sessionId: id,
    modelProvider: "openai",
    preview: "scheduled",
    name: null,
    isPinned: false,
    status: { type: "idle" },
    cwd: "/workspace",
    source: "automation",
    historyMode: "paginated",
    activeTurnId: null,
  };
}

function session(id: string): ThreadSession {
  return {
    thread: thread(id),
    model: "gpt-main",
    modelProvider: "openai",
    reasoningEffort: "medium",
    serviceTier: "default",
    contextCompactionItemIds: [],
  };
}

function lifecycle(): ThreadLifecyclePort {
  const unsupported = async (): Promise<never> => {
    throw new Error("unsupported");
  };
  return {
    listThreads: unsupported,
    readThread: unsupported,
    startThread: async () => session("new"),
    resumeThread: async (id) => session(id),
    forkThread: unsupported,
    archiveThread: unsupported,
    unarchiveThread: unsupported,
    unsubscribeThread: async () => undefined,
  };
}

function turn(id: string, status: ThreadTurnSummary["status"]): ThreadTurnSummary {
  return {
    id,
    status,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 1,
    inputType: "text",
    textPreview: "read report",
  };
}

function setup(history: ThreadHistoryPort, options: { readonly markRunning?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "codexc-scheduled-coordinator-"));
  directories.push(directory);
  secureTestDirectory(directory);
  const store = new SqliteScheduledTaskStore(join(directory, "scheduled.sqlite3"));
  const task = store.createTask(taskInput());
  const bindings = new MemoryBindingStore();
  bindings.selectWorkspace(target, "main");
  bindings.rememberActor(target, "actor-1");
  bindings.bindBackground({
    target,
    workspaceId: "main",
    threadId: "thread-1",
    sessionId: "thread-1",
  });
  const workspaces = new WorkspaceRegistry([
    { id: "main", name: "Main", cwd: "/workspace", sandbox: "read-only", approvalPolicy: "never" },
  ], "main");
  const router = new SessionRouter(lifecycle(), bindings, workspaces);
  router.updateModelSettings("thread-1", {
    model: "gpt-main",
    modelProvider: "openai",
    effort: "medium",
    serviceTier: "default",
    collaborationMode: "default",
  });
  const claim = store.claimDue(task.taskId, task.nextRunAt!, "claimed", task.nextRunAt! + 1);
  if (claim.kind !== "claimed") throw new Error("test occurrence was not claimed");
  if (options.markRunning !== false) {
    store.markRunning(claim.run.runId, task.nextRunAt! + 2, {
      threadId: "thread-1",
      turnId: "turn-1",
    });
  }
  return {
    store,
    router,
    task,
    coordinator: new ScheduledTaskRunCoordinator(store, router, history, {
      validateRun: async () => undefined,
    }),
  };
}

describe("ScheduledTaskRunCoordinator", () => {
  it("fails closed when restart authorization validation is missing", () => {
    const history: ThreadHistoryPort = {
      listThreadTurns: async () => ({ turns: [], nextCursor: null }),
      revertThread: async () => ({ thread: thread("thread-1") }),
    };
    const { store, router } = setup(history);

    expect(() => new ScheduledTaskRunCoordinator(
      store,
      router,
      history,
      {} as never,
    )).toThrow(/校验依赖/u);
    store.close();
  });

  it("reconciles a running Run from terminal Turn history and releases its background binding", async () => {
    const history: ThreadHistoryPort = {
      listThreadTurns: async () => ({ turns: [turn("turn-1", "completed")], nextCursor: null }),
      revertThread: async () => ({ thread: thread("thread-1") }),
    };
    const { store, router, coordinator } = setup(history);
    coordinator.initialize();

    await coordinator.recoverRunning();

    expect(store.listRuns("task-1")[0]?.state).toBe("completed");
    expect(router.isBackgroundThread("thread-1")).toBe(false);
    store.close();
  });

  it("recovers an old running Run outside the 200-row display window", async () => {
    const history: ThreadHistoryPort = {
      listThreadTurns: async () => ({ turns: [turn("turn-1", "completed")], nextCursor: null }),
      revertThread: async () => ({ thread: thread("thread-1") }),
    };
    const { store, router, task, coordinator } = setup(history);
    const runningRunId = store.listRuns(task.taskId)[0]!.runId;
    let current = store.getTask(task.taskId)!;
    for (let index = 0; index < 201; index += 1) {
      store.claimDue(
        task.taskId,
        current.nextRunAt!,
        "skipped_overlap",
        current.nextRunAt!,
      );
      current = store.getTask(task.taskId)!;
    }
    expect(store.listRuns(task.taskId).some((run) => run.state === "running")).toBe(false);

    coordinator.initialize();
    await coordinator.recoverRunning();

    expect(store.getRun(runningRunId)?.state).toBe("completed");
    expect(router.isBackgroundThread("thread-1")).toBe(false);
    store.close();
  });

  it("converges a running Run to uncertain when the exact Turn cannot be located", async () => {
    const history: ThreadHistoryPort = {
      listThreadTurns: async () => ({ turns: [], nextCursor: null }),
      revertThread: async () => ({ thread: thread("thread-1") }),
    };
    const { store, router, coordinator } = setup(history);
    coordinator.initialize();

    await coordinator.recoverRunning();

    expect(store.listRuns("task-1")[0]?.state).toBe("uncertain");
    expect(router.isBackgroundThread("thread-1")).toBe(true);
    store.close();
  });

  it("blocks a task after restart authorization is revoked", async () => {
    const history: ThreadHistoryPort = {
      listThreadTurns: async () => ({ turns: [turn("turn-1", "completed")], nextCursor: null }),
      revertThread: async () => ({ thread: thread("thread-1") }),
    };
    const { store, router } = setup(history);
    const coordinator = new ScheduledTaskRunCoordinator(store, router, history, {
      validateRun: async () => ({ category: "authorization", blockTask: true }),
    });
    coordinator.initialize();

    await coordinator.recoverRunning();

    expect(store.getTask("task-1")?.status).toBe("blocked");
    expect(store.listRuns("task-1")[0]?.state).toBe("failed");
    store.close();
  });

  it("blocks an invalid persisted Run before attempting subscription restore", async () => {
    const history: ThreadHistoryPort = {
      listThreadTurns: async () => ({ turns: [], nextCursor: null }),
      revertThread: async () => ({ thread: thread("thread-1") }),
    };
    const { store, router } = setup(history);
    const coordinator = new ScheduledTaskRunCoordinator(store, router, history, {
      validateRun: async () => ({ category: "provider", blockTask: true }),
    });
    coordinator.initialize();

    await coordinator.prepareRecovery();

    expect(store.getTask("task-1")?.status).toBe("blocked");
    expect(store.listRuns("task-1")[0]?.state).toBe("failed");
    expect(coordinator.runningThreadIds()).toEqual(new Set());
    expect(router.isBackgroundThread("thread-1")).toBe(false);
    store.close();
  });

  it("keeps a task active when restart validation reports a transient Provider failure", async () => {
    const history: ThreadHistoryPort = {
      listThreadTurns: async () => ({ turns: [{ ...turn("turn-1", "completed") }], nextCursor: null }),
      revertThread: async () => ({ thread: thread("thread-1") }),
    };
    const { store, router } = setup(history);
    const coordinator = new ScheduledTaskRunCoordinator(store, router, history, {
      validateRun: async () => ({ category: "provider", blockTask: false }),
    });
    coordinator.initialize();

    await coordinator.recoverRunning();

    expect(store.getTask("task-1")?.status).toBe("active");
    expect(store.listRuns("task-1")[0]?.state).toBe("uncertain");
    store.close();
  });

  it("associates a dispatching Thread before turn/start and fills the Turn id later", () => {
    const history: ThreadHistoryPort = {
      listThreadTurns: async () => ({ turns: [], nextCursor: null }),
      revertThread: async () => ({ thread: thread("thread-1") }),
    };
    const { store, task, coordinator } = setup(history, { markRunning: false });
    const run = store.listRuns(task.taskId)[0]!;

    coordinator.onThreadStarted(run, target, "fresh-thread");
    expect(coordinator.taskForThread("fresh-thread")?.taskId).toBe(task.taskId);
    coordinator.onTurnStarted(run, target, "fresh-thread", "fresh-turn");
    expect(coordinator.taskForThread("fresh-thread")?.taskId).toBe(task.taskId);
    store.close();
  });

  it("applies a completion that arrives before the scheduler records running", () => {
    const history: ThreadHistoryPort = {
      listThreadTurns: async () => ({ turns: [], nextCursor: null }),
      revertThread: async () => ({ thread: thread("thread-1") }),
    };
    const { store, task, coordinator } = setup(history, { markRunning: false });
    const dispatching = store.listRuns(task.taskId)[0]!;
    coordinator.onThreadStarted(dispatching, target, "fresh-thread");
    coordinator.onTurnStarted(dispatching, target, "fresh-thread", "fresh-turn");

    coordinator.handleCompletion("fresh-thread", "fresh-turn", "completed");
    const running = store.markRunning(
      dispatching.runId,
      dispatching.dispatchStartedAt! + 1,
      { threadId: "fresh-thread", turnId: "fresh-turn" },
    );
    coordinator.onRunStateChanged(running);

    expect(store.getRun(dispatching.runId)?.state).toBe("completed");
    store.close();
  });

  it("records a rejected unattended Server Request as an approval failure", () => {
    const history: ThreadHistoryPort = {
      listThreadTurns: async () => ({ turns: [], nextCursor: null }),
      revertThread: async () => ({ thread: thread("thread-1") }),
    };
    const { store, coordinator } = setup(history);
    coordinator.initialize();

    coordinator.noteServerRequestRejected("thread-1");
    coordinator.handleCompletion("thread-1", "turn-1", "completed");

    expect(store.listRuns("task-1")[0]).toMatchObject({
      state: "failed",
      errorCategory: "approval",
    });
    store.close();
  });

  it("preserves a rejected unattended Server Request across Gateway restart", async () => {
    const history: ThreadHistoryPort = {
      listThreadTurns: async () => ({ turns: [turn("turn-1", "completed")], nextCursor: null }),
      revertThread: async () => ({ thread: thread("thread-1") }),
    };
    const { store, router, coordinator } = setup(history);
    coordinator.initialize();
    coordinator.noteServerRequestRejected("thread-1");

    const restarted = new ScheduledTaskRunCoordinator(store, router, history, {
      validateRun: async () => undefined,
    });
    restarted.initialize();
    await restarted.recoverRunning();

    expect(store.listRuns("task-1")[0]).toMatchObject({
      state: "failed",
      errorCategory: "approval",
    });
    store.close();
  });

  it("does not restore a Run to a different captured model", async () => {
    const history: ThreadHistoryPort = {
      listThreadTurns: async () => ({ turns: [{
        ...turn("turn-1", "completed"),
      }], nextCursor: null }),
      revertThread: async () => ({ thread: thread("thread-1") }),
    };
    const { store, router, coordinator } = setup(history);
    router.updateModelSettings("thread-1", {
      model: "different-model",
      modelProvider: "openai",
      effort: "medium",
      serviceTier: "default",
      collaborationMode: "default",
    });
    coordinator.initialize();

    await coordinator.recoverRunning();

    expect(store.listRuns("task-1")[0]?.state).toBe("uncertain");
    store.close();
  });
});
