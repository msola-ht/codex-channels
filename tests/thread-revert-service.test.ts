import { describe, expect, it, vi } from "vitest";

import {
  ConversationService,
  type ThreadHistoryPort,
} from "../src/application/index.js";
import type { ModelSelectionService } from "../src/application/model-selection-service.js";
import type { ThreadQueuePort } from "../src/application/thread-queue-port.js";
import type { ThreadTurnSummary } from "../src/application/thread-history-port.js";
import type { ConversationQueryPort } from "../src/application/conversation-service.js";
import type { TurnExecutionPort } from "../src/application/turn-port.js";
import type { ConversationCore } from "../src/conversation-core/index.js";
import type { ConversationTarget } from "../src/conversation-core/index.js";
import type { SessionRouter, ThreadSnapshot } from "../src/session-routing/index.js";

const target: ConversationTarget = {
  surface: "telegram",
  accountId: "account-1",
  conversationId: "conversation-1",
};

const threadId = "thread-paginated";
const queueFingerprint = "a".repeat(64);

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

function snapshot(historyMode: ThreadSnapshot["historyMode"] = "paginated"): ThreadSnapshot {
  return {
    id: threadId,
    sessionId: "session-1",
    modelProvider: "openai",
    preview: "Revert test",
    name: null,
    isPinned: false,
    section: null,
    status: { type: "idle" },
    cwd: "/workspace",
    source: "appServer",
    historyMode,
    activeTurnId: null,
  };
}

function turnSummary(id: string, textPreview = id): ThreadTurnSummary {
  return {
    id,
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    durationMs: 1_000,
    inputType: "text",
    textPreview,
  };
}

function makeService(options: {
  historyMode?: ThreadSnapshot["historyMode"];
  turns?: ThreadTurnSummary[];
  activeTurnId?: string | null;
  queue?: ThreadQueuePort;
} = {}): {
  service: ConversationService;
  history: ThreadHistoryPort & {
    listThreadTurns: ReturnType<typeof vi.fn>;
    revertThread: ReturnType<typeof vi.fn>;
  };
  router: {
    current: ReturnType<typeof vi.fn>;
    readThread: ReturnType<typeof vi.fn>;
    newSession: ReturnType<typeof vi.fn>;
  };
  queue: ThreadQueuePort;
  sourceTurns: ThreadTurnSummary[];
} {
  const sourceTurns = options.turns ?? [
    turnSummary("turn-3", "third"),
    turnSummary("turn-2", "second"),
    turnSummary("turn-1", "first"),
  ];
  const thread = snapshot(options.historyMode);
  thread.activeTurnId = options.activeTurnId ?? null;
  const router = {
    current: vi.fn(() => ({
      target,
      workspaceId: "workspace-1",
      threadId,
      sessionId: "session-1",
    })),
    readThread: vi.fn(async () => ({ ...thread })),
    newSession: vi.fn(async () => undefined),
  };
  const queue = options.queue ?? {
    addQueueItem: vi.fn(),
    listQueue: vi.fn(async () => ({ items: [], nextCursor: null, fingerprint: queueFingerprint })),
    updateQueueItem: vi.fn(),
    deleteQueueItem: vi.fn(),
    reorderQueue: vi.fn(),
    startQueueItem: vi.fn(),
  } satisfies ThreadQueuePort;
  const history = {
    listThreadTurns: vi.fn(async (_id: string, request?: { cursor?: string | null }) => ({
      turns: sourceTurns.map((turn) => ({ ...turn })),
      nextCursor: request?.cursor ? null : null,
    })),
    revertThread: vi.fn(async () => ({
      thread: snapshot(options.historyMode),
    })),
  } satisfies ThreadHistoryPort;
  const service = new ConversationService(
    turnPort(),
    router as unknown as SessionRouter,
    { activeTurn: vi.fn(() => undefined) } as unknown as ConversationCore,
    {} as ModelSelectionService,
    queryPort(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { pluginApiEnabled: false },
    undefined,
    queue,
    history,
  );
  return { service, history, router, queue, sourceTurns };
}

describe("ConversationService Thread Revert", () => {
  it("lists a bounded paginated page and requires that page for full-ID selection", async () => {
    const { service, history } = makeService();

    await expect(service.revertList(target)).resolves.toMatchObject({
      threadId,
      selectors: ["1", "2", "3"],
      page: 1,
      hasNextPage: false,
    });
    expect(history.listThreadTurns).toHaveBeenCalledWith(threadId, {
      cursor: null,
      limit: 25,
      sortDirection: "desc",
    });

    await expect(service.revertPreview(target, "turn-2", "actor-1"))
      .resolves.toMatchObject({ beforeTurnId: "turn-2" });
    expect(history.listThreadTurns).toHaveBeenCalledTimes(2);

    const noSnapshot = makeService();
    await expect(noSnapshot.service.revertPreview(target, "turn-2", "actor-1"))
      .rejects.toMatchObject({ code: "revert.snapshot-required" });
    expect(noSnapshot.history.listThreadTurns).not.toHaveBeenCalled();
  });

  it("rejects legacy Threads before reading or writing paginated history", async () => {
    const { service, history } = makeService({ historyMode: "legacy" });

    await expect(service.revertList(target)).rejects.toMatchObject({
      code: "revert.legacy-thread",
    });
    expect(history.listThreadTurns).not.toHaveBeenCalled();
  });

  it("maps an unmaterialized paginated Thread to an actionable empty-history error", async () => {
    const { service, history } = makeService();
    history.listThreadTurns.mockRejectedValueOnce(
      new Error("thread is not materialized yet; thread/turns/list is unavailable before first user message"),
    );

    await expect(service.revertList(target)).rejects.toMatchObject({
      code: "revert.empty-history",
      message: "当前 Thread 还没有可回退的 Turn",
    });
  });

  it("requires a fingerprinted Queue snapshot and consumes confirmation once", async () => {
    const { service, history } = makeService();
    await service.revertList(target);
    const preview = await service.revertPreview(target, "1", "actor-1");
    await expect(service.revertConfirm(target, preview.token, "actor-1")).resolves.toEqual({
      threadId,
      beforeTurnId: "turn-3",
    });
    expect(history.revertThread).toHaveBeenCalledOnce();
    await expect(service.revertConfirm(target, preview.token, "actor-1"))
      .rejects.toMatchObject({ code: "revert.confirmation-invalid" });
  });

  it("preserves a non-empty Queue after its full fingerprint is confirmed", async () => {
    const queue = {
      listQueue: vi.fn(async () => ({
        items: [{
          id: "queued-1",
          clientUserMessageId: "client-queued-1",
          inputType: "text" as const,
          textPreview: "pending",
          editable: true,
        }],
        nextCursor: null,
        fingerprint: queueFingerprint,
      })),
    } as unknown as ThreadQueuePort;
    const { service, history } = makeService({ queue });
    await service.revertList(target);

    const preview = await service.revertPreview(target, "1", "actor-1");
    expect(preview.queueItemCount).toBe(1);
    await expect(service.revertConfirm(target, preview.token, "actor-1")).resolves.toEqual({
      threadId,
      beforeTurnId: "turn-3",
    });
    expect(history.revertThread).toHaveBeenCalledOnce();
  });

  it("invalidates a token when the latest history changes before confirmation", async () => {
    const { service, history, sourceTurns } = makeService();
    await service.revertList(target);
    const preview = await service.revertPreview(target, "1", "actor-1");
    sourceTurns[0] = turnSummary("turn-new", "newest");

    await expect(service.revertConfirm(target, preview.token, "actor-1"))
      .rejects.toMatchObject({ code: "revert.concurrent" });
    expect(history.revertThread).not.toHaveBeenCalled();
  });

  it("invalidates a token when Queue contents change before confirmation", async () => {
    let fingerprint = queueFingerprint;
    const queue = {
      listQueue: vi.fn(async () => ({
        items: [],
        nextCursor: null,
        fingerprint,
      })),
    } as unknown as ThreadQueuePort;
    const { service, history } = makeService({ queue });
    await service.revertList(target);
    const preview = await service.revertPreview(target, "1", "actor-1");
    fingerprint = "b".repeat(64);

    await expect(service.revertConfirm(target, preview.token, "actor-1"))
      .rejects.toMatchObject({ code: "revert.concurrent" });
    expect(history.revertThread).not.toHaveBeenCalled();
  });

  it("rejects a preview when the latest history changed after listing", async () => {
    const { service, history, sourceTurns } = makeService();
    await service.revertList(target);
    sourceTurns.unshift(turnSummary("turn-new", "newest"));

    await expect(service.revertPreview(target, "turn-2", "actor-1"))
      .rejects.toMatchObject({ code: "revert.concurrent" });
    expect(history.revertThread).not.toHaveBeenCalled();
  });

  it("binds confirmation to the current Thread and Workspace", async () => {
    const { service, history, router } = makeService();
    await service.revertList(target);
    const preview = await service.revertPreview(target, "1", "actor-1");
    router.current.mockReturnValue({
      target,
      workspaceId: "workspace-2",
      threadId: "thread-other",
      sessionId: "session-other",
    });

    await expect(service.revertConfirm(target, preview.token, "actor-1"))
      .rejects.toMatchObject({ code: "revert.confirmation-invalid" });
    expect(history.revertThread).not.toHaveBeenCalled();
  });

  it("invalidates an older confirmation when a new list replaces its snapshot", async () => {
    const { service, history } = makeService();
    await service.revertList(target);
    const preview = await service.revertPreview(target, "1", "actor-1");
    await service.revertList(target);

    await expect(service.revertConfirm(target, preview.token, "actor-1"))
      .rejects.toMatchObject({ code: "revert.confirmation-invalid" });
    expect(history.revertThread).not.toHaveBeenCalled();
  });

  it("invalidates confirmation when the Conversation starts a new session", async () => {
    const { service, history, router } = makeService();
    await service.revertList(target);
    const preview = await service.revertPreview(target, "1", "actor-1");

    await service.newSession(target);

    expect(router.newSession).toHaveBeenCalledOnce();
    await expect(service.revertConfirm(target, preview.token, "actor-1"))
      .rejects.toMatchObject({ code: "revert.confirmation-invalid" });
    expect(history.revertThread).not.toHaveBeenCalled();
  });

  it("reports an unknown write outcome without retrying the destructive request", async () => {
    const { service, history } = makeService();
    await service.revertList(target);
    const preview = await service.revertPreview(target, "1", "actor-1");
    history.revertThread.mockRejectedValueOnce(new Error("connection closed after request"));

    await expect(service.revertConfirm(target, preview.token, "actor-1"))
      .rejects.toMatchObject({ code: "revert.result-unknown" });
    expect(history.revertThread).toHaveBeenCalledOnce();
    await expect(service.revertConfirm(target, preview.token, "actor-1"))
      .rejects.toMatchObject({ code: "revert.confirmation-invalid" });
    expect(history.revertThread).toHaveBeenCalledOnce();
  });
});
