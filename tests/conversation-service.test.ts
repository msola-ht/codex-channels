import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  ConversationService,
  type ConversationQueryPort,
} from "../src/application/conversation-service.js";
import { ModelSelectionService } from "../src/application/model-selection-service.js";
import type { CollaborationModeSelectionService } from "../src/application/collaboration-mode-service.js";
import {
  estimateWeeklyLimit,
  type RequestMetricsQueryPort,
} from "../src/application/request-metrics-port.js";
import type { ThreadApprovalsReviewerPort, TurnExecutionPort } from "../src/application/turn-port.js";
import { GatewayApplication } from "../src/bootstrap/app.js";
import { CodexAppServerClient, JsonRpcClient, toThreadStateEvent, type RpcNotification } from "../src/codex-client/index.js";
import {
  ConversationCore,
  type ConversationRoutingPort,
  type OutputEvent,
} from "../src/conversation-core/index.js";
import { EventBus } from "../src/event-bus/index.js";
import { SessionRouter } from "../src/session-routing/router.js";
import { ThreadStateSynchronizer, type ThreadLifecyclePort, type ThreadSession, type ThreadStartOptions } from "../src/session-routing/index.js";
import { MemoryBindingStore } from "../src/storage/memory-binding-store.js";
import { WorkspaceRegistry } from "../src/policy/workspace-registry.js";
import { FakeTransport } from "./support/json-rpc-fixtures.js";

const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
const main = { id: "main", name: "Main", cwd: "/workspace/main" };

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

function defaultProviderConversation(providers: string[]) {
  const sessions = new Map<string, ThreadSession>();
  const startThread = vi.fn(async (_cwd: string, options: ThreadStartOptions = {}): Promise<ThreadSession> => {
    const id = `thread-${sessions.size}`;
    const provider = options.modelProvider ?? "openai";
    const session: ThreadSession = {
      thread: {
        id, sessionId: id, modelProvider: provider, preview: "", name: null, isPinned: false,
        status: { type: "idle" }, cwd: main.cwd, source: "cli", historyMode: "paginated", activeTurnId: null,
      },
      model: options.model ?? "gpt-main", modelProvider: provider, reasoningEffort: "high",
      serviceTier: null, contextCompactionItemIds: [],
    };
    sessions.set(id, session);
    return session;
  });
  const lifecycle = {
    listThreads: async () => [], startThread, unsubscribeThread: async () => undefined,
    forkThread: async (id: string) => {
      const original = sessions.get(id)!;
      const nextId = `${id}-fork`;
      const forked = { ...original, thread: { ...original.thread, id: nextId, sessionId: nextId } };
      sessions.set(nextId, forked);
      return forked;
    },
  } as unknown as ThreadLifecyclePort;
  const router = new SessionRouter(lifecycle, new MemoryBindingStore(), new WorkspaceRegistry([main], main.id));
  const models = new ModelSelectionService({
    listModels: async () => [], writeDefaultFastMode: async () => undefined,
    readDefaultReasoningEffort: async () => "high", readDefaultServiceTier: async () => null,
  }, router, undefined, providers.map((provider) => ({
    provider, id: "third-default", model: "third-default", displayName: provider, isDefault: true,
    inputModalities: ["text"], supportedReasoningEfforts: [{ effort: "high", description: "High" }],
    defaultReasoningEffort: "high", serviceTiers: [], defaultServiceTier: null,
  })), "openai", [], () => false);
  const startTurn = vi.fn(async () => ({ turnId: "turn-1" }));
  const service = new ConversationService(turnPort({
    startTurn, getGoal: async () => null, clearGoal: async () => undefined,
    setGoal: async (threadId, objective) => ({
      threadId, objective, status: "active", tokenBudget: null, tokensUsed: 0,
      timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
    }),
    compactThread: async () => undefined,
    startReview: async (threadId) => ({ threadId, turnId: "review-1" }),
  }), router, {
    activeTurn: () => undefined, markTurnStarted: vi.fn(), handle: vi.fn(),
  } as unknown as ConversationCore, models, queryPort());
  return { service, router, models, startThread, startTurn };
}

describe("ConversationService Workspace Auto-review", () => {
  function fixture() {
    const { router, models, startThread } = defaultProviderConversation(["deepseek"]);
    const activeTurn = vi.fn(() => undefined as string | undefined);
    const updateWorkspacePermissions = vi.fn(async () => main);
    const service = new ConversationService(
      turnPort(), router, { activeTurn } as unknown as ConversationCore, models, queryPort(),
      undefined, undefined, undefined, undefined, undefined, { updateWorkspacePermissions },
    );
    return { service, router, startThread, updateWorkspacePermissions, activeTurn };
  }

  it("updates the Workspace without creating or changing a loaded or active Thread", async () => {
    const { service, router, startThread, updateWorkspacePermissions, activeTurn } = fixture();
    await service.updateWorkspacePermissions(target, { kind: "approvals-reviewer", value: "auto_review" }, "main");
    expect(startThread).not.toHaveBeenCalled();
    await router.ensure(target);
    router.updateModelSettings("thread-0", { model: "gpt-main", effort: null, serviceTier: null, collaborationMode: "default", approvalsReviewer: "auto_review" });
    activeTurn.mockReturnValue("turn-1");
    await service.updateWorkspacePermissions(target, { kind: "approvals-reviewer", value: "user" }, "main");
    await service.updateWorkspacePermissions(target, { kind: "approvals-reviewer", value: null }, "main");
    expect(updateWorkspacePermissions).toHaveBeenCalledTimes(3);
    expect(updateWorkspacePermissions).toHaveBeenLastCalledWith("main", { kind: "approvals-reviewer", value: null });
    expect(router.current(target)?.threadId).toBe("thread-0");
    expect(router.modelSettingsForThread("thread-0")?.approvalsReviewer).toBe("auto_review");
    expect(startThread).toHaveBeenCalledOnce();
  });

  it("rejects a button bound to a different Workspace before writing", async () => {
    const { service, updateWorkspacePermissions } = fixture();
    await expect(service.updateWorkspacePermissions(target, { kind: "approvals-reviewer", value: "user" }, "old-workspace"))
      .rejects.toMatchObject({ code: "workspace.permission.usage", details: { reason: "stale-selection" } });
    expect(updateWorkspacePermissions).not.toHaveBeenCalled();
  });
});

describe("ConversationService current Thread Auto-review", () => {
  function fixture(reviewerPort?: ThreadApprovalsReviewerPort) {
    const { router, models, startThread } = defaultProviderConversation(["deepseek"]);
    const activeTurn = vi.fn(() => undefined as string | undefined);
    const hasPendingInteraction = vi.fn(() => false);
    const updateThreadApprovalsReviewer = vi.fn(async (_threadId: string, approvalsReviewer: "user" | "auto_review") => {
      router.updateModelSettings("thread-0", { model: "gpt-main", effort: null, serviceTier: null, collaborationMode: "default", approvalsReviewer });
    });
    const service = new ConversationService(turnPort(), router, { activeTurn } as unknown as ConversationCore,
      models, queryPort(), undefined, undefined,
      { hasPendingInteraction, notifyTransferred: () => undefined },
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, reviewerPort ?? { updateThreadApprovalsReviewer });
    const setReviewer = (approvalsReviewer: "user" | "auto_review" | "guardian_subagent" | null) =>
      router.updateModelSettings("thread-0", { model: "gpt-main", effort: null, serviceTier: null, collaborationMode: "default", approvalsReviewer });
    return { service, router, startThread, activeTurn, hasPendingInteraction, updateThreadApprovalsReviewer, setReviewer };
  }

  it("queries without creating a Thread and rejects an unbound write", async () => {
    const { service, startThread, updateThreadApprovalsReviewer } = fixture();
    expect(service.autoReview(target)).toEqual({ threadId: null, reviewer: null, updated: false });
    await expect(service.updateAutoReview(target, true)).rejects.toMatchObject({ code: "conversation.missing" });
    expect(startThread).not.toHaveBeenCalled();
    expect(updateThreadApprovalsReviewer).not.toHaveBeenCalled();
  });

  it("short-circuits confirmed same values and returns only notification-confirmed writes without optimistic cache mutation", async () => {
    const { service, router, setReviewer, updateThreadApprovalsReviewer } = fixture();
    await router.ensure(target);
    setReviewer("auto_review");
    await expect(service.updateAutoReview(target, true, "thread-0")).resolves.toEqual({ threadId: "thread-0", reviewer: "auto_review", updated: false });
    expect(updateThreadApprovalsReviewer).not.toHaveBeenCalled();
    await expect(service.updateAutoReview(target, false, "thread-0")).resolves.toEqual({ threadId: "thread-0", reviewer: "user", updated: true });
    expect(updateThreadApprovalsReviewer).toHaveBeenCalledWith("thread-0", "user");
    expect(router.modelSettingsForThread("thread-0")?.approvalsReviewer).toBe("user");
  });

  it("rejects stale buttons, active Turns, pending interactions and non-writable actual reviewers before RPC", async () => {
    const { service, router, setReviewer, activeTurn, hasPendingInteraction, updateThreadApprovalsReviewer } = fixture();
    await router.ensure(target);
    setReviewer("user");
    await expect(service.updateAutoReview(target, true, "old-thread")).rejects.toMatchObject({ code: "autoreview.stale-selection" });
    activeTurn.mockReturnValue("turn-1");
    await expect(service.updateAutoReview(target, true)).rejects.toMatchObject({ code: "conversation.busy" });
    activeTurn.mockReturnValue(undefined);
    hasPendingInteraction.mockReturnValue(true);
    await expect(service.updateAutoReview(target, true)).rejects.toMatchObject({ code: "conversation.busy" });
    hasPendingInteraction.mockReturnValue(false);
    for (const reviewer of [null, "guardian_subagent"] as const) {
      setReviewer(reviewer);
      expect(service.autoReview(target).reviewer).toBe(reviewer);
      await expect(service.updateAutoReview(target, true)).rejects.toMatchObject({ code: "autoreview.unavailable" });
    }
    expect(updateThreadApprovalsReviewer).not.toHaveBeenCalled();
  });

  it("keeps the old reviewer on failure and hides arbitrary upstream errors", async () => {
    const { service, router, setReviewer, updateThreadApprovalsReviewer } = fixture();
    await router.ensure(target);
    setReviewer("user");
    updateThreadApprovalsReviewer.mockRejectedValueOnce(new Error("secret upstream body"));
    await expect(service.updateAutoReview(target, true)).rejects.toMatchObject({ code: "autoreview.update-failed" });
    expect(service.autoReview(target)).toEqual({ threadId: "thread-0", reviewer: "user", updated: false });
  });

  it("keeps cached reviewer unchanged while waiting and rejects a binding invalidated by an authoritative lifecycle event", async () => {
    const { service, router, setReviewer, updateThreadApprovalsReviewer } = fixture();
    await router.ensure(target);
    setReviewer("user");
    let finish!: () => void;
    updateThreadApprovalsReviewer.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = service.updateAutoReview(target, true, "thread-0");
    const rejected = expect(pending).rejects.toMatchObject({ code: "autoreview.stale-selection" });
    await vi.waitFor(() => expect(updateThreadApprovalsReviewer).toHaveBeenCalledOnce());
    expect(service.autoReview(target).reviewer).toBe("user");
    router.forgetThread("thread-0");
    finish();
    await rejected;
    expect(router.current(target)).toBeUndefined();
  });

  it("returns the latest authoritative reviewer when another client overrides the confirmed setting before result delivery", async () => {
    const { service, router, setReviewer, updateThreadApprovalsReviewer } = fixture();
    await router.ensure(target);
    setReviewer("user");
    updateThreadApprovalsReviewer.mockImplementationOnce(async () => {
      setReviewer("auto_review");
      setReviewer("guardian_subagent");
    });
    await expect(service.updateAutoReview(target, true)).resolves.toEqual({ threadId: "thread-0", reviewer: "guardian_subagent", updated: true });
  });

  it.each(["success", "override", "invalidated", "timeout", "shutdown"])("waits for real inbound reduction after Client confirmation under notification backlog (%s)", async scenario => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), { sandbox: "read-only" });
    const inbound = new EventBus<RpcNotification>(pino({ level: "silent" }));
    // Use the production composition-root adapter without starting services,
    // opening live sockets or creating a production database.
    const port = Object.assign(Object.create(GatewayApplication.prototype), { codex: client, inbound, stopping: false }) as ThreadApprovalsReviewerPort & { stopping: boolean };
    const { service, router, setReviewer } = fixture(port);
    const synchronizer = new ThreadStateSynchronizer(router);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let reduced = 0;
    inbound.subscribe("conversation-core", async notification => {
      if (notification.method === "item/agentMessage/delta") await blocked;
      const event = toThreadStateEvent(notification);
      if (event) { synchronizer.handle(event); reduced++; }
    });
    const remove = client.onNotification(notification => inbound.publish(notification, true));
    let clientConfirmed = false;
    const originalUpdate = client.updateThreadApprovalsReviewer.bind(client);
    vi.spyOn(client, "updateThreadApprovalsReviewer").mockImplementation(async (...args) => {
      await originalUpdate(...args);
      clientConfirmed = true;
    });
    const notifyReviewer = (approvalsReviewer: string) => transport.receive({
      method: "thread/settings/updated", params: { threadId: "thread-0", threadSettings: {
        model: "gpt-main", effort: null, serviceTier: null,
        collaborationMode: { mode: "default" }, approvalsReviewer,
      } },
    });
    await client.connect();
    const send = vi.spyOn(transport, "send").mockImplementation(async message => {
      const request = JSON.parse(message) as { id: number; params: { approvalsReviewer: string } };
      for (let index = 0; index < 20; index++) {
        transport.receive({ method: "item/agentMessage/delta", params: { threadId: "thread-0", turnId: "turn-0", itemId: "item-0", delta: "text" } });
      }
      notifyReviewer(request.params.approvalsReviewer);
      transport.receive({ id: request.id, result: {} });
    });
    try {
      await router.ensure(target);
      setReviewer("user");
      if (scenario === "timeout") vi.useFakeTimers();
      let delivered = false;
      const pending = service.updateAutoReview(target, true, "thread-0");
      void pending.then(() => { delivered = true; }, () => { delivered = true; });
      const result = scenario === "invalidated"
        ? expect(pending).rejects.toMatchObject({ code: "autoreview.stale-selection" })
        : scenario === "timeout" || scenario === "shutdown"
          ? expect(pending).rejects.toMatchObject({ code: "autoreview.update-unconfirmed" })
          : expect(pending).resolves.toEqual({ threadId: "thread-0", reviewer: scenario === "override" ? "guardian_subagent" : "auto_review", updated: true });
      await vi.waitFor(() => expect(clientConfirmed).toBe(true));
      expect(reduced).toBe(0);
      expect(service.autoReview(target).reviewer).toBe("user");
      expect(delivered).toBe(false);
      if (scenario === "override") notifyReviewer("guardian_subagent");
      if (scenario === "invalidated") transport.receive({ method: "thread/archived", params: { threadId: "thread-0" } });
      if (scenario === "shutdown") port.stopping = true;
      if (scenario === "timeout") await vi.advanceTimersByTimeAsync(5_000);
      else release();
      await result;
      if (scenario === "success") {
        expect(service.autoReview(target).reviewer).toBe("auto_review");
        await expect(service.updateAutoReview(target, false)).resolves.toEqual({ threadId: "thread-0", reviewer: "user", updated: true });
        expect(send).toHaveBeenCalledTimes(2);
        expect(service.autoReview(target).reviewer).toBe("user");
      }
    } finally {
      release();
      vi.useRealTimers();
      await inbound.drain();
      remove();
      send.mockRestore();
      await client.close();
      await inbound.close({ requireDrained: true });
    }
  });
});

describe("ConversationService model selection", () => {
  it("keeps the Provider switch notice until the target Thread is created, then clears it before the next Turn", async () => {
    const { service, router, models } = defaultProviderConversation(["deepseek", "custom"]);
    await router.ensure(target, { model: "third-default", modelProvider: "deepseek" });
    await models.selectModel(target, { provider: "custom", model: "third-default" });
    expect(router.current(target)).toBeUndefined();
    expect(models.status(target).providerPending).toBe(true);
    await models.selectModel(target, { provider: "custom", model: "third-default" });
    expect((await models.state(target)).providerPending).toBe(true);
    await service.getGoal(target);
    expect(models.status(target).providerPending).toBe(false);
    expect((await models.state(target)).providerPending).toBe(false);
    await service.submit(target, "继续任务");
    expect(models.hasPending(target)).toBe(false);
    expect(models.status(target).providerPending).toBe(false);
  });

  const sessionCommands: Array<[string, (service: ConversationService) => Promise<unknown>]> = [
    ["getGoal", (service) => service.getGoal(target)],
    ["setGoal", (service) => service.setGoal(target, "完成任务")],
    ["clearGoal", (service) => service.clearGoal(target)],
    ["review", (service) => service.review(target, { type: "uncommittedChanges" })],
    ["compact", (service) => service.compact(target)],
    ["fork", (service) => service.fork(target)],
  ];

  it.each(sessionCommands)("keeps %s and the following message on the unauthenticated third-party default", async (_name, execute) => {
    const { service, router, startThread, startTurn } = defaultProviderConversation(["deepseek"]);
    await execute(service);
    expect(startThread).toHaveBeenCalledWith(main.cwd, { model: "third-default", modelProvider: "deepseek" });
    expect(router.modelSettings(target)).toMatchObject({ model: "third-default", modelProvider: "deepseek" });
    const binding = router.current(target)!;
    await service.submit(target, "继续任务");
    expect(startTurn).toHaveBeenCalledWith(binding.threadId, expect.any(Array), expect.any(String), main.cwd, {});
    expect(startThread).toHaveBeenCalledOnce();
  });

  it.each(sessionCommands)("rejects %s before creating a Thread when several unauthenticated Providers need selection", async (_name, execute) => {
    const { service, router, startThread } = defaultProviderConversation(["deepseek", "custom"]);
    await expect(execute(service)).rejects.toMatchObject({ code: "model.provider.selection-required" });
    expect(startThread).not.toHaveBeenCalled();
    expect(router.current(target)).toBeUndefined();
  });

  it.each(sessionCommands)("uses an explicit Provider selection in %s and preserves it for the following message", async (_name, execute) => {
    const { service, router, models, startThread, startTurn } = defaultProviderConversation(["deepseek", "custom"]);
    await models.selectModel(target, { provider: "custom", model: "third-default" });
    await execute(service);
    expect(startThread).toHaveBeenCalledWith(main.cwd, { model: "third-default", modelProvider: "custom" });
    expect(models.status(target).providerPending).toBe(false);
    await service.submit(target, "继续任务");
    expect(startTurn).toHaveBeenCalledWith(router.current(target)!.threadId, expect.any(Array), expect.any(String), main.cwd, expect.any(Object));
    expect(router.modelSettings(target)?.modelProvider).toBe("custom");
  });

  it("queries global metrics without requiring a current Thread", () => {
    const report = {
      view: "global" as const,
      range: "7d" as const,
      startAtMs: 1,
      endAtMs: 2,
      aggregate: null,
      groups: [],
      totalGroupCount: 0,
    };
    const errorReport = {
      view: "errors" as const,
      range: "24h" as const,
      startAtMs: 1,
      endAtMs: 2,
      requestCount: 3,
      requestOutcomes: { completed: 2, interrupted: 0, failed: 1, incomplete: 0 },
      unsuccessfulRequestCount: 1,
      groups: [],
      totalGroupCount: 0,
    };
    const metrics = {
      forThread: vi.fn(),
      aggregate: vi.fn(() => report),
      errors: vi.fn(() => errorReport),
      weeklyQuotaEstimate: vi.fn(() => null),
    } satisfies RequestMetricsQueryPort;
    const service = new ConversationService(
      turnPort(),
      { current: () => undefined } as unknown as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
      undefined,
      undefined,
      undefined,
      undefined,
      metrics,
    );

    expect(service.requestMetrics(target, { view: "session" })).toBeNull();
    expect(service.requestMetrics(target, { view: "global", range: "7d" }))
      .toEqual(report);
    expect(metrics.aggregate).toHaveBeenCalledWith("global", "7d");
    expect(service.requestMetrics(target, { view: "errors", range: "24h" }))
      .toEqual(errorReport);
    expect(metrics.errors).toHaveBeenCalledWith("24h");
    expect(metrics.forThread).not.toHaveBeenCalled();
  });

  it("delegates thread occupancy release to the injected port", async () => {
    const result = {
      status: "held" as const,
      threadId: "thread-release",
      holder: { pid: 4242, command: "codex app-server" },
      releasable: true,
      stuck: true,
    };
    const releaseThread = vi.fn(async () => result);
    const service = new ConversationService(
      turnPort(),
      {} as SessionRouter,
      {} as ConversationCore,
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
      { releaseThread },
    );

    await expect(service.releaseThread(target, false)).resolves.toEqual(result);
    expect(releaseThread).toHaveBeenCalledWith(target, false);
  });

  it("rejects thread occupancy release without an injected port", async () => {
    const service = new ConversationService(
      turnPort(),
      {} as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
    );

    await expect(service.releaseThread(target)).rejects.toMatchObject({
      code: "release.unsupported",
    });
  });

  it("clears pending model selection through the selection service", async () => {
    const state = {
      models: [],
      model: "gpt-5.6-sol",
      modelProvider: "OpenAI",
      effort: null,
      serviceTier: null,
      pending: false,
      modelPending: false,
      effortPending: false,
      serviceTierPending: false,
    };
    const models = {
      clear: vi.fn(),
      state: vi.fn(async () => state),
    } as unknown as ModelSelectionService;
    const service = new ConversationService(
      turnPort(),
      {} as SessionRouter,
      {} as ConversationCore,
      models,
      queryPort(),
    );

    await expect(service.clearModelSelection(target)).resolves.toEqual(state);
    expect(models.clear).toHaveBeenCalledWith(target);
    expect(models.state).toHaveBeenCalledWith(target);
  });

  it("estimates one percent and remaining weekly allowance from proxy metrics", () => {
    const estimate = estimateWeeklyLimit({
      limitId: "codex",
      limitName: null,
      normalModelSlug: null,
      primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 2_000_000 },
      secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 2_000_000 },
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: "plus",
      rateLimitReachedType: null,
    }, {
      limitId: "codex",
      resetsAt: 2_000_000,
      firstObservedAtMs: 1_900_000_000,
      lastObservedAtMs: 1_999_000_000,
      latestUsedPercentMillionths: 20_000_000,
      observedDeltaPercentMillionths: 2_000_000,
      intervalCount: 2,
      requestCount: 40,
      unsuccessfulRequestCount: 2,
      inputTokens: 180_000,
      outputTokens: 20_000,
      totalTokens: 200_000,
    });

    expect(estimate).toMatchObject({
      usedPercent: 20,
      remainingPercent: 80,
      requestCount: 40,
      inputTokensPerPercent: 90_000,
      outputTokensPerPercent: 10_000,
      totalTokensPerPercent: 100_000,
      remainingTokens: 8_000_000,
    });
  });

  it("does not estimate without an aligned weekly window or proxy samples", () => {
    const limit = {
      limitId: "codex",
      limitName: null,
      normalModelSlug: null,
      primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 2_000_000 },
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: "plus" as const,
      rateLimitReachedType: null,
    };
    expect(estimateWeeklyLimit(limit, null)).toBeNull();
  });

  it("enriches OpenAI limits with the matching local provider window", async () => {
    const nowMs = 1_999_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const weeklyQuotaEstimate = vi.fn(() => ({
      limitId: "codex",
      resetsAt: 2_000_000,
      firstObservedAtMs: 1_900_000_000,
      lastObservedAtMs: nowMs,
      latestUsedPercentMillionths: 10_000_000,
      observedDeltaPercentMillionths: 10_000_000,
      intervalCount: 1,
      requestCount: 2,
      unsuccessfulRequestCount: 0,
      inputTokens: 18_000,
      outputTokens: 2_000,
      totalTokens: 20_000,
    }));
    const service = new ConversationService(
      turnPort(),
      {} as SessionRouter,
      {} as ConversationCore,
      { status: () => ({ modelProvider: "openai" }) } as unknown as ModelSelectionService,
      queryPort(),
      undefined,
      undefined,
      undefined,
      {
        accountUsage: vi.fn(),
        accountLimits: vi.fn(async () => ({
          kind: "rate-limits" as const,
          provider: "openai" as const,
          limits: {
            limits: [{
              limitId: "codex",
              limitName: null,
              normalModelSlug: null,
              primary: null,
              secondary: {
                usedPercent: 10,
                windowDurationMins: 10_080,
                resetsAt: 2_000_000,
              },
              credits: null,
              individualLimit: null,
              spendControlReached: null,
              planType: "plus" as const,
              rateLimitReachedType: null,
            }, {
              limitId: "codex-other",
              limitName: "Other",
              normalModelSlug: null,
              primary: null,
              secondary: {
                usedPercent: 5,
                windowDurationMins: 10_080,
                resetsAt: 2_000_000,
              },
              credits: null,
              individualLimit: null,
              spendControlReached: null,
              planType: null,
              rateLimitReachedType: null,
            }],
            ordinaryUsageLimit: {
              limitId: "codex",
              limitName: null,
              normalModelSlug: null,
              primary: null,
              secondary: {
                usedPercent: 10,
                windowDurationMins: 10_080,
                resetsAt: 2_000_000,
              },
              credits: null,
              individualLimit: null,
              spendControlReached: null,
              planType: "plus" as const,
              rateLimitReachedType: null,
            },
            resetCreditsAvailable: null,
            accountId: null,
            ordinaryUsageAllowed: null,
            lunaReserve: null,
            unsupportedUpsellPresent: false,
          },
        })),
      },
      {
        forThread: vi.fn(),
        aggregate: vi.fn(),
        errors: vi.fn(),
        weeklyQuotaEstimate,
      },
    );

    try {
      await expect(service.providerAccountLimits(target)).resolves.toMatchObject({
        weeklyEstimates: [{
          limitId: "codex",
          totalTokensPerPercent: 2_000,
        }],
      });
      expect(weeklyQuotaEstimate).toHaveBeenCalledWith(
        "openai",
        "codex",
        2_000_000,
        nowMs,
      );
      expect(weeklyQuotaEstimate).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  it("passes only the bound OpenAI Thread to the optional account query", async () => {
    const providerAccountUsage = vi.fn(async (provider: string, threadId?: string) => ({
      kind: "unsupported" as const,
      provider: `${provider}:${threadId ?? "none"}`,
    }));
    const service = new ConversationService(
      turnPort(),
      {
        current: () => ({
          target,
          workspaceId: "main",
          threadId: "thread-openai",
          sessionId: "session-openai",
        }),
        modelSettings: () => ({
          model: "gpt-test",
          modelProvider: "openai",
          effort: "high",
          serviceTier: null,
          collaborationMode: "default" as const,
        }),
      } as unknown as SessionRouter,
      {} as ConversationCore,
      { status: () => ({ modelProvider: "openai" }) } as unknown as ModelSelectionService,
      queryPort(),
      undefined,
      undefined,
      undefined,
      { accountUsage: providerAccountUsage, accountLimits: vi.fn() },
    );

    await expect(service.providerAccountUsage(target)).resolves.toEqual({
      kind: "unsupported",
      provider: "openai:thread-openai",
    });
    expect(providerAccountUsage).toHaveBeenCalledWith("openai", "thread-openai");
  });

  it("does not pass a Thread to third-party account providers", async () => {
    const providerAccountUsage = vi.fn(async (provider: string, threadId?: string) => ({
      kind: "unsupported" as const,
      provider: `${provider}:${threadId ?? "none"}`,
    }));
    const service = new ConversationService(
      turnPort(),
      {
        current: () => ({
          target,
          workspaceId: "main",
          threadId: "thread-deepseek",
          sessionId: "session-deepseek",
        }),
        modelSettings: () => ({
          model: "deepseek-v4-flash",
          modelProvider: "deepseek",
          effort: "high",
          serviceTier: null,
          collaborationMode: "default" as const,
        }),
      } as unknown as SessionRouter,
      {} as ConversationCore,
      { status: () => ({ modelProvider: "deepseek" }) } as unknown as ModelSelectionService,
      queryPort(),
      undefined,
      undefined,
      undefined,
      { accountUsage: providerAccountUsage, accountLimits: vi.fn() },
    );

    await expect(service.providerAccountUsage(target)).resolves.toEqual({
      kind: "unsupported",
      provider: "deepseek:none",
    });
    expect(providerAccountUsage).toHaveBeenCalledWith("deepseek");
  });

  it("preserves a pending third-party account selection over the bound OpenAI Thread", async () => {
    const providerAccountUsage = vi.fn(async (provider: string, threadId?: string) => ({
      kind: "unsupported" as const,
      provider: `${provider}:${threadId ?? "none"}`,
    }));
    const service = new ConversationService(
      turnPort(),
      {
        current: () => ({
          target,
          workspaceId: "main",
          threadId: "thread-openai",
          sessionId: "session-openai",
        }),
        modelSettings: () => ({
          model: "gpt-test",
          modelProvider: "openai",
          effort: "high",
          serviceTier: null,
          collaborationMode: "default" as const,
        }),
      } as unknown as SessionRouter,
      {} as ConversationCore,
      { status: () => ({ modelProvider: "deepseek" }) } as unknown as ModelSelectionService,
      queryPort(),
      undefined,
      undefined,
      undefined,
      { accountUsage: providerAccountUsage, accountLimits: vi.fn() },
    );

    await expect(service.providerAccountUsage(target)).resolves.toEqual({
      kind: "unsupported",
      provider: "deepseek:none",
    });
    expect(providerAccountUsage).toHaveBeenCalledWith("deepseek");
  });

  it("queries only the OpenAI account summary before a Thread is bound", async () => {
    const providerAccountUsage = vi.fn(async (provider: string, threadId?: string) => ({
      kind: "unsupported" as const,
      provider: `${provider}:${threadId ?? "none"}`,
    }));
    const service = new ConversationService(
      turnPort(),
      {
        current: () => undefined,
      } as unknown as SessionRouter,
      {} as ConversationCore,
      { status: () => ({ modelProvider: "openai" }) } as unknown as ModelSelectionService,
      queryPort(),
      undefined,
      undefined,
      undefined,
      { accountUsage: providerAccountUsage, accountLimits: vi.fn() },
    );

    await expect(service.providerAccountUsage(target)).resolves.toEqual({
      kind: "unsupported",
      provider: "openai:none",
    });
    expect(providerAccountUsage).toHaveBeenCalledWith("openai");
  });

  it("reflects confirmed Goal set and clear results in status immediately", async () => {
    const goal = {
      threadId: "thread-1",
      objective: "完成 Gateway",
      status: "active" as const,
      tokenBudget: 100_000,
      tokensUsed: 12_500,
      timeUsedSeconds: 90,
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const router = {
      allBindings: () => [],
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
      current: () => ({
        target,
        workspaceId: "main",
        threadId: "thread-1",
        sessionId: "session-1",
      }),
      ensure: async () => ({
        target,
        workspaceId: "main",
        threadId: "thread-1",
        sessionId: "session-1",
      }),
      workspace: () => main,
    } satisfies ConversationRoutingPort & Pick<
      SessionRouter,
      "current" | "ensure" | "workspace"
    >;
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const core = new ConversationCore(router, output);
    const service = new ConversationService(
      turnPort({
        setGoal: async () => goal,
        clearGoal: async () => undefined,
      }),
      router as unknown as SessionRouter,
      core,
      {
        status: () => ({
          model: "gpt-main",
          effort: "medium",
          serviceTier: "default",
          modelPending: false,
          effortPending: false,
          serviceTierPending: false,
        }),
      } as unknown as ModelSelectionService,
      queryPort(),
    );

    await expect(service.setGoal(target, goal.objective)).resolves.toEqual(goal);
    expect(service.status(target).goal).toEqual(goal);

    await service.clearGoal(target);
    expect(service.status(target).goal).toBeUndefined();
    await output.close();
  });

  it("includes the current Core Goal and reads Git only for display", async () => {
    const goal = {
      threadId: "thread-1",
      objective: "完成 Gateway",
      status: "active" as const,
      tokenBudget: 100_000,
      tokensUsed: 12_500,
      timeUsedSeconds: 90,
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const currentGitBranch = vi.fn(async () => "feature/weixin-surface");
    const modelStatus = vi.fn(() => ({
      model: "gpt-main", effort: "medium", serviceTier: "default",
      modelPending: false, effortPending: false, serviceTierPending: false,
    }));
    let workspace = main;
    let authorized = true;
    const service = new ConversationService(
      turnPort(),
      {
        current: () => ({
          target,
          workspaceId: "main",
          threadId: "thread-1",
          sessionId: "session-1",
        }),
        workspace: () => {
          if (!authorized) throw new Error("Workspace access revoked");
          return workspace;
        },
        modelSettingsForThread: () => ({ approvalsReviewer: "auto_review" }),
      } as unknown as SessionRouter,
      {
        activeTurn: () => undefined,
        tokenUsage: () => undefined,
        goal: () => goal,
        contextCompactionCount: () => 2,
        weeklyRateLimit: () => undefined,
      } as unknown as ConversationCore,
      {
        status: modelStatus,
      } as unknown as ModelSelectionService,
      queryPort(),
      { currentGitBranch },
    );

    expect(service.status(target)).not.toHaveProperty("gitBranch");
    expect(service.status(target).approvalsReviewer).toBe("auto_review");
    expect(currentGitBranch).not.toHaveBeenCalled();
    expect(await service.statusForDisplay(target)).toMatchObject({
      threadId: "thread-1",
      goal,
      contextCompactionCount: 2,
      gitBranch: "feature/weixin-surface",
    });
    expect(currentGitBranch).toHaveBeenCalledWith(main.cwd, undefined);
    modelStatus.mockClear();
    expect(await service.workspaceGitBranch(target)).toBe("feature/weixin-surface");
    expect(modelStatus).not.toHaveBeenCalled();

    currentGitBranch.mockImplementationOnce(async () => {
      workspace = { id: "other", name: "Other", cwd: "/workspace/other" };
      return "feature/old-workspace";
    });
    expect(await service.statusForDisplay(target)).toMatchObject({ workspaceId: "other", cwd: "/workspace/other" });
    currentGitBranch.mockImplementationOnce(async () => { authorized = false; return "feature/revoked"; });
    await expect(service.statusForDisplay(target)).rejects.toThrow("Workspace access revoked");
    currentGitBranch.mockClear();
    await expect(service.workspaceGitBranch(target)).rejects.toThrow("Workspace access revoked");
    expect(currentGitBranch).not.toHaveBeenCalled();
  });

  it("starts an inline Plan prompt with the selected collaboration mode override", async () => {
    const startTurn = vi.fn(async () => ({ turnId: "turn-plan" }));
    const markTurnStarted = vi.fn();
    const select = vi.fn(async () => ({ mode: "plan" as const, pending: true }));
    const markApplied = vi.fn();
    const service = new ConversationService(
      turnPort({ startTurn }),
      {
        ensure: async () => ({
          target,
          workspaceId: "main",
          threadId: "thread-1",
          sessionId: "session-1",
        }),
        workspace: () => main,
      } as unknown as SessionRouter,
      {
        activeTurn: () => undefined,
        markTurnStarted,
      } as unknown as ConversationCore,
      {
        turnOverrides: () => ({}),
        markApplied: vi.fn(),
      } as unknown as ModelSelectionService,
      queryPort(),
      undefined,
      {
        select,
        turnOverride: () => ({
          mode: "plan",
          settings: {
            model: "gpt-5.6-sol",
            effort: "medium",
            developerInstructions: null,
          },
        }),
        markApplied,
      } as unknown as CollaborationModeSelectionService,
    );

    await expect(service.startPlan(target, " 设计发布流程 ")).resolves.toEqual({
      threadId: "thread-1",
      turnId: "turn-plan",
      steered: false,
    });
    expect(select).toHaveBeenCalledWith(target, "plan");
    expect(startTurn).toHaveBeenCalledWith(
      "thread-1",
      [{ type: "text", text: "设计发布流程" }],
      expect.stringMatching(/^codex_connect:/),
      main.cwd,
      {
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-5.6-sol",
            effort: "medium",
            developerInstructions: null,
          },
        },
      },
    );
    expect(markApplied).toHaveBeenCalledWith(target);
    expect(markTurnStarted).toHaveBeenCalledWith(target, "thread-1", "turn-plan");
  });

  it("does not change collaboration mode during an active Turn", async () => {
    const toggle = vi.fn();
    const service = new ConversationService(
      turnPort(),
      {} as SessionRouter,
      {
        activeTurn: () => ({ threadId: "thread-1", turnId: "turn-1" }),
      } as unknown as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
      undefined,
      { toggle } as unknown as CollaborationModeSelectionService,
    );

    await expect(service.togglePlanMode(target)).rejects.toMatchObject({
      code: "conversation.busy",
    });
    expect(toggle).not.toHaveBeenCalled();
  });

  it("fails closed when a staged model provider differs from the bound Thread provider", async () => {
    const startTurn = vi.fn(async () => ({ turnId: "turn-x" }));
    const service = new ConversationService(
      turnPort({ startTurn }),
      {
        ensure: async () => ({
          target,
          workspaceId: "main",
          threadId: "thread-openai",
          sessionId: "session-openai",
        }),
        workspace: () => main,
        modelSettings: () => ({
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          effort: "high",
          serviceTier: null,
          collaborationMode: "default" as const,
        }),
      } as unknown as SessionRouter,
      { activeTurn: () => undefined } as unknown as ConversationCore,
      {
        status: () => ({
          model: "deepseek-flash",
          modelProvider: "deepseek",
          effort: "high",
        }),
        turnOverrides: () => ({
          model: "deepseek-flash",
          modelProvider: "deepseek",
          effort: "high",
        }),
        markApplied: vi.fn(),
      } as unknown as ModelSelectionService,
      queryPort(),
    );

    await expect(service.submit(target, "第二段消息"))
      .rejects.toMatchObject({ code: "model.provider.mismatch" });
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("records a Turn start RPC failure as a model request error", async () => {
    const startTurn = vi.fn().mockRejectedValue(Object.assign(
      new Error("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage"),
      { code: -32603 },
    ));
    const recorder = { recordTurnError: vi.fn() };
    const service = new ConversationService(
      turnPort({ startTurn }),
      {
        ensure: async () => ({
          target,
          workspaceId: "main",
          threadId: "thread-1",
          sessionId: "session-1",
        }),
        workspace: () => main,
      } as unknown as SessionRouter,
      { activeTurn: () => undefined } as unknown as ConversationCore,
      {
        status: () => ({ modelProvider: "openai", model: "gpt-5.6-sol" }),
        turnOverrides: () => ({}),
        markApplied: vi.fn(),
      } as unknown as ModelSelectionService,
      queryPort(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      recorder,
    );

    await expect(service.submit(target, "hello"))
      .rejects.toThrow("usage limit");
    expect(recorder.recordTurnError).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openai",
      model: "gpt-5.6-sol",
      phase: "start",
      threadId: "thread-1",
      turnId: null,
      errorType: "usage_limit_reached",
      errorCode: "rpc:-32603",
    }));
  });


  it("lists built-in agent roles with configured roles overriding duplicates", () => {
    const service = new ConversationService(
      turnPort(),
      { workspace: () => main } as unknown as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        listAgentRoles: () => [
          { name: "worker", description: "项目专用执行角色" },
          { name: "external", description: "第三方模型子代理" },
        ],
      },
    );

    expect(service.listAgentRoles()).toEqual([
      { name: "default", description: "默认角色，继承当前模型与配置" },
      { name: "explorer", description: "代码库探查：快速回答具体的代码库问题" },
      { name: "worker", description: "项目专用执行角色" },
      { name: "external", description: "第三方模型子代理" },
    ]);
  });

  it("invokes an agent role with the official text marker and task", async () => {
    const startTurn = vi.fn().mockResolvedValue({ turnId: "turn-1" });
    const markTurnStarted = vi.fn();
    const service = new ConversationService(
      turnPort({ startTurn }),
      {
        ensure: async () => ({
          target,
          workspaceId: "main",
          threadId: "thread-1",
          sessionId: "session-1",
        }),
        workspace: () => main,
      } as unknown as SessionRouter,
      {
        activeTurn: () => undefined,
        markTurnStarted,
      } as unknown as ConversationCore,
      {
        turnOverrides: () => ({}),
        markApplied: vi.fn(),
      } as unknown as ModelSelectionService,
      queryPort(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        listAgentRoles: () => [{ name: "external", description: "第三方模型子代理" }],
      },
    );

    await expect(service.invokeAgent(
      target,
      "external",
      "  审查提交  ",
    )).resolves.toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
      roleName: "external",
    });
    expect(startTurn.mock.calls[0]?.[1]).toEqual([
      {
        type: "text",
        text: "请使用 agent_type=\"external\"、fork_turns=\"1\" 的子代理执行以下任务，子代理完成后把最终结果回复给我：\n\n审查提交",
      },
    ]);
    expect(markTurnStarted).toHaveBeenCalledWith(
      target,
      "thread-1",
      "turn-1",
      { kind: "agent", name: "external" },
    );
  });

  it("resolves an agent role by list number", async () => {
    const startTurn = vi.fn().mockResolvedValue({ turnId: "turn-1" });
    const service = new ConversationService(
      turnPort({ startTurn }),
      {
        ensure: async () => ({
          target,
          workspaceId: "main",
          threadId: "thread-1",
          sessionId: "session-1",
        }),
        workspace: () => main,
      } as unknown as SessionRouter,
      {
        activeTurn: () => undefined,
        markTurnStarted: vi.fn(),
      } as unknown as ConversationCore,
      {
        turnOverrides: () => ({}),
        markApplied: vi.fn(),
      } as unknown as ModelSelectionService,
      queryPort(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        listAgentRoles: () => [{ name: "external", description: "第三方模型子代理" }],
      },
    );

    const submission = await service.invokeAgent(target, "4", "执行任务");

    expect(submission.roleName).toBe("external");
    expect(startTurn.mock.calls[0]?.[1]?.[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("agent_type=\"external\""),
    });
  });

  it("rejects agent invocation with an unknown role", async () => {
    const service = new ConversationService(
      turnPort(),
      { workspace: () => main } as unknown as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        listAgentRoles: () => [],
      },
    );

    await expect(service.invokeAgent(target, "ds", "执行任务"))
      .rejects.toMatchObject({ code: "agents.not-found" });
  });

  it("wraps unreadable agent role configuration as a user-facing error", () => {
    const service = new ConversationService(
      turnPort(),
      { workspace: () => main } as unknown as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        listAgentRoles: () => {
          throw new Error("Codex 子代理角色配置无法安全读取");
        },
      },
    );

    let caught: unknown;
    try {
      service.listAgentRoles();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "agents.config-unreadable",
    });
  });




});
