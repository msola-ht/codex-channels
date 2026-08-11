import { describe, expect, it, vi } from "vitest";

import {
  ConversationCommandService,
  conversationCommandNames,
  isConversationCommandName,
  type ConversationUseCases,
  type InstalledPlugin,
} from "../src/application/index.js";
import type { ConversationTarget } from "../src/conversation-core/index.js";
import { TelegramAccessPolicy } from "../src/policy/index.js";

const target: ConversationTarget = {
  surface: "telegram",
  accountId: "default",
  conversationId: "100",
};

function installedPlugin(
  index: number,
  overrides: Partial<InstalledPlugin> = {},
): InstalledPlugin {
  return {
    id: `plugin-${index}@local`,
    name: `plugin-${index}`,
    displayName: `Plugin ${index}`,
    marketplaceName: "local",
    description: null,
    enabled: true,
    available: true,
    version: null,
    localVersion: null,
    source: "local",
    installedAt: null,
    developerName: null,
    category: null,
    capabilities: [],
    authPolicy: "onUse",
    eligiblePlanTypes: [],
    disabledReason: null,
    ...overrides,
  };
}

describe("ConversationCommandService", () => {
  it("owns the platform-independent command catalog without duplicates", () => {
    expect(new Set(conversationCommandNames).size).toBe(conversationCommandNames.length);
    expect(conversationCommandNames).toContain("resume");
    expect(conversationCommandNames).toContain("fast");
    expect(conversationCommandNames).toContain("metrics");
    expect(conversationCommandNames).toContain("goal");
    expect(conversationCommandNames).toContain("agents");
    expect(conversationCommandNames).toContain("pin");
    expect(conversationCommandNames).toContain("rules");
    expect(conversationCommandNames).toContain("plugin");
    expect(isConversationCommandName("status")).toBe(true);
    expect(isConversationCommandName("plugins")).toBe(false);
    expect(isConversationCommandName("plugin")).toBe(true);
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
      page: 1,
      pageCount: 1,
      matchedSessionCount: 1,
      view: {
        page: 1,
        filter: "all",
        provider: null,
        sectionSelector: null,
        searchTerm: "fix",
      },
    });
    expect(listSessions).toHaveBeenCalledWith(target, { searchTerm: "fix" });
  });

  it("parses session paging and filters while keeping the full matched count", async () => {
    const sessions = Array.from({ length: 21 }, (_, index) => ({ id: `thread-${index + 1}` }));
    const listSessions = vi.fn(async () => sessions);
    const commands = new ConversationCommandService({
      listSessions,
      status: () => ({}),
    } as unknown as ConversationUseCases);

    await expect(commands.execute(
      target,
      "sessions",
      "2 filter running provider deepseek section 项目 search 修复 CI",
    )).resolves.toMatchObject({
      kind: "sessions",
      sessions: [{ id: "thread-21" }],
      page: 2,
      pageCount: 2,
      matchedSessionCount: 21,
      view: {
        filter: "running",
        provider: "deepseek",
        sectionSelector: "项目",
        searchTerm: "修复 CI",
      },
    });
    expect(listSessions).toHaveBeenCalledWith(target, {
      filter: "running",
      provider: "deepseek",
      sectionSelector: "项目",
      searchTerm: "修复 CI",
    });
  });

  it("keeps a multi-word Thread Section selector until the next session option", async () => {
    const listSessions = vi.fn(async () => []);
    const commands = new ConversationCommandService({
      listSessions,
      status: () => ({}),
    } as unknown as ConversationUseCases);

    await commands.execute(
      target,
      "sessions",
      "2 section 项目 Alpha provider deepseek search 修复 CI",
    );

    expect(listSessions).toHaveBeenCalledWith(target, {
      sectionSelector: "项目 Alpha",
      provider: "deepseek",
      searchTerm: "修复 CI",
    });
  });

  it("routes Thread Section list, move and confirmed delete operations", async () => {
    const section = {
      id: "section-project",
      name: "项目",
      builtIn: null,
      currentWorkspaceActiveCount: 1,
      currentWorkspaceArchivedCount: 0,
    };
    const moveCurrentThreadToSection = vi.fn(async () => section);
    const previewThreadSectionDelete = vi.fn(async () => ({ section }));
    const deleteThreadSection = vi.fn(async () => section);
    const commands = new ConversationCommandService({
      listThreadSections: vi.fn(async () => [section]),
      moveCurrentThreadToSection,
      previewThreadSectionDelete,
      deleteThreadSection,
    } as unknown as ConversationUseCases, {
      isAllowed: ({ actorId }) => actorId === "actor-admin",
    });

    await expect(commands.execute(target, "section", ""))
      .resolves.toMatchObject({ kind: "thread-sections", selectors: ["1"] });
    await expect(commands.execute(target, "section", "move 1 before thread-2", "actor-admin"))
      .resolves.toMatchObject({
        kind: "outcome",
        outcome: { type: "thread-section.moved", ordered: true },
      });
    expect(moveCurrentThreadToSection).toHaveBeenCalledWith(target, "1", "thread-2");
    await expect(commands.execute(target, "section", "delete 1", "actor-admin"))
      .resolves.toEqual({ kind: "thread-section-delete-preview", preview: { section } });
    expect(deleteThreadSection).not.toHaveBeenCalled();
    await expect(commands.execute(target, "section", "delete section-project confirm", "actor-admin"))
      .resolves.toMatchObject({
        kind: "outcome",
        outcome: { type: "thread-section.deleted", sectionId: "section-project" },
      });
  });

  it("allows Thread Section reads but denies global writes without an administrator", async () => {
    const listThreadSections = vi.fn(async () => []);
    const createThreadSection = vi.fn();
    const commands = new ConversationCommandService({
      listThreadSections,
      createThreadSection,
    } as unknown as ConversationUseCases);

    await expect(commands.execute(target, "section", "list"))
      .resolves.toMatchObject({ kind: "thread-sections" });
    await expect(commands.execute(target, "section", "create 项目", "actor-user"))
      .rejects.toMatchObject({ code: "thread-section.admin-required" });
    expect(createThreadSection).not.toHaveBeenCalled();
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
    await commands.execute(target, "metrics", "providers yesterday");
    await commands.execute(target, "metrics", "global all");

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
    expect(requestMetrics).toHaveBeenNthCalledWith(7, target, {
      view: "providers",
      range: "yesterday",
    });
    expect(requestMetrics).toHaveBeenNthCalledWith(8, target, {
      view: "global",
      range: "all",
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
    const listPlugins = vi.fn(async () => ({
      plugins: [],
      loadErrorCount: 0,
    }));
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
    await expect(commands.execute(target, "plugin")).resolves.toEqual({
      kind: "plugins",
      plugins: [],
      selectors: [],
      loadErrorCount: 0,
      totalPluginCount: 0,
      matchedPluginCount: 0,
      page: 1,
      pageCount: 1,
      searchTerm: null,
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

  it("routes MCP health, reload, detail, login, and resource operations through the shared boundary", async () => {
    const server = { name: "project-tools" };
    const mcpServerDetail = vi.fn(async () => server);
    const loginMcpServer = vi.fn()
      .mockResolvedValueOnce({
        type: "oauth",
        server: "project-tools",
        authorizationUrl: "https://example.test/oauth",
      })
      .mockResolvedValueOnce({
        type: "bearerToken",
        server: "token-tools",
      });
    const readMcpResource = vi.fn(async () => ({
      server: "project-tools",
      requestedUri: "project://readme",
      contents: [],
      omittedContentCount: 0,
    }));
    const mcpHealth = vi.fn(async () => ({
      serverCount: 1,
      toolCount: 1,
      resourceCount: 0,
      resourceTemplateCount: 0,
      actions: [],
      notices: [],
    }));
    const reloadMcpServers = vi.fn(async () => undefined);
    const commands = new ConversationCommandService({
      mcpHealth,
      reloadMcpServers,
      mcpServerDetail,
      loginMcpServer,
      readMcpResource,
    } as unknown as ConversationUseCases);

    await expect(commands.execute(target, "mcp", "health")).resolves.toEqual({
      kind: "mcp-health",
      report: {
        serverCount: 1,
        toolCount: 1,
        resourceCount: 0,
        resourceTemplateCount: 0,
        actions: [],
        notices: [],
      },
    });
    await expect(commands.execute(target, "mcp", "reload")).resolves.toEqual({
      kind: "mcp-reload",
    });

    await expect(commands.execute(target, "mcp", "1")).resolves.toEqual({
      kind: "mcp-detail",
      selector: "1",
      server,
    });
    await expect(commands.execute(
      target,
      "mcp",
      "1 tools 2 search github issue",
    )).resolves.toEqual({
      kind: "mcp-detail",
      selector: "1",
      server,
      view: {
        section: "tools",
        page: 2,
        searchTerm: "github issue",
      },
    });
    await expect(commands.execute(
      target,
      "mcp",
      "project-tools resources search plugin",
    )).resolves.toEqual({
      kind: "mcp-detail",
      selector: "project-tools",
      server,
      view: {
        section: "resources",
        page: 1,
        searchTerm: "plugin",
      },
    });
    await expect(commands.execute(target, "mcp", "login project-tools"))
      .resolves.toEqual({
        kind: "mcp-login",
        login: {
          type: "oauth",
          server: "project-tools",
          authorizationUrl: "https://example.test/oauth",
        },
      });
    await expect(commands.execute(target, "mcp", "login token-tools"))
      .resolves.toEqual({
        kind: "mcp-login",
        login: {
          type: "bearerToken",
          server: "token-tools",
        },
      });
    await expect(commands.execute(
      target,
      "mcp",
      "resource project-tools project://readme",
    )).resolves.toMatchObject({ kind: "mcp-resource" });
    expect(mcpServerDetail).toHaveBeenCalledWith(target, "1");
    expect(loginMcpServer).toHaveBeenNthCalledWith(1, target, "project-tools");
    expect(loginMcpServer).toHaveBeenNthCalledWith(2, target, "token-tools");
    expect(readMcpResource)
      .toHaveBeenCalledWith(target, "project-tools", "project://readme");
    expect(mcpHealth).toHaveBeenCalledWith(target);
    expect(reloadMcpServers).toHaveBeenCalledWith(target);
    await expect(commands.execute(target, "mcp", "login"))
      .rejects.toMatchObject({ code: "mcp.usage" });
    await expect(commands.execute(target, "mcp", "1 tools 0"))
      .rejects.toMatchObject({ code: "mcp.usage" });
    await expect(commands.execute(target, "mcp", "1 unknown"))
      .rejects.toMatchObject({ code: "mcp.usage" });
    await expect(commands.execute(target, "mcp", "health extra"))
      .rejects.toMatchObject({ code: "mcp.usage" });
    await expect(commands.execute(target, "mcp", "reload extra"))
      .rejects.toMatchObject({ code: "mcp.usage" });
  });

  it("rejects /skill without both selector and task", async () => {
    const commands = new ConversationCommandService(
      {} as ConversationUseCases,
    );
    await expect(commands.execute(target, "skill", "systematic-debugging"))
      .rejects.toMatchObject({ code: "skill.usage" });
  });

  it("lists and invokes Plugins through the shared command boundary", async () => {
    const listPlugins = vi.fn(async () => ({
      plugins: [{ id: "github@local" }],
      loadErrorCount: 0,
    }));
    const invokePlugin = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-plugin",
      steered: false,
      pluginName: "GitHub",
    }));
    const pluginDetail = vi.fn(async () => ({ id: "github@local" }));
    const pluginHealth = vi.fn(async () => ({
      installedCount: 1,
      enabledCount: 1,
      callableCount: 1,
      marketplaceLoadErrorCount: 0,
      issues: [],
    }));
    const commands = new ConversationCommandService({
      listPlugins,
      pluginHealth,
      pluginDetail,
      invokePlugin,
    } as unknown as ConversationUseCases);

    await expect(commands.execute(target, "plugin")).resolves.toEqual({
      kind: "plugins",
      plugins: [{ id: "github@local" }],
      selectors: ["1"],
      loadErrorCount: 0,
      totalPluginCount: 1,
      matchedPluginCount: 1,
      page: 1,
      pageCount: 1,
      searchTerm: null,
    });
    await expect(commands.execute(target, "plugin", "health"))
      .resolves.toMatchObject({
        kind: "plugin-health",
        report: { callableCount: 1 },
      });
    await expect(commands.execute(target, "plugin", "github@local"))
      .resolves.toEqual({
        kind: "plugin-detail",
        plugin: { id: "github@local" },
      });
    await expect(commands.execute(target, "plugin", "github@local 检查 PR"))
      .resolves.toEqual({
        kind: "outcome",
        outcome: {
          type: "plugin.started",
          pluginName: "GitHub",
          turnId: "turn-plugin",
          steered: false,
        },
      });
    await expect(commands.execute(target, "plugin", "health 检查状态"))
      .resolves.toMatchObject({ kind: "outcome" });
    await expect(commands.execute(target, "plugin", "list 检查目录"))
      .resolves.toMatchObject({ kind: "outcome" });
    expect(invokePlugin).toHaveBeenCalledWith(target, "github@local", "检查 PR");
    expect(invokePlugin).toHaveBeenCalledWith(target, "health", "检查状态");
    expect(invokePlugin).toHaveBeenCalledWith(target, "list", "检查目录");
  });

  it("paginates and searches installed Plugins without changing global selectors", async () => {
    const plugins = Array.from({ length: 10 }, (_, index) =>
      installedPlugin(index + 1, index === 9 ? { category: "Special tools" } : {})
    );
    const listPlugins = vi.fn(async () => ({ plugins, loadErrorCount: 0 }));
    const commands = new ConversationCommandService({
      listPlugins,
    } as unknown as ConversationUseCases);

    await expect(commands.execute(target, "plugin", "list 2"))
      .resolves.toMatchObject({
        kind: "plugins",
        selectors: ["9", "10"],
        totalPluginCount: 10,
        matchedPluginCount: 10,
        page: 2,
        pageCount: 2,
        searchTerm: null,
      });
    await expect(commands.execute(target, "plugin", "list search special"))
      .resolves.toMatchObject({
        kind: "plugins",
        selectors: ["10"],
        matchedPluginCount: 1,
        page: 1,
        pageCount: 1,
        searchTerm: "special",
      });
    await expect(commands.execute(target, "plugin", "list 0"))
      .rejects.toMatchObject({ code: "plugin.usage" });
    await expect(commands.execute(target, "plugin", "list search"))
      .rejects.toMatchObject({ code: "plugin.usage" });
  });

  it("lists and invokes agent roles through the shared command boundary", async () => {
    const listAgentRoles = vi.fn(() => [
      { name: "ds", description: "DeepSeek 子代理" },
    ]);
    const invokeAgent = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
      roleName: "ds",
    }));
    const commands = new ConversationCommandService({
      listAgentRoles,
      invokeAgent,
    } as unknown as ConversationUseCases);

    await expect(commands.execute(target, "agents")).resolves.toEqual({
      kind: "agents",
      roles: [{ name: "ds", description: "DeepSeek 子代理" }],
    });
    await expect(commands.execute(
      target,
      "agents",
      "ds 审查提交",
    )).resolves.toEqual({
      kind: "outcome",
      outcome: {
        type: "agents.started",
        roleName: "ds",
        turnId: "turn-1",
        steered: false,
      },
    });
    expect(invokeAgent).toHaveBeenCalledWith(target, "ds", "审查提交");
  });

  it("rejects /agents without both role and task", async () => {
    const commands = new ConversationCommandService(
      {} as ConversationUseCases,
    );
    await expect(commands.execute(target, "agents", "ds"))
      .rejects.toMatchObject({ code: "agents.usage" });
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
      listThreadSections: vi.fn(async () => []),
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
      listAgentRoles: vi.fn(() => []),
      listMcpServers: vi.fn(async () => []),
      listPlugins: vi.fn(async () => ({ plugins: [], loadErrorCount: 0 })),
      invokePlugin: vi.fn(async () => ({
        threadId: "thread-1",
        turnId: "turn-plugin",
        steered: false,
        pluginName: "plugin",
      })),
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
      ["section", "", "listThreadSections"],
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
      ["plugin", "", "listPlugins"],
      ["usage", "", "providerAccountUsage"],
      ["metrics", "", "requestMetrics"],
      ["limits", "", "providerAccountLimits"],
      ["permissions", "", "listPermissionProfiles"],
      ["rules", "init", "initializeProjectRules"],
      ["diff", "", "artifacts"],
      ["plan", "", "togglePlanMode"],
      ["goal", "set ship", "setGoal"],
      ["agents", "", "listAgentRoles"],
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
