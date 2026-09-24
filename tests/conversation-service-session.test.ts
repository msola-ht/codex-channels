import pino from "pino";
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
import { SessionRouter } from "../src/session-routing/router.js";
import type { ThreadLifecyclePort, ThreadResumeSession } from "../src/session-routing/index.js";
import { MemoryBindingStore } from "../src/storage/index.js";
import { WorkspaceRegistry } from "../src/policy/index.js";
import { EventBus } from "../src/event-bus/index.js";
import type { OutputEvent } from "../src/conversation-core/index.js";

const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
const main = { id: "main", name: "Main", cwd: "/workspace/main" };
const other = { id: "other", name: "Other", cwd: "/workspace/other" };
const trackThreadActivity = () => ({ restore: vi.fn(), stop: vi.fn() });

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
  it.each(["reconnect", "explicit"].flatMap((entry) =>
    ["directory", "permissions", "cleanup"].map((mismatch) => ({ entry, mismatch }))))("does not route input to invalid history after $entry rejects $mismatch", async ({ entry, mismatch }) => {
    const store = new MemoryBindingStore();
    store.bind({ target, workspaceId: main.id, threadId: "old", sessionId: "old" });
    const session: ThreadResumeSession = {
      thread: { id: "old", sessionId: "old", cwd: main.cwd, source: "cli", modelProvider: "openai",
        preview: "", name: null, isPinned: false, historyMode: "paginated", status: { type: "idle" }, activeTurnId: null },
      model: "gpt-main", reasoningEffort: null, serviceTier: null, contextCompactionItemIds: [],
      collaborationMode: "default",
      settingsMatch: false,
      effectiveSettings: { cwd: main.cwd, approvalPolicy: "never", sandbox: "read-only", permissions: null },
    };
    const listThreads = vi.fn(async () => [session.thread]);
    const router = new SessionRouter({
      readThread: async () => {
        core.handle({ type: "turn.started", threadId: "old", turnId: "turn-old" });
        return { ...session.thread, cwd: mismatch === "directory" ? other.cwd : main.cwd };
      },
      resumeThread: async () => session,
      unsubscribeThread: async () => { if (mismatch === "cleanup") throw new Error("unsubscribe failed"); },
      startThread: async () => ({ ...session, thread: { ...session.thread, id: "fresh", sessionId: "fresh" } }),
      listThreads,
    } as unknown as ThreadLifecyclePort, store, new WorkspaceRegistry([main, other], main.id));
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const core = new ConversationCore(router, output);
    const startTurn = vi.fn(async () => ({ threadId: "fresh", turnId: "turn-fresh" }));
    const service = new ConversationService(turnPort({ startTurn }), router, core, {
      turnOverrides: () => ({}), markApplied: vi.fn(),
    } as unknown as ModelSelectionService, queryPort());
    if (entry === "reconnect") await router.restoreSubscriptions();
    else await expect(router.resume(target, "old", false, main.cwd)).rejects.toThrow();
    expect(core.activeTurn(target)).toBeUndefined();
    expect(core.activeTurnForThread("old")).toBeUndefined();
    expect(core.hasActiveTurns()).toBe(false);
    expect(await service.stop(target)).toBe(false);
    expect(await service.submit(target, "继续")).toMatchObject({ threadId: "fresh" });
    expect(startTurn).toHaveBeenCalledExactlyOnceWith("fresh", [{ type: "text", text: "继续" }], expect.any(String), main.cwd, {});
    expect(listThreads).not.toHaveBeenCalled();
    await output.close();
  });

  it.each(["active", "completed", "next-turn"])("restores authoritative %s activity and makes stop target the live Turn", async (state) => {
    const threadId = "historical";
    let bound = false;
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const core = new ConversationCore({
      allBindings: () => [],
      foregroundThreadId: () => bound ? threadId : undefined,
      targetForThread: () => bound ? target : undefined,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);
    const snapshot = {
      id: threadId, sessionId: threadId, cwd: main.cwd, source: "cli" as const,
      modelProvider: "openai", preview: "", name: null, isPinned: false,
      historyMode: "paginated" as const, status: { type: "active" as const }, activeTurnId: "turn-1",
    };
    const binding = { target, workspaceId: main.id, threadId, sessionId: threadId };
    const resume: SessionRouter["resume"] = async (_target, _id, _preserve, _cwd, transition) => {
      if (state !== "active") core.handle({ type: "turn.completed", threadId, turnId: "turn-1", status: "completed", error: null });
      if (state === "next-turn") core.handle({ type: "turn.started", threadId, turnId: "turn-2" });
      transition?.assertCurrent();
      bound = true;
      transition?.restored(binding, snapshot);
      return binding;
    };
    const interruptTurn = vi.fn(async () => undefined);
    const service = new ConversationService(turnPort({ interruptTurn }), {
      workspace: () => main, list: async () => [snapshot], resume,
      targetForThread: () => undefined, current: () => bound ? binding : undefined,
      modelSettingsForThread: () => undefined,
    } as unknown as SessionRouter, core, { clear: vi.fn() } as unknown as ModelSelectionService, queryPort());
    await service.resume(target, threadId);
    expect(await service.stop(target)).toBe(state !== "completed");
    if (state === "completed") expect(interruptTurn).not.toHaveBeenCalled();
    else expect(interruptTurn).toHaveBeenCalledExactlyOnceWith(threadId, state === "next-turn" ? "turn-2" : "turn-1");
    await output.close();
  });

  it.each(["01a0c390-cde6-7992-b12a-f44a7732ee1c", "01a0c390", "history", "1"])("limits selector %s to the current workspace list", async (selector) => {
    const list = vi.fn(async () => []);
    const resume = vi.fn();
    const service = new ConversationService(turnPort(), {
      workspace: () => main,
      list,
      resume,
    } as unknown as SessionRouter, {} as ConversationCore, {} as ModelSelectionService, queryPort());
    await expect(service.resume(target, selector)).rejects.toMatchObject({ code: "session.selector.not-found" });
    expect(list).toHaveBeenCalledExactlyOnceWith(target);
    expect(resume).not.toHaveBeenCalled();
  });

  it("rejects a short selection when a queued workspace switch changes its context", async () => {
    let workspace = main;
    let releaseList!: () => void;
    let listStarted!: () => void;
    const started = new Promise<void>((resolve) => { listStarted = resolve; });
    const waiting = new Promise<void>((resolve) => { releaseList = resolve; });
    const resume = vi.fn();
    const service = new ConversationService(turnPort(), {
      workspace: () => workspace,
      list: async () => {
        listStarted();
        await waiting;
        return [{ id: "historical", cwd: main.cwd }];
      },
      resolveWorkspace: () => other,
      selectWorkspace: async () => { workspace = other; return other; },
      targetForThread: () => undefined,
      resume,
    } as unknown as SessionRouter, { activeTurn: () => undefined } as unknown as ConversationCore,
    { clear: vi.fn() } as unknown as ModelSelectionService, queryPort());
    const recovering = service.resume(target, "1");
    await started;
    const switching = service.selectWorkspace(target, "other");
    releaseList();
    await switching;
    await expect(recovering).rejects.toMatchObject({ code: "thread.takeover.changed" });
    expect(resume).not.toHaveBeenCalled();
  });

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
      workspace: () => main,
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
        workspace: () => main,
        current: () => undefined,
        transferBinding,
      } as unknown as SessionRouter,
      { activeTurn: () => undefined } as unknown as ConversationCore,
      { clear: vi.fn() } as unknown as ModelSelectionService,
      queryPort(),
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
        workspace: () => main,
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
        workspace: () => main,
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
        workspace: () => main,
        modelSettingsForThread: () => undefined,
      } as unknown as SessionRouter,
      { activeTurn: () => undefined, trackThreadActivity } as unknown as ConversationCore,
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
    expect(resume).toHaveBeenCalledWith(target, "pinned-old", false, main.cwd, expect.objectContaining({ restored: expect.any(Function) }));
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
        workspace: () => main,
        backgroundBindings: () => [],
        isBackgroundThread: () => false,
        modelSettingsForThread: () => undefined,
        resume,
      } as unknown as SessionRouter,
      {
        activeTurn: () => ({ target, threadId: "running", turnId: "turn-running" }),
        trackThreadActivity,
      } as unknown as ConversationCore,
      { clear: vi.fn() } as unknown as ModelSelectionService,
      queryPort(),
    );

    await expect(service.resume(target, "selected")).resolves.toEqual({
      threadId: "selected",
      backgroundedThreadId: "running",
    });
    expect(resume).toHaveBeenCalledWith(target, "selected", true, main.cwd, expect.objectContaining({ restored: expect.any(Function) }));
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

  it("reports the detached Thread after /new for the recovery command", async () => {
    const binding = {
      target,
      workspaceId: "main",
      threadId: "thread-current",
      sessionId: "session-current",
    };
    const idleNewSession = vi.fn(async () => undefined);
    const idleService = new ConversationService(
      turnPort(),
      {
        current: () => binding,
        newSession: idleNewSession,
        backgroundBindings: () => [],
      } as unknown as SessionRouter,
      { activeTurn: () => undefined } as unknown as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
    );

    await expect(idleService.newSession(target)).resolves.toEqual({
      previousThreadId: "thread-current",
    });
    expect(idleNewSession).toHaveBeenCalledWith(target, false);

    const activeNewSession = vi.fn(async () => undefined);
    const activeService = new ConversationService(
      turnPort(),
      {
        current: () => binding,
        newSession: activeNewSession,
        backgroundBindings: () => [],
      } as unknown as SessionRouter,
      {
        activeTurn: () => ({
          target,
          threadId: "thread-current",
          turnId: "turn-active",
        }),
      } as unknown as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
    );

    await expect(activeService.newSession(target)).resolves.toEqual({
      previousThreadId: "thread-current",
      backgroundedThreadId: "thread-current",
    });
    expect(activeNewSession).toHaveBeenCalledWith(target, true);
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
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, history, undefined,
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
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      { listThreadTurns } as unknown as ThreadHistoryPort, undefined,
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
