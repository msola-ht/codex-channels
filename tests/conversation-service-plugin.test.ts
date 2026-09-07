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

describe("ConversationService conversation service plugin", () => {
  it("lists installed Plugins for the authorized Workspace", async () => {
    const github = {
      id: "github@local",
      name: "github",
      displayName: "GitHub",
      marketplaceName: "local",
      description: "GitHub development tools",
      enabled: true,
      available: true,
      version: "0.1.8",
      localVersion: "0.1.8",
      source: "local" as const,
      installedAt: null,
      developerName: null,
      category: null,
      capabilities: [],
      authPolicy: "onUse" as const,
      eligiblePlanTypes: [],
      disabledReason: null,
    };
    const listPlugins = vi.fn(async () => ({
      plugins: [
        github,
        {
          ...github,
          id: "disabled@local",
          name: "disabled",
          displayName: "Disabled",
          enabled: false,
        },
        {
          ...github,
          id: "plan@local",
          name: "plan",
          displayName: "Plan restricted",
          available: false,
          disabledReason: "plan_not_eligible" as const,
        },
      ],
      loadErrorCount: 2,
    }));
    const service = new ConversationService(
      turnPort(),
      { workspace: () => main } as unknown as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort({ listPlugins }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { pluginApiEnabled: true },
    );

    await expect(service.listPlugins(target)).resolves.toMatchObject({
      plugins: expect.arrayContaining([expect.objectContaining({ id: "github@local" })]),
      loadErrorCount: 2,
    });
    await expect(service.pluginDetail(target, "1")).resolves.toMatchObject({
      id: "github@local",
      displayName: "GitHub",
    });
    await expect(service.pluginHealth(target)).resolves.toEqual({
      installedCount: 3,
      enabledCount: 2,
      callableCount: 1,
      marketplaceLoadErrorCount: 2,
      issues: [{
        type: "notEnabled",
        plugin: "Disabled",
        selector: "2",
        reason: null,
      }, {
        type: "unavailable",
        plugin: "Plan restricted",
        selector: "3",
        reason: "plan_not_eligible",
      }],
    });
    expect(listPlugins).toHaveBeenCalledWith(main.cwd);
  });

  it("invokes an enabled Plugin with the official mention input", async () => {
    const startTurn = vi.fn().mockResolvedValue({ turnId: "turn-1" });
    const listPlugins = vi.fn(async () => ({
      plugins: [{
        id: "github@local",
        name: "github",
        displayName: "GitHub",
        marketplaceName: "local",
        description: "GitHub development tools",
        enabled: true,
        available: true,
        version: null,
        localVersion: null,
        source: "local" as const,
        installedAt: null,
        developerName: null,
        category: null,
        capabilities: [],
        authPolicy: "onUse" as const,
        eligiblePlanTypes: [],
        disabledReason: null,
      }],
      loadErrorCount: 0,
    }));
    const resolvePlugin = vi.fn(async () => ({
      id: "github@local",
      name: "github",
      displayName: "GitHub",
      path: "plugin://github@local",
    }));
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
        status: () => ({ modelProvider: "openai" }),
        turnOverrides: () => ({}),
        markApplied: vi.fn(),
      } as unknown as ModelSelectionService,
      queryPort({ listPlugins, resolvePlugin }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { pluginApiEnabled: true },
    );

    await expect(service.invokePlugin(target, "1", " 检查 PR "))
      .resolves.toMatchObject({
        threadId: "thread-1",
        turnId: "turn-1",
        steered: false,
        pluginName: "GitHub",
      });
    expect(resolvePlugin).toHaveBeenCalledWith(main.cwd, "github@local");
    expect(startTurn.mock.calls[0]?.[1]).toEqual([
      { type: "text", text: "@github 检查 PR" },
      {
        type: "plugin",
        name: "GitHub",
        path: "plugin://github@local",
      },
    ]);
    expect(markTurnStarted).toHaveBeenCalledWith(
      target,
      "thread-1",
      "turn-1",
      { kind: "plugin", name: "GitHub" },
    );
  });

  it("rechecks the Plugin provider after waiting for the Conversation lock", async () => {
    let provider = "openai";
    let releaseSelection: (() => void) | undefined;
    const selectionPaused = new Promise<void>((resolve) => {
      releaseSelection = resolve;
    });
    const selectModel = vi.fn(async () => {
      await selectionPaused;
      provider = "deepseek";
      return {} as never;
    });
    const startTurn = vi.fn().mockResolvedValue({ turnId: "turn-1" });
    const service = new ConversationService(
      turnPort({ startTurn }),
      {
        workspace: () => main,
        ensure: async () => ({
          target,
          workspaceId: "main",
          threadId: "thread-1",
          sessionId: "session-1",
        }),
      } as unknown as SessionRouter,
      {
        activeTurn: () => undefined,
        markTurnStarted: vi.fn(),
      } as unknown as ConversationCore,
      {
        status: () => ({ modelProvider: provider }),
        selectModel,
        turnOverrides: () => ({}),
        markApplied: vi.fn(),
      } as unknown as ModelSelectionService,
      queryPort({
        listPlugins: async () => ({
          plugins: [{
            id: "github@local",
            name: "github",
            displayName: "GitHub",
            marketplaceName: "local",
            description: null,
            enabled: true,
            available: true,
            version: null,
            localVersion: null,
            source: "local" as const,
            installedAt: null,
            developerName: null,
            category: null,
            capabilities: [],
            authPolicy: "onUse" as const,
            eligiblePlanTypes: [],
            disabledReason: null,
          }],
          loadErrorCount: 0,
        }),
        resolvePlugin: async () => ({
          id: "github@local",
          name: "github",
          displayName: "GitHub",
          path: "plugin://github@local",
        }),
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { pluginApiEnabled: true },
    );

    const switching = service.selectModel(target, "deepseek");
    await vi.waitFor(() => expect(selectModel).toHaveBeenCalledOnce());
    const invocation = service.invokePlugin(target, "github", "检查 PR");
    releaseSelection?.();

    await switching;
    await expect(invocation).rejects.toMatchObject({
      code: "plugin.provider.unsupported",
    });
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("fails closed by default or for a non-OpenAI provider", async () => {
    const disabled = new ConversationService(
      turnPort(),
      { workspace: () => main } as unknown as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort(),
    );
    expect(() => disabled.listPlugins(target))
      .toThrow(expect.objectContaining({ code: "plugin.disabled" }));

    const deepseek = new ConversationService(
      turnPort(),
      {} as SessionRouter,
      {} as ConversationCore,
      { status: () => ({ modelProvider: "deepseek" }) } as unknown as ModelSelectionService,
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
      { pluginApiEnabled: true },
    );
    await expect(deepseek.invokePlugin(target, "github", "检查 PR"))
      .rejects.toMatchObject({ code: "plugin.provider.unsupported" });
  });
});
