import { describe, expect, it } from "vitest";

import { WorkspaceRegistry } from "../src/policy/index.js";
import {
  SessionRouter,
  ThreadStateSynchronizer,
  type ThreadLifecyclePort,
} from "../src/session-routing/index.js";
import { MemoryBindingStore } from "../src/storage/index.js";

const target = {
  surface: "telegram",
  accountId: "default",
  conversationId: "100",
};

function unusedThreadPort(): ThreadLifecyclePort {
  const unsupported = async (): Promise<never> => {
    throw new Error("该测试不应调用 ThreadLifecyclePort");
  };
  return {
    listThreads: unsupported,
    startThread: unsupported,
    resumeThread: unsupported,
    forkThread: unsupported,
    archiveThread: unsupported,
    unarchiveThread: unsupported,
    unsubscribeThread: unsupported,
  };
}

function createBoundRouter(): SessionRouter {
  const bindings = new MemoryBindingStore();
  bindings.bind({
    target,
    workspaceId: "main",
    threadId: "thread-1",
    sessionId: "session-1",
  });
  return new SessionRouter(
    unusedThreadPort(),
    bindings,
    new WorkspaceRegistry([{ id: "main", name: "Main", cwd: "/workspace" }], "main"),
  );
}

describe("ThreadStateSynchronizer", () => {
  it("updates model, effort and Fast state from the complete App Server notification", () => {
    const router = createBoundRouter();
    const synchronizer = new ThreadStateSynchronizer(router);

    synchronizer.handle({
      method: "thread/settings/updated",
      params: {
        threadId: "thread-1",
        threadSettings: {
          model: "gpt-5.6-sol",
          effort: "high",
          serviceTier: "priority",
        },
      },
    });

    expect(router.modelSettings(target)).toEqual({
      model: "gpt-5.6-sol",
      effort: "high",
      serviceTier: "priority",
    });
  });

  it("ignores incomplete settings notifications instead of inventing local state", () => {
    const router = createBoundRouter();
    router.updateModelSettings("thread-1", {
      model: "gpt-original",
      effort: "medium",
      serviceTier: "default",
    });
    const synchronizer = new ThreadStateSynchronizer(router);

    synchronizer.handle({
      method: "thread/settings/updated",
      params: {
        threadId: "thread-1",
        threadSettings: {
          model: "gpt-changed",
          effort: "high",
        },
      },
    });

    expect(router.modelSettings(target)).toEqual({
      model: "gpt-original",
      effort: "medium",
      serviceTier: "default",
    });
  });

  it.each([
    "thread/archived",
    "thread/deleted",
  ])("forgets a bound Thread after %s", (method) => {
    const router = createBoundRouter();
    const synchronizer = new ThreadStateSynchronizer(router);

    synchronizer.handle({
      method,
      params: { threadId: "thread-1" },
    });

    expect(router.current(target)).toBeUndefined();
  });

  it("keeps a bound Thread after App Server unloads it from memory", () => {
    const router = createBoundRouter();
    const synchronizer = new ThreadStateSynchronizer(router);

    synchronizer.handle({
      method: "thread/closed",
      params: { threadId: "thread-1" },
    });

    expect(router.current(target)?.threadId).toBe("thread-1");
  });

  it("ignores unrelated and malformed Thread notifications", () => {
    const router = createBoundRouter();
    const synchronizer = new ThreadStateSynchronizer(router);

    synchronizer.handle({ method: "turn/started", params: { threadId: "thread-1" } });
    synchronizer.handle({ method: "thread/deleted", params: { threadId: 1 } });

    expect(router.current(target)?.threadId).toBe("thread-1");
  });
});
