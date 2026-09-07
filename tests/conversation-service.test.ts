import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  ConversationService,
  type ConversationQueryPort,
} from "../src/application/conversation-service.js";
import type { ModelSelectionService } from "../src/application/model-selection-service.js";
import type { CollaborationModeSelectionService } from "../src/application/collaboration-mode-service.js";
import {
  estimateWeeklyLimit,
  type RequestMetricsQueryPort,
} from "../src/application/request-metrics-port.js";
import type { TurnExecutionPort } from "../src/application/turn-port.js";
import {
  ConversationCore,
  type ConversationRoutingPort,
  type OutputEvent,
} from "../src/conversation-core/index.js";
import { EventBus } from "../src/event-bus/index.js";
import type { SessionRouter } from "../src/session-routing/router.js";

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

describe("ConversationService model selection", () => {
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
      pricingCurrency: "USD",
      pricedRequestCount: 38,
      totalCostNanos: 400_000_000,
    });

    expect(estimate).toMatchObject({
      usedPercent: 20,
      remainingPercent: 80,
      requestCount: 40,
      inputTokensPerPercent: 90_000,
      outputTokensPerPercent: 10_000,
      totalTokensPerPercent: 100_000,
      remainingTokens: 8_000_000,
      pricingCurrency: "USD",
      costPerPercentNanos: 200_000_000,
      remainingCostNanos: 16_000_000_000,
    });
  });

  it("does not estimate without an aligned weekly window or proxy samples", () => {
    const limit = {
      limitId: "codex",
      limitName: null,
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
      pricingCurrency: "USD",
      pricedRequestCount: 2,
      totalCostNanos: 40_000_000,
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
            resetCreditsAvailable: null,
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
          costPerPercentNanos: 4_000_000,
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

  it("includes the current Core Goal in Conversation status", () => {
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
    const currentGitBranch = vi.fn(() => "feature/weixin-surface");
    const service = new ConversationService(
      turnPort(),
      {
        current: () => ({
          target,
          workspaceId: "main",
          threadId: "thread-1",
          sessionId: "session-1",
        }),
        workspace: () => main,
      } as unknown as SessionRouter,
      {
        activeTurn: () => undefined,
        tokenUsage: () => undefined,
        goal: () => goal,
        contextCompactionCount: () => 2,
        weeklyRateLimit: () => undefined,
      } as unknown as ConversationCore,
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
      undefined,
      { currentGitBranch },
    );

    expect(service.status(target, { includeGitBranch: true })).toMatchObject({
      threadId: "thread-1",
      goal,
      contextCompactionCount: 2,
      gitBranch: "feature/weixin-surface",
    });
    expect(currentGitBranch).toHaveBeenCalledWith(main.cwd);
  });

  it("applies project rules only to the selected authorized Workspace", async () => {
    const result = {
      projectRoot: main.cwd,
      rulesPath: `${main.cwd}/.codex/rules/default.rules`,
    };
    const initialize = vi.fn(async () => result);
    const check = vi.fn(async () => result);
    const service = new ConversationService(
      turnPort(),
      { workspace: () => main } as unknown as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
      { initialize, check },
    );

    await expect(service.initializeProjectRules(target)).resolves.toEqual(result);
    await expect(service.checkProjectRules(target)).resolves.toEqual(result);
    expect(initialize).toHaveBeenCalledWith(main.cwd);
    expect(check).toHaveBeenCalledWith(main.cwd);
  });

  it("maps project rule runtime failures to stable user-facing errors", async () => {
    const service = new ConversationService(
      turnPort(),
      { workspace: () => main } as unknown as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
      {
        initialize: () => {
          throw Object.assign(new Error("internal path"), { code: "exists" });
        },
        check: () => {
          throw Object.assign(new Error("internal command"), { code: "check-failed" });
        },
      },
    );

    await expect(service.initializeProjectRules(target))
      .rejects.toMatchObject({ code: "rules.exists" });
    await expect(service.checkProjectRules(target))
      .rejects.toMatchObject({ code: "rules.check-failed" });
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
          model: "deepseek-v4-flash-vision-exp",
          modelProvider: "deepseek",
          effort: "high",
        }),
        turnOverrides: () => ({
          model: "deepseek-v4-flash-vision-exp",
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
