import { describe, expect, it, vi } from "vitest";
import { ConversationIdleReleaser } from "../src/bootstrap/conversation-idle-releaser.js";

import {
  ConversationService,
  type ConversationQueryPort,
} from "../src/application/conversation-service.js";
import type { ConversationCore } from "../src/conversation-core/index.js";
import type { ConversationTransferPort } from "../src/application/conversation-service.js";
import type { SessionRouter } from "../src/session-routing/router.js";

const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
const binding = {
  target,
  workspaceId: "main",
  threadId: "thread-idle",
  sessionId: "session-idle",
};

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

function createService({
  activeTurn,
  hasQueue = false,
  pendingInteraction = false,
  pendingSubagent = false,
  capturePreference,
  restorePreference,
  modelClear,
  collaborationClear,
  status = { type: "idle" },
  newSession,
  routerOverrides = {},
  coreOverrides = {},
  queueList,
}: {
  activeTurn?: unknown;
  hasQueue?: boolean;
  pendingInteraction?: boolean;
  pendingSubagent?: boolean;
  capturePreference?: ReturnType<typeof vi.fn>;
  restorePreference?: ReturnType<typeof vi.fn>;
  modelClear?: ReturnType<typeof vi.fn>;
  collaborationClear?: ReturnType<typeof vi.fn>;
  status?: { type: "idle" | "active" | "notLoaded" | "systemError" };
  newSession: ReturnType<typeof vi.fn>;
  routerOverrides?: Record<string, unknown>;
  coreOverrides?: Record<string, unknown>;
  queueList?: ReturnType<typeof vi.fn>;
}): ConversationService {
  const router = {
    current: () => binding,
    readThread: async () => ({ status }),
    releaseIdle: newSession,
    idleState: () => ({ lastActivityAt: 1, forceNew: false }),
    touchActivity: vi.fn(),
    ...routerOverrides,
  } as unknown as SessionRouter;
  const transfers: ConversationTransferPort = {
    hasPendingInteraction: () => pendingInteraction,
    notifyTransferred: vi.fn(),
  };
  const models = {
    ...(capturePreference === undefined ? {} : { capturePreference }),
    ...(restorePreference === undefined ? {} : { restorePreference }),
    ...(modelClear === undefined ? {} : { clear: modelClear }),
  } as never;
  const collaborationModes = collaborationClear === undefined
    ? undefined
    : { clear: collaborationClear } as never;
  return new ConversationService(
    {} as never,
    router,
    { activeTurn: () => activeTurn, ...coreOverrides } as unknown as ConversationCore,
    models,
    queryPort(),
    undefined,
    collaborationModes,
    transfers,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      listQueue: queueList ?? (async () => ({
        items: hasQueue ? [{}] : [],
        nextCursor: null,
      })),
    } as never,
    undefined,
    pendingSubagent ? () => true : undefined,
  );
}

describe("ConversationService idle release", () => {
  it("does not unsubscribe in new scans while disconnect inspection is pending and authoritative reads fail", async () => {
    const releaseIdle = vi.fn(async () => true);
    const readThread = vi.fn(async () => { throw new Error("App Server disconnected"); });
    const restoreBinding = vi.fn();
    const service = createService({ newSession: releaseIdle, routerOverrides: { readThread } });
    const releaser = new ConversationIdleReleaser({
      logger: { info: vi.fn(), warn: vi.fn() } as never,
      idleThresholdMs: 10, nowMs: () => 100, listForegroundBindings: () => [binding],
      idleState: () => ({ lastActivityAt: 1, forceNew: false }), ensureIdleState: vi.fn(),
      // The asynchronous supervisor inspection has not marked this Provider as restoring yet.
      isBindingRestoring: () => false, restoreBinding,
      releaseIdle: (candidate, condition) => service.releaseIdle(candidate, condition), notifyReleased: vi.fn(),
    });
    releaser.cancelPending(new Set([binding.threadId]));
    await releaser.scan();
    await releaser.scan();
    expect(readThread).toHaveBeenCalledTimes(2);
    expect(releaseIdle).not.toHaveBeenCalled();
    expect(restoreBinding).not.toHaveBeenCalled();
    await releaser.stop();
  });

  it("rejects a scanned Thread replaced before the conversation lock is acquired", async () => {
    const releaseIdle = vi.fn(async () => true);
    let current = binding;
    const service = createService({ newSession: releaseIdle, routerOverrides: { current: () => current } });
    const releasing = service.releaseIdle(target);
    current = { ...binding, threadId: "replacement", sessionId: "replacement" };
    await expect(releasing).resolves.toEqual({ status: "busy", threadId: "replacement" });
    expect(releaseIdle).not.toHaveBeenCalled();
  });

  it.each(["activity", "disabled", "cancelled", "restoring", "interaction"])(
    "keeps the binding when %s changes during the authoritative read",
    async (change) => {
      let finishRead!: () => void;
      let at = 1;
      let restoring = false;
      let interaction = false;
      const controller = new AbortController();
      const releaseIdle = vi.fn(async () => true);
      const readThread = vi.fn(async () => {
        await new Promise<void>(resolve => { finishRead = resolve; });
        return { status: { type: "idle" } };
      });
      const service = createService({
        newSession: releaseIdle,
        routerOverrides: { readThread, idleState: () => ({ lastActivityAt: at, forceNew: false }) },
        coreOverrides: { activeTurn: () => interaction ? { threadId: binding.threadId } : undefined },
      });
      const releasing = service.releaseIdle(target, {
        threadId: binding.threadId, lastActivityAt: 1, signal: controller.signal,
        isCurrent: () => !restoring, canRestore: () => !restoring,
      });
      await vi.waitFor(() => expect(readThread).toHaveBeenCalled());
      if (change === "activity") at = 2;
      if (change === "disabled") { service.setIdleReleaseEnabled(false); service.setIdleReleaseEnabled(true); }
      if (change === "cancelled") controller.abort();
      if (change === "restoring") restoring = true;
      if (change === "interaction") interaction = true;
      finishRead();
      await expect(releasing).resolves.toEqual({ status: "busy", threadId: binding.threadId });
      expect(releaseIdle).not.toHaveBeenCalled();
    },
  );

  it("asks the existing recovery owner to restore an unsuccessful subscription cleanup", async () => {
    const restoreRequired = vi.fn();
    const service = createService({ newSession: vi.fn(async () => { throw new Error("restore unavailable"); }) });
    await expect(service.releaseIdle(target, {
      threadId: binding.threadId, lastActivityAt: 1, signal: new AbortController().signal,
      isCurrent: () => true, canRestore: () => true, restoreRequired,
    })).resolves.toMatchObject({ status: "busy" });
    expect(restoreRequired).toHaveBeenCalledOnce();
  });

  it.each(["queue", "active"])("rechecks native %s state after the unsubscribe boundary", async change => {
    const readThread = vi.fn()
      .mockResolvedValueOnce({ status: { type: "idle" } })
      .mockResolvedValue({ status: { type: change === "active" ? "active" : "idle" } });
    const queueList = vi.fn()
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockResolvedValue({ items: change === "queue" ? [{}] : [], nextCursor: null });
    const releaseIdle = vi.fn(async (_target, _binding, _snapshot, condition) => condition.verifyIdle());
    const service = createService({ newSession: releaseIdle, routerOverrides: { readThread }, queueList });
    await expect(service.releaseIdle(target)).resolves.toEqual({ status: "busy", threadId: binding.threadId });
    expect(queueList).toHaveBeenCalledTimes(2);
  });

  it("releases an idle foreground binding through the router", async () => {
    const newSession = vi.fn(async () => true);
    const service = createService({ newSession });

    await expect(service.releaseIdle(target)).resolves.toEqual({
      status: "released",
      threadId: binding.threadId,
    });
    expect(newSession).toHaveBeenCalledWith(target, binding, expect.objectContaining({ status: { type: "idle" } }), expect.objectContaining({ isCurrent: expect.any(Function) }), undefined);
  });

  it("restores model preference and clears pending collaboration after idle release", async () => {
    const preference = {
      model: "gpt-deep",
      modelProvider: "openai",
      effort: "high",
      serviceTier: "default",
    };
    const capturePreference = vi.fn(() => preference);
    const restorePreference = vi.fn();
    const modelClear = vi.fn();
    const collaborationClear = vi.fn();
    const newSession = vi.fn(async () => true);
    const service = createService({
      capturePreference,
      restorePreference,
      modelClear,
      collaborationClear,
      newSession,
    });

    await service.releaseIdle(target);

    expect(capturePreference).toHaveBeenCalledWith(target);
    expect(restorePreference).toHaveBeenCalledWith(target, preference);
    expect(collaborationClear).toHaveBeenCalledWith(target);
    expect(modelClear).not.toHaveBeenCalled();
  });

  it("does not release a busy Thread or one with a queue/pending interaction", async () => {
    const newSession = vi.fn();
    const activeService = createService({ activeTurn: { threadId: binding.threadId }, newSession });
    await expect(activeService.releaseIdle(target)).resolves.toEqual({
      status: "busy",
      threadId: binding.threadId,
    });
    expect(newSession).not.toHaveBeenCalled();

    const queueService = createService({ hasQueue: true, newSession });
    await expect(queueService.releaseIdle(target)).resolves.toEqual({
      status: "busy",
      threadId: binding.threadId,
    });
    expect(newSession).not.toHaveBeenCalled();

    const pendingService = createService({ pendingInteraction: true, newSession });
    await expect(pendingService.releaseIdle(target)).resolves.toEqual({
      status: "busy",
      threadId: binding.threadId,
    });
    expect(newSession).not.toHaveBeenCalled();

    const subagentService = createService({ pendingSubagent: true, newSession });
    await expect(subagentService.releaseIdle(target)).resolves.toEqual({
      status: "busy",
      threadId: binding.threadId,
    });
    expect(newSession).not.toHaveBeenCalled();
  });
});
