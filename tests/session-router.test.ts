import { describe, expect, it, vi } from "vitest";

import { JsonRpcError } from "../src/codex-client/json-rpc.js";
import { MemoryBindingStore } from "../src/storage/memory-binding-store.js";
import {
  SessionRouter,
  type ThreadLifecyclePort,
  type ThreadSession,
  type ThreadSnapshot,
  type ThreadStatus,
} from "../src/session-routing/index.js";
import { WorkspaceRegistry } from "../src/policy/workspace-registry.js";

const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
const registry = new WorkspaceRegistry(
  [
    { id: "main", name: "Main", cwd: "/workspace" },
    { id: "other", name: "Other", cwd: "/other" },
  ],
  "main",
);

function thread(id: string, status: ThreadStatus): ThreadSnapshot {
  return {
    id,
    sessionId: id,
    modelProvider: "openai",
    preview: "test",
    isPinned: false,
    status,
    cwd: "/workspace",
    source: "cli",
    name: null,
    activeTurnId: null,
    historyMode: "paginated",
  };
}

function session(
  value: ThreadSnapshot,
  overrides: Partial<Omit<ThreadSession, "thread">> = {},
): ThreadSession {
  return {
    thread: value,
    model: "gpt-main",
    reasoningEffort: "medium",
    serviceTier: "default",
    contextCompactionItemIds: [],
    ...overrides,
  };
}

function threadPort(overrides: Partial<ThreadLifecyclePort> = {}): ThreadLifecyclePort {
  const unsupported = async (): Promise<never> => {
    throw new Error("测试未配置 ThreadLifecyclePort 方法");
  };
  return {
    listThreads: unsupported,
    readThread: unsupported,
    startThread: unsupported,
    resumeThread: unsupported,
    forkThread: unsupported,
    archiveThread: unsupported,
    unarchiveThread: unsupported,
    unsubscribeThread: unsupported,
    ...overrides,
  };
}

describe("SessionRouter", () => {
  it("removes a binding when its Provider was deleted", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "deleted-provider", sessionId: "deleted-provider" });
    const router = new SessionRouter(threadPort({
      resumeThread: async () => {
        throw new Error("模型 Provider 未配置独立 App Server：opencode-go-main");
      },
    }), store, registry);

    const failures = await router.restoreSubscriptions();

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ bindingRemoved: true, reason: "unavailable" });
    expect(store.get(target)).toBeUndefined();
  });

  it("passes workspace permissions to startThread and resumeThread", async () => {
    const store = new MemoryBindingStore();
    const entitledRegistry = new WorkspaceRegistry([
      {
        id: "main",
        name: "Main",
        cwd: "/workspace",
        sandbox: "workspace-write",
        approvalPolicy: "never",
      },
      { id: "other", name: "Other", cwd: "/other" },
    ], "main");
    const started: unknown[] = [];
    const resumed: unknown[] = [];
    const client = threadPort({
      listThreads: async () => [],
      startThread: async (cwd, options) => {
        started.push({ cwd, options });
        return session(thread("new", { type: "idle" }));
      },
      resumeThread: async (threadId, cwd, options) => {
        resumed.push({ threadId, cwd, options });
        return session(thread(threadId, { type: "idle" }));
      },
      unsubscribeThread: async () => {},
    });
    const router = new SessionRouter(client, store, entitledRegistry);

    await router.ensure(target);
    await router.resume(target, "existing");

    expect(started).toEqual([{
      cwd: "/workspace",
      options: { sandbox: "workspace-write", approvalPolicy: "never" },
    }]);
    expect(resumed).toEqual([{
      threadId: "existing",
      cwd: "/workspace",
      options: { sandbox: "workspace-write", approvalPolicy: "never" },
    }]);
  });

  it("attaches dynamic tools to foreground threads and strips them from automation threads", async () => {
    const store = new MemoryBindingStore();
    const started: unknown[] = [];
    const tool = {
      type: "function" as const,
      name: "schedule_task",
      description: "Manage schedules",
      inputSchema: { type: "object" },
    };
    const client = threadPort({
      listThreads: async () => [],
      startThread: async (cwd, options) => {
        started.push({ cwd, options });
        return session(thread(`new-${started.length}`, { type: "idle" }));
      },
    });
    const router = new SessionRouter(client, store, registry, [tool]);

    await router.ensure(target);
    await router.startBackground(target, {}, "main");

    expect(started[0]).toMatchObject({
      cwd: "/workspace",
      options: { dynamicTools: [tool] },
    });
    expect(started[1]).toMatchObject({
      options: {
        threadSource: "automation",
      },
    });
    expect((started[1] as { options: Record<string, unknown> }).options)
      .not.toHaveProperty("dynamicTools");
    expect(router.hasDynamicTools("new-1")).toBe(true);
    expect(router.hasDynamicTools("new-2")).toBe(false);
  });

  it("passes a configured permission profile instead of sandbox", async () => {
    const store = new MemoryBindingStore();
    const entitledRegistry = new WorkspaceRegistry([
      {
        id: "main",
        name: "Main",
        cwd: "/workspace",
        permissions: ":read-only",
      },
    ], "main");
    const started: unknown[] = [];
    const client = threadPort({
      listThreads: async () => [],
      startThread: async (cwd, options) => {
        started.push({ cwd, options });
        return session(thread("new", { type: "idle" }));
      },
    });
    const router = new SessionRouter(client, store, entitledRegistry);

    await router.ensure(target);

    expect(started).toEqual([{
      cwd: "/workspace",
      options: { permissions: ":read-only" },
    }]);
  });

  it("does not auto-resume a Thread from another Provider when a channel model is retained", async () => {
    const store = new MemoryBindingStore();
    const resumed: string[] = [];
    const started: unknown[] = [];
    const deepseekThread = {
      ...thread("deepseek-existing", { type: "idle" }),
      modelProvider: "deepseek",
    };
    const client = threadPort({
      listThreads: async () => [deepseekThread],
      resumeThread: async (threadId) => {
        resumed.push(threadId);
        return session(deepseekThread, {
          model: "deepseek-v4-flash",
          modelProvider: "deepseek",
          reasoningEffort: "high",
        });
      },
      startThread: async (cwd, options) => {
        started.push({ cwd, options });
        return session(thread("openai-new", { type: "idle" }), {
          model: "gpt-deep",
          modelProvider: "openai",
          reasoningEffort: "high",
        });
      },
    });
    const router = new SessionRouter(client, store, registry);

    await router.ensure(target, { model: "gpt-deep", modelProvider: "openai" });

    expect(resumed).toEqual([]);
    expect(started).toEqual([{
      cwd: "/workspace",
      options: { model: "gpt-deep", modelProvider: "openai" },
    }]);
  });

  it("forks the current Thread with provider options before replacing its binding", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "original", sessionId: "original" });
    const calls: unknown[] = [];
    const unsubscribed: string[] = [];
    const client = threadPort({
      forkThread: async (threadId, cwd, options) => {
        calls.push({ threadId, cwd, options });
        return session(thread("forked", { type: "idle" }), {
          model: "deepseek-v4-flash",
          modelProvider: "deepseek",
          reasoningEffort: "high",
        });
      },
      unsubscribeThread: async (threadId) => {
        unsubscribed.push(threadId);
      },
    });
    const router = new SessionRouter(client, store, registry);

    await router.fork(target, {
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
    });

    expect(calls).toEqual([{
      threadId: "original",
      cwd: "/workspace",
      options: {
        model: "deepseek-v4-flash",
        modelProvider: "deepseek",
      },
    }]);
    expect(unsubscribed).toEqual(["original"]);
    expect(store.get(target)?.threadId).toBe("forked");
  });

  it("keeps the original binding when a provider Fork fails", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "original", sessionId: "original" });
    const unsubscribed: string[] = [];
    const client = threadPort({
      forkThread: async () => {
        throw new Error("fork failed");
      },
      unsubscribeThread: async (threadId) => {
        unsubscribed.push(threadId);
      },
    });
    const router = new SessionRouter(client, store, registry);

    await expect(router.fork(target, {
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
    })).rejects.toThrow("fork failed");

    expect(store.get(target)?.threadId).toBe("original");
    expect(unsubscribed).toEqual([]);
  });

  it("transfers an idle binding without unsubscribing the selected Thread", async () => {
    const destination = {
      surface: "feishu" as const,
      accountId: "tenant-a",
      conversationId: "chat-a",
    };
    const store = new MemoryBindingStore();
    store.bind({
      target,
      workspaceId: "main",
      threadId: "thread-owned",
      sessionId: "session-owned",
    });
    store.bind({
      target: destination,
      workspaceId: "main",
      threadId: "thread-replaced",
      sessionId: "session-replaced",
    });
    const unsubscribed: string[] = [];
    const listed: string[] = [];
    const router = new SessionRouter(
      threadPort({
        readThread: async (threadId) => thread(threadId, { type: "idle" }),
        unsubscribeThread: async (threadId) => {
          unsubscribed.push(threadId);
        },
        listThreads: async () => {
          listed.push("listed");
          return [];
        },
        startThread: async () => session(thread("thread-new", { type: "idle" })),
      }),
      store,
      registry,
    );

    const transfer = await router.transferBinding(destination, "thread-owned");

    expect(transfer.previousOwner.target).toEqual(target);
    expect(transfer.replaced?.threadId).toBe("thread-replaced");
    expect(router.current(target)).toBeUndefined();
    expect(router.current(destination)?.threadId).toBe("thread-owned");
    expect(unsubscribed).toEqual(["thread-replaced"]);

    await expect(router.ensure(target)).resolves
      .toMatchObject({ threadId: "thread-new" });
    expect(listed).toEqual([]);
  });

  it("keeps both bindings when either side is not idle", async () => {
    const destination = {
      surface: "feishu" as const,
      accountId: "tenant-a",
      conversationId: "chat-a",
    };
    const store = new MemoryBindingStore();
    store.bind({
      target,
      workspaceId: "main",
      threadId: "thread-owned",
      sessionId: "session-owned",
    });
    store.bind({
      target: destination,
      workspaceId: "main",
      threadId: "thread-replaced",
      sessionId: "session-replaced",
    });
    let activeThreadId = "thread-owned";
    const router = new SessionRouter(
      threadPort({
        readThread: async (threadId) =>
          thread(
            threadId,
            threadId === activeThreadId ? { type: "active" } : { type: "idle" },
          ),
      }),
      store,
      registry,
    );

    await expect(router.transferBinding(destination, "thread-owned"))
      .rejects.toMatchObject({ code: "thread.takeover.busy" });
    activeThreadId = "thread-replaced";
    await expect(router.transferBinding(destination, "thread-owned"))
      .rejects.toMatchObject({ code: "thread.takeover.busy" });
    expect(router.current(target)?.threadId).toBe("thread-owned");
    expect(router.current(destination)?.threadId).toBe("thread-replaced");
  });

  it("skips active threads and resumes the latest idle thread", async () => {
    const resumed: string[] = [];
    const client = threadPort({
      listThreads: async () => [
        thread("active", { type: "active" }),
        thread("idle", { type: "idle" }),
      ],
      resumeThread: async (threadId: string) => {
        resumed.push(threadId);
        return session(thread(threadId, { type: "idle" }), {
          reasoningEffort: "high",
          serviceTier: "fast",
        });
      },
    });
    const router = new SessionRouter(client, new MemoryBindingStore(), registry);

    const binding = await router.ensure(target);

    expect(binding.threadId).toBe("idle");
    expect(resumed).toEqual(["idle"]);
    expect(router.modelSettings(target)).toEqual({
      model: "gpt-main",
      modelProvider: "openai",
      effort: "high",
      serviceTier: "fast",
      collaborationMode: "default",
    });

    router.updateModelSettings("idle", {
      model: "gpt-updated",
      effort: "xhigh",
      serviceTier: "default",
      collaborationMode: "plan",
    });
    expect(router.modelSettings(target)).toEqual({
      model: "gpt-updated",
      modelProvider: "openai",
      effort: "xhigh",
      serviceTier: "default",
      collaborationMode: "plan",
    });
  });

  it("starts a fresh automation background Thread without listing or replacing the foreground", async () => {
    const store = new MemoryBindingStore();
    store.bind({
      target,
      workspaceId: "main",
      threadId: "foreground",
      sessionId: "foreground",
    });
    const listed = vi.fn(async () => [thread("idle-history", { type: "idle" })]);
    const started: unknown[] = [];
    const router = new SessionRouter(threadPort({
      listThreads: listed,
      startThread: async (cwd, options) => {
        started.push({ cwd, options });
        return session(thread("automation", { type: "idle" }));
      },
    }), store, registry);

    const result = await router.startBackground(
      target,
      { model: "gpt-main", modelProvider: "openai" },
      "main",
    );

    expect(listed).not.toHaveBeenCalled();
    expect(started).toEqual([{
      cwd: "/workspace",
      options: {
        model: "gpt-main",
        modelProvider: "openai",
        threadSource: "automation",
      },
    }]);
    expect(router.current(target)?.threadId).toBe("foreground");
    expect(router.backgroundBindings(target).map(({ threadId }) => threadId)).toEqual(["automation"]);
    expect(result.binding.threadId).toBe("automation");
  });

  it("starts a background Thread in its frozen Workspace without changing foreground selection", async () => {
    const store = new MemoryBindingStore();
    store.bind({
      target,
      workspaceId: "other",
      threadId: "foreground-other",
      sessionId: "foreground-other",
    });
    const started: unknown[] = [];
    const router = new SessionRouter(threadPort({
      startThread: async (cwd, options) => {
        started.push({ cwd, options });
        return session(thread("automation-main", { type: "idle" }));
      },
    }), store, registry);

    await router.startBackground(target, {}, "main");

    expect(store.getWorkspace(target)).toBe("other");
    expect(router.current(target)?.threadId).toBe("foreground-other");
    expect(router.backgroundBindings(target)[0]).toMatchObject({ workspaceId: "main" });
    expect(started[0]).toMatchObject({ cwd: "/workspace" });
  });

  it("does not disturb an existing binding when thread/start returns a duplicate Thread id", async () => {
    const store = new MemoryBindingStore();
    const otherTarget = { ...target, conversationId: "other-conversation" };
    store.bindBackground({
      target: otherTarget,
      workspaceId: "main",
      threadId: "conflict",
      sessionId: "conflict",
    });
    const unsubscribe = vi.fn(async () => undefined);
    const router = new SessionRouter(threadPort({
      startThread: async () => session(thread("conflict", { type: "idle" })),
      unsubscribeThread: unsubscribe,
    }), store, registry);

    await expect(router.startBackground(target, {}, "main")).rejects.toThrow("已绑定");

    expect(unsubscribe).not.toHaveBeenCalled();
    expect(router.contextCompactionItemIdsForThread("conflict")).toBeUndefined();
    expect(store.getByThread("conflict")?.target).toEqual(otherTarget);
  });

  it("serializes the capacity check and fresh start per Conversation", async () => {
    const store = new MemoryBindingStore();
    const startThread = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      return session(thread(`background-${startThread.mock.calls.length}`, { type: "idle" }));
    });
    const router = new SessionRouter(threadPort({ startThread }), store, registry);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => router.startBackground(target, {}, "main")),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
    expect(router.backgroundBindings(target)).toHaveLength(3);
    expect(startThread).toHaveBeenCalledTimes(3);
  });

  it("enforces the three-Thread background limit for forced automation starts", async () => {
    const store = new MemoryBindingStore();
    for (const threadId of ["bg-1", "bg-2", "bg-3"]) {
      store.bindBackground({ target, workspaceId: "main", threadId, sessionId: threadId });
    }
    const startThread = vi.fn(async () => session(thread("not-started", { type: "idle" })));
    const router = new SessionRouter(threadPort({ startThread }), store, registry);

    await expect(router.startBackground(target, {}, "main"))
      .rejects.toMatchObject({ code: "conversation.background-limit" });
    expect(startThread).not.toHaveBeenCalled();
  });

  it("unsubscribes before forcing a new thread", async () => {
    const unsubscribed: string[] = [];
    const client = threadPort({
      listThreads: async () => [],
      startThread: async () => session(thread("new", { type: "idle" })),
      unsubscribeThread: async (threadId: string) => {
        unsubscribed.push(threadId);
      },
    });
    const router = new SessionRouter(client, new MemoryBindingStore(), registry);
    await router.ensure(target);
    await router.newSession(target);
    await router.ensure(target);

    expect(unsubscribed).toEqual(["new"]);
  });

  it("keeps an active foreground subscription when switching it to the background", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "running", sessionId: "running" });
    const unsubscribed: string[] = [];
    const client = threadPort({
      resumeThread: async (threadId) => session(thread(threadId, { type: "idle" })),
      unsubscribeThread: async (threadId) => {
        unsubscribed.push(threadId);
      },
    });
    const router = new SessionRouter(client, store, registry);

    await router.resume(target, "selected", true);

    expect(router.current(target)?.threadId).toBe("selected");
    expect(router.backgroundBindings(target).map(({ threadId }) => threadId)).toEqual(["running"]);
    expect(router.targetForThread("running")).toEqual(target);
    expect(unsubscribed).toEqual([]);
  });


  it("keeps model settings after detaching so session lists can annotate them", async () => {
    const client = threadPort({
      listThreads: async () => [],
      startThread: async () => session(thread("new", { type: "idle" })),
      unsubscribeThread: async () => undefined,
    });
    const router = new SessionRouter(client, new MemoryBindingStore(), registry);
    await router.ensure(target);

    await router.newSession(target);

    expect(router.current(target)).toBeUndefined();
    expect(router.modelSettingsForThread("new")).toEqual({
      model: "gpt-main",
      modelProvider: "openai",
      effort: "medium",
      serviceTier: "default",
      collaborationMode: "default",
    });
  });

  it("restores bound thread model, effort and Fast state after Gateway reconnect", async () => {
    const resumed: string[] = [];
    const client = threadPort({
      listThreads: async () => [],
      startThread: async () => session(thread("bound", { type: "idle" })),
      resumeThread: async (threadId: string) => {
        resumed.push(threadId);
        return session(thread(threadId, { type: "idle" }), {
          reasoningEffort: "high",
          serviceTier: "priority",
          contextCompactionItemIds: ["compact-1", "compact-2"],
        });
      },
    });
    const router = new SessionRouter(client, new MemoryBindingStore(), registry);
    await router.ensure(target);

    const failures = await router.restoreSubscriptions();

    expect(failures).toEqual([]);
    expect(resumed).toEqual(["bound"]);
    expect(router.current(target)?.threadId).toBe("bound");
    expect(router.modelSettings(target)).toEqual({
      model: "gpt-main",
      modelProvider: "openai",
      effort: "high",
      serviceTier: "priority",
      collaborationMode: "default",
    });
    expect(router.contextCompactionItemIdsForThread("bound"))
      .toEqual(["compact-1", "compact-2"]);
  });

  it("reports an active Turn when restoring a bound Thread subscription", async () => {
    const store = new MemoryBindingStore();
    store.bind({
      target,
      workspaceId: "main",
      threadId: "active-thread",
      sessionId: "active-thread",
    });
    const activeThread = {
      ...thread("active-thread", { type: "active" }),
      activeTurnId: "turn-running",
    };
    const restored: Array<{ threadId: string; turnId: string }> = [];
    const router = new SessionRouter(
      threadPort({
        resumeThread: async () => session(activeThread, {
          reasoningEffort: "high",
          serviceTier: "default",
        }),
      }),
      store,
      registry,
    );

    await router.restoreSubscriptions(
      undefined,
      (binding, restoredThread) => {
        if (restoredThread.activeTurnId) {
          restored.push({ threadId: binding.threadId, turnId: restoredThread.activeTurnId });
        }
      },
    );

    expect(restored).toEqual([{
      threadId: "active-thread",
      turnId: "turn-running",
    }]);
  });

  it("preserves but does not subscribe bindings for disabled Surface accounts", async () => {
    const store = new MemoryBindingStore();
    const disabled = {
      surface: "feishu" as const,
      accountId: "tenant-a",
      conversationId: "chat-1",
    };
    store.bind({
      target,
      workspaceId: "main",
      threadId: "telegram-thread",
      sessionId: "telegram-session",
    });
    store.bind({
      target: disabled,
      workspaceId: "main",
      threadId: "feishu-thread",
      sessionId: "feishu-session",
    });
    const resumed: string[] = [];
    const client = threadPort({
      resumeThread: async (threadId: string) => {
        resumed.push(threadId);
        return session(thread(threadId, { type: "idle" }));
      },
    });
    const router = new SessionRouter(client, store, registry);

    const failures = await router.restoreSubscriptions(
      (candidate) => candidate.surface === "telegram",
    );

    expect(failures).toEqual([]);
    expect(resumed).toEqual(["telegram-thread"]);
    expect(store.get(disabled)?.threadId).toBe("feishu-thread");
  });

  it("keeps a binding when subscription restore fails transiently", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "bound", sessionId: "bound" });
    const client = threadPort({
      resumeThread: async () => {
        throw new JsonRpcError(-32001, "Server overloaded; retry later.");
      },
    });
    const router = new SessionRouter(client, store, registry);

    const failures = await router.restoreSubscriptions();

    expect(failures).toEqual([
      expect.objectContaining({ bindingRemoved: false }),
    ]);
    expect(router.current(target)?.threadId).toBe("bound");
  });

  it("classifies the fixed-version active writer conflict without removing the binding", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "bound", sessionId: "bound" });
    const client = threadPort({
      resumeThread: async () => {
        throw new JsonRpcError(
          -32600,
          "thread bound already has an active writer",
        );
      },
    });
    const router = new SessionRouter(client, store, registry);

    const failures = await router.restoreSubscriptions();

    expect(failures).toEqual([
      expect.objectContaining({
        bindingRemoved: false,
        reason: "active-writer",
      }),
    ]);
    expect(router.current(target)?.threadId).toBe("bound");
  });

  it("classifies the wrapped official active writer conflict without removing the binding", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "bound", sessionId: "bound" });
    const client = threadPort({
      resumeThread: async () => {
        throw new JsonRpcError(
          -32600,
          "thread-store conflict: thread bound already has an active writer",
        );
      },
    });
    const router = new SessionRouter(client, store, registry);

    const failures = await router.restoreSubscriptions();

    expect(failures).toEqual([
      expect.objectContaining({
        bindingRemoved: false,
        reason: "active-writer",
      }),
    ]);
    expect(router.current(target)?.threadId).toBe("bound");
  });

  it("keeps a binding when subscription restore fails for an unknown reason", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "bound", sessionId: "bound" });
    const client = threadPort({
      resumeThread: async () => {
        throw new Error("Unexpected App Server response");
      },
    });
    const router = new SessionRouter(client, store, registry);

    const failures = await router.restoreSubscriptions();

    expect(failures).toEqual([
      expect.objectContaining({ bindingRemoved: false }),
    ]);
    expect(router.current(target)?.threadId).toBe("bound");
  });

  it("removes a binding when App Server reports that its session is archived", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "bound", sessionId: "bound" });
    const client = threadPort({
      resumeThread: async () => {
        throw new JsonRpcError(
          -32602,
          "session bound is archived. Run `codex unarchive bound` to unarchive it first.",
        );
      },
    });
    const router = new SessionRouter(client, store, registry);

    const failures = await router.restoreSubscriptions();

    expect(failures).toEqual([
      expect.objectContaining({ bindingRemoved: true }),
    ]);
    expect(router.current(target)).toBeUndefined();
  });

  it("keeps a binding while App Server is temporarily closing its loaded Thread", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "bound", sessionId: "bound" });
    const client = threadPort({
      resumeThread: async () => {
        throw new JsonRpcError(
          -32602,
          "thread bound is closing; retry after the thread is closed",
        );
      },
    });
    const router = new SessionRouter(client, store, registry);

    const failures = await router.restoreSubscriptions();

    expect(failures).toEqual([
      expect.objectContaining({ bindingRemoved: false }),
    ]);
    expect(router.current(target)?.threadId).toBe("bound");
  });

  it("preserves bindings when subscription restore is cancelled during shutdown", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "bound", sessionId: "bound" });
    let running = true;
    const client = threadPort({
      resumeThread: async () => {
        running = false;
        throw new Error("Codex JSON-RPC Client 已关闭");
      },
    });
    const router = new SessionRouter(client, store, registry);

    const failures = await router.restoreSubscriptions(() => running);

    expect(failures).toEqual([]);
    expect(router.current(target)?.threadId).toBe("bound");
  });

  it("keeps the current binding when resuming another Thread fails", async () => {
    const store = new MemoryBindingStore();
    store.bind({
      target,
      workspaceId: "main",
      threadId: "current",
      sessionId: "current",
    });
    const unsubscribed: string[] = [];
    const client = threadPort({
      resumeThread: async () => {
        throw new JsonRpcError(-32602, "Thread not found");
      },
      unsubscribeThread: async (threadId: string) => {
        unsubscribed.push(threadId);
      },
    });
    const router = new SessionRouter(client, store, registry);

    await expect(router.resume(target, "missing"))
      .rejects.toThrow("Thread not found");

    expect(router.current(target)?.threadId).toBe("current");
    expect(unsubscribed).toEqual([]);
  });

  it("switches only to a preconfigured workspace and scopes thread discovery by cwd", async () => {
    const listedCwds: string[] = [];
    const unsubscribed: string[] = [];
    const client = threadPort({
      listThreads: async (cwd: string) => {
        listedCwds.push(cwd);
        return [];
      },
      startThread: async (cwd: string) => session({ ...thread("created", { type: "idle" }), cwd }),
      unsubscribeThread: async (threadId: string) => {
        unsubscribed.push(threadId);
      },
    });
    const store = new MemoryBindingStore();
    const router = new SessionRouter(client, store, registry);
    await router.ensure(target);

    const selected = await router.selectWorkspace(target, "other");
    await router.ensure(target);

    expect(selected.id).toBe("other");
    expect(unsubscribed).toEqual(["created"]);
    expect(listedCwds).toEqual(["/workspace", "/workspace", "/other", "/other"]);
    expect(store.getWorkspace(target)).toBe("other");
    expect(router.current(target)?.workspaceId).toBe("other");
  });

  it("rejects workspace paths or ids that are not in the server registry", async () => {
    const router = new SessionRouter(threadPort(), new MemoryBindingStore(), registry);

    await expect(router.selectWorkspace(target, "/arbitrary/path"))
      .rejects.toThrow("Workspace 不存在或未获授权");
  });

  it("keeps the current thread bound when selecting the same workspace", async () => {
    const unsubscribed: string[] = [];
    const client = threadPort({
      listThreads: async () => [],
      startThread: async () => session(thread("current", { type: "idle" })),
      unsubscribeThread: async (threadId: string) => {
        unsubscribed.push(threadId);
      },
    });
    const router = new SessionRouter(client, new MemoryBindingStore(), registry);
    await router.ensure(target);

    await router.selectWorkspace(target, "main");

    expect(unsubscribed).toEqual([]);
    expect(router.current(target)?.threadId).toBe("current");
  });

  it("passes search and archive filters to App Server thread discovery", async () => {
    const calls: unknown[] = [];
    const client = threadPort({
      listThreads: async (_cwd: string, options: unknown) => {
        calls.push(options);
        return [thread("archived", { type: "idle" })];
      },
    });
    const router = new SessionRouter(client, new MemoryBindingStore(), registry);

    await router.list(target, { archived: true, searchTerm: "修复" });

    expect(calls).toEqual([{ archived: true, searchTerm: "修复" }]);
  });

  it("archives the current binding and resumes an unarchived thread", async () => {
    const archived: string[] = [];
    const unarchived: string[] = [];
    const client = threadPort({
      listThreads: async () => [],
      startThread: async () => session(thread("current", { type: "idle" })),
      archiveThread: async (threadId: string) => {
        archived.push(threadId);
      },
      unarchiveThread: async (threadId: string) => {
        unarchived.push(threadId);
        return thread(threadId, { type: "idle" });
      },
      resumeThread: async (threadId: string) => session(thread(threadId, { type: "idle" })),
    });
    const router = new SessionRouter(client, new MemoryBindingStore(), registry);
    await router.ensure(target);

    await expect(router.archive(target)).resolves.toBe("current");
    expect(router.current(target)).toBeUndefined();
    await router.unarchive(target, "archived");

    expect(archived).toEqual(["current"]);
    expect(unarchived).toEqual(["archived"]);
    expect(router.current(target)?.threadId).toBe("archived");
  });
});
