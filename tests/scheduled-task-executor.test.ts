import { describe, expect, it, vi } from "vitest";

import type { TurnExecutionPort } from "../src/application/index.js";
import {
  ScheduledTaskExecutor,
  type ScheduledTaskExecutorOptions,
} from "../src/bootstrap/scheduled-task-executor.js";
import type { ConversationCore } from "../src/conversation-core/index.js";
import { MemoryBindingStore } from "../src/storage/index.js";
import {
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
