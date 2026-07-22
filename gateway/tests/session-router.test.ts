import { describe, expect, it } from "vitest";

import type { CodexAppServerClient } from "../src/codex-client/client.js";
import type { Thread } from "../src/codex-protocol/index.js";
import { MemoryBindingStore } from "../src/storage/memory-binding-store.js";
import { SessionRouter } from "../src/session-routing/router.js";

const target = { surface: "telegram" as const, conversationId: "100" };

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
        return { thread: thread(threadId, { type: "idle" }) };
      },
    } as unknown as CodexAppServerClient;
    const router = new SessionRouter(client, new MemoryBindingStore());

    const binding = await router.ensure(target);

    expect(binding.threadId).toBe("idle");
    expect(resumed).toEqual(["idle"]);
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
    const router = new SessionRouter(client, new MemoryBindingStore());
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
    const router = new SessionRouter(client, new MemoryBindingStore());
    await router.ensure(target);

    const failures = await router.restoreSubscriptions();

    expect(failures).toEqual([]);
    expect(resumed).toEqual(["bound"]);
    expect(router.current(target)?.threadId).toBe("bound");
  });
});
