import { describe, expect, it } from "vitest";

import type { CodexAppServerClient } from "../src/codex-client/client.js";
import { JsonRpcError } from "../src/codex-client/json-rpc.js";
import type { Thread } from "../src/codex-protocol/index.js";
import { MemoryBindingStore } from "../src/storage/memory-binding-store.js";
import { SessionRouter } from "../src/session-routing/router.js";
import { WorkspaceRegistry } from "../src/policy/workspace-registry.js";

const target = { surface: "telegram" as const, conversationId: "100" };
const registry = new WorkspaceRegistry(
  [
    { id: "main", name: "Main", cwd: "/workspace" },
    { id: "other", name: "Other", cwd: "/other" },
  ],
  "main",
);

function thread(id: string, status: Thread["status"]): Thread {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "test",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status,
    path: null,
    cwd: "/workspace",
    cliVersion: "0.145.0",
    source: "cli",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

describe("SessionRouter", () => {
  it("skips active threads and resumes the latest idle thread", async () => {
    const resumed: string[] = [];
    const client = {
      listThreads: async () => [
        thread("active", { type: "active", activeFlags: [] }),
        thread("idle", { type: "idle" }),
      ],
      resumeThread: async (threadId: string) => {
        resumed.push(threadId);
        return {
          thread: thread(threadId, { type: "idle" }),
          model: "gpt-main",
          reasoningEffort: "high",
        };
      },
    } as unknown as CodexAppServerClient;
    const router = new SessionRouter(client, new MemoryBindingStore(), registry);

    const binding = await router.ensure(target);

    expect(binding.threadId).toBe("idle");
    expect(resumed).toEqual(["idle"]);
    expect(router.modelSettings(target)).toEqual({ model: "gpt-main", effort: "high" });

    router.updateModelSettings("idle", { model: "gpt-updated", effort: "xhigh" });
    expect(router.modelSettings(target)).toEqual({ model: "gpt-updated", effort: "xhigh" });
  });

  it("unsubscribes before forcing a new thread", async () => {
    const unsubscribed: string[] = [];
    const client = {
      listThreads: async () => [],
      startThread: async () => ({ thread: thread("new", { type: "idle" }) }),
      unsubscribeThread: async (threadId: string) => {
        unsubscribed.push(threadId);
        return { status: "unsubscribed" };
      },
    } as unknown as CodexAppServerClient;
    const router = new SessionRouter(client, new MemoryBindingStore(), registry);
    await router.ensure(target);
    await router.newSession(target);
    await router.ensure(target);

    expect(unsubscribed).toEqual(["new"]);
  });

  it("restores bound thread subscriptions after App Server reconnect", async () => {
    const resumed: string[] = [];
    const client = {
      listThreads: async () => [],
      startThread: async () => ({ thread: thread("bound", { type: "idle" }) }),
      resumeThread: async (threadId: string) => {
        resumed.push(threadId);
        return { thread: thread(threadId, { type: "idle" }) };
      },
    } as unknown as CodexAppServerClient;
    const router = new SessionRouter(client, new MemoryBindingStore(), registry);
    await router.ensure(target);

    const failures = await router.restoreSubscriptions();

    expect(failures).toEqual([]);
    expect(resumed).toEqual(["bound"]);
    expect(router.current(target)?.threadId).toBe("bound");
  });

  it("keeps a binding when subscription restore fails transiently", async () => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: "main", threadId: "bound", sessionId: "bound" });
    const client = {
      resumeThread: async () => {
        throw new JsonRpcError(-32001, "Server overloaded; retry later.");
      },
    } as unknown as CodexAppServerClient;
    const router = new SessionRouter(client, store, registry);

    const failures = await router.restoreSubscriptions();

    expect(failures).toEqual([
      expect.objectContaining({ bindingRemoved: false }),
    ]);
    expect(router.current(target)?.threadId).toBe("bound");
  });

  it("switches only to a preconfigured workspace and scopes thread discovery by cwd", async () => {
    const listedCwds: string[] = [];
    const unsubscribed: string[] = [];
    const client = {
      listThreads: async (cwd: string) => {
        listedCwds.push(cwd);
        return [];
      },
      startThread: async (cwd: string) => ({ thread: { ...thread("created", { type: "idle" }), cwd } }),
      unsubscribeThread: async (threadId: string) => {
        unsubscribed.push(threadId);
        return { status: "unsubscribed" };
      },
    } as unknown as CodexAppServerClient;
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
    const router = new SessionRouter({} as CodexAppServerClient, new MemoryBindingStore(), registry);

    await expect(router.selectWorkspace(target, "/arbitrary/path"))
      .rejects.toThrow("Workspace 不存在或未获授权");
  });

  it("keeps the current thread bound when selecting the same workspace", async () => {
    const unsubscribed: string[] = [];
    const client = {
      listThreads: async () => [],
      startThread: async () => ({ thread: thread("current", { type: "idle" }) }),
      unsubscribeThread: async (threadId: string) => {
        unsubscribed.push(threadId);
        return { status: "unsubscribed" };
      },
    } as unknown as CodexAppServerClient;
    const router = new SessionRouter(client, new MemoryBindingStore(), registry);
    await router.ensure(target);

    await router.selectWorkspace(target, "main");

    expect(unsubscribed).toEqual([]);
    expect(router.current(target)?.threadId).toBe("current");
  });

  it("passes search and archive filters to App Server thread discovery", async () => {
    const calls: unknown[] = [];
    const client = {
      listThreads: async (_cwd: string, options: unknown) => {
        calls.push(options);
        return [thread("archived", { type: "idle" })];
      },
    } as unknown as CodexAppServerClient;
    const router = new SessionRouter(client, new MemoryBindingStore(), registry);

    await router.list(target, { archived: true, searchTerm: "修复" });

    expect(calls).toEqual([{ archived: true, searchTerm: "修复" }]);
  });

  it("archives the current binding and resumes an unarchived thread", async () => {
    const archived: string[] = [];
    const unarchived: string[] = [];
    const client = {
      listThreads: async () => [],
      startThread: async () => ({ thread: thread("current", { type: "idle" }) }),
      archiveThread: async (threadId: string) => archived.push(threadId),
      unarchiveThread: async (threadId: string) => {
        unarchived.push(threadId);
        return { thread: thread(threadId, { type: "idle" }) };
      },
      resumeThread: async (threadId: string) => ({ thread: thread(threadId, { type: "idle" }) }),
    } as unknown as CodexAppServerClient;
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
