import { describe, expect, it, vi } from "vitest";

import {
  ConversationService,
  type ConversationQueryPort,
} from "../src/application/conversation-service.js";
import type { ModelSelectionService } from "../src/application/model-selection-service.js";
import type { TurnExecutionPort } from "../src/application/turn-port.js";
import type { ThreadQueuePort } from "../src/application/thread-queue-port.js";
import type { ThreadHistoryPort } from "../src/application/thread-history-port.js";
import {
  ConversationCore,
} from "../src/conversation-core/index.js";
import type { SessionDisplayCachePort } from "../src/conversation-core/index.js";
import type { SessionRouter } from "../src/session-routing/router.js";

const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
const main = { id: "main", name: "Main", cwd: "/workspace/main" };
const other = { id: "other", name: "Other", cwd: "/workspace/other" };

function turnPort(overrides: Partial<TurnExecutionPort> = {}): TurnExecutionPort {
  const unsupported = async (): Promise<never> => {
    throw new Error("测试未配置 TurnExecutionPort 方法");
  };
  return {
    startTurn: unsupported,
    steerTurn: unsupported,
    interruptTurn: unsupported,
    setThreadName: unsupported,
    setThreadPinned: unsupported,
    compactThread: unsupported,
    startReview: unsupported,
    getGoal: unsupported,
    setGoal: unsupported,
    clearGoal: unsupported,
    ...overrides,
  };
}

function queryPort(overrides: Partial<ConversationQueryPort> = {}): ConversationQueryPort {
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
    ...overrides,
  };
}

describe("ConversationService conversation service session", () => {
  it("takes over an idle Thread and notifies the previous channel", async () => {
    const previousTarget = {
      surface: "feishu" as const,
      accountId: "tenant-a",
      conversationId: "chat-a",
    };
    const destinationBinding = {
      target,
      workspaceId: "main",
      threadId: "thread-destination",
      sessionId: "session-destination",
    };
    const previousOwner = {
      target: previousTarget,
      workspaceId: "main",
      threadId: "thread-shared",
      sessionId: "session-shared",
    };
    const transferredBinding = {
      ...previousOwner,
      target,
    };
    const transferBinding = vi.fn(async () => ({
      binding: transferredBinding,
      previousOwner,
      replaced: destinationBinding,
    }));
    const clear = vi.fn();
    const notifyTransferred = vi.fn();
    const router = {
      list: async () => [{
        id: "thread-shared",
        sessionId: "session-shared",
        modelProvider: "openai",
        preview: "共享会话",
        name: null,
        isPinned: false,
        status: { type: "idle" as const },
        cwd: main.cwd,
        source: "cli" as const,
        activeTurnId: null,
      }],
      targetForThread: () => previousTarget,
      current: (candidate: typeof target | typeof previousTarget) =>
        candidate.surface === "telegram" ? destinationBinding : previousOwner,
      transferBinding,
    } as unknown as SessionRouter;
    const service = new ConversationService(
      turnPort(),
      router,
      { activeTurn: () => undefined } as unknown as ConversationCore,
      { clear } as unknown as ModelSelectionService,
      queryPort(),
      undefined,
      undefined,
      undefined,
      {
        hasPendingInteraction: () => false,
        notifyTransferred,
      },
    );

    await expect(service.resume(target, "thread-shared")).resolves.toEqual({
      threadId: "thread-shared",
      transferredFrom: "feishu",
    });
    expect(transferBinding).toHaveBeenCalledWith(target, "thread-shared");
    expect(clear).toHaveBeenCalledWith(previousTarget);
    expect(clear).toHaveBeenCalledWith(target);
    expect(notifyTransferred).toHaveBeenCalledWith({
      previousTarget,
      nextTarget: target,
      threadId: "thread-shared",
    });
  });

  it("does not take over a Thread with a pending interaction", async () => {
    const previousTarget = {
      surface: "weixin" as const,
      accountId: "bot-a",
      conversationId: "user-a",
    };
    const transferBinding = vi.fn();
    const service = new ConversationService(
      turnPort(),
      {
        list: async () => [{
          id: "thread-shared",
          sessionId: "session-shared",
          modelProvider: "openai",
          preview: "共享会话",
          name: null,
          isPinned: false,
          status: { type: "idle" as const },
          cwd: main.cwd,
          source: "cli" as const,
          activeTurnId: null,
        }],
        targetForThread: () => previousTarget,
        current: () => undefined,
        transferBinding,
      } as unknown as SessionRouter,
      { activeTurn: () => undefined } as unknown as ConversationCore,
      { clear: vi.fn() } as unknown as ModelSelectionService,
      queryPort(),
      undefined,
      undefined,
      undefined,
      {
        hasPendingInteraction: () => true,
        notifyTransferred: vi.fn(),
      },
    );

    await expect(service.resume(target, "thread-shared"))
      .rejects.toMatchObject({ code: "thread.takeover.busy" });
    expect(transferBinding).not.toHaveBeenCalled();
  });

  it("does not take over a Thread while its native Queue is non-empty", async () => {
    const previousTarget = {
      surface: "feishu" as const,
      accountId: "tenant-a",
      conversationId: "chat-a",
    };
    const transferBinding = vi.fn();
    const listQueue = vi.fn(async () => ({
      items: [{
        id: "queued-1",
        clientUserMessageId: "client-1",
        inputType: "text" as const,
        textPreview: "queued",
        editable: true,
      }],
      nextCursor: null,
    }));
    const service = new ConversationService(
      turnPort(),
      {
        list: async () => [{
          id: "thread-shared",
          sessionId: "session-shared",
          modelProvider: "openai",
          preview: "共享会话",
          name: null,
          isPinned: false,
          status: { type: "idle" as const },
          cwd: main.cwd,
          source: "cli" as const,
          activeTurnId: null,
        }],
        targetForThread: () => previousTarget,
        current: () => undefined,
        transferBinding,
      } as unknown as SessionRouter,
      {
        activeTurn: () => undefined,
      } as unknown as ConversationCore,
      { clear: vi.fn() } as unknown as ModelSelectionService,
      queryPort(),
      undefined,
      undefined,
      undefined,
      {
        hasPendingInteraction: () => false,
        notifyTransferred: vi.fn(),
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { listQueue } as unknown as ThreadQueuePort,
    );

    await expect(service.resume(target, "thread-shared"))
      .rejects.toMatchObject({ code: "thread.takeover.busy" });
    expect(transferBinding).not.toHaveBeenCalled();
    expect(listQueue).toHaveBeenCalledWith("thread-shared", { limit: 1 });
  });

  it("does not automatically take over another Conversation on the same Surface", async () => {
    const sameSurfaceOwner = {
      surface: "telegram" as const,
      accountId: "default",
      conversationId: "200",
    };
    const transferBinding = vi.fn();
    const service = new ConversationService(
      turnPort(),
      {
        list: async () => [{
          id: "thread-shared",
          sessionId: "session-shared",
          modelProvider: "openai",
          preview: "共享会话",
          name: null,
          isPinned: false,
          status: { type: "idle" as const },
          cwd: main.cwd,
          source: "cli" as const,
          activeTurnId: null,
        }],
        targetForThread: () => sameSurfaceOwner,
        transferBinding,
      } as unknown as SessionRouter,
      { activeTurn: () => undefined } as unknown as ConversationCore,
      { clear: vi.fn() } as unknown as ModelSelectionService,
      queryPort(),
    );

    await expect(service.resume(target, "thread-shared"))
      .rejects.toMatchObject({ code: "thread.bound" });
    expect(transferBinding).not.toHaveBeenCalled();
  });

  it("keeps pinned sessions first without changing order inside each group", async () => {
    const preference = {
      model: "gpt-deep",
      modelProvider: "openai",
      effort: "high",
      serviceTier: "default",
    };
    const capturePreference = vi.fn(() => preference);
    const restorePreference = vi.fn();
    const resume = vi.fn(async (resumeTarget, threadId: string) => ({
      target: resumeTarget,
      workspaceId: "main",
      threadId,
      sessionId: `session-${threadId}`,
    }));
    const service = new ConversationService(
      turnPort(),
      {
        list: async () => [
          {
            id: "recent",
            sessionId: "session-recent",
            modelProvider: "openai",
            preview: "最近",
            name: null,
            isPinned: false,
            status: { type: "idle" as const },
            cwd: main.cwd,
            source: "cli" as const,
            activeTurnId: null,
          },
          {
            id: "pinned-old",
            sessionId: "session-pinned-old",
            modelProvider: "openai",
            preview: "固定较早",
            name: null,
            isPinned: true,
            status: { type: "idle" as const },
            cwd: main.cwd,
            source: "cli" as const,
            activeTurnId: null,
          },
          {
            id: "pinned-new",
            sessionId: "session-pinned-new",
            modelProvider: "openai",
            preview: "固定较新",
            name: null,
            isPinned: true,
            status: { type: "idle" as const },
            cwd: main.cwd,
            source: "cli" as const,
            activeTurnId: null,
          },
        ],
        resume,
        targetForThread: () => undefined,
        modelSettingsForThread: () => undefined,
      } as unknown as SessionRouter,
      { activeTurn: () => undefined } as unknown as ConversationCore,
      { capturePreference, restorePreference } as unknown as ModelSelectionService,
      queryPort(),
    );

    await expect(service.listSessions(target)).resolves.toEqual([
      expect.objectContaining({ id: "pinned-old", isPinned: true }),
      expect.objectContaining({ id: "pinned-new", isPinned: true }),
      expect.objectContaining({ id: "recent", isPinned: false }),
    ]);
    await expect(service.resume(target, "1")).resolves.toEqual({
      threadId: "pinned-old",
    });
    expect(resume).toHaveBeenCalledWith(target, "pinned-old");
    expect(restorePreference).toHaveBeenCalledWith(target, preference);
  });

  it("moves the active Thread to the background when resuming another session", async () => {
    const resume = vi.fn(async (resumeTarget, threadId: string) => ({
      target: resumeTarget,
      workspaceId: "main",
      threadId,
      sessionId: `session-${threadId}`,
    }));
    const service = new ConversationService(
      turnPort(),
      {
        list: async () => [{
          id: "selected",
          sessionId: "session-selected",
          modelProvider: "openai",
          preview: "另一个会话",
          name: null,
          isPinned: false,
          status: { type: "idle" as const },
          cwd: main.cwd,
          source: "cli" as const,
          activeTurnId: null,
        }],
        current: () => ({
          target,
          workspaceId: "main",
          threadId: "running",
          sessionId: "session-running",
        }),
        targetForThread: () => undefined,
        backgroundBindings: () => [],
        isBackgroundThread: () => false,
        modelSettingsForThread: () => undefined,
        resume,
      } as unknown as SessionRouter,
      {
        activeTurn: () => ({ target, threadId: "running", turnId: "turn-running" }),
      } as unknown as ConversationCore,
      { clear: vi.fn() } as unknown as ModelSelectionService,
      queryPort(),
    );

    await expect(service.resume(target, "selected")).resolves.toEqual({
      threadId: "selected",
      backgroundedThreadId: "running",
    });
    expect(resume).toHaveBeenCalledWith(target, "selected", true);
  });

  it("annotates sessions with the model and effort the router knows", async () => {
    const service = new ConversationService(
      turnPort(),
      {
        list: async () => [{
          id: "known-model",
          sessionId: "session-known",
          modelProvider: "openai",
          preview: "已知模型",
          name: null,
          isPinned: false,
          status: { type: "idle" as const },
          cwd: main.cwd,
          source: "cli" as const,
          activeTurnId: null,
        }, {
          id: "unknown-model",
          sessionId: "session-unknown",
          modelProvider: "openai",
          preview: "未知模型",
          name: null,
          isPinned: false,
          status: { type: "idle" as const },
          cwd: main.cwd,
          source: "cli" as const,
          activeTurnId: null,
        }],
        modelSettingsForThread: (threadId: string) =>
          threadId === "known-model"
            ? { model: "gpt-test", effort: "high", serviceTier: null, collaborationMode: "default" }
            : undefined,
      } as unknown as SessionRouter,
      { activeTurn: () => undefined } as unknown as ConversationCore,
      { clear: vi.fn() } as unknown as ModelSelectionService,
      queryPort(),
    );

    await expect(service.listSessions(target)).resolves.toEqual([
      { selector: "1", id: "known-model", preview: "已知模型", name: null, isPinned: false, modelProvider: "openai", status: { type: "idle" }, model: "gpt-test", reasoningEffort: "high" },
      { selector: "2", id: "unknown-model", preview: "未知模型", name: null, isPinned: false, modelProvider: "openai", status: { type: "idle" } },
    ]);
  });

  it("annotates the visible session page with official turn counts", async () => {
    const service = new ConversationService(
      turnPort(),
      {
        list: async () => [
          {
            id: "thread-a",
            sessionId: "session-a",
            modelProvider: "openai",
            preview: "会话 A",
            name: null,
            isPinned: false,
            status: { type: "idle" as const },
            cwd: main.cwd,
            source: "cli" as const,
            activeTurnId: null,
          },
          {
            id: "thread-b",
            sessionId: "session-b",
            modelProvider: "openai",
            preview: "会话 B",
            name: null,
            isPinned: false,
            status: { type: "idle" as const },
            cwd: main.cwd,
            source: "cli" as const,
            activeTurnId: null,
          },
        ],
        modelSettingsForThread: () => undefined,
      } as unknown as SessionRouter,
      { activeTurn: () => undefined } as unknown as ConversationCore,
      { clear: vi.fn() } as unknown as ModelSelectionService,
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
      undefined,
      undefined,
      undefined,
      {
        listThreadTurns: vi.fn(async (threadId: string) => ({
          turns: Array.from({ length: threadId === "thread-a" ? 2 : 4 }, (_, index) => ({
            id: `${threadId}-turn-${index + 1}`,
            status: "completed" as const,
            startedAt: null,
            completedAt: null,
            durationMs: null,
            inputType: "text" as const,
            textPreview: null,
          })),
          nextCursor: null,
        })),
      } as unknown as ThreadHistoryPort,
    );

    await expect(service.listSessions(target, { page: 1 })).resolves.toEqual([
      expect.objectContaining({ id: "thread-a", turnCount: 2 }),
      expect.objectContaining({ id: "thread-b", turnCount: 4 }),
    ]);
  });

  it("filters sessions locally while preserving selectors from the full list", async () => {
    const list = vi.fn(async () => {
      const threads = [{
        id: "other",
        sessionId: "session-other",
        modelProvider: "openai",
        preview: "其他",
        name: null,
        isPinned: false,
        section: null,
        status: { type: "idle" as const },
        cwd: main.cwd,
        source: "cli" as const,
        activeTurnId: null,
      }, {
        id: "matched",
        sessionId: "session-matched",
        modelProvider: "deepseek",
        preview: "处理项目故障",
        name: "项目修复",
        isPinned: false,
        section: null,
        status: { type: "active" as const },
        cwd: main.cwd,
        source: "cli" as const,
        activeTurnId: "turn-1",
      }];
      return threads;
    });
    const service = new ConversationService(
      turnPort(),
      {
        list,
        modelSettingsForThread: () => undefined,
      } as unknown as SessionRouter,
      { activeTurn: () => undefined } as unknown as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
    );

    await expect(service.listSessions(target, {
      filter: "running",
      provider: "deepseek",
      searchTerm: "修复",
    })).resolves.toEqual([expect.objectContaining({
      id: "matched",
      selector: "2",
      modelProvider: "deepseek",
    })]);
    expect(list).toHaveBeenCalledWith(target, { fullScan: true });
    expect(list).toHaveBeenCalledWith(target, {
      fullScan: true,
      searchTerm: "修复",
    });

    list.mockClear();
    await service.listSessions(target, { provider: "deepseek" });
    expect(list).toHaveBeenCalledWith(target, { fullScan: true });
  });

  it("keeps pending settings when selecting the same workspace", async () => {
    const capturePreference = vi.fn();
    const restorePreference = vi.fn();
    const service = workspaceService(main, async () => main, {
      capturePreference,
      restorePreference,
    });

    await service.selectWorkspace(target, "main");

    expect(capturePreference).not.toHaveBeenCalled();
    expect(restorePreference).not.toHaveBeenCalled();
  });

  it("retains the current channel model when starting a new session", async () => {
    const preference = {
      model: "gpt-deep",
      modelProvider: "openai",
      effort: "high",
      serviceTier: "default",
    };
    const capturePreference = vi.fn(() => preference);
    const restorePreference = vi.fn();
    const newSession = vi.fn(async () => undefined);
    const service = new ConversationService(
      turnPort(),
      {
        newSession,
        backgroundBindings: () => [],
      } as unknown as SessionRouter,
      { activeTurn: () => undefined } as unknown as ConversationCore,
      { capturePreference, restorePreference } as unknown as ModelSelectionService,
      queryPort(),
    );

    await service.newSession(target);

    expect(newSession).toHaveBeenCalledWith(target, false);
    expect(restorePreference).toHaveBeenCalledWith(target, preference);
  });

  it("restores the current channel model only after a workspace switch succeeds", async () => {
    const preference = {
      model: "gpt-deep",
      modelProvider: "openai",
      effort: "high",
      serviceTier: "default",
    };
    const capturePreference = vi.fn(() => preference);
    const restorePreference = vi.fn();
    const successful = workspaceService(main, async () => other, {
      capturePreference,
      restorePreference,
    });

    await successful.selectWorkspace(target, "other");
    expect(capturePreference).toHaveBeenCalledWith(target);
    expect(restorePreference).toHaveBeenCalledWith(target, preference);

    capturePreference.mockClear();
    restorePreference.mockClear();
    const failed = workspaceService(main, async () => {
      throw new Error("switch failed");
    }, { capturePreference, restorePreference });
    await expect(failed.selectWorkspace(target, "other")).rejects.toThrow("switch failed");
    expect(capturePreference).toHaveBeenCalledWith(target);
    expect(restorePreference).not.toHaveBeenCalled();
  });


  it("reuses a recent cached turn count for session listing", async () => {
    const listThreadTurns = vi.fn(async () => ({
      turns: [{ id: "turn-1", status: "completed" as const, startedAt: null, completedAt: null, durationMs: null, inputType: "text" as const, textPreview: null }],
      nextCursor: null,
    }));
    const cache = new Map<string, Record<string, unknown>>();
    const sessionDisplayCache = {
      get: (id: string) => cache.get(id),
      put: (entry: Record<string, unknown>) => cache.set(String(entry.threadId), entry),
      invalidateTurnCount: vi.fn(),
      remove: vi.fn(),
    };
    const router = {
      list: async () => [{ id: "thread-cached", sessionId: "s", modelProvider: "openai", preview: "缓存", name: null, isPinned: false, status: { type: "idle" as const }, cwd: main.cwd, source: "cli" as const, activeTurnId: null }],
      workspace: () => main,
      modelSettingsForThread: () => undefined,
    } as unknown as SessionRouter;
    const history = { listThreadTurns } as unknown as ThreadHistoryPort;
    const service = new ConversationService(
      turnPort(), router, { activeTurn: () => undefined } as unknown as ConversationCore,
      {} as ModelSelectionService, queryPort(),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, history, undefined, undefined,
      sessionDisplayCache as unknown as import("../src/conversation-core/index.js").SessionDisplayCachePort,
    );

    await expect(service.listSessions(target, { page: 1 })).resolves.toEqual([
      expect.objectContaining({ id: "thread-cached", turnCount: 1 }),
    ]);
    await expect(service.listSessions(target, { page: 1, turnCountMode: "cached" })).resolves.toEqual([
      expect.objectContaining({ id: "thread-cached", turnCount: 1 }),
    ]);
    expect(listThreadTurns).toHaveBeenCalledTimes(1);
  });

  it("refreshes an invalidated session count after a completed Turn", async () => {
    const listThreadTurns = vi.fn(async () => ({
      turns: [
        { id: "turn-1", status: "completed" as const, startedAt: null, completedAt: null, durationMs: null, inputType: "text" as const, textPreview: null },
        { id: "turn-2", status: "completed" as const, startedAt: null, completedAt: null, durationMs: null, inputType: "text" as const, textPreview: null },
        { id: "turn-3", status: "completed" as const, startedAt: null, completedAt: null, durationMs: null, inputType: "text" as const, textPreview: null },
      ],
      nextCursor: null,
    }));
    const entry = {
      threadId: "thread-refresh",
      workspaceId: "main",
      archived: false,
      preview: "刷新",
      name: null,
      modelProvider: "openai",
      status: { type: "active" as const },
      activeTurnId: "turn-3",
      isPinned: false,
      turnCount: null,
      measuredAt: null,
    };
    const put = vi.fn();
    const sessionDisplayCache = {
      get: vi.fn(() => entry),
      put,
      invalidateTurnCount: vi.fn(),
      remove: vi.fn(),
    } satisfies SessionDisplayCachePort;
    const router = {
      targetForThread: () => target,
      readThread: vi.fn(async () => ({
        id: "thread-refresh",
        sessionId: "session-refresh",
        modelProvider: "openai",
        preview: "刷新完成",
        name: null,
        isPinned: false,
        status: { type: "idle" as const },
        cwd: main.cwd,
        source: "cli" as const,
        historyMode: "paginated" as const,
        activeTurnId: null,
      })),
    } as unknown as SessionRouter;
    const service = new ConversationService(
      turnPort(), router, { activeTurn: () => undefined } as unknown as ConversationCore,
      {} as ModelSelectionService, queryPort(),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      { listThreadTurns } as unknown as ThreadHistoryPort, undefined, undefined,
      sessionDisplayCache,
    );

    const first = service.refreshSessionDisplayCache("thread-refresh");
    const second = service.refreshSessionDisplayCache("thread-refresh");
    expect(second).toBe(first);
    await first;

    expect(listThreadTurns).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-refresh",
      turnCount: 3,
      measuredAt: expect.any(Number),
      status: { type: "idle" },
      activeTurnId: null,
    }));
  });

});


function workspaceService(
  current: typeof main,
  selectWorkspace: () => Promise<typeof main>,
  models: {
    capturePreference: ReturnType<typeof vi.fn>;
    restorePreference: ReturnType<typeof vi.fn>;
  },
): ConversationService {
  return new ConversationService(
    turnPort(),
    {
      workspace: () => current,
      resolveWorkspace: (selector: string) => selector === "other" ? other : main,
      selectWorkspace,
    } as unknown as SessionRouter,
    { activeTurn: () => undefined } as unknown as ConversationCore,
    models as unknown as ModelSelectionService,
    queryPort(),
  );
}
