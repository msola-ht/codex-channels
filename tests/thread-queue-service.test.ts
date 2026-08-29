import { describe, expect, it, vi } from "vitest";

import {
  ConversationService,
  type ConversationQueryPort,
} from "../src/application/conversation-service.js";
import type { CollaborationModeSelectionService } from "../src/application/collaboration-mode-service.js";
import type {
  ThreadQueueItem,
  ThreadQueuePort,
} from "../src/application/thread-queue-port.js";
import type { ModelSelectionService } from "../src/application/model-selection-service.js";
import type { TurnExecutionPort } from "../src/application/turn-port.js";
import {
  ConversationCore,
  UserFacingError,
  type ConversationTarget,
} from "../src/conversation-core/index.js";
import type { SessionRouter } from "../src/session-routing/router.js";

const target: ConversationTarget = {
  surface: "telegram",
  accountId: "default",
  conversationId: "queue-test",
};
const binding = {
  target,
  workspaceId: "main",
  threadId: "thread-queue",
  sessionId: "session-queue",
};

function item(index: number, text = `queued ${index}`): ThreadQueueItem {
  return {
    id: `queued-${index}`,
    clientUserMessageId: `client-${index}`,
    inputType: "text",
    textPreview: text,
    editable: true,
  };
}

function turnPort(): TurnExecutionPort {
  const unsupported = async (): Promise<never> => {
    throw new Error("测试未配置 TurnExecutionPort 方法");
  };
  return {
    startTurn: unsupported,
    steerTurn: unsupported,
    interruptTurn: unsupported,
    setThreadName: unsupported,
    setThreadPinned: unsupported,
    listThreadSections: unsupported,
    createThreadSection: unsupported,
    renameThreadSection: unsupported,
    deleteThreadSection: unsupported,
    moveThreadToSection: unsupported,
    compactThread: unsupported,
    startReview: unsupported,
    getGoal: unsupported,
    setGoal: unsupported,
    clearGoal: unsupported,
  };
}

function queryPort(): ConversationQueryPort {
  const unsupported = async (): Promise<never> => {
    throw new Error("测试未配置 ConversationQueryPort 方法");
  };
  return {
    listSkills: unsupported,
    resolveSkill: unsupported,
    listMcpServers: unsupported,
    listMcpServerDetails: unsupported,
    reloadMcpServers: unsupported,
    startMcpOAuthLogin: unsupported,
    readMcpResource: unsupported,
    listPlugins: unsupported,
    resolvePlugin: unsupported,
    accountUsage: unsupported,
    accountRateLimits: unsupported,
    accountThreadUsage: unsupported,
    listPermissionProfiles: unsupported,
  };
}

function queuePort(initial: ThreadQueueItem[]): ThreadQueuePort & {
  items: ThreadQueueItem[];
  addQueueItem: ReturnType<typeof vi.fn>;
  listQueue: ReturnType<typeof vi.fn>;
  reorderQueue: ReturnType<typeof vi.fn>;
  startQueueItem: ReturnType<typeof vi.fn>;
} {
  const items = [...initial];
  const port = {
    items,
    addQueueItem: vi.fn(async (
      _threadId: string,
      text: string,
      clientUserMessageId: string,
    ) => {
      const added = {
        id: `queued-${items.length + 1}`,
        clientUserMessageId,
        inputType: "text" as const,
        textPreview: text,
        editable: true,
      };
      items.push(added);
      return added;
    }),
    listQueue: vi.fn(async (
      _threadId: string,
      options: { cursor?: string | null; limit?: number } = {},
    ) => {
      const limit = options.limit ?? 25;
      const start = options.cursor ? Number(options.cursor) : 0;
      const page = items.slice(start, start + limit);
      return {
        items: page,
        nextCursor: start + page.length < items.length
          ? String(start + page.length)
          : null,
      };
    }),
    updateQueueItem: vi.fn(async (
      _threadId: string,
      queuedSubmissionId: string,
      text: string,
    ) => {
      const index = items.findIndex((entry) => entry.id === queuedSubmissionId);
      const updated = { ...items[index]!, textPreview: text };
      items[index] = updated;
      return updated;
    }),
    deleteQueueItem: vi.fn(async (_threadId: string, queuedSubmissionId: string) => {
      const index = items.findIndex((entry) => entry.id === queuedSubmissionId);
      if (index < 0) return { deleted: false };
      items.splice(index, 1);
      return { deleted: true };
    }),
    reorderQueue: vi.fn(async (_threadId: string, ids: string[]) => {
      const next = ids.flatMap((id) => {
        const found = items.find((entry) => entry.id === id);
        return found ? [found] : [];
      });
      items.splice(0, items.length, ...next);
    }),
    startQueueItem: vi.fn(async (
      _threadId: string,
      queuedSubmissionId?: string,
    ) => {
      if (items.length === 0) {
        throw new Error("queue is empty");
      }
      const index = queuedSubmissionId === undefined
        ? 0
        : items.findIndex((entry) => entry.id === queuedSubmissionId);
      if (index < 0) {
        throw new Error(`queued submission not found: ${queuedSubmissionId}`);
      }
      items.splice(index, 1);
      return { turnId: "turn-queue-start" };
    }),
  };
  return port;
}

function serviceWithQueue(
  queue: ThreadQueuePort,
  options: {
    active?: boolean;
    activeThreadId?: string;
    router?: Partial<SessionRouter>;
    models?: Partial<ModelSelectionService>;
    collaborationModes?: object;
    hasPendingSubagentRuns?: (parentThreadId: string) => boolean;
  } = {},
): ConversationService {
  const router = {
    current: () => binding,
    workspace: () => ({ id: "main", name: "Main", cwd: "/workspace/main" }),
    backgroundBindings: () => [],
    isBackgroundThread: () => false,
    targetForThread: () => undefined,
    ...options.router,
  } as unknown as SessionRouter;
  const core = {
    activeTurn: () => options.active ? {
      target,
      threadId: options.activeThreadId ?? binding.threadId,
      turnId: "turn-active",
    } : undefined,
    activeTurnForThread: (threadId: string) => options.active
      && threadId === (options.activeThreadId ?? binding.threadId)
      ? {
          target,
          threadId,
          turnId: "turn-active",
        }
      : undefined,
  } as unknown as ConversationCore;
  return new ConversationService(
    turnPort(),
    router,
    core,
    { ...options.models } as ModelSelectionService,
    queryPort(),
    undefined,
    undefined,
    options.collaborationModes as unknown as CollaborationModeSelectionService | undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    queue,
    undefined,
    undefined,
    options.hasPendingSubagentRuns,
  );
}

describe("ConversationService native Thread Queue", () => {
  it("uses the native Queue for add/list/update/delete/reorder/start", async () => {
    const queue = queuePort([item(1), item(2)]);
    const service = serviceWithQueue(queue, { active: true });

    await expect(service.queueAdd(target, " added ")).resolves.toMatchObject({
      inputType: "text",
      textPreview: "added",
    });
    await expect(service.queueUpdate(target, "1", "updated")).rejects.toMatchObject({
      code: "queue.snapshot.required",
    });
    const listed = await service.queueList(target);
    expect(listed.totalItemCount).toBe(3);
    expect(listed.items).toHaveLength(3);
    await expect(service.queueUpdate(target, "1", "updated")).resolves.toMatchObject({
      textPreview: "updated",
    });
    await service.queueList(target);
    await expect(service.queueDelete(target, "2")).resolves.toEqual({ deleted: true });
    await service.queueList(target);
    await expect(service.queueReorder(target, "1", 1)).resolves.toMatchObject({
      itemId: "queued-1",
      position: 1,
    });
    await expect(service.queueStart(target, "queued-1")).resolves.toEqual({
      turnId: "turn-queue-start",
    });
    expect(queue.addQueueItem).toHaveBeenCalledWith(
      "thread-queue",
      "added",
      expect.stringMatching(/^codex_connect:/),
    );
  });

  it("shares the Conversation lock with binding lifecycle operations", async () => {
    const queue = queuePort([]);
    let releaseAdd: (() => void) | undefined;
    const addBlocked = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    queue.addQueueItem.mockImplementationOnce(async (
      _threadId: string,
      text: string,
      clientUserMessageId: string,
    ) => {
      await addBlocked;
      const added = {
        id: "queued-1",
        clientUserMessageId,
        inputType: "text" as const,
        textPreview: text,
        editable: true,
      };
      queue.items.push(added);
      return added;
    });
    const newSession = vi.fn(async () => undefined);
    const service = serviceWithQueue(queue, { router: { newSession } });

    const adding = service.queueAdd(target, "queued while switching");
    await vi.waitFor(() => expect(queue.addQueueItem).toHaveBeenCalledOnce());
    const switching = service.newSession(target);
    await Promise.resolve();
    expect(newSession).not.toHaveBeenCalled();

    releaseAdd?.();
    await expect(adding).resolves.toMatchObject({ id: "queued-1" });
    await expect(switching).rejects.toMatchObject({
      code: "conversation.background-queued",
    });
    expect(newSession).not.toHaveBeenCalled();
  });

  it("uses 25-item pages and rejects an App Server response over the native 100 limit", async () => {
    const queue = queuePort(Array.from({ length: 100 }, (_value, index) => item(index + 1)));
    const service = serviceWithQueue(queue);
    const secondPage = await service.queueList(target, 2);
    expect(secondPage.items).toHaveLength(25);
    expect(secondPage.selectors[0]).toBe("26");
    expect(secondPage.totalItemCount).toBe(100);
    expect(queue.listQueue).toHaveBeenCalledTimes(1);

    const overfull = queuePort(Array.from({ length: 101 }, (_value, index) => item(index + 1)));
    await expect(serviceWithQueue(overfull).queueList(target)).rejects.toMatchObject({
      code: "queue.unavailable",
    });
    expect(overfull.listQueue).toHaveBeenCalledTimes(1);

    const malformed = queuePort([item(1)]);
    malformed.listQueue.mockResolvedValueOnce({
      items: [item(1)],
      nextCursor: "unexpected-cursor",
    });
    await expect(serviceWithQueue(malformed).queueList(target)).rejects.toMatchObject({
      code: "queue.unavailable",
    });
  });

  it("invalidates numeric selectors on Queue change and maps reorder concurrency failures", async () => {
    const queue = queuePort([item(1), item(2)]);
    const service = serviceWithQueue(queue);
    await service.queueList(target);
    service.invalidateQueueSnapshot("thread-queue");
    await expect(service.queueDelete(target, "1")).rejects.toMatchObject({
      code: "queue.snapshot.required",
    });

    await service.queueList(target);
    queue.reorderQueue.mockRejectedValueOnce(
      new Error("queue reorder must include every queued submission exactly once"),
    );
    await expect(service.queueReorder(target, "1", 2)).rejects.toMatchObject({
      code: "queue.reorder-conflict",
    });
  });

  it("freshly rechecks update editability after a cross-client Queue change", async () => {
    const queue = queuePort([item(1), item(2)]);
    const service = serviceWithQueue(queue);
    await service.queueList(target);
    queue.items[0] = {
      ...queue.items[0]!,
      inputType: "image",
      textPreview: null,
      editable: false,
    };
    await expect(service.queueUpdate(target, "1", "must not overwrite"))
      .rejects.toMatchObject({ code: "queue.item-not-editable" });
    expect(queue.updateQueueItem).not.toHaveBeenCalled();
  });

  it("keeps selector snapshots bounded and stores only IDs", async () => {
    const queue = queuePort([item(1)]);
    const service = serviceWithQueue(queue);
    const conversations = Array.from({ length: 129 }, (_value, index) => ({
      ...target,
      conversationId: `queue-${index}`,
    }));
    for (const conversation of conversations) {
      await service.queueList(conversation);
    }
    const snapshots = (service as unknown as {
      queueUseCases: {
        selectionSnapshots: Map<string, { itemIds: string[]; capturedAtMs: number }>;
      };
    }).queueUseCases.selectionSnapshots;
    expect(snapshots.size).toBe(128);
    expect([...snapshots.values()].every((snapshot) => {
      return Array.isArray(snapshot.itemIds)
        && !("items" in snapshot)
        && !snapshot.itemIds.some((entry) => entry.includes("queued 1"));
    })).toBe(true);
    await expect(service.queueDelete(conversations[0]!, "1"))
      .rejects.toMatchObject({ code: "queue.snapshot.required" });
    await expect(service.queueDelete(conversations[128]!, "1"))
      .resolves.toEqual({ deleted: true });
  });

  it("rejects Queue operations that could strand pending model or Plan overrides", async () => {
    const queue = queuePort([item(1)]);
    const service = serviceWithQueue(queue, {
      models: { hasPending: () => true },
    });
    await expect(service.queueAdd(target, "unsafe pending override"))
      .rejects.toMatchObject({ code: "queue.pending-overrides" });
    expect(queue.addQueueItem).not.toHaveBeenCalled();

    const guarded = serviceWithQueue(queue, {
      models: {
        selectEffort: vi.fn(async () => ({}) as never),
      },
    });
    await expect(guarded.selectEffort(target, "high"))
      .rejects.toMatchObject({ code: "queue.pending-overrides" });

    const clear = vi.fn();
    const invalidSelection = serviceWithQueue(queuePort([]), {
      models: {
        hasPending: () => true,
        clear,
        selectEffort: vi.fn(async () => {
          throw new UserFacingError("effort.unsupported", "不支持该思考等级");
        }),
      },
    });
    await expect(invalidSelection.selectEffort(target, "invalid"))
      .rejects.toMatchObject({ code: "effort.unsupported" });
    expect(clear).not.toHaveBeenCalled();

    const pendingStart = serviceWithQueue(queuePort([item(1)]), {
      models: { hasPending: () => true },
    });
    await expect(pendingStart.queueStart(target))
      .rejects.toMatchObject({ code: "queue.pending-overrides" });
  });

  it("clears pending selections only when the started Thread is current for its Conversation", () => {
    const modelClear = vi.fn();
    const planClear = vi.fn();
    const service = serviceWithQueue(queuePort([]), {
      router: {
        targetForThread: (threadId: string) =>
          threadId === binding.threadId || threadId === "background-thread"
            ? target
            : undefined,
      },
      models: { clear: modelClear },
      collaborationModes: { clear: planClear },
    });

    service.clearPendingSelectionsForThread(binding.threadId);
    service.clearPendingSelectionsForThread("background-thread");
    service.clearPendingSelectionsForThread("unbound-thread");

    expect(modelClear).toHaveBeenCalledTimes(1);
    expect(modelClear).toHaveBeenCalledWith(target);
    expect(planClear).toHaveBeenCalledTimes(1);
    expect(planClear).toHaveBeenCalledWith(target);
  });

  it("blocks backgrounding before a Turn while the native Queue is non-empty", async () => {
    const queue = queuePort([item(1)]);
    const service = serviceWithQueue(queue, {
      router: {
        newSession: vi.fn(async () => undefined),
      },
    });
    await expect(service.newSession(target)).rejects.toMatchObject({
      code: "conversation.background-queued",
    });
    expect(queue.listQueue).toHaveBeenCalledWith("thread-queue", { limit: 1 });
  });

  it("checks an idle current Thread before every binding-changing lifecycle action", async () => {
    const queue = queuePort([item(1)]);
    const newSession = vi.fn(async () => undefined);
    const service = serviceWithQueue(queue, {
      router: { newSession },
    });
    await expect(service.newSession(target)).rejects.toMatchObject({
      code: "conversation.background-queued",
    });
    expect(newSession).not.toHaveBeenCalled();

    const resume = vi.fn(async () => binding);
    const resumeService = serviceWithQueue(queue, {
      router: {
        list: async () => [{
          id: "other-thread",
          sessionId: "other-session",
          modelProvider: "openai",
          preview: "other",
          name: null,
          isPinned: false,
          status: { type: "idle" as const },
          cwd: "/workspace/main",
          source: "cli" as const,
          activeTurnId: null,
          historyMode: "paginated",
        }],
        resume,
      },
    });
    await expect(resumeService.resume(target, "other-thread")).rejects.toMatchObject({
      code: "conversation.background-queued",
    });
    expect(resume).not.toHaveBeenCalled();

    const selectWorkspace = vi.fn(async () => ({
      id: "other",
      name: "Other",
      cwd: "/workspace/other",
    }));
    const workspaceService = serviceWithQueue(queue, {
      router: {
        workspace: () => ({ id: "main", name: "Main", cwd: "/workspace/main" }),
        resolveWorkspace: () => ({ id: "other", name: "Other", cwd: "/workspace/other" }),
        selectWorkspace,
      },
    });
    await expect(workspaceService.selectWorkspace(target, "other"))
      .rejects.toMatchObject({ code: "conversation.background-queued" });
    expect(selectWorkspace).not.toHaveBeenCalled();

    const fork = vi.fn(async () => binding);
    const forkService = serviceWithQueue(queue, {
      router: {
        ensure: async () => binding,
        fork,
      },
    });
    await expect(forkService.fork(target)).rejects.toMatchObject({
      code: "conversation.background-queued",
    });
    expect(fork).not.toHaveBeenCalled();
  });

  it("does not restore old pending settings when resuming a Thread with a cold Queue", async () => {
    const queue = queuePort([]);
    queue.listQueue.mockImplementation(async (threadId: string) => threadId === "cold-thread"
      ? { items: [item(1)], nextCursor: null }
      : { items: [], nextCursor: null });
    const clear = vi.fn();
    const restorePreference = vi.fn();
    const resume = vi.fn(async () => ({
      ...binding,
      threadId: "cold-thread",
    }));
    const service = serviceWithQueue(queue, {
      router: {
        list: async () => [{
          id: "cold-thread",
          sessionId: "cold-session",
          modelProvider: "openai",
          preview: "cold queue",
          name: null,
          isPinned: false,
          status: { type: "idle" as const },
          cwd: "/workspace/main",
          source: "cli" as const,
          activeTurnId: null,
          historyMode: "paginated",
        }],
        resume,
      },
      models: {
        capturePreference: () => ({
          model: "old-model",
          modelProvider: "openai",
          effort: "high",
          serviceTier: "default",
        }),
        restorePreference,
        clear,
      },
    });

    await expect(service.resume(target, "cold-thread")).resolves.toEqual({
      threadId: "cold-thread",
      queuePending: true,
    });
    expect(resume).toHaveBeenCalledWith(target, "cold-thread");
    expect(clear).toHaveBeenCalledWith(target);
    expect(restorePreference).not.toHaveBeenCalled();
  });

  it("keeps a background binding when Queue or a follow-up Turn remains", async () => {
    const releaseBackground = vi.fn(async () => undefined);
    const queued = serviceWithQueue(queuePort([item(1)]), {
      router: {
        isBackgroundThread: () => true,
        releaseBackground,
      },
    });
    await expect(queued.releaseBackgroundIfComplete(binding.threadId))
      .resolves.toBe(false);
    expect(releaseBackground).not.toHaveBeenCalled();

    const active = serviceWithQueue(queuePort([]), {
      active: true,
      router: {
        isBackgroundThread: () => true,
        releaseBackground,
      },
    });
    await expect(active.releaseBackgroundIfComplete(binding.threadId))
      .resolves.toBe(false);
    expect(releaseBackground).not.toHaveBeenCalled();

    const released = serviceWithQueue(queuePort([]), {
      router: {
        isBackgroundThread: () => true,
        releaseBackground,
      },
    });
    await expect(released.releaseBackgroundIfComplete(binding.threadId))
      .resolves.toBe(true);
    expect(releaseBackground).toHaveBeenCalledWith(binding.threadId);
  });

  it("keeps a background binding while its parent Thread has a pending subagent run", async () => {
    const releaseBackground = vi.fn(async () => undefined);
    const service = serviceWithQueue(queuePort([]), {
      router: {
        isBackgroundThread: () => true,
        releaseBackground,
      },
      hasPendingSubagentRuns: (parentThreadId) => parentThreadId === binding.threadId,
    });

    await expect(service.releaseBackgroundIfComplete(binding.threadId))
      .resolves.toBe(false);
    expect(releaseBackground).not.toHaveBeenCalled();
  });

  it("retries a deferred background release after the last subagent run settles", async () => {
    let pending = true;
    const releaseBackground = vi.fn(async () => undefined);
    const service = serviceWithQueue(queuePort([]), {
      router: {
        isBackgroundThread: () => true,
        releaseBackground,
      },
      hasPendingSubagentRuns: () => pending,
    });

    await expect(service.releaseBackgroundIfComplete(binding.threadId))
      .resolves.toBe(false);
    pending = false;
    await expect(service.retryPendingBackgroundRelease(binding.threadId))
      .resolves.toBe(true);
    expect(releaseBackground).toHaveBeenCalledTimes(1);
  });

  it("uses native Queue start as the completion-release barrier", async () => {
    let resolveStart: ((result: { turnId: string }) => void) | undefined;
    const queue = queuePort([item(1)]);
    queue.startQueueItem.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStart = resolve;
    }));
    const releaseBackground = vi.fn(async () => undefined);
    const service = serviceWithQueue(queue, {
      router: {
        isBackgroundThread: () => true,
        releaseBackground,
      },
    });

    const release = service.releaseBackgroundIfComplete(binding.threadId);
    await Promise.resolve();
    expect(releaseBackground).not.toHaveBeenCalled();
    resolveStart?.({ turnId: "queued-turn" });
    await expect(release).resolves.toBe(false);
    expect(queue.startQueueItem).toHaveBeenCalledWith(binding.threadId);
    expect(releaseBackground).not.toHaveBeenCalled();
  });

  it("coalesces concurrent completion and idle-state background release attempts", async () => {
    let resolveStart: ((result: { turnId: string }) => void) | undefined;
    const queue = queuePort([item(1)]);
    queue.startQueueItem.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStart = resolve;
    }));
    const releaseBackground = vi.fn(async () => undefined);
    const service = serviceWithQueue(queue, {
      router: {
        isBackgroundThread: () => true,
        releaseBackground,
      },
    });

    const completionAttempt = service.releaseBackgroundIfComplete(binding.threadId);
    const idleAttempt = service.retryPendingBackgroundRelease(binding.threadId);
    await Promise.resolve();
    expect(queue.startQueueItem).toHaveBeenCalledTimes(1);
    resolveStart?.({ turnId: "queued-turn" });
    await expect(Promise.all([completionAttempt, idleAttempt]))
      .resolves.toEqual([false, false]);
    expect(queue.startQueueItem).toHaveBeenCalledTimes(1);
    expect(releaseBackground).not.toHaveBeenCalled();
  });

  it("keeps a pending release after a completion/start busy race and retries it on idle", async () => {
    const queue = queuePort([item(1)]);
    queue.startQueueItem.mockRejectedValueOnce(
      new Error("thread already has an active or pending turn"),
    );
    const releaseBackground = vi.fn(async () => undefined);
    const service = serviceWithQueue(queue, {
      router: {
        isBackgroundThread: () => true,
        releaseBackground,
        readThread: async () => ({ status: { type: "idle" } }) as never,
      },
    });

    await expect(service.releaseBackgroundIfComplete(binding.threadId)).resolves.toBe(false);
    expect(releaseBackground).not.toHaveBeenCalled();
    queue.items.splice(0, queue.items.length);
    await expect(service.retryPendingBackgroundRelease(binding.threadId)).resolves.toBe(true);
    expect(releaseBackground).toHaveBeenCalledWith(binding.threadId);
    expect(queue.startQueueItem).toHaveBeenCalledTimes(2);
  });

  it("fails closed when native Queue support is unavailable", async () => {
    const service = new ConversationService(
      turnPort(),
      { current: () => binding } as unknown as SessionRouter,
      { activeTurn: () => undefined } as unknown as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
    );
    await expect(service.queueList(target)).rejects.toMatchObject({
      code: "queue.unavailable",
    });

    const unavailable = queuePort([]);
    unavailable.listQueue.mockRejectedValue(
      new Error("user message queue is unavailable"),
    );
    const releaseBackground = vi.fn(async () => undefined);
    const lifecycle = serviceWithQueue(unavailable, {
      router: {
        isBackgroundThread: () => true,
        releaseBackground,
      },
    });
    await expect(lifecycle.queueList(target)).rejects.toMatchObject({
      code: "queue.unavailable",
    });
    await expect(lifecycle.releaseBackgroundIfComplete(binding.threadId))
      .resolves.toBe(true);
    expect(releaseBackground).toHaveBeenCalledWith(binding.threadId);
  });

  it("reports an empty Queue when start has no available item", async () => {
    const service = serviceWithQueue(queuePort([]));

    await expect(service.queueStart(target)).rejects.toMatchObject({
      code: "queue.empty",
      message: "App Server Queue 为空",
    });
  });
});
