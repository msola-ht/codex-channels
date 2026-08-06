import { describe, expect, it, vi } from "vitest";

import {
  ConversationCommandService,
  conversationCommandNames,
  isConversationCommandName,
  type ConversationUseCases,
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
    expect(conversationCommandNames).toContain("metrics");
    expect(conversationCommandNames).toContain("goal");
    expect(conversationCommandNames).toContain("pin");
    expect(conversationCommandNames).toContain("rules");
    expect(isConversationCommandName("status")).toBe(true);
    expect(isConversationCommandName("whoami")).toBe(false);
  });

  it("routes project rule generation and checks through the application boundary", async () => {
    const result = {
      projectRoot: "/workspace/project",
      rulesPath: "/workspace/project/.codex/rules/default.rules",
    };
    const initializeProjectRules = vi.fn(async () => result);
    const checkProjectRules = vi.fn(async () => result);
    const commands = new ConversationCommandService({
      initializeProjectRules,
      checkProjectRules,
    } as unknown as ConversationUseCases);

    await expect(commands.execute(target, "rules", "init")).resolves.toEqual({
      kind: "project-rules",
      action: "initialized",
      ...result,
    });
    await expect(commands.execute(target, "rules", "check")).resolves.toEqual({
      kind: "project-rules",
      action: "checked",
      ...result,
    });
    await expect(commands.execute(target, "rules", "--force"))
      .rejects.toMatchObject({ code: "rules.usage" });
    expect(initializeProjectRules).toHaveBeenCalledWith(target);
    expect(checkProjectRules).toHaveBeenCalledWith(target);
  });

  it("routes session search and returns typed presentation data", async () => {
    const sessions = [{ id: "thread-1" }];
    const listSessions = vi.fn(async () => sessions);
    const conversations = {
      listSessions,
      status: () => ({ threadId: "thread-1" }),
    } as unknown as ConversationUseCases;
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

  it("shows and updates workspace permissions through /workspaceperm", async () => {
    const workspace = {
      id: "main",
      name: "Main",
      cwd: "/workspace",
      sandbox: "workspace-write",
    };
    const updateWorkspacePermissions = vi.fn(async () => ({
      ...workspace,
      approvalPolicy: "never",
    }));
    const commands = new ConversationCommandService({
      status: () => ({ workspaceId: "main" }),
      listWorkspaces: () => [workspace],
      updateWorkspacePermissions,
    } as unknown as ConversationUseCases);

    await expect(commands.execute(target, "workspaceperm")).resolves.toEqual({
      kind: "workspace-permissions",
      workspace,
    });
    await expect(
      commands.execute(target, "workspaceperm", "approval never"),
    ).resolves.toEqual({
      kind: "outcome",
      outcome: {
        type: "workspace.permissions-updated",
        workspace: { ...workspace, approvalPolicy: "never" },
      },
    });
    expect(updateWorkspacePermissions).toHaveBeenCalledWith(target, {
      kind: "approval",
      value: "never",
    });
  });

  it("rejects invalid workspace permission values", async () => {
    const commands = new ConversationCommandService({
      status: () => ({ workspaceId: "main" }),
      listWorkspaces: () => [{ id: "main", name: "Main", cwd: "/workspace" }],
    } as unknown as ConversationUseCases);

    await expect(commands.execute(target, "workspaceperm", "sandbox root"))
      .rejects.toMatchObject({ code: "workspace.permission.usage" });
  });

  it("parses canonical metrics scopes and bounded time ranges", async () => {
    const requestMetrics = vi.fn(() => null);
    const commands = new ConversationCommandService({
      requestMetrics,
    } as unknown as ConversationUseCases);

    await commands.execute(target, "metrics");
    await commands.execute(target, "metrics", "session");
    await commands.execute(target, "metrics", "global 7d");
    await commands.execute(target, "metrics", "providers");
    await commands.execute(target, "metrics", "models 30d");
    await commands.execute(target, "metrics", "errors 7d");

    expect(requestMetrics).toHaveBeenNthCalledWith(1, target, { view: "session" });
    expect(requestMetrics).toHaveBeenNthCalledWith(2, target, { view: "session" });
    expect(requestMetrics).toHaveBeenNthCalledWith(3, target, {
      view: "global",
      range: "7d",
    });
    expect(requestMetrics).toHaveBeenNthCalledWith(4, target, {
      view: "providers",
      range: "24h",
    });
    expect(requestMetrics).toHaveBeenNthCalledWith(5, target, {
      view: "models",
      range: "30d",
    });
    expect(requestMetrics).toHaveBeenNthCalledWith(6, target, {
      view: "errors",
      range: "7d",
    });
    await expect(commands.execute(target, "metrics", "provider 7d"))
      .rejects.toMatchObject({ code: "metrics.usage" });
    await expect(commands.execute(target, "metrics", "global 1y"))
      .rejects.toMatchObject({ code: "metrics.usage" });
  });

  it("preserves automatic takeover details in the shared resume outcome", async () => {
    const commands = new ConversationCommandService({
      resume: vi.fn(async () => ({
        threadId: "thread-shared",
        transferredFrom: "weixin",
      })),
    } as unknown as ConversationUseCases);

    await expect(commands.execute(target, "resume", "thread-shared"))
      .resolves.toEqual({
        kind: "outcome",
        outcome: {
          type: "thread.resumed",
          threadId: "thread-shared",
          transferredFrom: "weixin",
        },
      });
  });

  it("keeps review parsing and business invocation outside Surface adapters", async () => {
    const review = vi.fn(async () => ({
      threadId: "review-thread",
      turnId: "review-turn",
      steered: false,
    }));
    const commands = new ConversationCommandService({
      review,
    } as unknown as ConversationUseCases);

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

  it("uses canonical /plan to toggle mode or start a Plan Turn with an inline prompt", async () => {
    const togglePlanMode = vi.fn(async () => ({ mode: "plan" as const, pending: true }));
    const startPlan = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-plan",
      steered: false,
    }));
    const commands = new ConversationCommandService({
      togglePlanMode,
      startPlan,
    } as unknown as ConversationUseCases);

    await expect(commands.execute(target, "plan")).resolves.toEqual({
      kind: "collaboration-mode",
      state: { mode: "plan", pending: true },
    });
    await expect(commands.execute(target, "plan", " 设计发布流程 ")).resolves.toEqual({
      kind: "outcome",
      outcome: { type: "plan.started", turnId: "turn-plan" },
    });
    expect(togglePlanMode).toHaveBeenCalledWith(target);
    expect(startPlan).toHaveBeenCalledWith(target, "设计发布流程");
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
    } as unknown as ConversationUseCases);

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
    } as unknown as ConversationUseCases);

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
    } as unknown as ConversationUseCases);

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
    const providerAccountUsage = vi.fn(async () => ({ usage: "usage" }));
    const providerAccountLimits = vi.fn(async () => ({ limits: "limits" }));
    const listPermissionProfiles = vi.fn(async () => ["permissions"]);
    const commands = new ConversationCommandService({
      modelState,
      selectModel,
      selectEffort,
      selectFastMode,
      listSkills,
      listMcpServers,
      listPlugins,
      providerAccountUsage,
      providerAccountLimits,
      listPermissionProfiles,
    } as unknown as ConversationUseCases);

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
    await expect(commands.execute(target, "skill")).resolves.toEqual({
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

  it("invokes a Skill through the shared command boundary", async () => {
    const invokeSkill = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
      skillName: "systematic-debugging",
    }));
    const commands = new ConversationCommandService({
      invokeSkill,
    } as unknown as ConversationUseCases);

    await expect(commands.execute(
      target,
      "skill",
      "systematic-debugging 排查断线",
    )).resolves.toEqual({
      kind: "outcome",
      outcome: {
        type: "skill.started",
        skillName: "systematic-debugging",
        turnId: "turn-1",
        steered: false,
      },
    });
    expect(invokeSkill).toHaveBeenCalledWith(
      target,
      "systematic-debugging",
      "排查断线",
    );
  });

  it("rejects /skill without both selector and task", async () => {
    const commands = new ConversationCommandService(
      {} as ConversationUseCases,
    );
    await expect(commands.execute(target, "skill", "systematic-debugging"))
      .rejects.toMatchObject({ code: "skill.usage" });
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
      resume: vi.fn(async () => ({ threadId: "thread-resumed" })),
      listSessions: vi.fn(async () => []),
      status: vi.fn(() => ({ workspaceId: "main" })),
      newSession: vi.fn(async () => undefined),
      archive: vi.fn(async () => "thread-archived"),
      unarchive: vi.fn(async () => "thread-unarchived"),
      setPinned: vi.fn(async () => undefined),
      selectWorkspace: vi.fn(async () => ({ id: "main", name: "Main", cwd: "/workspace" })),
      listWorkspaces: vi.fn(() => [{ id: "main", name: "Main", cwd: "/workspace" }]),
      updateWorkspacePermissions: vi.fn(async () => ({
        id: "main",
        name: "Main",
        cwd: "/workspace",
      })),
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
      invokeSkill: vi.fn(async () => ({
        threadId: "thread-1",
        turnId: "turn-skill",
        steered: false,
        skillName: "skill",
      })),
      listMcpServers: vi.fn(async () => []),
      listPlugins: vi.fn(async () => ({})),
      providerAccountUsage: vi.fn(async () => ({})),
      requestMetrics: vi.fn(() => null),
      providerAccountLimits: vi.fn(async () => ({})),
      listPermissionProfiles: vi.fn(async () => []),
      initializeProjectRules: vi.fn(async () => ({
        projectRoot: "/workspace",
        rulesPath: "/workspace/.codex/rules/default.rules",
      })),
      artifacts: vi.fn(() => undefined),
      togglePlanMode: vi.fn(async () => ({ mode: "plan" as const, pending: true })),
      setGoal: vi.fn(async () => goal),
    };
    const commands = new ConversationCommandService(
      service as unknown as ConversationUseCases,
    );
    const cases = [
      ["resume", "thread-1", "resume"],
      ["sessions", "", "listSessions"],
      ["archived", "", "listSessions"],
      ["new", "", "newSession"],
      ["archive", "", "archive"],
      ["unarchive", "thread-1", "unarchive"],
      ["pin", "", "setPinned"],
      ["unpin", "", "setPinned"],
      ["status", "", "status"],
      ["workspace", "main", "selectWorkspace"],
      ["workspaceperm", "approval never", "updateWorkspacePermissions"],
      ["stop", "", "stop"],
      ["queue", "follow up", "queueFollowUp"],
      ["rename", "name", "rename"],
      ["compact", "", "compact"],
      ["fork", "", "fork"],
      ["review", "", "review"],
      ["model", "gpt-test", "selectModel"],
      ["effort", "high", "selectEffort"],
      ["fast", "on", "selectFastMode"],
      ["skill", "", "listSkills"],
      ["mcp", "", "listMcpServers"],
      ["plugins", "", "listPlugins"],
      ["usage", "", "providerAccountUsage"],
      ["metrics", "", "requestMetrics"],
      ["limits", "", "providerAccountLimits"],
      ["permissions", "", "listPermissionProfiles"],
      ["rules", "init", "initializeProjectRules"],
      ["diff", "", "artifacts"],
      ["plan", "", "togglePlanMode"],
      ["goal", "set ship", "setGoal"],
    ] as const;

    expect(cases.map(([command]) => command)).toEqual(conversationCommandNames);
    for (const [command, input, method] of cases) {
      const before = service[method].mock.calls.length;
      await expect(commands.execute(target, command, input)).resolves.toHaveProperty("kind");
      expect(service[method].mock.calls.length).toBeGreaterThan(before);
    }
    expect(service.status).toHaveBeenCalledWith(target, {
      includeGitBranch: true,
    });
    expect(service.setPinned).toHaveBeenNthCalledWith(1, target, true);
    expect(service.setPinned).toHaveBeenNthCalledWith(2, target, false);
  });

  it("returns structured goal query and clear results", async () => {
    const getGoal = vi.fn(async () => null);
    const clearGoal = vi.fn(async () => undefined);
    const commands = new ConversationCommandService({
      getGoal,
      clearGoal,
    } as unknown as ConversationUseCases);

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
    } as unknown as ConversationUseCases);

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
