import { describe, expect, it, vi } from "vitest";

import { ConversationService } from "../src/application/conversation-service.js";
import type { ModelSelectionService } from "../src/application/model-selection-service.js";
import type { CodexAppServerClient } from "../src/codex-client/client.js";
import type { ConversationCore } from "../src/conversation-core/core.js";
import type { SessionRouter } from "../src/session-routing/router.js";

const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
const main = { id: "main", name: "Main", cwd: "/workspace/main" };
const other = { id: "other", name: "Other", cwd: "/workspace/other" };

describe("ConversationService model selection", () => {
  it("applies project rules only to the selected authorized Workspace", async () => {
    const result = {
      projectRoot: main.cwd,
      rulesPath: `${main.cwd}/.codex/rules/default.rules`,
    };
    const initialize = vi.fn(async () => result);
    const check = vi.fn(async () => result);
    const service = new ConversationService(
      {} as CodexAppServerClient,
      { workspace: () => main } as unknown as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      { initialize, check },
    );

    await expect(service.initializeProjectRules(target)).resolves.toEqual(result);
    await expect(service.checkProjectRules(target)).resolves.toEqual(result);
    expect(initialize).toHaveBeenCalledWith(main.cwd);
    expect(check).toHaveBeenCalledWith(main.cwd);
  });

  it("maps project rule runtime failures to stable user-facing errors", async () => {
    const service = new ConversationService(
      {} as CodexAppServerClient,
      { workspace: () => main } as unknown as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
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
      { steerTurn } as unknown as CodexAppServerClient,
      {} as SessionRouter,
      {
        activeTurn: () => ({ threadId: "thread-1", turnId: "turn-1" }),
      } as unknown as ConversationCore,
      {} as ModelSelectionService,
    );

    await expect(service.queueFollowUp(target, "下一轮再检查测试"))
      .resolves.toEqual({ position: 1 });
    expect(steerTurn).not.toHaveBeenCalled();
  });

  it("starts the first queued follow-up as a new Turn after the active Turn completes", async () => {
    let active = { threadId: "thread-1", turnId: "turn-1" } as
      | { threadId: string; turnId: string }
      | undefined;
    const startTurn = vi.fn().mockResolvedValue({ turn: { id: "turn-2" } });
    const markTurnStarted = vi.fn(() => {
      active = { threadId: "thread-1", turnId: "turn-2" };
    });
    const service = new ConversationService(
      { startTurn } as unknown as CodexAppServerClient,
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
      [{ type: "text", text: "下一轮再检查测试", text_elements: [] }],
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
      .mockResolvedValueOnce({ turn: { id: "turn-2" } })
      .mockResolvedValueOnce({ turn: { id: "turn-3" } });
    const service = new ConversationService(
      { startTurn } as unknown as CodexAppServerClient,
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
    );
    await service.queueFollowUp(target, "第一条");
    await service.queueFollowUp(target, "第二条");

    active = undefined;
    await service.handleTurnCompleted(target, "thread-1");
    active = undefined;
    await service.handleTurnCompleted(target, "thread-1");

    expect(startTurn.mock.calls.map((call) => call[1])).toEqual([
      [{ type: "text", text: "第一条", text_elements: [] }],
      [{ type: "text", text: "第二条", text_elements: [] }],
    ]);
  });

  it("rejects follow-up queuing when no Turn is running", async () => {
    const service = new ConversationService(
      {} as CodexAppServerClient,
      {} as SessionRouter,
      { activeTurn: () => undefined } as unknown as ConversationCore,
      {} as ModelSelectionService,
    );

    await expect(service.queueFollowUp(target, "稍后执行"))
      .rejects.toMatchObject({ code: "queue.inactive" });
  });

  it("rejects follow-ups beyond the per-Conversation queue limit", async () => {
    const service = new ConversationService(
      {} as CodexAppServerClient,
      {} as SessionRouter,
      {
        activeTurn: () => ({ threadId: "thread-1", turnId: "turn-1" }),
      } as unknown as ConversationCore,
      {} as ModelSelectionService,
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
      {
        startTurn: vi.fn().mockRejectedValue(new Error("start failed")),
      } as unknown as CodexAppServerClient,
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
      {} as CodexAppServerClient,
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

  it("lists directly installed user and project Skills without bundled Skills", async () => {
    const listSkills = vi.fn(async () => [{
      cwd: main.cwd,
      errors: [],
      skills: [
        {
          name: "personal",
          description: "个人",
          path: "/Users/test/.codex/skills/personal/SKILL.md",
          scope: "user" as const,
          enabled: true,
        },
        {
          name: "agents-personal",
          description: "个人",
          path: "/Users/test/.agents/skills/agents-personal/SKILL.md",
          scope: "user" as const,
          enabled: true,
        },
        {
          name: "plugin:skill",
          description: "插件",
          path: "/Users/test/.codex/plugins/cache/plugin/skills/example/SKILL.md",
          scope: "user" as const,
          enabled: true,
        },
        {
          name: "system-skill",
          description: "系统",
          path: "/Users/test/.codex/skills/.system/system-skill/SKILL.md",
          scope: "system" as const,
          enabled: true,
        },
        {
          name: "repo-skill",
          description: "项目",
          path: "/workspace/main/.codex/skills/repo-skill/SKILL.md",
          scope: "repo" as const,
          enabled: true,
        },
        {
          name: "disabled",
          description: "禁用",
          path: "/Users/test/.codex/skills/disabled/SKILL.md",
          scope: "user" as const,
          enabled: false,
        },
      ],
    }]);
    const service = new ConversationService(
      { listSkills } as unknown as CodexAppServerClient,
      { workspace: () => main } as unknown as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
    );

    const entries = await service.listSkills(target);

    expect(entries.flatMap((entry) => entry.skills).map((skill) => skill.name))
      .toEqual(["personal", "agents-personal", "repo-skill"]);
    expect(listSkills).toHaveBeenCalledWith(main.cwd);
  });

  it("allows read-only Fast status during an active turn but blocks switching", async () => {
    const selectFastMode = vi.fn().mockResolvedValue({ serviceTier: "fast" });
    const service = new ConversationService(
      {} as CodexAppServerClient,
      {} as SessionRouter,
      {
        activeTurn: () => ({ threadId: "thread-1", turnId: "turn-1" }),
      } as unknown as ConversationCore,
      { selectFastMode } as unknown as ModelSelectionService,
    );

    await service.selectFastMode(target, "status");
    await expect(service.selectFastMode(target, "off"))
      .rejects.toThrow("当前任务运行中");
    expect(selectFastMode).toHaveBeenCalledTimes(1);
    expect(selectFastMode).toHaveBeenCalledWith(target, "status");
  });

  it("passes pending model settings to the next turn and clears them after success", async () => {
    const startTurn = vi.fn().mockResolvedValue({ turn: { id: "turn-1" } });
    const markApplied = vi.fn();
    const markTurnStarted = vi.fn();
    const service = new ConversationService(
      { startTurn } as unknown as CodexAppServerClient,
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
    );

    await service.submit(target, "测试输入");

    expect(startTurn).toHaveBeenCalledWith(
      "thread-1",
      [{ type: "text", text: "测试输入", text_elements: [] }],
      expect.stringMatching(/^codex_connect_gateway:/),
      "/workspace/main",
      { model: "gpt-selected", effort: "high" },
    );
    expect(markApplied).toHaveBeenCalledWith(target);
    expect(markTurnStarted).toHaveBeenCalledWith(target, "thread-1", "turn-1");
  });

  it("passes text and local images to a new turn", async () => {
    const startTurn = vi.fn().mockResolvedValue({ turn: { id: "turn-1" } });
    const service = new ConversationService(
      { startTurn } as unknown as CodexAppServerClient,
      {
        ensure: async () => ({ target, workspaceId: "main", threadId: "thread-1", sessionId: "session-1" }),
        workspace: () => main,
      } as unknown as SessionRouter,
      { activeTurn: () => undefined, markTurnStarted: vi.fn() } as unknown as ConversationCore,
      { turnOverrides: () => ({}), markApplied: vi.fn() } as unknown as ModelSelectionService,
    );

    await service.submit(target, {
      text: "检查截图",
      localImages: [{ path: "/private/uploads/screenshot.png" }],
    });

    expect(startTurn.mock.calls[0]?.[1]).toEqual([
      { type: "text", text: "检查截图", text_elements: [] },
      { type: "localImage", path: "/private/uploads/screenshot.png" },
    ]);
  });

  it("steers local images into the active turn", async () => {
    const steerTurn = vi.fn().mockResolvedValue({ turnId: "turn-1" });
    const service = new ConversationService(
      { steerTurn } as unknown as CodexAppServerClient,
      {} as SessionRouter,
      { activeTurn: () => ({ threadId: "thread-1", turnId: "turn-1" }) } as unknown as ConversationCore,
      {} as ModelSelectionService,
    );

    const submission = await service.submit(target, {
      text: "补充图片",
      localImages: [{ path: "/private/uploads/extra.jpg" }],
    });

    expect(steerTurn).toHaveBeenCalledWith(
      "thread-1",
      "turn-1",
      [
        { type: "text", text: "补充图片", text_elements: [] },
        { type: "localImage", path: "/private/uploads/extra.jpg" },
      ],
      expect.stringMatching(/^codex_connect_gateway:/),
    );
    expect(submission.steered).toBe(true);
  });

  it("rejects relative image paths at the application boundary", async () => {
    const service = new ConversationService(
      {} as CodexAppServerClient,
      {} as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
    );

    await expect(service.submit(target, {
      localImages: [{ path: "relative/image.png" }],
    })).rejects.toThrow("本地图片路径必须是绝对路径");
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
    {} as CodexAppServerClient,
    {
      workspace: () => current,
      resolveWorkspace: (selector: string) => selector === "other" ? other : main,
      selectWorkspace,
    } as unknown as SessionRouter,
    { activeTurn: () => undefined } as unknown as ConversationCore,
    { clear } as unknown as ModelSelectionService,
  );
}
