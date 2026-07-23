import { describe, expect, it, vi } from "vitest";

import {
  ConversationCommandService,
  conversationCommandNames,
  isConversationCommandName,
  type ConversationService,
} from "../src/application/index.js";
import type { ConversationTarget } from "../src/conversation-core/index.js";
import { TelegramAccessPolicy } from "../src/policy/index.js";

const target: ConversationTarget = {
  surface: "telegram",
  accountId: "default",
  conversationId: "100",
};

describe("ConversationCommandService", () => {
  it("owns the platform-independent command catalog without duplicates", () => {
    expect(new Set(conversationCommandNames).size).toBe(conversationCommandNames.length);
    expect(conversationCommandNames).toContain("resume");
    expect(conversationCommandNames).toContain("fast");
    expect(conversationCommandNames).toContain("goal");
    expect(isConversationCommandName("status")).toBe(true);
    expect(isConversationCommandName("whoami")).toBe(false);
  });

  it("routes session search and returns typed presentation data", async () => {
    const sessions = [{ id: "thread-1" }];
    const listSessions = vi.fn(async () => sessions);
    const conversations = {
      listSessions,
      status: () => ({ threadId: "thread-1" }),
    } as unknown as ConversationService;
    const commands = new ConversationCommandService(conversations);

    await expect(commands.execute(target, "sessions", " fix ")).resolves.toEqual({
      kind: "sessions",
      sessions,
      currentThreadId: "thread-1",
      archived: false,
      searchTerm: "fix",
    });
    expect(listSessions).toHaveBeenCalledWith(target, { searchTerm: "fix" });
  });

  it("keeps review parsing and business invocation outside Surface adapters", async () => {
    const review = vi.fn(async () => ({
      threadId: "review-thread",
      turnId: "review-turn",
      steered: false,
    }));
    const commands = new ConversationCommandService({
      review,
    } as unknown as ConversationService);

    await expect(commands.execute(target, "review", "branch main")).resolves.toEqual({
      kind: "outcome",
      outcome: { type: "review.started", turnId: "review-turn" },
    });
    expect(review).toHaveBeenCalledWith(target, {
      type: "baseBranch",
      branch: "main",
    });
    await commands.execute(target, "review", "");
    await commands.execute(target, "review", "commit abc");
    await commands.execute(target, "review", "custom inspect auth");
    expect(review).toHaveBeenNthCalledWith(2, target, {
      type: "uncommittedChanges",
    });
    expect(review).toHaveBeenNthCalledWith(3, target, {
      type: "commit",
      sha: "abc",
      title: null,
    });
    expect(review).toHaveBeenNthCalledWith(4, target, {
      type: "custom",
      instructions: "inspect auth",
    });
    await expect(commands.execute(target, "review", "branch")).rejects.toMatchObject({
      code: "review.usage",
      message: "Review 参数无效",
    });
  });

  it("normalizes goal commands before calling the application service", async () => {
    const setGoal = vi.fn(async (_target: ConversationTarget, objective: string) => ({
      threadId: "thread-1",
      objective,
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 0,
      createdAt: 1,
      updatedAt: 1,
    }));
    const commands = new ConversationCommandService({
      setGoal,
    } as unknown as ConversationService);

    await expect(commands.execute(target, "goal", " set ship it ")).resolves.toEqual({
      kind: "outcome",
      outcome: { type: "goal.updated", goal: expect.objectContaining({ objective: "ship it" }) },
    });
    expect(setGoal).toHaveBeenCalledWith(target, "ship it");
  });

  it("queues a follow-up through the shared command boundary", async () => {
    const queueFollowUp = vi.fn(async () => ({ position: 2 }));
    const commands = new ConversationCommandService({
      queueFollowUp,
    } as unknown as ConversationService);

    await expect(commands.execute(target, "queue", " 下一轮检查测试 "))
      .resolves.toEqual({
        kind: "outcome",
        outcome: { type: "turn.follow-up-queued", position: 2 },
      });
    expect(queueFollowUp).toHaveBeenCalledWith(target, "下一轮检查测试");
  });

  it("rejects /queue without a follow-up description", async () => {
    const queueFollowUp = vi.fn();
    const commands = new ConversationCommandService({
      queueFollowUp,
    } as unknown as ConversationService);

    await expect(commands.execute(target, "queue", " "))
      .rejects.toMatchObject({ code: "queue.usage" });
    expect(queueFollowUp).not.toHaveBeenCalled();
  });

  it("routes model and account queries without Surface-specific branching", async () => {
    const state = { model: "gpt-test" };
    const modelState = vi.fn(async () => state);
    const selectModel = vi.fn(async () => state);
    const selectEffort = vi.fn(async () => state);
    const selectFastMode = vi.fn(async () => state);
    const listSkills = vi.fn(async () => ["skill"]);
    const listMcpServers = vi.fn(async () => ["mcp"]);
    const listPlugins = vi.fn(async () => ({ plugins: ["plugin"] }));
    const accountUsage = vi.fn(async () => ({ usage: "usage" }));
    const accountRateLimits = vi.fn(async () => ({ limits: "limits" }));
    const listPermissionProfiles = vi.fn(async () => ["permissions"]);
    const commands = new ConversationCommandService({
      modelState,
      selectModel,
      selectEffort,
      selectFastMode,
      listSkills,
      listMcpServers,
      listPlugins,
      accountUsage,
      accountRateLimits,
      listPermissionProfiles,
    } as unknown as ConversationService);

    await expect(commands.execute(target, "model", "gpt-test")).resolves.toMatchObject({
      kind: "models",
      view: "model",
      state,
    });
    await expect(commands.execute(target, "effort", "high")).resolves.toMatchObject({
      kind: "models",
      view: "effort",
      state,
    });
    await expect(commands.execute(target, "fast", "on")).resolves.toMatchObject({
      kind: "models",
      view: "fast",
      state,
    });
    await expect(commands.execute(target, "skills")).resolves.toEqual({
      kind: "skills",
      entries: ["skill"],
    });
    await expect(commands.execute(target, "mcp")).resolves.toEqual({
      kind: "mcp",
      servers: ["mcp"],
    });
    await expect(commands.execute(target, "plugins")).resolves.toEqual({
      kind: "plugins",
      result: { plugins: ["plugin"] },
    });
    await expect(commands.execute(target, "usage")).resolves.toEqual({
      kind: "usage",
      result: { usage: "usage" },
    });
    await expect(commands.execute(target, "limits")).resolves.toEqual({
      kind: "limits",
      result: { limits: "limits" },
    });
    await expect(commands.execute(target, "permissions")).resolves.toEqual({
      kind: "permissions",
      profiles: ["permissions"],
    });
    expect(selectModel).toHaveBeenCalledWith(target, "gpt-test");
    expect(selectEffort).toHaveBeenCalledWith(target, "high");
    expect(selectFastMode).toHaveBeenCalledWith(target, "on");
  });

  it("covers every registered command through the shared dispatcher", async () => {
    const goal = {
      threadId: "thread-1",
      objective: "ship",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const service = {
      resume: vi.fn(async () => "thread-resumed"),
      listSessions: vi.fn(async () => []),
      status: vi.fn(() => ({ workspaceId: "main" })),
      newSession: vi.fn(async () => undefined),
      archive: vi.fn(async () => "thread-archived"),
      unarchive: vi.fn(async () => "thread-unarchived"),
      selectWorkspace: vi.fn(async () => ({ id: "main", name: "Main", cwd: "/workspace" })),
      listWorkspaces: vi.fn(() => [{ id: "main", name: "Main", cwd: "/workspace" }]),
      stop: vi.fn(async () => true),
      queueFollowUp: vi.fn(async () => ({ position: 1 })),
      rename: vi.fn(async () => undefined),
      compact: vi.fn(async () => undefined),
      fork: vi.fn(async () => "thread-forked"),
      review: vi.fn(async () => ({ threadId: "review-thread", turnId: "review-turn" })),
      selectModel: vi.fn(async () => ({ model: "gpt-test" })),
      selectEffort: vi.fn(async () => ({ model: "gpt-test" })),
      selectFastMode: vi.fn(async () => ({ model: "gpt-test" })),
      listSkills: vi.fn(async () => []),
      listMcpServers: vi.fn(async () => []),
      listPlugins: vi.fn(async () => ({})),
      accountUsage: vi.fn(async () => ({})),
      accountRateLimits: vi.fn(async () => ({})),
      listPermissionProfiles: vi.fn(async () => []),
      artifacts: vi.fn(() => undefined),
      setGoal: vi.fn(async () => goal),
    };
    const commands = new ConversationCommandService(
      service as unknown as ConversationService,
    );
    const cases = [
      ["resume", "thread-1", "resume"],
      ["sessions", "", "listSessions"],
      ["archived", "", "listSessions"],
      ["new", "", "newSession"],
      ["archive", "", "archive"],
      ["unarchive", "thread-1", "unarchive"],
      ["status", "", "status"],
      ["workspace", "main", "selectWorkspace"],
      ["stop", "", "stop"],
      ["queue", "follow up", "queueFollowUp"],
      ["rename", "name", "rename"],
      ["compact", "", "compact"],
      ["fork", "", "fork"],
      ["review", "", "review"],
      ["model", "gpt-test", "selectModel"],
      ["effort", "high", "selectEffort"],
      ["fast", "on", "selectFastMode"],
      ["skills", "", "listSkills"],
      ["mcp", "", "listMcpServers"],
      ["plugins", "", "listPlugins"],
      ["usage", "", "accountUsage"],
      ["limits", "", "accountRateLimits"],
      ["permissions", "", "listPermissionProfiles"],
      ["diff", "", "artifacts"],
      ["plan", "", "artifacts"],
      ["goal", "set ship", "setGoal"],
    ] as const;

    expect(cases.map(([command]) => command)).toEqual(conversationCommandNames);
    for (const [command, input, method] of cases) {
      const before = service[method].mock.calls.length;
      await expect(commands.execute(target, command, input)).resolves.toHaveProperty("kind");
      expect(service[method].mock.calls.length).toBeGreaterThan(before);
    }
  });

  it("returns structured goal query and clear results", async () => {
    const getGoal = vi.fn(async () => null);
    const clearGoal = vi.fn(async () => undefined);
    const commands = new ConversationCommandService({
      getGoal,
      clearGoal,
    } as unknown as ConversationService);

    await expect(commands.execute(target, "goal")).resolves.toEqual({
      kind: "goal",
      goal: null,
    });
    await expect(commands.execute(target, "goal", "clear")).resolves.toEqual({
      kind: "outcome",
      outcome: { type: "goal.cleared" },
    });
  });

  it("rejects incomplete or unknown goal subcommands instead of querying state", async () => {
    const getGoal = vi.fn(async () => null);
    const commands = new ConversationCommandService({
      getGoal,
    } as unknown as ConversationService);

    for (const input of ["set", "clear extra", "unknown"]) {
      await expect(commands.execute(target, "goal", input)).rejects.toMatchObject({
        code: "goal.usage",
      });
    }
    expect(getGoal).not.toHaveBeenCalled();
  });
});

describe("shared Surface access boundary", () => {
  it("uses target and canonical Actor identity and fails closed across Surfaces", () => {
    const access = new TelegramAccessPolicy(new Set([123]), "default");

    expect(access.isAllowed({ target, actorId: "123" })).toBe(true);
    expect(access.isAllowed({ target, actorId: "0123" })).toBe(false);
    expect(access.isAllowed({
      target: { surface: "feishu", accountId: "tenant-a", conversationId: "100" },
      actorId: "123",
    })).toBe(false);
    expect(access.isAllowed({
      target: { surface: "telegram", accountId: "other", conversationId: "100" },
      actorId: "123",
    })).toBe(false);
  });
});
