import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  ConversationService,
  type ConversationQueryPort,
} from "../src/application/conversation-service.js";
import type { ModelSelectionService } from "../src/application/model-selection-service.js";
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
    listMcpServers: unsupported,
    listPlugins: unsupported,
    accountUsage: unsupported,
    accountRateLimits: unsupported,
    listPermissionProfiles: unsupported,
    ...overrides,
  };
}

describe("ConversationService model selection", () => {
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

  it("queues a follow-up for the active Turn without steering it immediately", async () => {
    const steerTurn = vi.fn();
    const service = new ConversationService(
      turnPort({ steerTurn }),
      {} as SessionRouter,
      {
        activeTurn: () => ({ threadId: "thread-1", turnId: "turn-1" }),
      } as unknown as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
    );

    await expect(service.queueFollowUp(target, "下一轮再检查测试"))
      .resolves.toEqual({ position: 1 });
    expect(steerTurn).not.toHaveBeenCalled();
  });

  it("starts the first queued follow-up as a new Turn after the active Turn completes", async () => {
    let active = { threadId: "thread-1", turnId: "turn-1" } as
      | { threadId: string; turnId: string }
      | undefined;
    const startTurn = vi.fn().mockResolvedValue({ turnId: "turn-2" });
    const markTurnStarted = vi.fn(() => {
      active = { threadId: "thread-1", turnId: "turn-2" };
    });
    const service = new ConversationService(
      turnPort({ startTurn }),
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
        activeTurn: () => active,
        markTurnStarted,
      } as unknown as ConversationCore,
      {
        turnOverrides: () => ({}),
        markApplied: vi.fn(),
      } as unknown as ModelSelectionService,
      queryPort(),
    );
    await service.queueFollowUp(target, "下一轮再检查测试");
    active = undefined;

    await expect(service.handleTurnCompleted(target, "thread-1"))
      .resolves.toMatchObject({
        threadId: "thread-1",
        turnId: "turn-2",
        steered: false,
      });
    expect(startTurn).toHaveBeenCalledWith(
      "thread-1",
      [{ type: "text", text: "下一轮再检查测试" }],
      expect.stringMatching(/^codex_connect_gateway:/),
      "/workspace/main",
      {},
    );
  });

  it("starts multiple queued follow-ups one Turn at a time in insertion order", async () => {
    let active = { threadId: "thread-1", turnId: "turn-1" } as
      | { threadId: string; turnId: string }
      | undefined;
    const startTurn = vi.fn()
      .mockResolvedValueOnce({ turnId: "turn-2" })
      .mockResolvedValueOnce({ turnId: "turn-3" });
    const service = new ConversationService(
      turnPort({ startTurn }),
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
        activeTurn: () => active,
        markTurnStarted: (
          _target: typeof target,
          threadId: string,
          turnId: string,
        ) => {
          active = { threadId, turnId };
        },
      } as unknown as ConversationCore,
      {
        turnOverrides: () => ({}),
        markApplied: vi.fn(),
      } as unknown as ModelSelectionService,
      queryPort(),
    );
    await service.queueFollowUp(target, "第一条");
    await service.queueFollowUp(target, "第二条");

    active = undefined;
    await service.handleTurnCompleted(target, "thread-1");
    active = undefined;
    await service.handleTurnCompleted(target, "thread-1");

    expect(startTurn.mock.calls.map((call) => call[1])).toEqual([
      [{ type: "text", text: "第一条" }],
      [{ type: "text", text: "第二条" }],
    ]);
  });

  it("rejects follow-up queuing when no Turn is running", async () => {
    const service = new ConversationService(
      turnPort(),
      {} as SessionRouter,
      { activeTurn: () => undefined } as unknown as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
    );

    await expect(service.queueFollowUp(target, "稍后执行"))
      .rejects.toMatchObject({ code: "queue.inactive" });
  });

  it("rejects follow-ups beyond the per-Conversation queue limit", async () => {
    const service = new ConversationService(
      turnPort(),
      {} as SessionRouter,
      {
        activeTurn: () => ({ threadId: "thread-1", turnId: "turn-1" }),
      } as unknown as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
    );

    for (let index = 1; index <= 10; index += 1) {
      await expect(service.queueFollowUp(target, `任务 ${index}`))
        .resolves.toEqual({ position: index });
    }
    await expect(service.queueFollowUp(target, "任务 11"))
      .rejects.toMatchObject({ code: "queue.full" });
  });

  it("clears queued follow-ups when the next Turn cannot start", async () => {
    let active = { threadId: "thread-1", turnId: "turn-1" } as
      | { threadId: string; turnId: string }
      | undefined;
    const service = new ConversationService(
      turnPort({
        startTurn: vi.fn().mockRejectedValue(new Error("start failed")),
      }),
      {
        current: () => ({
          target,
          workspaceId: "main",
          threadId: "thread-1",
          sessionId: "session-1",
        }),
        workspace: () => main,
      } as unknown as SessionRouter,
      { activeTurn: () => active } as unknown as ConversationCore,
      {
        turnOverrides: () => ({}),
      } as unknown as ModelSelectionService,
      queryPort(),
    );
    await service.queueFollowUp(target, "第一条");
    await service.queueFollowUp(target, "第二条");
    active = undefined;

    await expect(service.handleTurnCompleted(target, "thread-1"))
      .rejects.toThrow("start failed");
    active = { threadId: "thread-1", turnId: "turn-2" };
    await expect(service.queueFollowUp(target, "失败后的新任务"))
      .resolves.toEqual({ position: 1 });
  });

  it("cancels queued follow-ups instead of running them in a different Thread", async () => {
    let active = { threadId: "thread-1", turnId: "turn-1" } as
      | { threadId: string; turnId: string }
      | undefined;
    let currentThreadId = "thread-1";
    const service = new ConversationService(
      turnPort(),
      {
        current: () => ({
          target,
          workspaceId: "main",
          threadId: currentThreadId,
          sessionId: "session-1",
        }),
      } as unknown as SessionRouter,
      { activeTurn: () => active } as unknown as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
    );
    await service.queueFollowUp(target, "只属于旧会话");
    active = undefined;
    currentThreadId = "thread-2";

    await expect(service.handleTurnCompleted(target, "thread-1"))
      .rejects.toMatchObject({ code: "queue.thread-changed" });
    active = { threadId: "thread-2", turnId: "turn-2" };
    await expect(service.queueFollowUp(target, "新会话任务"))
      .resolves.toEqual({ position: 1 });
  });

  it("lists stable installed Skills for the authorized Workspace", async () => {
    const listSkills = vi.fn(async () => [
      { name: "personal", description: "个人" },
      { name: "agents-personal", description: "个人" },
      { name: "repo-skill", description: "项目" },
    ]);
    const service = new ConversationService(
      turnPort(),
      { workspace: () => main } as unknown as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort({ listSkills }),
    );

    const entries = await service.listSkills(target);

    expect(entries.map((skill) => skill.name))
      .toEqual(["personal", "agents-personal", "repo-skill"]);
    expect(listSkills).toHaveBeenCalledWith(main.cwd);
  });

  it("lists MCP summaries for the current Thread", async () => {
    const listMcpServers = vi.fn(async () => [
      { name: "project-tools", authStatus: "oAuth" as const, toolCount: 2 },
    ]);
    const service = new ConversationService(
      turnPort(),
      {
        current: () => ({ threadId: "thread-1" }),
      } as unknown as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort({ listMcpServers }),
    );

    await expect(service.listMcpServers(target)).resolves.toEqual([
      { name: "project-tools", authStatus: "oAuth", toolCount: 2 },
    ]);
    expect(listMcpServers).toHaveBeenCalledWith("thread-1");
  });

  it("lists stable installed Plugins for the authorized Workspace", async () => {
    const listPlugins = vi.fn(async () => [
      { name: "github", enabled: true },
      { name: "local-tools", enabled: false },
    ]);
    const service = new ConversationService(
      turnPort(),
      { workspace: () => main } as unknown as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort({ listPlugins }),
    );

    await expect(service.listPlugins(target)).resolves.toEqual([
      { name: "github", enabled: true },
      { name: "local-tools", enabled: false },
    ]);
    expect(listPlugins).toHaveBeenCalledWith(main.cwd);
  });

  it("lists stable Permission Profiles for the authorized Workspace", async () => {
    const listPermissionProfiles = vi.fn(async () => [
      { id: ":read-only", description: null, allowed: true },
      { id: "project", description: "项目策略", allowed: false },
    ]);
    const service = new ConversationService(
      turnPort(),
      { workspace: () => main } as unknown as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort({ listPermissionProfiles }),
    );

    await expect(service.listPermissionProfiles(target)).resolves.toEqual([
      { id: ":read-only", description: null, allowed: true },
      { id: "project", description: "项目策略", allowed: false },
    ]);
    expect(listPermissionProfiles).toHaveBeenCalledWith(main.cwd);
  });

  it("allows read-only Fast status during an active turn but blocks switching", async () => {
    const selectFastMode = vi.fn().mockResolvedValue({ serviceTier: "fast" });
    const service = new ConversationService(
      turnPort(),
      {} as SessionRouter,
      {
        activeTurn: () => ({ threadId: "thread-1", turnId: "turn-1" }),
      } as unknown as ConversationCore,
      { selectFastMode } as unknown as ModelSelectionService,
      queryPort(),
    );

    await service.selectFastMode(target, "status");
    await expect(service.selectFastMode(target, "off"))
      .rejects.toThrow("当前任务运行中");
    expect(selectFastMode).toHaveBeenCalledTimes(1);
    expect(selectFastMode).toHaveBeenCalledWith(target, "status");
  });

  it("passes pending model settings to the next turn and clears them after success", async () => {
    const startTurn = vi.fn().mockResolvedValue({ turnId: "turn-1" });
    const markApplied = vi.fn();
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
      { activeTurn: () => undefined, markTurnStarted } as unknown as ConversationCore,
      {
        turnOverrides: () => ({ model: "gpt-selected", effort: "high" }),
        markApplied,
      } as unknown as ModelSelectionService,
      queryPort(),
    );

    await service.submit(target, "测试输入");

    expect(startTurn).toHaveBeenCalledWith(
      "thread-1",
      [{ type: "text", text: "测试输入" }],
      expect.stringMatching(/^codex_connect_gateway:/),
      "/workspace/main",
      { model: "gpt-selected", effort: "high" },
    );
    expect(markApplied).toHaveBeenCalledWith(target);
    expect(markTurnStarted).toHaveBeenCalledWith(target, "thread-1", "turn-1");
  });

  it("passes text and local images to a new turn", async () => {
    const startTurn = vi.fn().mockResolvedValue({ turnId: "turn-1" });
    const service = new ConversationService(
      turnPort({ startTurn }),
      {
        ensure: async () => ({ target, workspaceId: "main", threadId: "thread-1", sessionId: "session-1" }),
        workspace: () => main,
      } as unknown as SessionRouter,
      { activeTurn: () => undefined, markTurnStarted: vi.fn() } as unknown as ConversationCore,
      { turnOverrides: () => ({}), markApplied: vi.fn() } as unknown as ModelSelectionService,
      queryPort(),
    );

    await service.submit(target, {
      text: "检查截图",
      localImages: [{ path: "/private/uploads/screenshot.png" }],
    });

    expect(startTurn.mock.calls[0]?.[1]).toEqual([
      { type: "text", text: "检查截图" },
      { type: "localImage", path: "/private/uploads/screenshot.png" },
    ]);
  });

  it("steers local images into the active turn", async () => {
    const steerTurn = vi.fn().mockResolvedValue({ turnId: "turn-1" });
    const service = new ConversationService(
      turnPort({ steerTurn }),
      {} as SessionRouter,
      { activeTurn: () => ({ threadId: "thread-1", turnId: "turn-1" }) } as unknown as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
    );

    const submission = await service.submit(target, {
      text: "补充图片",
      localImages: [{ path: "/private/uploads/extra.jpg" }],
    });

    expect(steerTurn).toHaveBeenCalledWith(
      "thread-1",
      "turn-1",
      [
        { type: "text", text: "补充图片" },
        { type: "localImage", path: "/private/uploads/extra.jpg" },
      ],
      expect.stringMatching(/^codex_connect_gateway:/),
    );
    expect(submission.steered).toBe(true);
  });

  it("rejects relative image paths at the application boundary", async () => {
    const service = new ConversationService(
      turnPort(),
      {} as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
    );

    await expect(service.submit(target, {
      localImages: [{ path: "relative/image.png" }],
    })).rejects.toThrow("本地图片路径必须是绝对路径");
  });

  it("uses the stable Turn port for control, Review and Goal operations", async () => {
    let active = { threadId: "thread-1", turnId: "turn-1" } as
      | { threadId: string; turnId: string }
      | undefined;
    const interruptTurn = vi.fn(async () => undefined);
    const setThreadName = vi.fn(async () => undefined);
    const compactThread = vi.fn(async () => undefined);
    const startReview = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "review-turn-1",
    }));
    const goal = {
      threadId: "thread-1",
      objective: "完成阶段 2",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const getGoal = vi.fn(async () => goal);
    const setGoal = vi.fn(async () => goal);
    const clearGoal = vi.fn(async () => undefined);
    const markTurnStarted = vi.fn();
    const service = new ConversationService(
      turnPort({
        interruptTurn,
        setThreadName,
        compactThread,
        startReview,
        getGoal,
        setGoal,
        clearGoal,
      }),
      {
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
      } as unknown as SessionRouter,
      {
        activeTurn: () => active,
        markTurnStarted,
        handle: vi.fn(),
      } as unknown as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
    );

    await expect(service.stop(target)).resolves.toBe(true);
    active = undefined;
    await service.rename(target, "新名称");
    await service.compact(target);
    await expect(service.review(target, { type: "uncommittedChanges" }))
      .resolves.toEqual({
        threadId: "thread-1",
        turnId: "review-turn-1",
        steered: false,
      });
    await expect(service.getGoal(target)).resolves.toEqual(goal);
    await expect(service.setGoal(target, "完成阶段 2")).resolves.toEqual(goal);
    await service.clearGoal(target);

    expect(interruptTurn).toHaveBeenCalledWith("thread-1", "turn-1");
    expect(setThreadName).toHaveBeenCalledWith("thread-1", "新名称");
    expect(compactThread).toHaveBeenCalledWith("thread-1");
    expect(startReview).toHaveBeenCalledWith("thread-1", { type: "uncommittedChanges" });
    expect(markTurnStarted).toHaveBeenCalledWith(target, "thread-1", "review-turn-1");
    expect(setGoal).toHaveBeenCalledWith("thread-1", "完成阶段 2");
    expect(clearGoal).toHaveBeenCalledWith("thread-1");
  });

  it("keeps pending settings when selecting the same workspace", async () => {
    const clear = vi.fn();
    const service = workspaceService(main, async () => main, clear);

    await service.selectWorkspace(target, "main");

    expect(clear).not.toHaveBeenCalled();
  });

  it("only clears pending settings after a workspace switch succeeds", async () => {
    const clear = vi.fn();
    const successful = workspaceService(main, async () => other, clear);

    await successful.selectWorkspace(target, "other");
    expect(clear).toHaveBeenCalledWith(target);

    clear.mockClear();
    const failed = workspaceService(main, async () => {
      throw new Error("switch failed");
    }, clear);
    await expect(failed.selectWorkspace(target, "other")).rejects.toThrow("switch failed");
    expect(clear).not.toHaveBeenCalled();
  });
});

function workspaceService(
  current: typeof main,
  selectWorkspace: () => Promise<typeof main>,
  clear: ReturnType<typeof vi.fn>,
): ConversationService {
  return new ConversationService(
    turnPort(),
    {
      workspace: () => current,
      resolveWorkspace: (selector: string) => selector === "other" ? other : main,
      selectWorkspace,
    } as unknown as SessionRouter,
    { activeTurn: () => undefined } as unknown as ConversationCore,
    { clear } as unknown as ModelSelectionService,
    queryPort(),
  );
}
