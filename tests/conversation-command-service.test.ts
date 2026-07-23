import { describe, expect, it, vi } from "vitest";

import {
  ConversationCommandService,
  conversationCommands,
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
    expect(conversationCommands.every(({ description }) => description.length > 0)).toBe(true);
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
      kind: "notice",
      text: "已启动 Codex Review\nTurn：review-turn",
      detail: "expanded",
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
    await expect(commands.execute(target, "review", "branch")).rejects.toThrow(
      "用法：/review",
    );
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
      kind: "notice",
      text: "Goal 已设置\n目标：ship it",
      detail: "expanded",
    });
    expect(setGoal).toHaveBeenCalledWith(target, "ship it");
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
});

describe("shared Surface access boundary", () => {
  it("uses target and canonical Actor identity and fails closed across Surfaces", () => {
    const access = new TelegramAccessPolicy(new Set([123]));

    expect(access.isAllowed({ target, actorId: "123" })).toBe(true);
    expect(access.isAllowed({ target, actorId: "0123" })).toBe(false);
    expect(access.isAllowed({
      target: { surface: "feishu", accountId: "tenant-a", conversationId: "100" },
      actorId: "123",
    })).toBe(false);
  });
});
