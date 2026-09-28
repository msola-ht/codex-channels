import { cleanupScheduledTaskTestFixtures, scheduledTaskDatabasePath, scheduledTaskInput, scheduledTaskBase } from "./scheduled-task-test-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TurnExecutionPort } from "../src/application/index.js";
import {
  ScheduledTaskExecutor,
  type ScheduledTaskExecutorOptions,
} from "../src/bootstrap/scheduled-task-executor.js";
import { UserFacingError } from "../src/conversation-core/index.js";
import type { ConversationCore } from "../src/conversation-core/index.js";
import { MemoryBindingStore } from "../src/storage/index.js";
import {
  ScheduledTaskScheduler, SqliteScheduledTaskStore,
  type ScheduledRun,
  type ScheduledTask,
} from "../src/scheduled-tasks/index.js";
import {
  SessionRouter,
  type ThreadLifecyclePort,
  type ThreadSession,
  type ThreadSnapshot,
} from "../src/session-routing/index.js";
import { WorkspaceRegistry } from "../src/policy/index.js";

const deliveryDirectories: string[] = [];
afterEach(() => cleanupScheduledTaskTestFixtures(deliveryDirectories));

const target = {
  surface: "telegram",
  accountId: "default",
  conversationId: "chat-1",
} as const;

function snapshot(id: string, status: "idle" | "active" = "idle"): ThreadSnapshot {
  return {
    id,
    sessionId: id,
    modelProvider: "openai",
    preview: "scheduled",
    name: null,
    isPinned: false,
    status: { type: status },
    cwd: "/workspace",
    source: "automation",
    historyMode: "paginated",
    activeTurnId: null,
  };
}

function session(
  id: string,
  overrides: Partial<Omit<ThreadSession, "thread">> = {},
): ThreadSession {
  return {
    thread: snapshot(id),
    model: "gpt-main",
    modelProvider: "openai",
    reasoningEffort: "medium",
    serviceTier: "default",
    contextCompactionItemIds: [],
    ...overrides,
  };
}

function port(overrides: Partial<ThreadLifecyclePort> = {}): ThreadLifecyclePort {
  const unsupported = async (): Promise<never> => {
    throw new Error("测试未配置 ThreadLifecyclePort 方法");
  };
  return {
    listThreads: unsupported,
    readThread: unsupported,
    startThread: async () => session("automation-thread"),
    resumeThread: unsupported,
    forkThread: unsupported,
    archiveThread: unsupported,
    unarchiveThread: unsupported,
    unsubscribeThread: async () => undefined,
    ...overrides,
  };
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    taskId: "task-1",
    name: "nightly",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    surface: target.surface,
    accountId: target.accountId,
    conversationId: target.conversationId,
    actorId: "actor-1",
    workspaceId: "main",
    prompt: "read the report",
    schedule: null,
    timezone: null,
    nextRunAt: null,
    modelProvider: "openai",
    model: "gpt-main",
    reasoningEffort: "medium",
    serviceTier: "default",
    permission: {
      sandbox: "read-only",
      approvalPolicy: "never",
      permissions: null,
    },
    ...overrides,
  };
}

const run: ScheduledRun = {
  runId: "run-1",
  taskId: "task-1",
  scheduledFor: 1,
  state: "dispatching",
  threadId: null,
  turnId: null,
  dispatchStartedAt: 1,
  startedAt: null,
  completedAt: null,
  errorCategory: null,
  errorMessage: null,
};

function setup(options: {
  startThread?: ThreadLifecyclePort["startThread"];
  startTurn?: TurnExecutionPort["startTurn"];
  unsubscribeThread?: ThreadLifecyclePort["unsubscribeThread"];
  models?: Partial<ConstructorParameters<typeof ScheduledTaskExecutor>[4]>;
  executorOptions?: Partial<ScheduledTaskExecutorOptions>;
} = {}) {
  const bindings = new MemoryBindingStore();
  bindings.selectWorkspace(target, "main");
  bindings.rememberActor(target, "actor-1");
  const workspaces = new WorkspaceRegistry([
    { id: "main", name: "Main", cwd: "/workspace", sandbox: "read-only", approvalPolicy: "never" },
  ], "main");
  const router = new SessionRouter(
    port({
      ...(options.startThread === undefined ? {} : { startThread: options.startThread }),
      ...(options.unsubscribeThread === undefined ? {} : { unsubscribeThread: options.unsubscribeThread }),
    }),
    bindings,
    workspaces,
  );
  const turns = {
    startTurn: options.startTurn ?? (async () => ({ turnId: "turn-1" })),
  } as TurnExecutionPort;
  const core = { markTurnStarted: vi.fn() } as unknown as Pick<ConversationCore, "markTurnStarted">;
  const models = {
    isProviderConfigured: () => true,
    ensureProvider: async () => undefined,
    isModelAvailable: async () => true,
    ...options.models,
  };
  const executorOptions: ScheduledTaskExecutorOptions = {
    isSurfaceEnabled: () => true,
    acceptsExecution: () => true,
    onThreadStarted: () => undefined,
    onTurnStarted: () => undefined,
    onRunStateChanged: () => undefined,
    ...options.executorOptions,
  };
  const executor = new ScheduledTaskExecutor(
    router,
    turns,
    bindings,
    workspaces,
    models,
    core,
    executorOptions,
  );
  return { executor, bindings, router, turns, core, workspaces };
}

describe("ScheduledTaskExecutor", () => {
  it("does not let background cleanup unsubscribe a valid foreground binding", async () => {
    const unsubscribeThread = vi.fn(async () => {});
    const value = setup({ unsubscribeThread });
    value.bindings.bind({ target, workspaceId: "main", threadId: "foreground", sessionId: "foreground" });
    await value.router.releaseBackground("foreground");
    expect(unsubscribeThread).not.toHaveBeenCalled();
    expect(value.bindings.get(target)?.threadId).toBe("foreground");
  });
  it.each(["provider", "model", "thread", "bound"] as const)("rejects revocation during %s preparation before starting a Turn", async (stage) => {
    let revoke = () => {};
    const startTurn = vi.fn(async () => ({ turnId: "turn" }));
    const unsubscribeThread = vi.fn(async () => {});
    const startThread = vi.fn(async () => { if (stage === "thread") revoke(); return session("automation-thread"); });
    const value = setup({ startThread, startTurn, unsubscribeThread,
      executorOptions: { onThreadStarted: () => { if (stage === "bound") revoke(); } }, models: {
      ensureProvider: async () => { if (stage === "provider") revoke(); },
      isModelAvailable: async () => { if (stage === "model") revoke(); return true; },
    } });
    revoke = () => { value.bindings.retainActors(target, new Set()); };
    expect(await value.executor.execute(task(), run, new AbortController().signal)).toMatchObject({ kind: "failed", category: "authorization", blockTask: true });
    expect(startTurn).not.toHaveBeenCalled();
    expect(startThread).toHaveBeenCalledTimes(stage === "thread" || stage === "bound" ? 1 : 0);
    expect(unsubscribeThread).toHaveBeenCalledTimes(stage === "thread" || stage === "bound" ? 1 : 0);
    expect(value.router.backgroundBindings(target)).toHaveLength(0);
  });

  it.each(["cancel", "capacity", "workspace"] as const)("cleans up a newly created Thread after %s changes without starting a Turn", async (change) => {
    const controller = new AbortController(); let available = true;
    let update = () => {};
    const startTurn = vi.fn(async () => ({ turnId: "turn" }));
    const unsubscribeThread = vi.fn(async () => {});
    const value = setup({ startTurn, unsubscribeThread,
      startThread: async () => { update(); return session("automation-thread"); },
      executorOptions: { acceptsExecution: () => available },
    });
    update = () => {
      if (change === "cancel") controller.abort();
      if (change === "capacity") available = false;
      if (change === "workspace") value.workspaces.replace([{ id: "main", name: "Main", cwd: "/changed", sandbox: "read-only", approvalPolicy: "never" }], "main");
    };
    expect(await value.executor.execute(task(), run, controller.signal)).toMatchObject(change === "cancel"
      ? { kind: "interrupted" } : { kind: "failed", category: change });
    expect(startTurn).not.toHaveBeenCalled(); expect(unsubscribeThread).toHaveBeenCalledOnce();
    expect(value.router.backgroundBindings(target)).toHaveLength(0);
  });

  it("stops model preflight after cancellation without issuing a Thread write", async () => {
    const controller = new AbortController();
    const startThread = vi.fn(async () => session("automation-thread"));
    const isModelAvailable = vi.fn(async () => true);
    const value = setup({ startThread, models: { ensureProvider: async () => { controller.abort(); }, isModelAvailable } });
    expect(await value.executor.execute(task(), run, controller.signal)).toEqual({ kind: "interrupted" });
    expect(isModelAvailable).not.toHaveBeenCalled(); expect(startThread).not.toHaveBeenCalled();
  });

  it("fails closed when mandatory unattended validation dependencies are missing", () => {
    const { router, turns, bindings, workspaces, core } = setup();

    expect(() => new ScheduledTaskExecutor(
      router,
      turns,
      bindings,
      workspaces,
      {} as never,
      core,
      {} as never,
    )).toThrow(/校验依赖/u);
  });

  it("revalidates Actor authorization on every Run", async () => {
    const { executor, bindings } = setup();
    bindings.forgetActor(target, "actor-1");

    await expect(executor.execute(task(), run, new AbortController().signal))
      .resolves.toEqual({ kind: "failed", category: "authorization", blockTask: true });
  });

  it("starts a fresh background Thread and Turn with fixed unattended permissions", async () => {
    const started: unknown[] = [];
    const turns: unknown[] = [];
    const { executor, core } = setup({
      startThread: async (cwd, options) => {
        started.push({ cwd, options });
        return session("automation-thread");
      },
      startTurn: async (...args) => {
        turns.push(args);
        return { turnId: "turn-1" };
      },
    });

    await expect(executor.execute(task(), run, new AbortController().signal))
      .resolves.toMatchObject({ kind: "running", threadId: "automation-thread", turnId: "turn-1" });
    expect(started).toEqual([{
      cwd: "/workspace",
      options: {
        model: "gpt-main",
        modelProvider: "openai",
        sandbox: "read-only",
        approvalPolicy: "never",
        threadSource: "automation",
      },
    }]);
    expect(turns[0]).toEqual([
      "automation-thread",
      [{ type: "text", text: "read the report" }],
      "scheduled-run-run-1",
      "/workspace",
      { model: "gpt-main", effort: "medium", serviceTier: "default" },
    ]);
    expect(core.markTurnStarted).toHaveBeenCalledWith(
      target,
      "automation-thread",
      "turn-1",
    );
  });

  it("uses the current Workspace permission instead of a frozen task permission", async () => {
    const started: unknown[] = [];
    const { executor } = setup({
      startThread: async (cwd, options) => {
        started.push({ cwd, options });
        return session("automation-thread");
      },
    });

    await executor.execute(
      task({ permission: { sandbox: "workspace-write", approvalPolicy: "never", permissions: null } }),
      run,
      new AbortController().signal,
    );

    expect(started[0]).toMatchObject({
      options: { sandbox: "read-only", approvalPolicy: "never" },
    });
  });

  it("fails closed for unavailable Provider or model before thread/start", async () => {
    const startThread = vi.fn(async () => session("should-not-start"));
    const { executor } = setup({
      startThread,
      models: {
        ensureProvider: async () => {
          throw new Error("provider unavailable");
        },
      },
    });

    await expect(executor.execute(task(), run, new AbortController().signal))
      .resolves.toEqual({ kind: "failed", category: "provider" });
    expect(startThread).not.toHaveBeenCalled();
  });

  it("blocks only an explicitly unconfigured Provider, not a transient connect failure", async () => {
    const startThread = vi.fn(async () => session("should-not-start"));
    const ensureProvider = vi.fn(async () => {
      throw new Error("temporary connection failure");
    });
    const { executor } = setup({
      startThread,
      models: {
        isProviderConfigured: () => true,
        ensureProvider,
      },
    });

    await expect(executor.execute(task(), run, new AbortController().signal))
      .resolves.toEqual({ kind: "failed", category: "provider" });
    expect(ensureProvider).toHaveBeenCalledWith("openai");
    expect(startThread).not.toHaveBeenCalled();

    const unavailable = setup({
      startThread,
      models: { isProviderConfigured: () => false, ensureProvider },
    });
    await expect(unavailable.executor.execute(task(), run, new AbortController().signal))
      .resolves.toEqual({ kind: "failed", category: "provider", blockTask: true });
    expect(ensureProvider).toHaveBeenCalledTimes(1);
  });

  it("checks the actual Thread model before issuing turn/start", async () => {
    const startTurn = vi.fn(async () => ({ turnId: "must-not-start" }));
    const { executor } = setup({
      startThread: async () => session("wrong-model", { model: "other-model" }),
      startTurn,
    });

    await expect(executor.execute(task(), run, new AbortController().signal))
      .resolves.toEqual({ kind: "failed", category: "model", threadId: "wrong-model" });
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("retains ownership when fresh Thread unsubscribe fails during cleanup", async () => {
    const { executor, router } = setup({
      startThread: async () => session("wrong-model", { model: "other-model" }),
      unsubscribeThread: async () => {
        throw new Error("temporary unsubscribe failure");
      },
    });

    await expect(executor.execute(task(), run, new AbortController().signal))
      .resolves.toMatchObject({ kind: "failed", category: "model", threadId: "wrong-model" });
    expect(router.isBackgroundThread("wrong-model")).toBe(true);
  });

  it("turns cancellation after known Thread creation into an interrupted terminal result", async () => {
    const controller = new AbortController();
    const unsubscribe = vi.fn(async () => undefined);
    const { executor } = setup({
      executorOptions: {
        onThreadStarted: () => controller.abort(),
      },
      unsubscribeThread: unsubscribe,
      startTurn: vi.fn(async () => ({ turnId: "must-not-start" })),
    });

    await expect(executor.execute(task(), run, controller.signal))
      .resolves.toEqual({ kind: "interrupted", threadId: "automation-thread" });
    expect(unsubscribe).toHaveBeenCalledWith("automation-thread");
  });

  it("marks a write result unknown without retrying after a transport failure", async () => {
    const startThread = vi.fn(async () => {
      throw new Error("Codex JSON-RPC 请求超时：thread/start");
    });
    const { executor } = setup({ startThread });

    await expect(executor.execute(task(), run, new AbortController().signal))
      .resolves.toEqual({ kind: "uncertain" });
    expect(startThread).toHaveBeenCalledTimes(1);
  });

  it("does not start when the fixed three-background capacity is full", async () => {
    const { executor, bindings } = setup();
    for (const id of ["one", "two", "three"]) {
      bindings.bindBackground({ target, workspaceId: "main", threadId: id, sessionId: id });
    }

    await expect(executor.execute(task(), run, new AbortController().signal))
      .resolves.toEqual({ kind: "failed", category: "capacity" });
  });
});


it.each(["before-validation", "during-validation"])("rejects temporary delivery pressure %s before creating a Thread", async (stage) => {
  let allowed = stage !== "before-validation";
  const startThread = vi.fn(async () => session("fresh"));
  const { executor } = setup({ startThread,
    models: { ensureProvider: async () => { allowed = false; } },
    executorOptions: { acceptsExecution: () => allowed },
  });
  await expect(executor.execute(task(), run, new AbortController().signal)).resolves.toEqual({ kind: "failed", category: "capacity" });
  expect(startThread).not.toHaveBeenCalled();
  expect(executor.availableCapacity(task())).toBe(0);
  allowed = true;
  expect(executor.availableCapacity(task())).toBe(3);
});

it("preserves the recurring task through early pressure and a Turn admission race, then runs after recovery", async () => {
  let allowed = false;
  let race = false;
  let count = 0;
  const startThread = vi.fn(async () => session(`fresh-${++count}`));
  const unsubscribeThread = vi.fn(async () => {});
  const { executor } = setup({ startThread, unsubscribeThread,
    startTurn: async () => { if (race) throw new UserFacingError("delivery.overloaded", "fixture pressure"); return { turnId: "accepted" }; },
    executorOptions: { acceptsExecution: () => allowed },
  });
  const store = new SqliteScheduledTaskStore(scheduledTaskDatabasePath(deliveryDirectories).path);
  const scheduled = store.createTask(scheduledTaskInput({ ...target, actorId: "actor-1", workspaceId: "main", model: "gpt-main", modelProvider: "openai" }));
  const scheduler = new ScheduledTaskScheduler(store, executor);
  try {
    expect(await scheduler.runTaskNow(scheduled.taskId, scheduledTaskBase + 1)).toMatchObject({ state: "skipped_capacity" });
    expect(startThread).not.toHaveBeenCalled();
    allowed = true;
    race = true;
    expect(await scheduler.runTaskNow(scheduled.taskId, scheduledTaskBase + 2)).toMatchObject({ state: "failed", errorCategory: "capacity" });
    expect(unsubscribeThread).toHaveBeenCalledWith("fresh-1");
    expect(store.getTask(scheduled.taskId)).toMatchObject({ status: "active", nextRunAt: scheduled.nextRunAt });
    race = false;
    expect(await scheduler.runTaskNow(scheduled.taskId, scheduledTaskBase + 3)).toMatchObject({ state: "running", turnId: "accepted" });
    expect(startThread).toHaveBeenCalledTimes(2);
  } finally { await scheduler.stop(); store.close(); }
});
