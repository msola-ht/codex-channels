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

describe("ConversationService MCP operations", () => {
  it("lists MCP summaries for the current Thread", async () => {
    const listMcpServers = vi.fn(async () => [
      {
        name: "project-tools",
        runtimeStatus: "connected" as const,
        pluginId: null,
        authStatus: "oAuth" as const,
        toolCount: 2,
      },
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
      {
        name: "project-tools",
        runtimeStatus: "connected",
        pluginId: null,
        authStatus: "oAuth",
        toolCount: 2,
      },
    ]);
    expect(listMcpServers).toHaveBeenCalledWith("thread-1");
  });

  it("resolves MCP details and routes OAuth and resource reads to one Thread snapshot", async () => {
    const server = {
      name: "project-tools",
      runtimeStatus: "authenticationRequired" as const,
      pluginId: null,
      authStatus: "notLoggedIn" as const,
      toolCount: 1,
      serverTitle: "Project Tools",
      serverVersion: "1.0.0",
      serverDescription: null,
      tools: [{ name: "search", title: null, description: null, access: "readOnly" as const }],
      resources: [{
        uri: "project://readme",
        name: "readme",
        title: null,
        description: null,
        mimeType: "text/plain",
      }],
      resourceTemplates: [],
    };
    const summary = {
      name: server.name,
      runtimeStatus: server.runtimeStatus,
      pluginId: server.pluginId,
      authStatus: server.authStatus,
      toolCount: server.toolCount,
    };
    const listMcpServers = vi.fn(async () => [summary]);
    const listMcpServerDetails = vi.fn(async () => [server]);
    const startMcpOAuthLogin = vi.fn(async () => ({
      server: "project-tools",
      authorizationUrl: "https://example.test/oauth",
    }));
    const readMcpResource = vi.fn(async () => ({
      server: "project-tools",
      requestedUri: "project://readme",
      contents: [],
      omittedContentCount: 0,
    }));
    let currentCalls = 0;
    const service = new ConversationService(
      turnPort(),
      {
        current: () => {
          currentCalls += 1;
          return { threadId: "thread-1" };
        },
      } as unknown as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort({
        listMcpServers,
        listMcpServerDetails,
        startMcpOAuthLogin,
        readMcpResource,
      }),
    );

    await expect(service.mcpServerDetail(target, "1")).resolves.toEqual(server);
    await expect(service.loginMcpServer(target, "project-tools")).resolves.toEqual({
      type: "oauth",
      server: "project-tools",
      authorizationUrl: "https://example.test/oauth",
    });
    await expect(service.readMcpResource(target, "1", " project://readme "))
      .resolves.toEqual({
        server: "project-tools",
        requestedUri: "project://readme",
        contents: [],
        omittedContentCount: 0,
      });
    expect(startMcpOAuthLogin).toHaveBeenCalledWith("project-tools", "thread-1");
    expect(readMcpResource)
      .toHaveBeenCalledWith("project-tools", "project://readme", "thread-1");
    expect(listMcpServerDetails).toHaveBeenCalledTimes(1);
    expect(listMcpServers).toHaveBeenCalledTimes(2);
    expect(currentCalls).toBe(3);
  });

  it("summarizes actionable MCP health findings and reloads managed App Servers", async () => {
    const listMcpServerDetails = vi.fn(async () => [{
      name: "oauth tools",
      runtimeStatus: "authenticationRequired" as const,
      pluginId: null,
      authStatus: "notLoggedIn" as const,
      toolCount: 0,
      serverTitle: null,
      serverVersion: null,
      serverDescription: null,
      tools: [],
      resources: [],
      resourceTemplates: [],
    }, {
      name: "unknown auth",
      runtimeStatus: "unknown" as const,
      pluginId: null,
      authStatus: "unknown" as const,
      toolCount: 1,
      serverTitle: null,
      serverVersion: null,
      serverDescription: null,
      tools: [{ name: "search", title: null, description: null, access: "unknown" as const }],
      resources: [],
      resourceTemplates: [],
    }, {
      name: "empty",
      runtimeStatus: "disabled" as const,
      pluginId: null,
      authStatus: "unsupported" as const,
      toolCount: 0,
      serverTitle: null,
      serverVersion: null,
      serverDescription: null,
      tools: [],
      resources: [],
      resourceTemplates: [],
    }, {
      name: "failed",
      runtimeStatus: "failed" as const,
      pluginId: null,
      authStatus: "unsupported" as const,
      toolCount: 0,
      serverTitle: null,
      serverVersion: null,
      serverDescription: null,
      tools: [],
      resources: [],
      resourceTemplates: [],
    }, {
      name: "starting",
      runtimeStatus: "starting" as const,
      pluginId: null,
      authStatus: "unsupported" as const,
      toolCount: 0,
      serverTitle: null,
      serverVersion: null,
      serverDescription: null,
      tools: [],
      resources: [],
      resourceTemplates: [],
    }]);
    const reloadMcpServers = vi.fn(async () => undefined);
    const service = new ConversationService(
      turnPort(),
      { current: () => ({ threadId: "thread-1" }) } as unknown as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort({ listMcpServerDetails, reloadMcpServers }),
    );

    await expect(service.mcpHealth(target)).resolves.toEqual({
      serverCount: 5,
      toolCount: 1,
      resourceCount: 0,
      resourceTemplateCount: 0,
      actions: [
        { type: "loginRequired", server: "oauth tools", selector: "1" },
        { type: "reconnectRecommended", server: "failed", selector: "4" },
      ],
      notices: [
        { type: "authUnknown", server: "unknown auth", selector: "2" },
        { type: "disabled", server: "empty", selector: "3" },
        { type: "starting", server: "starting", selector: "5" },
      ],
    });
    await expect(service.reloadMcpServers(target)).resolves.toBeUndefined();
    expect(listMcpServerDetails).toHaveBeenCalledWith("thread-1");
    expect(reloadMcpServers).toHaveBeenCalledOnce();
  });

  it("returns Bearer Token authentication as information and rejects unsupported MCP OAuth or invalid resources", async () => {
    const listMcpServers = vi.fn()
      .mockResolvedValueOnce([{
        name: "local-tools",
        runtimeStatus: "connected" as const,
        pluginId: null,
        authStatus: "unsupported" as const,
        toolCount: 0,
      }])
      .mockResolvedValueOnce([{
        name: "token-tools",
        runtimeStatus: "connected" as const,
        pluginId: null,
        authStatus: "bearerToken" as const,
        toolCount: 0,
      }]);
    const startMcpOAuthLogin = vi.fn();
    const readMcpResource = vi.fn();
    const service = new ConversationService(
      turnPort(),
      { current: () => undefined } as unknown as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort({ listMcpServers, startMcpOAuthLogin, readMcpResource }),
    );

    await expect(service.loginMcpServer(target, "local-tools"))
      .rejects.toMatchObject({ code: "mcp.oauth.unsupported" });
    await expect(service.loginMcpServer(target, "token-tools"))
      .resolves.toEqual({
        type: "bearerToken",
        server: "token-tools",
      });
    await expect(service.readMcpResource(target, "local-tools", " \n "))
      .rejects.toMatchObject({ code: "mcp.resource.usage" });
    expect(startMcpOAuthLogin).not.toHaveBeenCalled();
    expect(readMcpResource).not.toHaveBeenCalled();
  });

  it("requires a bound Thread before starting MCP OAuth", async () => {
    const listMcpServers = vi.fn(async () => [{
      name: "oauth-tools",
      runtimeStatus: "authenticationRequired" as const,
      pluginId: null,
      authStatus: "notLoggedIn" as const,
      toolCount: 0,
    }]);
    const startMcpOAuthLogin = vi.fn();
    const service = new ConversationService(
      turnPort(),
      { current: () => undefined } as unknown as SessionRouter,
      {} as ConversationCore,
      {} as ModelSelectionService,
      queryPort({ listMcpServers, startMcpOAuthLogin }),
    );

    await expect(service.loginMcpServer(target, "oauth-tools"))
      .rejects.toMatchObject({ code: "mcp.thread.required" });
    expect(startMcpOAuthLogin).not.toHaveBeenCalled();
  });
});
