import { describe, expect, it, vi } from "vitest";

import { JsonRpcError } from "../src/codex-client/json-rpc.js";
import { MemoryBindingStore } from "../src/storage/memory-binding-store.js";
import {
  SessionRouter,
  type ThreadLifecyclePort,
  type ThreadResumeSession,
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
  overrides: Partial<Omit<ThreadResumeSession, "thread">> = {},
): ThreadResumeSession {
  return {
    thread: value,
    settingsMatch: true,
    collaborationMode: "default",
    model: "gpt-main",
    reasoningEffort: "medium",
    serviceTier: "default",
    contextCompactionItemIds: [],
    effectiveSettings: { cwd: value.cwd, approvalPolicy: "on-request", sandbox: "read-only", permissions: null },
    ...overrides,
  };
}

function threadPort(overrides: Partial<ThreadLifecyclePort> = {}): ThreadLifecyclePort {
  const unsupported = async (): Promise<never> => {
    throw new Error("测试未配置 ThreadLifecyclePort 方法");
  };
  return {
    listThreads: unsupported,
    readThread: async (id) => thread(id, { type: "idle" }),
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
  it("does not unsubscribe an idle scan superseded while waiting for a Thread lifecycle operation", async () => {
    const store = new MemoryBindingStore();
    const binding = { target, workspaceId: "main", threadId: "idle", sessionId: "idle" };
    store.bind(binding);
    let finishRead!: () => void;
    const readThread = vi.fn(async () => {
      await new Promise<void>(resolve => { finishRead = resolve; });
      return thread("idle", { type: "idle" });
    });
    const unsubscribeThread = vi.fn(async () => undefined);
    const router = new SessionRouter(threadPort({ readThread, unsubscribeThread,
      resumeThread: async id => session(thread(id, { type: "idle" })),
    }), store, registry);
    const restoring = router.restoreSubscriptions();
    await vi.waitFor(() => expect(readThread).toHaveBeenCalled());
    let current = true;
    const releasing = router.releaseIdle(target, binding, thread("idle", { type: "idle" }), {
      isCurrent: () => current, verifyIdle: async () => true, canRestore: () => true, restored: vi.fn(),
    });
    current = false;
    finishRead();
    await restoring;
    await expect(releasing).resolves.toBe(false);
    expect(unsubscribeThread).not.toHaveBeenCalled();
    expect(router.current(target)?.threadId).toBe("idle");
  });

  it.each([true, false])("keeps the binding after cancellation during unsubscribe (can restore: %s)", async canRestore => {
    const store = new MemoryBindingStore();
    const binding = { target, workspaceId: "main", threadId: "idle", sessionId: "idle" };
    store.bind(binding);
    let finishUnsubscribe!: () => void;
    const unsubscribeThread = vi.fn(async () => {
      await new Promise<void>(resolve => { finishUnsubscribe = resolve; });
    });
    const resumeThread = vi.fn(async id => session(thread(id, { type: "idle" })));
    const router = new SessionRouter(threadPort({ unsubscribeThread, resumeThread }), store, registry);
    let current = true;
    const restored = vi.fn();
    const releasing = router.releaseIdle(target, binding, thread("idle", { type: "idle" }), {
      isCurrent: () => current, verifyIdle: async () => true, canRestore: () => canRestore, restored,
    });
    await vi.waitFor(() => expect(unsubscribeThread).toHaveBeenCalled());
    current = false;
    finishUnsubscribe();
    await expect(releasing).resolves.toBe(false);
    expect(router.current(target)).toEqual(binding);
    expect(router.idleState(target).forceNew).toBe(false);
    expect(resumeThread).toHaveBeenCalledTimes(canRestore ? 1 : 0);
    expect(restored).toHaveBeenCalledTimes(canRestore ? 1 : 0);
  });

  it("invalidates an idle activity snapshot even when new input has the same timestamp", () => {
    const router = new SessionRouter(threadPort(), new MemoryBindingStore(), registry);
    router.touchActivity(target, 100);
    const before = router.idleState(target).lastActivityAt;
    router.touchActivity(target, 100);
    expect(router.idleState(target).lastActivityAt).toBeGreaterThan(before);
  });

  it("does not publish a restored state when shutdown starts during compensating resume", async () => {
    const store = new MemoryBindingStore();
    const binding = { target, workspaceId: "main", threadId: "idle", sessionId: "idle" };
    store.bind(binding);
    let finishResume!: () => void;
    let canRestore = true;
    let current = true;
    const restored = vi.fn();
    const resumeThread = vi.fn(async id => {
      await new Promise<void>(resolve => { finishResume = resolve; });
      return session(thread(id, { type: "idle" }));
    });
    const router = new SessionRouter(threadPort({
      unsubscribeThread: async () => { current = false; }, resumeThread,
    }), store, registry);
    const releasing = router.releaseIdle(target, binding, thread("idle", { type: "idle" }), {
      isCurrent: () => current, verifyIdle: async () => true, canRestore: () => canRestore, restored,
    });
    await vi.waitFor(() => expect(resumeThread).toHaveBeenCalled());
    canRestore = false;
    finishResume();
    await expect(releasing).rejects.toBeInstanceOf(Error);
    expect(store.get(target)).toEqual(binding);
    expect(restored).not.toHaveBeenCalled();
  });

  it.each(["busy", "unavailable"])("restores the subscription when the final idle query is %s", async outcome => {
    const store = new MemoryBindingStore();
    const binding = { target, workspaceId: "main", threadId: "idle", sessionId: "idle" };
    store.bind(binding);
    const resumeThread = vi.fn(async id => session(thread(id, { type: "idle" })));
    const router = new SessionRouter(threadPort({ unsubscribeThread: async () => undefined, resumeThread }), store, registry);
    await expect(router.releaseIdle(target, binding, thread("idle", { type: "idle" }), {
      isCurrent: () => true, canRestore: () => true, restored: vi.fn(),
      verifyIdle: async () => {
        if (outcome === "unavailable") throw new Error("read unavailable");
        return false;
      },
    })).resolves.toBe(false);
    expect(resumeThread).toHaveBeenCalledOnce();
    expect(store.get(target)).toEqual(binding);
    expect(store.idleState(target).forceNew).toBe(false);
  });

  it("keeps binding revocation across the resolver promise handoff until its owner aborts", async () => {
    const store = new MemoryBindingStore();
    const owner = { target, workspaceId: "main", threadId: "parent", sessionId: "parent" };
    store.bind(owner);
    const controller = new AbortController();
    const router = new SessionRouter(threadPort({ readThread: async id => {
      queueMicrotask(() => queueMicrotask(() => {
        router.forgetThread("parent");
        store.bind(owner);
      }));
      return thread(id, { type: "active" });
    } }), store, registry);
    try {
      const route = await router.resolveApprovalTarget("parent", () => true, controller.signal);
      expect(route).toBeDefined();
      expect(route?.isCurrent()).toBe(false);
    } finally { controller.abort(); }
  });

  it("releases cancelled resolution observers without waiting for readThread", async () => {
    const store = new MemoryBindingStore();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const readThread = vi.fn(async id => { await blocked; return thread(id, { type: "active" }); });
    const router = new SessionRouter(threadPort({ readThread }), store, registry);
    const reads = Array.from({ length: 101 }, () => {
      const controller = new AbortController();
      const reading = router.resolveApprovalTarget("child", () => true, controller.signal);
      controller.abort();
      return reading;
    });
    expect(readThread).toHaveBeenCalledTimes(101);
    release();
    await expect(Promise.all(reads)).resolves.toEqual(Array(101).fill(undefined));
  });

  it("cancels the underlying approval ancestry read without reading further ancestors", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "parent", sessionId: "parent" });
    const controller = new AbortController();
    const cancellation = new Error("approval cancelled");
    const onReadCancelled = vi.fn();
    const readThread = vi.fn((id: string, signal?: AbortSignal): Promise<ThreadSnapshot> => {
      if (id !== "child") return Promise.resolve(thread(id, { type: "active" }));
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          onReadCancelled();
          reject(signal.reason);
        }, { once: true });
      });
    });
    const router = new SessionRouter(threadPort({ readThread }), store, registry);
    const resolving = router.resolveApprovalTarget("child", () => true, controller.signal);
    expect(readThread).toHaveBeenCalledExactlyOnceWith("child", controller.signal);
    const cancelled = expect(resolving).rejects.toBe(cancellation);
    controller.abort(cancellation);
    await cancelled;
    expect(onReadCancelled).toHaveBeenCalledOnce();
    expect(readThread).toHaveBeenCalledExactlyOnceWith("child", controller.signal);
  });

  it.each(["unrelated", "parent", "child", "middle"])("remembers transient %s binding changes while ancestry is loading", async change => {
    const store = new MemoryBindingStore();
    const owner = { target, workspaceId: "main", threadId: "parent", sessionId: "parent" };
    store.bind(owner);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let firstRead = true;
    const snapshot = (id: string) => ({ ...thread(id, { type: "idle" }), parentThreadId: id === "child" ? "middle" : id === "middle" ? "parent" : null });
    const router = new SessionRouter(threadPort({
      readThread: async id => {
        if (firstRead) { firstRead = false; await blocked; }
        return snapshot(id);
      },
      resumeThread: async id => session(snapshot(id)),
      listThreads: async () => [],
      startThread: async () => session(snapshot("unrelated")),
      unsubscribeThread: async () => {},
    }), store, registry);
    const resolving = router.resolveApprovalTarget("child");
    if (change === "unrelated") await router.ensure({ ...target, conversationId: "other" });
    else if (change === "parent") {
      router.forgetThread("parent");
      await router.resume(target, "parent");
    } else {
      const temporaryTarget = { ...target, conversationId: "temporary" };
      await router.resume(temporaryTarget, change);
      await router.detach(temporaryTarget);
    }
    release();
    if (change === "unrelated") expect(await resolving).toMatchObject({ target, ownerThreadId: "parent" });
    else expect(await resolving).toBeUndefined();
  });

  it("routes nested subagent approvals to the nearest bound ancestor without binding descendants", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "parent", sessionId: "session" });
    const readThread = vi.fn(async (id: string) => ({
      ...thread(id, { type: "active" }), parentThreadId: id === "child" ? "middle" : id === "middle" ? "parent" : null,
    }));
    const router = new SessionRouter(threadPort({ readThread }), store, registry);
    const route = await router.resolveApprovalTarget("child");
    expect(route).toMatchObject({ target, ownerThreadId: "parent", relatedThreadIds: ["child", "middle", "parent"] });
    expect(route?.isCurrent()).toBe(true);
    expect(router.targetForThread("child")).toBeUndefined();
    expect(store.list()).toHaveLength(1);
    expect(readThread.mock.calls.map(([id]) => id)).toEqual(["child", "middle", "parent"]);
    const nearerTarget = { ...target, conversationId: "nearer" };
    store.bind({ target: nearerTarget, workspaceId: "main", threadId: "middle", sessionId: "session" });
    expect(route?.isCurrent()).toBe(false);
    expect(await router.resolveApprovalTarget("child")).toMatchObject({ target: nearerTarget, ownerThreadId: "middle", relatedThreadIds: ["child", "middle"] });
  });

  it.each(["missing", "fork", "cycle", "depth", "cwd", "provider", "wrong-id", "workspace", "cached-provider", "automation-ancestor", "automation-child"])(
    "rejects unproven subagent ancestry: %s", async (failure) => {
      const store = new MemoryBindingStore();
      store.bind({ target, workspaceId: failure === "workspace" ? "other" : "main", threadId: "parent", sessionId: "session" });
      const readThread = vi.fn(async (id: string): Promise<ThreadSnapshot> => {
        if (failure === "missing") throw new Error("not found");
        return {
          ...thread(id, { type: "active" }),
          id: failure === "wrong-id" ? "different" : id,
          parentThreadId: id === "parent" ? null : failure === "fork" ? null : failure === "cycle" ? id : failure === "depth" ? `${id}-next` : "parent",
          cwd: failure === "cwd" && id === "child" ? "/other" : "/workspace",
          modelProvider: failure === "provider" && id === "child" ? "deepseek" : "openai",
          source: (failure === "automation-ancestor" && id === "parent") || (failure === "automation-child" && id === "child") ? "automation" : "cli",
        };
      });
      const router = new SessionRouter(threadPort({ readThread }), store, registry);
      if (failure === "cached-provider") router.updateModelSettings("parent", { model: "test", modelProvider: "deepseek", effort: null, serviceTier: null, collaborationMode: "default" });
      if (failure === "missing") await expect(router.resolveApprovalTarget("child")).rejects.toThrow("not found");
      else expect(await router.resolveApprovalTarget("child")).toBeUndefined();
      expect(readThread.mock.calls.length).toBeLessThanOrEqual(16);
    },
  );

  it.each(["unbind", "takeover", "bind-child", "bind-middle", "provider", "workspace"])(
    "invalidates resolved ancestry after %s", async (change) => {
      const store = new MemoryBindingStore();
      const workspaces = new WorkspaceRegistry([{ id: "main", name: "Main", cwd: "/workspace" }], "main");
      const owner = { target, workspaceId: "main", threadId: "parent", sessionId: "parent" };
      store.bind(owner);
      const router = new SessionRouter(threadPort({ readThread: async id => ({ ...thread(id, { type: "active" }), parentThreadId: id === "child" ? "middle" : id === "middle" ? "parent" : null }) }), store, workspaces);
      const route = await router.resolveApprovalTarget("child");
      expect(route?.isCurrent()).toBe(true);
      if (change === "unbind" || change === "takeover") store.unbind(target);
      if (change === "takeover") store.bind({ ...owner, target: { ...target, conversationId: "other" } });
      if (change === "bind-child" || change === "bind-middle") store.bind({ ...owner, threadId: change === "bind-child" ? "child" : "middle", target: { ...target, conversationId: "other" } });
      if (change === "provider") router.updateModelSettings("parent", { model: "test", modelProvider: "deepseek", effort: null, serviceTier: null, collaborationMode: "default" });
      if (change === "workspace") workspaces.replace([{ id: "main", name: "Main", cwd: "/other" }], "main");
      expect(route?.isCurrent()).toBe(false);
    },
  );

  it.each(["new-binding", "takeover", "child-binding", "cancelled"])(
    "does not acquire approval ownership during an outstanding read: %s", async (change) => {
      const store = new MemoryBindingStore();
      const owner = { target, workspaceId: "main", threadId: "parent", sessionId: "parent" };
      if (change !== "new-binding") store.bind(owner);
      let release!: () => void;
      let active = true;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const readThread = vi.fn(async (id: string) => {
        if (id === "child") await blocked;
        return { ...thread(id, { type: "active" }), parentThreadId: id === "child" ? "parent" : null };
      });
      const router = new SessionRouter(threadPort({ readThread }), store, registry);
      const resolving = router.resolveApprovalTarget("child", () => active);
      if (change === "new-binding") store.bind(owner);
      if (change === "takeover") { store.unbind(target); store.bind({ ...owner, target: { ...target, conversationId: "other" } }); }
      if (change === "child-binding") store.bind({ ...owner, threadId: "child", target: { ...target, conversationId: "other" } });
      if (change === "cancelled") active = false;
      release();
      expect(await resolving).toBeUndefined();
      if (change === "cancelled") expect(readThread).toHaveBeenCalledOnce();
    },
  );

  it("verifies a directly bound Thread through the same official read boundary", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "parent", sessionId: "parent" });
    const readThread = vi.fn(async (id: string) => thread(id, { type: "active" }));
    const router = new SessionRouter(threadPort({ readThread }), store, registry);
    expect(await router.resolveApprovalTarget("parent")).toMatchObject({ target, ownerThreadId: "parent", relatedThreadIds: ["parent"] });
    expect(readThread).toHaveBeenCalledExactlyOnceWith("parent", undefined);
    readThread.mockResolvedValue({ ...thread("parent", { type: "active" }), source: "automation" });
    expect(await router.resolveApprovalTarget("parent")).toBeUndefined();
  });

  it("signals approval invalidation when ownership transfers after an approval arrived during the read", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "parent", sessionId: "parent" });
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { entered = resolve; });
    let firstRead = true;
    const changed = vi.fn();
    const router = new SessionRouter(threadPort({ readThread: async id => {
      if (firstRead) { firstRead = false; entered(); await blocked; }
      return { ...thread(id, { type: "idle" }), parentThreadId: id === "child" ? "parent" : null };
    } }), store, registry, [], changed);
    const transfer = router.transferBinding({ ...target, surface: "feishu" }, "parent");
    await reading;
    const route = await router.resolveApprovalTarget("child");
    expect(route?.isCurrent()).toBe(true);
    changed.mockImplementation(() => { expect(route?.isCurrent()).toBe(false); });
    release();
    await transfer;
    expect(changed).toHaveBeenCalledOnce();
  });

  it.each(["resume", "ensure", "restore"])("recovers authoritative Plan mode through %s", async (entry) => {
    const store = new MemoryBindingStore();
    const historical = thread("history", { type: "idle" });
    const router = new SessionRouter(threadPort({
      listThreads: async () => [historical],
      resumeThread: async () => session(historical, { collaborationMode: "plan" }),
    }), store, registry);
    if (entry === "restore") {
      store.bind({ target, workspaceId: "main", threadId: historical.id, sessionId: historical.id });
      expect(await router.restoreSubscriptions()).toEqual([]);
    } else if (entry === "ensure") {
      await router.ensure(target);
    } else {
      await router.resume(target, historical.id);
    }
    expect(router.modelSettings(target)?.collaborationMode).toBe("plan");
  });

  it.each(["read", "resume", "cleanup"])("serializes workspace switching behind recovery at the %s boundary", async (phase) => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "history", sessionId: "history" });
    let release!: () => void;
    let signal!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { signal = resolve; });
    let initial = true;
    const subscriptions = new Set<string>();
    const calls: string[] = [];
    const router = new SessionRouter(threadPort({
      readThread: async (id) => {
        if (id === "history" && initial && phase === "read") {
          signal(); await blocked;
          initial = false;
          return { ...thread(id, { type: "idle" }), cwd: "/other" };
        }
        return { ...thread(id, { type: "idle" }), cwd: id === "history" && !initial ? "/other" : "/workspace" };
      },
      resumeThread: async (id, cwd) => {
        calls.push(`resume:${id}`);
        subscriptions.add(id);
        if (id === "history" && initial) {
          if (phase === "resume") { signal(); await blocked; }
          initial = false;
          return session(thread(id, { type: "idle" }), { settingsMatch: false });
        }
        return session({ ...thread(id, { type: "idle" }), cwd });
      },
      unsubscribeThread: async (id) => {
        calls.push(`unsubscribe:${id}`);
        if (id === "history" && phase === "cleanup") { signal(); await blocked; }
        subscriptions.delete(id);
      },
    }), store, registry);
    const recovering = router.restoreSubscriptions();
    await entered;
    const switching = (async () => {
      await router.selectWorkspace(target, "other");
      return router.resume(target, "history");
    })();
    const independent = { ...target, conversationId: "independent" };
    await router.resume(independent, "independent");
    expect(calls.filter((call) => call === "resume:history")).toHaveLength(phase === "read" ? 0 : 1);
    release();
    await recovering;
    expect(await switching).toMatchObject({ threadId: "history", workspaceId: "other" });
    expect(router.current(target)?.workspaceId).toBe("other");
    expect(subscriptions.has("history")).toBe(true);
    expect(router.current(independent)?.threadId).toBe("independent");
  });

  it.each(["read", "resume"])("does not resurrect an officially removed binding after a late %s response", async (phase) => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "history", sessionId: "history" });
    let release!: () => void;
    let signal!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { signal = resolve; });
    const onRestored = vi.fn();
    const unsubscribeThread = vi.fn(async () => undefined);
    const resumeThread = vi.fn(async (id: string) => {
      if (phase === "resume") { signal(); await blocked; }
      return session(thread(id, { type: "idle" }));
    });
    const router = new SessionRouter(threadPort({
      readThread: async (id) => {
        if (phase === "read") { signal(); await blocked; }
        return thread(id, { type: "idle" });
      }, resumeThread, unsubscribeThread,
    }), store, registry);
    const recovering = router.restoreSubscriptions(() => true, onRestored);
    await entered;
    router.forgetThread("history");
    release();
    expect(await recovering).toEqual([]);
    expect(router.current(target)).toBeUndefined();
    expect(onRestored).not.toHaveBeenCalled();
    expect(unsubscribeThread).toHaveBeenCalledTimes(phase === "resume" ? 1 : 0);
  });

  it("discards a queued recovery snapshot after the preceding detach completes", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "history", sessionId: "history" });
    let release!: () => void;
    let signal!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { signal = resolve; });
    const resumeThread = vi.fn();
    const router = new SessionRouter(threadPort({ resumeThread,
      unsubscribeThread: async () => { signal(); await blocked; },
    }), store, registry);
    const detaching = router.detach(target);
    await entered;
    const recovering = router.restoreSubscriptions();
    release();
    await detaching;
    expect(await recovering).toEqual([]);
    expect(router.current(target)).toBeUndefined();
    expect(resumeThread).not.toHaveBeenCalled();
  });

  it("keeps the first successful subscription when another conversation concurrently resumes the same Thread", async () => {
    let release!: () => void;
    let signal!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { signal = resolve; });
    const unsubscribeThread = vi.fn(async () => undefined);
    const resumeThread = vi.fn(async (id: string) => { signal(); await blocked; return session(thread(id, { type: "idle" })); });
    const router = new SessionRouter(threadPort({ resumeThread, unsubscribeThread }), new MemoryBindingStore(), registry);
    const first = router.resume(target, "history");
    await entered;
    const otherTarget = { ...target, conversationId: "other" };
    const rejected = expect(router.resume(otherTarget, "history")).rejects.toMatchObject({ code: "thread.bound" });
    release();
    await first;
    await rejected;
    expect(resumeThread).toHaveBeenCalledTimes(1);
    expect(unsubscribeThread).not.toHaveBeenCalled();
    expect(router.current(target)?.threadId).toBe("history");
  });

  it("rejects automatic continuation when the selected history becomes active during resume", async () => {
    const historical = thread("historical", { type: "idle" });
    const unsubscribeThread = vi.fn(async () => undefined);
    const router = new SessionRouter(threadPort({
      listThreads: async () => [historical],
      resumeThread: async () => session({ ...historical, status: { type: "active" }, activeTurnId: "turn-1" }),
      unsubscribeThread,
    }), new MemoryBindingStore(), registry);
    await expect(router.ensure(target)).rejects.toMatchObject({ code: "conversation.busy" });
    expect(router.current(target)).toBeUndefined();
    expect(unsubscribeThread).toHaveBeenCalledExactlyOnceWith("historical");
  });

  it.each([false, true])("restores the previous subscription after binding failure; invalid response=%s", async (invalidRestore) => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "current", sessionId: "current" });
    vi.spyOn(store, "switchForeground").mockImplementation(() => { throw new Error("binding failed"); });
    const unsubscribeThread = vi.fn<(id: string) => Promise<void>>(async () => undefined);
    const resumeThread = vi.fn(async (id: string) => session(thread(id, { type: "idle" }), {
      settingsMatch: id !== "current" || !invalidRestore,
    }));
    const router = new SessionRouter(threadPort({ resumeThread, unsubscribeThread }), store, registry);
    await expect(router.resume(target, "historical")).rejects.toThrow(invalidRestore ? "原订阅恢复失败" : "binding failed");
    expect(resumeThread.mock.calls.map(([id]) => id)).toEqual(["historical", "current"]);
    expect(unsubscribeThread.mock.calls.map(([id]) => id)).toEqual(invalidRestore
      ? ["current", "current", "historical"] : ["current", "historical"]);
    expect(router.current(target)?.threadId).toBe(invalidRestore ? undefined : "current");
  });

  it.each(["settings", "cwd", "active-turn"])("cleans a newly restored subscription on %s mismatch", async (mismatch) => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "current", sessionId: "current" });
    const historical = thread("historical", { type: "idle" });
    const result = session(historical);
    if (mismatch === "settings") result.settingsMatch = false;
    if (mismatch === "cwd") result.effectiveSettings.cwd = "/other";
    if (mismatch === "active-turn") result.thread = { ...historical, status: { type: "active" }, activeTurnId: null };
    const unsubscribeThread = vi.fn(async () => undefined);
    const router = new SessionRouter(threadPort({ readThread: async () => historical,
      resumeThread: async () => result, unsubscribeThread }), store, registry);
    await expect(router.resume(target, historical.id, false, historical.cwd)).rejects.toMatchObject({ code: "thread.takeover.changed" });
    expect(unsubscribeThread).toHaveBeenCalledExactlyOnceWith("historical");
    expect(router.current(target)?.threadId).toBe("current");
    expect(router.workspace(target).id).toBe("main");
  });

  it.each([false, true])("cleans the new subscription if the previous unsubscribe fails; cleanup failure=%s", async (cleanupFails) => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "current", sessionId: "current" });
    const historical = thread("historical", { type: "idle" });
    const unsubscribeThread = vi.fn(async (id: string) => {
      if (id === "current" || cleanupFails) throw new Error(`unsubscribe failed: ${id}`);
    });
    const router = new SessionRouter(threadPort({ readThread: async () => historical,
      resumeThread: async () => session(historical), unsubscribeThread }), store, registry);
    await expect(router.resume(target, historical.id)).rejects.toThrow(cleanupFails ? "新订阅清理失败" : "unsubscribe failed: current");
    expect(unsubscribeThread.mock.calls.map(([id]) => id)).toEqual(["current", "historical"]);
    expect(router.current(target)?.threadId).toBe("current");
    expect(router.workspace(target).id).toBe("main");
  });

  it("does not overwrite a moved historical directory from a persisted binding on reconnect", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "historical", sessionId: "historical" });
    const resumeThread = vi.fn();
    const startThread = vi.fn(async () => session(thread("fresh", { type: "idle" })));
    const router = new SessionRouter(threadPort({
      readThread: async (id) => ({ ...thread(id, { type: "idle" }), cwd: "/other" }), resumeThread,
      startThread,
    }), store, registry);
    const failures = await router.restoreSubscriptions();
    expect(failures).toMatchObject([{ bindingRemoved: true, reason: "unavailable" }]);
    expect(resumeThread).not.toHaveBeenCalled();
    expect(router.current(target)).toBeUndefined();
    expect(router.workspace(target).id).toBe("main");
    expect((await router.ensure(target)).threadId).toBe("fresh");
    expect(startThread).toHaveBeenCalledWith("/workspace", {});
  });

  it.each([false, true])("removes an invalid reconnect binding even if subscription cleanup fails=%s", async (cleanupFails) => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "historical", sessionId: "historical" });
    const unsubscribeThread = vi.fn(async () => {
      if (cleanupFails) throw new Error("unsubscribe failed");
    });
    const startThread = vi.fn(async () => session(thread("fresh", { type: "idle" })));
    const router = new SessionRouter(threadPort({
      resumeThread: async (id) => session(thread(id, { type: "idle" }), { settingsMatch: false }), unsubscribeThread,
      startThread,
    }), store, registry);
    expect(await router.restoreSubscriptions()).toMatchObject([{ bindingRemoved: true, reason: "unavailable" }]);
    expect(unsubscribeThread).toHaveBeenCalledExactlyOnceWith("historical");
    expect(router.current(target)).toBeUndefined();
    expect((await router.ensure(target)).threadId).toBe("fresh");
  });
  it("rejects cross-workspace history before resume without changing the binding", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "current", sessionId: "current" });
    const historical = { ...thread("historical", { type: "idle" }), cwd: "/other" };
    const resumeThread = vi.fn(async () => session(historical, { effectiveSettings: {
      cwd: "/other", approvalPolicy: "never", sandbox: "read-only", permissions: null,
    } }));
    const unsubscribeThread = vi.fn(async () => undefined);
    const router = new SessionRouter(threadPort({
      readThread: async () => historical,
      resumeThread,
      unsubscribeThread,
    }), store, new WorkspaceRegistry([
      { id: "main", name: "Main", cwd: "/workspace", sandbox: "workspace-write" },
      { id: "other", name: "Other", cwd: "/other", sandbox: "read-only", approvalPolicy: "never" },
    ], "main"));

    await expect(router.resume(target, historical.id, false, historical.cwd)).rejects.toMatchObject({ code: "thread.takeover.workspace" });
    expect(resumeThread).not.toHaveBeenCalled();
    expect(unsubscribeThread).not.toHaveBeenCalled();
    expect(router.workspace(target).id).toBe("main");
    expect(router.current(target)?.threadId).toBe("current");
  });

  it.each(["changed", "unauthorized", "source", "rpc"])("preserves the original workspace and binding on %s recovery failure", async (failure) => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "current", sessionId: "current" });
    const historical: ThreadSnapshot = {
      ...thread("historical", { type: "idle" }),
      cwd: failure === "unauthorized" ? "/unregistered" : "/workspace",
      source: failure === "source" ? "automation" : "cli",
    };
    const resumeThread = vi.fn(async (): Promise<ThreadResumeSession> => { throw new Error("resume failed"); });
    const unsubscribeThread = vi.fn(async () => undefined);
    const router = new SessionRouter(threadPort({ readThread: async () => historical, resumeThread, unsubscribeThread }), store, registry);

    await expect(router.resume(target, historical.id, false, failure === "changed" ? "/other" : historical.cwd)).rejects.toThrow();

    expect(router.current(target)?.threadId).toBe("current");
    expect(router.workspace(target).id).toBe("main");
    expect(unsubscribeThread).not.toHaveBeenCalled();
    expect(resumeThread).toHaveBeenCalledTimes(failure === "rpc" ? 1 : 0);
  });

  it("rejects takeover when authoritative history no longer matches the bound workspace", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target: { ...target, surface: "feishu" }, workspaceId: "main", threadId: "historical", sessionId: "historical" });
    const unsubscribeThread = vi.fn(async () => undefined);
    const router = new SessionRouter(threadPort({
      readThread: async (id) => ({ ...thread(id, { type: "idle" }), cwd: "/other" }),
      unsubscribeThread,
    }), store, registry);
    await expect(router.transferBinding(target, "historical")).rejects.toMatchObject({ code: "thread.takeover.changed" });
    expect(store.getByThread("historical")).toBeUndefined();
    expect(unsubscribeThread).toHaveBeenCalledExactlyOnceWith("historical");
  });

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

  it("removes a binding when its Workspace was removed from the registry", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "removed", threadId: "bound", sessionId: "bound" });
    const router = new SessionRouter(threadPort(), store, registry);

    const failures = await router.restoreSubscriptions();

    expect(failures).toEqual([
      expect.objectContaining({ bindingRemoved: true, reason: "unavailable" }),
    ]);
    expect(store.get(target)).toBeUndefined();
  });

  it("passes Workspace permissions and reviewer to start, unloaded resume and fork", async () => {
    const store = new MemoryBindingStore();
    const entitledRegistry = new WorkspaceRegistry([
      {
        id: "main",
        name: "Main",
        cwd: "/workspace",
        sandbox: "workspace-write",
        approvalPolicy: "never",
        approvalsReviewer: "auto_review",
      },
      { id: "other", name: "Other", cwd: "/other" },
    ], "main");
    const started: unknown[] = [];
    const resumed: unknown[] = [];
    const forked: unknown[] = [];
    const client = threadPort({
      readThread: async (id) => thread(id, { type: "notLoaded" }),
      listThreads: async () => [],
      startThread: async (cwd, options) => {
        started.push({ cwd, options });
        return session(thread("new", { type: "idle" }));
      },
      resumeThread: async (threadId, cwd, options) => {
        resumed.push({ threadId, cwd, options });
        return session(thread(threadId, { type: "idle" }), { effectiveSettings: {
          cwd, approvalPolicy: "never", sandbox: "workspace-write", permissions: null,
        } });
      },
      forkThread: async (threadId, cwd, options) => {
        forked.push({ threadId, cwd, options });
        return session(thread("forked", { type: "idle" }));
      },
      unsubscribeThread: async () => {},
    });
    const router = new SessionRouter(client, store, entitledRegistry);

    await router.ensure(target);
    await router.resume(target, "existing");
    await router.fork(target);

    expect(started).toEqual([{
      cwd: "/workspace",
      options: { sandbox: "workspace-write", approvalPolicy: "never", approvalsReviewer: "auto_review" },
    }]);
    expect(resumed).toEqual([{
      threadId: "existing",
      cwd: "/workspace",
      options: { sandbox: "workspace-write", approvalPolicy: "never", approvalsReviewer: "auto_review" },
    }]);
    expect(forked).toEqual([{
      threadId: "existing", cwd: "/workspace",
      options: { sandbox: "workspace-write", approvalPolicy: "never", approvalsReviewer: "auto_review" },
    }]);
  });

  it.each(["idle", "active"] as const)("preserves the actual reviewer of an already loaded %s Thread on registry reload and resume", async (status) => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "loaded", sessionId: "loaded" });
    const workspaces = new WorkspaceRegistry([{ id: "main", name: "Main", cwd: "/workspace", approvalsReviewer: "user" }], "main");
    const snapshot = { ...thread("loaded", { type: status }), activeTurnId: status === "active" ? "running" : null };
    const resumeThread = vi.fn(async () => session(snapshot, { approvalsReviewer: "user" }));
    const router = new SessionRouter(threadPort({ resumeThread, readThread: async () => snapshot }), store, workspaces);
    workspaces.replace([{ id: "main", name: "Main", cwd: "/workspace", approvalsReviewer: "auto_review" }], "main");
    expect(await router.restoreSubscriptions()).toEqual([]);
    expect(resumeThread).toHaveBeenCalledWith("loaded", "/workspace", {});
    expect(router.modelSettings(target)?.approvalsReviewer).toBe("user");
    expect(router.current(target)?.threadId).toBe("loaded");
  });

  it("isolates reviewer defaults per Workspace and omits a cleared override", async () => {
    const store = new MemoryBindingStore();
    const workspaces = new WorkspaceRegistry([
      { id: "main", name: "Main", cwd: "/workspace", approvalsReviewer: "auto_review" },
      { id: "other", name: "Other", cwd: "/other", approvalsReviewer: "user" },
    ], "main");
    const started: Array<{ cwd: string; options: unknown }> = [];
    const router = new SessionRouter(threadPort({
      listThreads: async () => [],
      startThread: async (cwd, options) => {
        started.push({ cwd, options });
        return session({ ...thread(`new-${started.length}`, { type: "idle" }), cwd });
      }, unsubscribeThread: async () => {},
    }), store, workspaces);
    await router.ensure(target);
    await router.selectWorkspace(target, "other");
    await router.ensure(target);
    workspaces.replace([{ id: "main", name: "Main", cwd: "/workspace" }, { id: "other", name: "Other", cwd: "/other" }], "main");
    await router.newSession(target);
    await router.ensure(target);
    expect(started).toEqual([
      { cwd: "/workspace", options: { approvalsReviewer: "auto_review" } },
      { cwd: "/other", options: { approvalsReviewer: "user" } },
      { cwd: "/other", options: {} },
    ]);
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

  it("skips idle candidates whose Provider is no longer configured", async () => {
    const store = new MemoryBindingStore();
    const started: unknown[] = [];
    const orphaned = {
      ...thread("orphaned", { type: "notLoaded" }),
      modelProvider: "clp-main",
    };
    const usable = {
      ...thread("usable", { type: "notLoaded" }),
      modelProvider: "ds-main",
    };
    const client = threadPort({
      isProviderConfigured: (provider) => provider === "ds-main",
      listThreads: async () => [orphaned, usable],
      readThread: async (id) => (id === "usable" ? usable : orphaned),
      resumeThread: async (threadId) => session(
        threadId === "usable" ? usable : orphaned,
        { modelProvider: threadId === "usable" ? "ds-main" : "clp-main" },
      ),
      startThread: async (cwd, options) => {
        started.push({ cwd, options });
        return session(thread("fresh", { type: "idle" }));
      },
    });
    const router = new SessionRouter(client, store, registry);

    expect((await router.ensure(target)).threadId).toBe("usable");
    expect(started).toEqual([]);
  });

  it("starts a Thread when every idle candidate Provider was removed", async () => {
    const store = new MemoryBindingStore();
    const readThread = vi.fn(async () => thread("orphaned", { type: "notLoaded" }));
    const startThread = vi.fn(async () => session(thread("fresh", { type: "idle" })));
    const client = threadPort({
      isProviderConfigured: () => false,
      listThreads: async () => [{
        ...thread("orphaned", { type: "notLoaded" }),
        modelProvider: "clp-main",
      }],
      readThread,
      startThread,
    });
    const router = new SessionRouter(client, store, registry);

    expect((await router.ensure(target)).threadId).toBe("fresh");
    expect(readThread).not.toHaveBeenCalled();
    expect(startThread).toHaveBeenCalledWith("/workspace", {});
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

  it.each([false, true])("cleans the Fork subscription when original unsubscribe fails; cleanup failure=%s", async (cleanupFails) => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "original", sessionId: "original" });
    const unsubscribeThread = vi.fn(async (id: string) => {
      if (id === "original" || cleanupFails) throw new Error(`unsubscribe failed: ${id}`);
    });
    const router = new SessionRouter(threadPort({
      forkThread: async () => session(thread("forked", { type: "idle" })),
      unsubscribeThread,
    }), store, registry);

    await expect(router.fork(target)).rejects.toThrow(cleanupFails ? "新订阅清理失败" : "unsubscribe failed: original");
    expect(unsubscribeThread.mock.calls.map(([id]) => id)).toEqual(["original", "forked"]);
    expect(store.get(target)?.threadId).toBe("original");
    expect(store.getByThread("forked")).toBeUndefined();
  });

  it.each([false, true])("restores the original subscription after Fork binding fails; restore failure=%s", async (restoreFails) => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "original", sessionId: "original" });
    vi.spyOn(store, "switchForeground").mockImplementationOnce(() => { throw new Error("binding failed"); });
    const resumeThread = vi.fn(async () => {
      if (restoreFails) throw new Error("restore failed");
      return session(thread("original", { type: "idle" }));
    });
    const unsubscribeThread = vi.fn<(id: string) => Promise<void>>(async () => undefined);
    const router = new SessionRouter(threadPort({
      forkThread: async () => session(thread("forked", { type: "idle" })),
      resumeThread, unsubscribeThread,
    }), store, registry);

    await expect(router.fork(target)).rejects.toThrow(restoreFails ? "原订阅恢复失败" : "binding failed");
    expect(resumeThread).toHaveBeenCalledExactlyOnceWith("original", "/workspace", {});
    expect(unsubscribeThread.mock.calls.map(([id]) => id)).toEqual(["original", "forked"]);
    expect(store.get(target)?.threadId).toBe("original");
    expect(router.modelSettingsForThread("forked")).toBeUndefined();
  });

  it("does not recreate a revoked binding after Fork returns", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "original", sessionId: "original" });
    const unsubscribeThread = vi.fn(async () => undefined);
    const router = new SessionRouter(threadPort({
      forkThread: async () => {
        router.forgetThread("original");
        return session(thread("forked", { type: "idle" }));
      },
      unsubscribeThread,
    }), store, registry);

    await expect(router.fork(target)).rejects.toMatchObject({ code: "thread.takeover.changed" });
    expect(store.get(target)).toBeUndefined();
    expect(unsubscribeThread).toHaveBeenCalledExactlyOnceWith("forked");
  });

  it("cleans both subscriptions if ownership is revoked during Fork compensation", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "original", sessionId: "original" });
    vi.spyOn(store, "switchForeground").mockImplementationOnce(() => { throw new Error("binding failed"); });
    const unsubscribeThread = vi.fn<(id: string) => Promise<void>>(async () => undefined);
    const router = new SessionRouter(threadPort({
      forkThread: async () => session(thread("forked", { type: "idle" })),
      resumeThread: async () => {
        router.forgetThread("original");
        return session(thread("original", { type: "idle" }));
      },
      unsubscribeThread,
    }), store, registry);

    await expect(router.fork(target)).rejects.toThrow("原订阅恢复失败");
    expect(store.get(target)).toBeUndefined();
    expect(unsubscribeThread.mock.calls.map(([id]) => id)).toEqual(["original", "original", "forked"]);
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
          approvalsReviewer: "auto_review",
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
      approvalsReviewer: "auto_review",
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
      approvalsReviewer: "auto_review",
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
    const bindingsChanged = vi.fn();
    const client = threadPort({
      listThreads: async () => [],
      startThread: async () => session(thread("new", { type: "idle" })),
      unsubscribeThread: async (threadId: string) => {
        unsubscribed.push(threadId);
      },
    });
    const router = new SessionRouter(
      client,
      new MemoryBindingStore(),
      registry,
      [],
      bindingsChanged,
    );
    await router.ensure(target);
    await router.newSession(target);
    await router.ensure(target);

    expect(unsubscribed).toEqual(["new"]);
    expect(bindingsChanged).toHaveBeenCalledTimes(3);
  });

  it("persists the force-new marker until the next ordinary message creates a Thread", async () => {
    const store = new MemoryBindingStore();
    const client = threadPort({
      listThreads: async () => [thread("old", { type: "idle" })],
      startThread: async () => session(thread("new", { type: "idle" })),
      resumeThread: async (threadId) => session(thread(threadId, { type: "idle" })),
      unsubscribeThread: async () => undefined,
    });
    const router = new SessionRouter(client, store, registry);

    await router.newSession(target);
    expect(store.idleState(target)).toMatchObject({ forceNew: true });

    const binding = await router.ensure(target);
    expect(binding.threadId).toBe("new");
    expect(store.idleState(target)).toMatchObject({ forceNew: false });
  });

  it("keeps an active foreground subscription when switching it to the background", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "running", sessionId: "running" });
    const unsubscribed: string[] = [];
    const client = threadPort({
      readThread: async (id) => thread(id, { type: "idle" }),
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
    expect(router.workspaceForThread("running")).toEqual({ id: "main", name: "Main" });
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
      approvalsReviewer: null,
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
          approvalsReviewer: "user",
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
      approvalsReviewer: "user",
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
      readThread: async (id) => thread(id, { type: "idle" }),
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

  it("switches only to a preconfigured workspace and starts the Thread there", async () => {
    const listedCwds: string[] = [];
    const startedCwds: string[] = [];
    const unsubscribed: string[] = [];
    const client = threadPort({
      listThreads: async (cwd: string) => {
        listedCwds.push(cwd);
        return [];
      },
      startThread: async (cwd: string) => {
        startedCwds.push(cwd);
        return session({ ...thread("created", { type: "idle" }), cwd });
      },
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
    expect(listedCwds).toEqual(["/workspace", "/workspace"]);
    expect(startedCwds).toEqual(["/workspace", "/other"]);
    expect(store.getWorkspace(target)).toBe("other");
    expect(router.current(target)?.workspaceId).toBe("other");
  });

  it("starts a new Thread after switching Workspace instead of resuming history", async () => {
    const resumed: string[] = [];
    const started: string[] = [];
    const client = threadPort({
      listThreads: async (cwd: string) =>
        cwd === "/other" ? [thread("historical", { type: "idle" })] : [],
      startThread: async (cwd: string) => {
        started.push(cwd);
        return session({ ...thread(`new-${started.length}`, { type: "idle" }), cwd });
      },
      resumeThread: async (threadId: string, cwd: string) => {
        resumed.push(`${threadId}:${cwd}`);
        return session({ ...thread(threadId, { type: "idle" }), cwd });
      },
      unsubscribeThread: async () => {},
    });
    const router = new SessionRouter(client, new MemoryBindingStore(), registry);

    await router.ensure(target);
    await router.selectWorkspace(target, "other");
    const binding = await router.ensure(target);

    expect(binding.threadId).toBe("new-2");
    expect(started).toEqual(["/workspace", "/other"]);
    expect(resumed).toEqual([]);
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
      readThread: async (id) => thread(id, { type: "idle" }),
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
