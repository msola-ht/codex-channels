import { describe, expect, it, vi } from "vitest";

import {
  ConversationService,
  type ConversationQueryPort,
} from "../src/application/conversation-service.js";
import type { ModelSelectionService } from "../src/application/model-selection-service.js";
import type { TurnExecutionPort } from "../src/application/turn-port.js";
import { ConversationCore } from "../src/conversation-core/index.js";
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

describe("ConversationService conversation service input control", () => {
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
      expect.stringMatching(/^codex_connect:/),
      "/workspace/main",
      { model: "gpt-selected", effort: "high" },
    );
    expect(markApplied).toHaveBeenCalledWith(target);
    expect(markTurnStarted).toHaveBeenCalledWith(target, "thread-1", "turn-1");
  });

  it("passes text and inline images to a new turn", async () => {
    const startTurn = vi.fn().mockResolvedValue({ turnId: "turn-1" });
    const requireInputModality = vi.fn().mockResolvedValue(undefined);
    const service = new ConversationService(
      turnPort({ startTurn }),
      {
        ensure: async () => ({ target, workspaceId: "main", threadId: "thread-1", sessionId: "session-1" }),
        workspace: () => main,
        modelSettingsForThread: () => ({
          model: "deepseek-v4-flash",
          modelProvider: "deepseek",
          effort: "high",
          serviceTier: null,
          collaborationMode: "default",
        }),
      } as unknown as SessionRouter,
      { activeTurn: () => undefined, markTurnStarted: vi.fn() } as unknown as ConversationCore,
      {
        requireInputModality,
        turnOverrides: () => ({}),
        markApplied: vi.fn(),
      } as unknown as ModelSelectionService,
      queryPort(),
    );

    await service.submit(target, {
      text: "检查截图",
      images: [{ url: "data:image/png;base64,AA==" }],
    });

    expect(startTurn.mock.calls[0]?.[1]).toEqual([
      { type: "text", text: "检查截图" },
      { type: "image", url: "data:image/png;base64,AA==" },
    ]);
    expect(requireInputModality).toHaveBeenCalledWith(target, "image");
  });

  it.each(["jpeg", "gif", "webp"])(
    "steers inline %s images into the active turn",
    async (format) => {
    const steerTurn = vi.fn().mockResolvedValue({ turnId: "turn-1" });
    const requireInputModality = vi.fn().mockResolvedValue(undefined);
    const service = new ConversationService(
      turnPort({ steerTurn }),
      {} as SessionRouter,
      { activeTurn: () => ({ threadId: "thread-1", turnId: "turn-1" }) } as unknown as ConversationCore,
      { requireInputModality } as unknown as ModelSelectionService,
      queryPort(),
    );

    const submission = await service.submit(target, {
      text: "补充图片",
      images: [{ url: `data:image/${format};base64,AA==` }],
    });

    expect(steerTurn).toHaveBeenCalledWith(
      "thread-1",
      "turn-1",
      [
        { type: "text", text: "补充图片" },
        { type: "image", url: `data:image/${format};base64,AA==` },
      ],
      expect.stringMatching(/^codex_connect:/),
    );
    expect(submission.steered).toBe(true);
    expect(requireInputModality).toHaveBeenCalledWith(target, "image");
    },
  );

  it("rejects non-data image URLs at the application boundary", async () => {
    const service = new ConversationService(
      turnPort(),
      {} as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
    );

    await expect(service.submit(target, {
      images: [{ url: "https://example.com/image.png" }],
    })).rejects.toThrow("图片必须使用 PNG、JPEG、WebP 或非动画 GIF Base64 Data URL");
  });

  it.each([
    "data:image/png;base64,",
    "data:image/png;base64,A=",
    "data:image/jpeg;base64,AAAA=",
  ])("rejects malformed inline image Data URL %s", async (url) => {
    const service = new ConversationService(
      turnPort(),
      {} as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
    );

    await expect(service.submit(target, { images: [{ url }] }))
      .rejects.toThrow("图片必须使用 PNG、JPEG、WebP 或非动画 GIF Base64 Data URL");
  });

  it("rejects inline images before creating a Turn when the current model lacks image input", async () => {
    const startTurn = vi.fn();
    const requireInputModality = vi.fn().mockRejectedValue(
      new Error("当前模型 deepseek-v4-flash 不支持图片输入，请发送文字或切换支持图片的模型"),
    );
    const service = new ConversationService(
      turnPort({ startTurn }),
      {
        ensure: vi.fn(),
        workspace: () => main,
      } as unknown as SessionRouter,
      { activeTurn: () => undefined } as unknown as ConversationCore,
      { requireInputModality } as unknown as ModelSelectionService,
      queryPort(),
    );

    await expect(service.submit(target, {
      images: [{ url: "data:image/png;base64,AA==" }],
    })).rejects.toThrow(
      "当前模型 deepseek-v4-flash 不支持图片输入，请发送文字或切换支持图片的模型",
    );
    expect(requireInputModality).toHaveBeenCalledWith(target, "image");
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("passes local audio to a new turn", async () => {
    const startTurn = vi.fn().mockResolvedValue({ turnId: "turn-1" });
    const requireInputModality = vi.fn().mockResolvedValue(undefined);
    const service = new ConversationService(
      turnPort({ startTurn }),
      {
        ensure: async () => ({ target, workspaceId: "main", threadId: "thread-1", sessionId: "session-1" }),
        workspace: () => main,
      } as unknown as SessionRouter,
      { activeTurn: () => undefined, markTurnStarted: vi.fn() } as unknown as ConversationCore,
      {
        requireInputModality,
        turnOverrides: () => ({}),
        markApplied: vi.fn(),
      } as unknown as ModelSelectionService,
      queryPort(),
    );

    await service.submit(target, {
      text: "分析语音",
      localAudios: [{ path: "/private/uploads/voice.ogg" }],
    });

    expect(startTurn.mock.calls[0]?.[1]).toEqual([
      { type: "text", text: "分析语音" },
      { type: "localAudio", path: "/private/uploads/voice.ogg" },
    ]);
    expect(requireInputModality).toHaveBeenCalledWith(target, "audio");
  });

  it("rejects local audio before creating a Turn when the current model lacks audio input", async () => {
    const startTurn = vi.fn();
    const service = new ConversationService(
      turnPort({ startTurn }),
      {
        ensure: vi.fn(),
        workspace: () => main,
      } as unknown as SessionRouter,
      { activeTurn: () => undefined } as unknown as ConversationCore,
      {
        requireInputModality: vi.fn().mockRejectedValue(
          new Error("当前模型 gpt-main 不支持语音输入，请发送文字或图片"),
        ),
      } as unknown as ModelSelectionService,
      queryPort(),
    );

    await expect(service.submit(target, {
      localAudios: [{ path: "/private/uploads/voice.ogg" }],
    })).rejects.toThrow("当前模型 gpt-main 不支持语音输入，请发送文字或图片");
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("rejects relative audio paths at the application boundary", async () => {
    const service = new ConversationService(
      turnPort(),
      {} as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
    );

    await expect(service.submit(target, {
      localAudios: [{ path: "relative/voice.ogg" }],
    })).rejects.toThrow("本地音频路径必须是绝对路径");
  });

  it("uses the stable Turn port for control, Review and Goal operations", async () => {
    let active = { threadId: "thread-1", turnId: "turn-1" } as
      | { threadId: string; turnId: string }
      | undefined;
    const interruptTurn = vi.fn(async () => undefined);
    const setThreadName = vi.fn(async () => undefined);
    const setThreadPinned = vi.fn(async () => true);
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
        setThreadPinned,
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
    await service.setPinned(target, true);
    await service.setPinned(target, false);
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
    expect(setThreadPinned).toHaveBeenNthCalledWith(1, "thread-1", true);
    expect(setThreadPinned).toHaveBeenNthCalledWith(2, "thread-1", false);
    expect(compactThread).toHaveBeenCalledWith("thread-1");
    expect(startReview).toHaveBeenCalledWith("thread-1", { type: "uncommittedChanges" });
    expect(markTurnStarted).toHaveBeenCalledWith(target, "thread-1", "review-turn-1");
    expect(setGoal).toHaveBeenCalledWith("thread-1", "完成阶段 2");
    expect(clearGoal).toHaveBeenCalledWith("thread-1");
  });

  it("stops an active Turn without waiting for an in-flight conversation operation", async () => {
    let releaseSteer: () => void = () => undefined;
    const steerPending = new Promise<{ turnId: string }>((resolve) => {
      releaseSteer = () => resolve({ turnId: "turn-1" });
    });
    const steerTurn = vi.fn(() => steerPending);
    const interruptTurn = vi.fn(async () => undefined);
    const service = new ConversationService(
      turnPort({ steerTurn, interruptTurn }),
      {
        current: () => ({
          target,
          workspaceId: "main",
          threadId: "thread-1",
          sessionId: "session-1",
        }),
        workspace: () => ({
          id: "main",
          name: "Main",
          cwd: "/workspace",
        }),
      } as unknown as SessionRouter,
      {
        activeTurn: () => ({ threadId: "thread-1", turnId: "turn-1" }),
      } as unknown as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
    );

    const submission = service.submit(target, "补充消息");
    await vi.waitFor(() => expect(steerTurn).toHaveBeenCalledOnce());
    const stopping = service.stop(target);
    const stoppedBeforeSteerSettled = await Promise.race([
      stopping.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);

    releaseSteer();
    await submission;
    await stopping;

    expect(stoppedBeforeSteerSettled).toBe(true);
    expect(interruptTurn).toHaveBeenCalledWith("thread-1", "turn-1");
  });
});
