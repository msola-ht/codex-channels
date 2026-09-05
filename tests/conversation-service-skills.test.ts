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

describe("ConversationService Skill operations", () => {
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

  it("invokes an enabled Skill with the official text marker and structured input", async () => {
    const startTurn = vi.fn().mockResolvedValue({ turnId: "turn-1" });
    const markTurnStarted = vi.fn();
    const resolveSkill = vi.fn(async () => ({
      name: "systematic-debugging",
      path: "/workspace/main/.codex/skills/systematic-debugging/SKILL.md",
    }));
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
      queryPort({ resolveSkill }),
    );

    await expect(service.invokeSkill(
      target,
      "systematic-debugging",
      " 排查微信断线 ",
    )).resolves.toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
      skillName: "systematic-debugging",
    });
    expect(resolveSkill).toHaveBeenCalledWith(
      main.cwd,
      "systematic-debugging",
    );
    expect(startTurn.mock.calls[0]?.[1]).toEqual([
      {
        type: "text",
        text: "$systematic-debugging 排查微信断线",
      },
      {
        type: "skill",
        name: "systematic-debugging",
        path: "/workspace/main/.codex/skills/systematic-debugging/SKILL.md",
      },
    ]);
    expect(markTurnStarted).toHaveBeenCalledWith(
      target,
      "thread-1",
      "turn-1",
      { kind: "skill", name: "systematic-debugging" },
    );
  });

  it("keeps Skill resolution and Turn start in one Conversation lock", async () => {
    let releaseSkill: (() => void) | undefined;
    const resolveSkill = vi.fn(() => new Promise<{
      name: string;
      path: string;
    }>((resolveSkillResult) => {
      releaseSkill = () => resolveSkillResult({
        name: "repo-skill",
        path: "/workspace/main/.codex/skills/repo-skill/SKILL.md",
      });
    }));
    let currentWorkspace = main;
    const selectWorkspace = vi.fn(async () => {
      currentWorkspace = other;
      return other;
    });
    const startTurn = vi.fn().mockResolvedValue({ turnId: "turn-1" });
    const service = new ConversationService(
      turnPort({ startTurn }),
      {
        ensure: async () => ({
          target,
          workspaceId: currentWorkspace.id,
          threadId: "thread-1",
          sessionId: "session-1",
        }),
        workspace: () => currentWorkspace,
        resolveWorkspace: () => other,
        selectWorkspace,
      } as unknown as SessionRouter,
      {
        activeTurn: () => undefined,
        markTurnStarted: vi.fn(),
      } as unknown as ConversationCore,
      {
        clear: vi.fn(),
        turnOverrides: () => ({}),
        markApplied: vi.fn(),
      } as unknown as ModelSelectionService,
      queryPort({ resolveSkill }),
    );

    const invocation = service.invokeSkill(target, "repo-skill", "执行任务");
    await vi.waitFor(() => expect(resolveSkill).toHaveBeenCalled());
    const workspaceChange = service.selectWorkspace(target, other.id);
    expect(selectWorkspace).not.toHaveBeenCalled();
    releaseSkill?.();

    await invocation;
    await workspaceChange;

    expect(startTurn).toHaveBeenCalledWith(
      "thread-1",
      expect.any(Array),
      expect.stringMatching(/^codex_connect:/),
      main.cwd,
      {},
    );
    expect(selectWorkspace).toHaveBeenCalledTimes(1);
  });

  it("resolves a Skill list number before invoking and fails closed when stale", async () => {
    const listSkills = vi.fn(async () => [
      { name: "first", description: "第一个" },
      { name: "second", description: "第二个" },
    ]);
    const resolveSkill = vi.fn(async () => undefined);
    const service = new ConversationService(
      turnPort(),
      { workspace: () => main } as unknown as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort({ listSkills, resolveSkill }),
    );

    await expect(service.invokeSkill(target, "2", "执行任务"))
      .rejects.toMatchObject({ code: "skill.not-found" });
    expect(resolveSkill).toHaveBeenCalledWith(main.cwd, "second");
  });
});
