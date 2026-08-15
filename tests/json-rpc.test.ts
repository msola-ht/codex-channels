import { describe, expect, it, vi } from "vitest";

import { CodexAppServerClient } from "../src/codex-client/client.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { BaseTransport } from "../src/codex-client/transport.js";

const pinnedThreadSection = {
  id: "01984de2-8f74-7c91-a3b2-5c5e937cf318",
  name: "Pinned",
};

function appServerThread(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "thread-1",
    sessionId: "session-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "测试 Thread",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: "idle" },
    path: null,
    cwd: "/tmp/project",
    cliVersion: "0.146.0",
    source: "cli",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...overrides,
  };
}

function appServerGoal(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    threadId: "thread-1",
    objective: "完成协议边界",
    status: "active",
    tokenBudget: null,
    tokensUsed: 100,
    timeUsedSeconds: 10,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function appServerModel(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "gpt-test",
    model: "gpt-test",
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: "GPT Test",
    description: "Test model",
    hidden: false,
    supportedReasoningEfforts: [{
      reasoningEffort: "medium",
      description: "Medium",
    }],
    defaultReasoningEffort: "medium",
    inputModalities: ["text"],
    supportsPersonality: false,
    additionalSpeedTiers: ["fast"],
    serviceTiers: [{
      id: "priority",
      name: "Fast",
      description: "Faster responses",
    }],
    defaultServiceTier: "default",
    isDefault: true,
    ...overrides,
  };
}

function appServerRateLimit(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    limitId: "codex",
    limitName: null,
    primary: null,
    secondary: null,
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: "pro",
    rateLimitReachedType: null,
    ...overrides,
  };
}

function appServerMcpStatus(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "local-tools",
    serverInfo: null,
    tools: { search: {} },
    resources: [],
    resourceTemplates: [],
    authStatus: "unsupported",
    ...overrides,
  };
}

function appServerPlugin(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "github@local",
    name: "github",
    version: "0.1.8",
    localVersion: "0.1.8",
    source: { type: "local", path: "/private/plugins/github" },
    installed: true,
    installedAt: 1_786_294_800,
    enabled: true,
    authPolicy: "ON_USE",
    availability: "AVAILABLE",
    disabledReason: null,
    eligiblePlanTypes: null,
    interface: {
      displayName: "GitHub",
      shortDescription: "GitHub development tools",
      developerName: "OpenAI",
      category: "Developer tools",
      capabilities: ["Repository inspection", "Pull request management"],
    },
    ...overrides,
  };
}

class FakeTransport extends BaseTransport {
  readonly kind = "stdio" as const;
  readonly sent: Array<Record<string, unknown>> = [];
  overloadResponses = 0;
  simulateAccountUsageOverload = false;
  failServerResponse = false;
  circularModelCursor = false;
  modelListData: Array<Record<string, unknown>> = [];
  mcpPages: Array<Record<string, unknown>> = [{ data: [], nextCursor: null }];
  mcpPageIndex = 0;
  mcpOauthResult: Record<string, unknown> = {
    authorizationUrl: "https://example.test/oauth",
  };
  mcpResourceResult: Record<string, unknown> = { contents: [] };
  permissionPages: Array<Record<string, unknown>> = [{ data: [], nextCursor: null }];
  permissionPageIndex = 0;
  configServiceTier: unknown = "fast";
  configModel: unknown = "gpt-test";
  configReasoningEffort: unknown = "high";
  configLayers: unknown = null;
  accountUsageResult: Record<string, unknown> = {
    summary: {
      lifetimeTokens: null,
      peakDailyTokens: null,
      longestRunningTurnSec: null,
      currentStreakDays: null,
      longestStreakDays: null,
    },
    dailyUsageBuckets: null,
  };
  accountRateLimitsResult: Record<string, unknown> = {
    rateLimits: appServerRateLimit(),
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null,
  };
  skillsResult: Record<string, unknown> = { data: [] };
  pluginInstalledResult: Record<string, unknown> = {
    marketplaces: [],
    marketplaceLoadErrors: [],
  };
  disconnectAfterInitialized = false;
  threadListData: Array<Record<string, unknown>> = [];
  resumeThreadData: Record<string, unknown> = appServerThread();
  threadReadData: Record<string, unknown> = appServerThread();
  metadataUpdateThreadData: Record<string, unknown> | undefined;
  threadSections: Array<{ id: string; name: string }> = [pinnedThreadSection];
  goal = appServerGoal();

  async connect(): Promise<void> {}
  async close(): Promise<void> {}

  async send(message: string): Promise<void> {
    const decoded = JSON.parse(message) as Record<string, unknown>;
    if (this.failServerResponse && decoded.id === "server-1" && decoded.method === undefined) {
      throw new Error("socket closed");
    }
    this.sent.push(decoded);
    if (decoded.method === "initialize") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: {
              userAgent: "test",
              codexHome: "/tmp",
              platformFamily: "unix",
              platformOs: "macos",
            },
          }),
        ),
      );
    } else if (decoded.method === "initialized" && this.disconnectAfterInitialized) {
      this.emitClose(new Error("socket lost during initialization"));
    } else if (decoded.method === "account/usage/read" && this.simulateAccountUsageOverload) {
      this.overloadResponses += 1;
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify(
            this.overloadResponses === 1
              ? { id: decoded.id, error: { code: -32001, message: "Server overloaded; retry later." } }
              : { id: decoded.id, result: { ok: true } },
          ),
        ),
      );
    } else if (decoded.method === "thread/list") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: { data: this.threadListData, nextCursor: null },
          }),
        ),
      );
    } else if (decoded.method === "thread/start") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: {
              thread: appServerThread(),
              model: "gpt-default",
              reasoningEffort: "medium",
              serviceTier: "default",
            },
          }),
        ),
      );
    } else if (decoded.method === "thread/resume") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: {
              thread: this.resumeThreadData,
              model: "gpt-default",
              reasoningEffort: "medium",
              serviceTier: "default",
            },
          }),
        ),
      );
    } else if (decoded.method === "thread/fork") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: {
              thread: appServerThread({ id: "thread-forked", forkedFromId: "thread-1" }),
              model: "deepseek-v4-flash",
              modelProvider: "deepseek",
              reasoningEffort: "high",
              serviceTier: "default",
            },
          }),
        ),
      );
    } else if (decoded.method === "thread/archive") {
      queueMicrotask(() =>
        this.emitMessage(JSON.stringify({ id: decoded.id, result: {} })),
      );
    } else if (decoded.method === "thread/unarchive") {
      queueMicrotask(() =>
        this.emitMessage(JSON.stringify({
          id: decoded.id,
          result: { thread: appServerThread() },
        })),
      );
    } else if (decoded.method === "threadSection/list") {
      queueMicrotask(() =>
        this.emitMessage(JSON.stringify({
          id: decoded.id,
          result: { data: this.threadSections, nextCursor: null },
        })),
      );
    } else if (decoded.method === "threadSection/create") {
      const params = decoded.params as { name: string };
      const section = { id: `section-${this.threadSections.length}`, name: params.name };
      this.threadSections.push(section);
      queueMicrotask(() =>
        this.emitMessage(JSON.stringify({ id: decoded.id, result: { section } })),
      );
    } else if (decoded.method === "threadSection/update") {
      const params = decoded.params as { sectionId: string; name: string };
      const section = this.threadSections.find((entry) => entry.id === params.sectionId)!;
      section.name = params.name;
      queueMicrotask(() =>
        this.emitMessage(JSON.stringify({ id: decoded.id, result: { section } })),
      );
    } else if (decoded.method === "threadSection/delete") {
      const params = decoded.params as { sectionId: string };
      this.threadSections = this.threadSections.filter((entry) => entry.id !== params.sectionId);
      queueMicrotask(() =>
        this.emitMessage(JSON.stringify({ id: decoded.id, result: {} })),
      );
    } else if (decoded.method === "thread/metadata/update") {
      queueMicrotask(() =>
        this.emitMessage(JSON.stringify({
          id: decoded.id,
          result: { thread: this.metadataUpdateThreadData ?? this.threadReadData },
        })),
      );
    } else if (decoded.method === "thread/section/move") {
      const params = decoded.params as { sectionId: string | null };
      const section = params.sectionId === null
        ? null
        : this.threadSections.find((entry) => entry.id === params.sectionId) ?? null;
      this.threadReadData = appServerThread({
        section,
        sectionEnteredAt: params.sectionId === null ? null : 2,
      });
      queueMicrotask(() =>
        this.emitMessage(JSON.stringify({ id: decoded.id, result: {} })),
      );
    } else if (decoded.method === "thread/read") {
      queueMicrotask(() =>
        this.emitMessage(JSON.stringify({
          id: decoded.id,
          result: { thread: this.threadReadData },
        })),
      );
    } else if (decoded.method === "model/list") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: {
              data: this.modelListData,
              nextCursor: this.circularModelCursor ? "same-cursor" : null,
            },
          }),
        ),
      );
    } else if (decoded.method === "collaborationMode/list") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: {
              data: [
                {
                  name: "Default",
                  mode: "default",
                  model: null,
                  reasoning_effort: null,
                },
                {
                  name: "Plan",
                  mode: "plan",
                  model: null,
                  reasoning_effort: "medium",
                },
              ],
            },
          }),
        ),
      );
    } else if (decoded.method === "account/rateLimits/read") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: this.accountRateLimitsResult,
          }),
        ),
      );
    } else if (decoded.method === "account/usage/read") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: this.accountUsageResult,
          }),
        ),
      );
    } else if (decoded.method === "skills/list") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: this.skillsResult,
          }),
        ),
      );
    } else if (decoded.method === "plugin/installed") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: this.pluginInstalledResult,
          }),
        ),
      );
    } else if (decoded.method === "mcpServerStatus/list") {
      const page = this.mcpPages[
        Math.min(this.mcpPageIndex, this.mcpPages.length - 1)
      ];
      this.mcpPageIndex += 1;
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: page,
          }),
        ),
      );
    } else if (decoded.method === "mcpServer/oauth/login") {
      queueMicrotask(() =>
        this.emitMessage(JSON.stringify({ id: decoded.id, result: this.mcpOauthResult })),
      );
    } else if (decoded.method === "mcpServer/resource/read") {
      queueMicrotask(() =>
        this.emitMessage(JSON.stringify({ id: decoded.id, result: this.mcpResourceResult })),
      );
    } else if (decoded.method === "config/mcpServer/reload") {
      queueMicrotask(() =>
        this.emitMessage(JSON.stringify({ id: decoded.id, result: {} })),
      );
    } else if (decoded.method === "permissionProfile/list") {
      const page = this.permissionPages[
        Math.min(this.permissionPageIndex, this.permissionPages.length - 1)
      ];
      this.permissionPageIndex += 1;
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: page,
          }),
        ),
      );
    } else if (decoded.method === "config/batchWrite") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: {
              status: "ok",
              version: "1",
              filePath: "/tmp/config.toml",
              overriddenMetadata: null,
            },
          }),
        ),
      );
    } else if (decoded.method === "config/read") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: {
              config: {
                model: this.configModel,
                model_reasoning_effort: this.configReasoningEffort,
                service_tier: this.configServiceTier,
              },
              origins: {},
              layers: this.configLayers,
            },
          }),
        ),
      );
    } else if (decoded.method === "turn/start") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: {
              turn: {
                id: "turn-1",
                items: [],
                itemsView: "full",
                status: "inProgress",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
              },
            },
          }),
        ),
      );
    } else if (decoded.method === "turn/steer") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({ id: decoded.id, result: { turnId: "turn-1" } }),
        ),
      );
    } else if (decoded.method === "review/start") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: {
              reviewThreadId: "thread-1",
              turn: {
                id: "review-turn-1",
                items: [],
                itemsView: "full",
                status: "inProgress",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
              },
            },
          }),
        ),
      );
    } else if (decoded.method === "thread/goal/get") {
      queueMicrotask(() =>
        this.emitMessage(JSON.stringify({
          id: decoded.id,
          result: { goal: this.goal },
        })),
      );
    } else if (decoded.method === "thread/goal/set") {
      queueMicrotask(() =>
        this.emitMessage(JSON.stringify({
          id: decoded.id,
          result: { goal: this.goal },
        })),
      );
    } else if (
      decoded.method === "turn/interrupt"
      || decoded.method === "thread/name/set"
      || decoded.method === "thread/compact/start"
    ) {
      queueMicrotask(() =>
        this.emitMessage(JSON.stringify({ id: decoded.id, result: {} })),
      );
    } else if (decoded.method === "thread/goal/clear") {
      queueMicrotask(() =>
        this.emitMessage(JSON.stringify({ id: decoded.id, result: { cleared: true } })),
      );
    }
  }

  receive(message: Record<string, unknown>): void {
    this.emitMessage(JSON.stringify(message));
  }

  disconnect(error?: Error): void {
    this.emitClose(error);
  }
}

describe("JsonRpcClient", () => {
  it("logs sanitized request timing at debug level", async () => {
    const transport = new FakeTransport();
    const debug = vi.fn();
    const client = new JsonRpcClient(transport, 60_000, {
      warn: vi.fn(),
      debug,
    });

    await client.connect();

    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "initialize",
        requestId: 1,
        durationMs: expect.any(Number),
        outcome: "success",
      }),
      "Codex JSON-RPC 请求完成",
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain("clientInfo");
  });

  it("initializes once and routes notifications", async () => {
    const transport = new FakeTransport();
    const client = new JsonRpcClient(transport);
    const methods: string[] = [];
    const receivedTimes: Array<number | undefined> = [];
    client.onNotification((notification) => {
      methods.push(notification.method);
      receivedTimes.push(notification.receivedAtMs);
    });

    const initialized = await client.connect();
    transport.receive({ method: "warning", params: { message: "test" } });

    expect(initialized.platformOs).toBe("macos");
    expect(transport.sent.map((message) => message.method)).toEqual(["initialize", "initialized"]);
    expect(transport.sent[1]).toEqual({ method: "initialized" });
    expect(transport.sent[0]).toMatchObject({
      params: {
        clientInfo: {
          name: "codex_connect",
          title: "Codex Connect Gateway",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: null,
          extensions: {
            "openai/form": {},
          },
        },
      },
    });
    expect(methods).toEqual(["warning"]);
    expect(receivedTimes).toEqual([expect.any(Number)]);
  });

  it("responds to server requests without treating them as notifications", async () => {
    const transport = new FakeTransport();
    const client = new JsonRpcClient(transport);
    client.setServerRequestHandler(async (request) => ({ accepted: request.method === "test/request" }));
    await client.connect();

    transport.receive({ id: "server-1", method: "test/request", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.sent.at(-1)).toEqual({ id: "server-1", result: { accepted: true } });
  });

  it("does not accept a connection that closes while initialization completes", async () => {
    const transport = new FakeTransport();
    transport.disconnectAfterInitialized = true;
    const client = new JsonRpcClient(transport);

    await expect(client.connect()).rejects.toThrow("初始化期间已断开");
  });

  it("does not respond to a server request after its connection disconnects", async () => {
    const transport = new FakeTransport();
    const warnings: Array<Record<string, unknown>> = [];
    let resolveRequest: ((value: unknown) => void) | undefined;
    const client = new JsonRpcClient(transport, 60_000, {
      warn: (fields) => warnings.push(fields),
    });
    client.setServerRequestHandler(() => new Promise((resolve) => {
      resolveRequest = resolve;
    }));
    await client.connect();

    transport.receive({ id: "server-1", method: "test/request", params: {} });
    transport.disconnect(new Error("socket lost"));
    resolveRequest?.({ accepted: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.sent.some((message) => message.id === "server-1")).toBe(false);
    expect(warnings).toContainEqual(expect.objectContaining({ reason: "stale-connection" }));
  });

  it("reports a server response send failure without attempting a second response", async () => {
    const transport = new FakeTransport();
    const warnings: Array<Record<string, unknown>> = [];
    const client = new JsonRpcClient(transport, 60_000, {
      warn: (fields) => warnings.push(fields),
    });
    client.setServerRequestHandler(async () => ({ accepted: true }));
    await client.connect();
    transport.failServerResponse = true;

    transport.receive({ id: "server-1", method: "test/request", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warnings).toContainEqual(expect.objectContaining({ reason: "response-send" }));
    expect(transport.sent.filter((message) => message.id === "server-1")).toHaveLength(0);
  });

  it("rejects excess concurrent server requests with a bounded overload response", async () => {
    const transport = new FakeTransport();
    let resolveFirst: ((value: unknown) => void) | undefined;
    const client = new JsonRpcClient(transport, 60_000, undefined, 1);
    client.setServerRequestHandler((request) => request.id === "server-1"
      ? new Promise((resolve) => {
          resolveFirst = resolve;
        })
      : Promise.resolve({ accepted: true }));
    await client.connect();

    transport.receive({ id: "server-1", method: "test/request", params: {} });
    transport.receive({ id: "server-2", method: "test/request", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.sent.find((message) => message.id === "server-2")).toEqual({
      id: "server-2",
      error: {
        code: -32000,
        message: "Client overloaded; request rejected.",
      },
    });
    resolveFirst?.({ accepted: true });
  });

  it("reinitializes a replacement connection after disconnect", async () => {
    const transport = new FakeTransport();
    const client = new JsonRpcClient(transport);
    const disconnects: string[] = [];
    client.onDisconnect((error) => disconnects.push(error.message));
    await client.connect();

    transport.disconnect(new Error("socket lost"));
    const initialized = await client.reconnect();

    expect(initialized.platformOs).toBe("macos");
    expect(disconnects).toEqual(["socket lost"]);
    expect(transport.sent.filter((message) => message.method === "initialize")).toHaveLength(2);
    expect(transport.sent.filter((message) => message.method === "initialized")).toHaveLength(2);
  });

  it("retries overload only when the caller marks a request safe", async () => {
    const transport = new FakeTransport();
    transport.simulateAccountUsageOverload = true;
    const client = new JsonRpcClient(transport);
    await client.connect();

    const result = await client.request<{ ok: boolean }>(
      { method: "account/usage/read", params: undefined },
      { retryOverload: true, attempts: 2 },
    );

    expect(result).toEqual({ ok: true });
    expect(transport.overloadResponses).toBe(2);
  });

  it("lists CLI, Remote TUI, and App Server thread sources explicitly", async () => {
    const transport = new FakeTransport();
    const rpc = new JsonRpcClient(transport);
    const client = new CodexAppServerClient(rpc, {
      sandbox: "workspace-write",
    });
    await client.connect();

    await client.listThreads("/tmp/project");

    const request = transport.sent.find((message) => message.method === "thread/list");
    expect(request?.params).toMatchObject({
      cwd: "/tmp/project",
      modelProviders: [],
      sourceKinds: ["cli", "vscode", "appServer"],
      useStateDbOnly: true,
      archived: false,
    });
  });

  it("maps official Thread responses to the stable routing snapshot", async () => {
    const transport = new FakeTransport();
    transport.threadListData = [appServerThread({
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
      source: { custom: "future-client" },
      turns: [{
        id: "turn-running",
        items: [],
        itemsView: "full",
        status: "inProgress",
        error: null,
        startedAt: 1,
        completedAt: null,
        durationMs: null,
      }],
    })];
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    const threads = await client.listThreads("/tmp/project");

    expect(threads).toEqual([{
      id: "thread-1",
      sessionId: "session-1",
      modelProvider: "openai",
      preview: "测试 Thread",
      name: null,
      isPinned: false,
      section: null,
      status: { type: "active" },
      cwd: "/tmp/project",
      source: "other",
      activeTurnId: "turn-running",
    }]);
  });

  it("extracts context compaction item ids when resuming a thread", async () => {
    const transport = new FakeTransport();
    transport.resumeThreadData = appServerThread({
      turns: [{
        id: "turn-1",
        items: [
          { type: "contextCompaction", id: "compact-1" },
          { type: "contextCompaction", id: "compact-2" },
        ],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1_000,
      }],
    });
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    const session = await client.resumeThread("thread-1", "/tmp/project");

    expect(session.contextCompactionItemIds).toEqual(["compact-1", "compact-2"]);
  });

  it("does not override process-owned provider configuration when resuming a thread", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await client.resumeThread("thread-1", "/tmp/project");

    expect(transport.sent.find((message) => message.method === "thread/resume")?.params)
      .not.toHaveProperty("config");
  });

  it("fails closed when an official Thread response lacks a required routing field", async () => {
    const transport = new FakeTransport();
    transport.threadListData = [appServerThread({ sessionId: undefined })];
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listThreads("/tmp/project"))
      .rejects.toThrow("Codex Thread 响应缺少有效 sessionId");
  });

  it("fails closed when an official Thread response has invalid section state", async () => {
    const transport = new FakeTransport();
    transport.threadListData = [appServerThread({ section: { name: "Pinned" } })];
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listThreads("/tmp/project"))
      .rejects.toThrow("Codex Thread 响应缺少有效 section id");
  });

  it("passes stable search/archive filters and uses explicit archive methods", async () => {
    const transport = new FakeTransport();
    const rpc = new JsonRpcClient(transport);
    const client = new CodexAppServerClient(rpc, { sandbox: "workspace-write" });
    await client.connect();

    await client.listThreads("/tmp/project", { archived: true, searchTerm: "修复" });
    await client.archiveThread("thread-1");
    await client.unarchiveThread("thread-1");
    await client.setThreadPinned("thread-1", true);

    expect(transport.sent.find((message) => message.method === "thread/list")?.params)
      .toMatchObject({ archived: true, searchTerm: "修复" });
    expect(transport.sent.find((message) => message.method === "thread/archive")?.params)
      .toEqual({ threadId: "thread-1" });
    expect(transport.sent.find((message) => message.method === "thread/unarchive")?.params)
      .toEqual({ threadId: "thread-1" });
    expect(transport.sent.find((message) => message.method === "thread/metadata/update")?.params)
      .toEqual({ threadId: "thread-1", gitInfo: { sha: null } });
    expect(transport.sent.find((message) => message.method === "thread/section/move")?.params)
      .toEqual({
        threadId: "thread-1",
        sectionId: pinnedThreadSection.id,
        beforeThreadId: null,
      });
  });

  it.each([
    {
      entry: "/pin",
      operate: (client: CodexAppServerClient) => client.setThreadPinned("thread-1", true),
    },
    {
      entry: "custom Thread Section move",
      operate: (client: CodexAppServerClient) =>
        client.moveThreadToSection("thread-1", "section-project"),
    },
  ])("fails closed before $entry when Thread metadata update returns another target", async ({
    operate,
  }) => {
    const transport = new FakeTransport();
    transport.metadataUpdateThreadData = appServerThread({ id: "thread-other" });
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(operate(client))
      .rejects.toThrow("Codex Thread 分区元数据更新目标不一致");
    expect(transport.sent.some((message) => message.method === "thread/section/move"))
      .toBe(false);
  });

  it("passes stable Thread Section filters and position ordering", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await client.listThreads("/tmp/project", {
      fullScan: true,
      sectionId: "section-project",
      sortKey: "section_position",
      sortDirection: "asc",
    });

    expect(transport.sent.find((message) => message.method === "thread/list")?.params)
      .toMatchObject({
        useStateDbOnly: false,
        sectionId: "section-project",
        sortKey: "section_position",
        sortDirection: "asc",
      });
  });

  it("manages stable Thread Sections and preserves the requested thread order", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listThreadSections()).resolves.toEqual([{
      ...pinnedThreadSection,
      builtIn: "pinned",
    }]);
    const created = await client.createThreadSection("项目甲");
    await expect(client.renameThreadSection(created.id, "项目乙")).resolves.toMatchObject({
      id: created.id,
      name: "项目乙",
      builtIn: null,
    });
    await client.moveThreadToSection("thread-1", created.id, "thread-before");
    await expect(client.readThread("thread-1")).resolves.toMatchObject({
      section: { id: created.id, name: "项目乙", builtIn: null },
      isPinned: false,
    });
    expect(transport.sent.findLast((message) => message.method === "thread/section/move")?.params)
      .toEqual({
        threadId: "thread-1",
        sectionId: created.id,
        beforeThreadId: "thread-before",
      });
    await client.deleteThreadSection(created.id);
    await expect(client.listThreadSections()).resolves.toHaveLength(1);
  });

  it("reads account rate limits through the stable App Server method", async () => {
    const transport = new FakeTransport();
    transport.accountRateLimitsResult = {
      rateLimits: appServerRateLimit({ planType: "ent26" }),
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    };
    const rpc = new JsonRpcClient(transport);
    const client = new CodexAppServerClient(rpc, {
      sandbox: "workspace-write",
    });
    await client.connect();

    const result = await client.accountRateLimits();

    expect(result.limits[0]?.planType).toBe("ent26");
    expect(transport.sent.some((message) => message.method === "account/rateLimits/read")).toBe(true);
  });

  it("maps account usage and multi-bucket limits to stable Application summaries", async () => {
    const transport = new FakeTransport();
    transport.accountUsageResult = {
      summary: {
        lifetimeTokens: 123,
        peakDailyTokens: 45,
        longestRunningTurnSec: 6,
        currentStreakDays: 7,
        longestStreakDays: 8,
      },
      dailyUsageBuckets: [{ startDate: "2026-07-25", tokens: 9 }],
    };
    transport.accountRateLimitsResult = {
      rateLimits: appServerRateLimit(),
      rateLimitsByLimitId: {
        codex: appServerRateLimit({
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 100 },
        }),
        other: appServerRateLimit({ limitId: "other", limitName: "Other", planType: null }),
      },
      rateLimitResetCredits: { availableCount: 2, credits: null },
    };
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.accountUsage()).resolves.toEqual({
      summary: {
        lifetimeTokens: 123,
        peakDailyTokens: 45,
        longestRunningTurnSec: 6,
        currentStreakDays: 7,
        longestStreakDays: 8,
      },
      daily: [{ startDate: "2026-07-25", tokens: 9 }],
    });
    await expect(client.accountRateLimits()).resolves.toMatchObject({
      limits: [
        {
          limitId: "codex",
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 100 },
        },
        {
          limitId: "other",
          limitName: "Other",
        },
      ],
      resetCreditsAvailable: 2,
    });
  });

  it("fails closed when account query responses contain invalid metrics", async () => {
    const usageTransport = new FakeTransport();
    usageTransport.accountUsageResult = {
      ...usageTransport.accountUsageResult,
      summary: {
        lifetimeTokens: "secret upstream body",
        peakDailyTokens: null,
        longestRunningTurnSec: null,
        currentStreakDays: null,
        longestStreakDays: null,
      },
    };
    const usageClient = new CodexAppServerClient(new JsonRpcClient(usageTransport), {
      sandbox: "workspace-write",
    });
    await usageClient.connect();
    await expect(usageClient.accountUsage())
      .rejects.toThrow("Codex 响应缺少有效 lifetimeTokens");

    const limitsTransport = new FakeTransport();
    limitsTransport.accountRateLimitsResult = {
      rateLimits: appServerRateLimit({ planType: "future-plan" }),
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    };
    const limitsClient = new CodexAppServerClient(new JsonRpcClient(limitsTransport), {
      sandbox: "workspace-write",
    });
    await limitsClient.connect();
    await expect(limitsClient.accountRateLimits())
      .rejects.toThrow("Codex 响应缺少有效 planType");
  });

  it("omits params for App Server methods whose generated request has no params", async () => {
    const transport = new FakeTransport();
    const rpc = new JsonRpcClient(transport);
    const client = new CodexAppServerClient(rpc, {
      sandbox: "workspace-write",
    });
    await client.connect();

    await client.accountUsage();
    await client.accountRateLimits();

    expect(transport.sent.find((message) => message.method === "account/usage/read"))
      .toEqual(expect.objectContaining({ method: "account/usage/read" }));
    expect(transport.sent.find((message) => message.method === "account/usage/read"))
      .not.toHaveProperty("params");
    expect(transport.sent.find((message) => message.method === "account/rateLimits/read"))
      .not.toHaveProperty("params");
  });

  it("maps only directly installed user and repo Skills", async () => {
    const transport = new FakeTransport();
    transport.skillsResult = {
      data: [{
        cwd: "/tmp/project",
        errors: [],
        skills: [
          {
            name: "personal",
            description: "Personal",
            path: "/Users/test/.codex/skills/personal/SKILL.md",
            scope: "user",
            enabled: true,
          },
          {
            name: "repo",
            description: "Repository",
            path: "/tmp/project/.codex/skills/repo/SKILL.md",
            scope: "repo",
            enabled: true,
          },
          {
            name: "plugin:cached",
            description: "Plugin",
            path: "/Users/test/.codex/plugins/cache/plugin/skills/cached/SKILL.md",
            scope: "user",
            enabled: true,
          },
          {
            name: "system",
            description: "System",
            path: "/Users/test/.codex/skills/.system/system/SKILL.md",
            scope: "system",
            enabled: true,
          },
          {
            name: "disabled",
            description: "Disabled",
            path: "/Users/test/.codex/skills/disabled/SKILL.md",
            scope: "user",
            enabled: false,
          },
        ],
      }, {
        cwd: "/tmp/other",
        errors: [],
        skills: [{
          name: "repo",
          description: "Other repository",
          path: "/tmp/other/.codex/skills/repo/SKILL.md",
          scope: "repo",
          enabled: true,
        }],
      }],
    };
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listSkills("/tmp/project")).resolves.toEqual([
      { name: "personal", description: "Personal" },
      { name: "repo", description: "Repository" },
    ]);
    await expect(client.resolveSkill("/tmp/project", "repo")).resolves.toEqual({
      name: "repo",
      path: "/tmp/project/.codex/skills/repo/SKILL.md",
    });
    await expect(client.resolveSkill("/tmp/project", "system"))
      .resolves.toBeUndefined();
    expect(transport.sent.find((message) => message.method === "skills/list")?.params)
      .toEqual({ cwds: ["/tmp/project"], forceReload: false });
  });

  it("fails closed when an installed Skill lacks a required display field", async () => {
    const transport = new FakeTransport();
    transport.skillsResult = {
      data: [{
        cwd: "/tmp/project",
        errors: [],
        skills: [{
          name: "",
          description: "Broken",
          path: "/Users/test/.codex/skills/broken/SKILL.md",
          scope: "user",
          enabled: true,
        }],
      }],
    };
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listSkills("/tmp/project"))
      .rejects.toThrow("Codex 响应缺少有效 skill name");
  });

  it("lists installed Plugins and resolves only enabled available entries", async () => {
    const transport = new FakeTransport();
    transport.pluginInstalledResult = {
      marketplaces: [{
        name: "local",
        plugins: [
          appServerPlugin(),
          appServerPlugin({
            id: "disabled@local",
            name: "disabled",
            enabled: false,
            authPolicy: "ON_INSTALL",
            interface: null,
          }),
          appServerPlugin({
            id: "admin-blocked@local",
            name: "admin-blocked",
            availability: "DISABLED_BY_ADMIN",
            disabledReason: "plan_not_eligible",
            eligiblePlanTypes: ["plus", "pro", "enterprise_cbp_automation"],
          }),
          appServerPlugin({
            id: "not-installed@local",
            name: "not-installed",
            installed: false,
          }),
        ],
      }],
      marketplaceLoadErrors: [],
    };
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listPlugins("/tmp/project")).resolves.toEqual({
      plugins: [{
        id: "github@local",
        name: "github",
        displayName: "GitHub",
        marketplaceName: "local",
        description: "GitHub development tools",
        enabled: true,
        available: true,
        version: "0.1.8",
        localVersion: "0.1.8",
        source: "local",
        installedAt: 1_786_294_800,
        developerName: "OpenAI",
        category: "Developer tools",
        capabilities: ["Repository inspection", "Pull request management"],
        authPolicy: "onUse",
        eligiblePlanTypes: [],
        disabledReason: null,
      },
      {
        id: "disabled@local",
        name: "disabled",
        displayName: "disabled",
        marketplaceName: "local",
        description: null,
        enabled: false,
        available: true,
        version: "0.1.8",
        localVersion: "0.1.8",
        source: "local",
        installedAt: 1_786_294_800,
        developerName: null,
        category: null,
        capabilities: [],
        authPolicy: "onInstall",
        eligiblePlanTypes: [],
        disabledReason: null,
      },
      {
        id: "admin-blocked@local",
        name: "admin-blocked",
        displayName: "GitHub",
        marketplaceName: "local",
        description: "GitHub development tools",
        enabled: true,
        available: false,
        version: "0.1.8",
        localVersion: "0.1.8",
        source: "local",
        installedAt: 1_786_294_800,
        developerName: "OpenAI",
        category: "Developer tools",
        capabilities: ["Repository inspection", "Pull request management"],
        authPolicy: "onUse",
        eligiblePlanTypes: ["plus", "pro", "enterprise_cbp_automation"],
        disabledReason: "plan_not_eligible",
      }],
      loadErrorCount: 0,
    });
    await expect(client.resolvePlugin("/tmp/project", "github@local"))
      .resolves.toEqual({
        id: "github@local",
        name: "github",
        displayName: "GitHub",
        path: "plugin://github@local",
      });
    await expect(client.resolvePlugin("/tmp/project", "disabled@local"))
      .resolves.toBeUndefined();
    await expect(client.resolvePlugin("/tmp/project", "admin-blocked@local"))
      .resolves.toBeUndefined();
    expect(transport.sent.find((message) => message.method === "plugin/installed")?.params)
      .toEqual({ cwds: ["/tmp/project"] });
  });

  it("preserves a bounded count when Plugin marketplaces only partially load", async () => {
    const transport = new FakeTransport();
    transport.pluginInstalledResult = {
      marketplaces: [{
        name: "local",
        plugins: [appServerPlugin()],
      }],
      marketplaceLoadErrors: [
        { marketplacePath: "/private/one.json", message: "secret one" },
        { marketplacePath: "/private/two.json", message: "secret two" },
      ],
    };
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listPlugins("/tmp/project")).resolves.toEqual({
      plugins: [expect.objectContaining({ id: "github@local" })],
      loadErrorCount: 2,
    });
  });

  it("fails closed when an installed Plugin id does not match its marketplace", async () => {
    const transport = new FakeTransport();
    transport.pluginInstalledResult = {
      marketplaces: [{
        name: "local",
        plugins: [appServerPlugin({ id: "github@other" })],
      }],
      marketplaceLoadErrors: [],
    };
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listPlugins("/tmp/project"))
      .rejects.toThrow("Codex 响应包含不一致的 plugin id");
  });

  it("fails closed when an installed Plugin has an unknown auth policy", async () => {
    const transport = new FakeTransport();
    transport.pluginInstalledResult = {
      marketplaces: [{
        name: "local",
        plugins: [appServerPlugin({ authPolicy: "SOMETIMES" })],
      }],
      marketplaceLoadErrors: [],
    };
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listPlugins("/tmp/project"))
      .rejects.toThrow("Codex 响应缺少有效 plugin authPolicy");
  });

  it("fails closed when an invocable Skill has an unsafe name or path", async () => {
    const transport = new FakeTransport();
    transport.skillsResult = {
      data: [{
        cwd: "/tmp/project",
        errors: [],
        skills: [{
          name: "unsafe skill",
          description: "Broken",
          path: "relative/SKILL.md",
          scope: "repo",
          enabled: true,
        }],
      }],
    };
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.resolveSkill("/tmp/project", "unsafe skill"))
      .rejects.toThrow("Codex 返回了无法安全调用的 Skill");
  });

  it("maps and paginates MCP status into stable summaries", async () => {
    const transport = new FakeTransport();
    transport.mcpPages = [
      {
        data: [appServerMcpStatus({
          name: "project-tools",
          authStatus: "oAuth",
          tools: { search: {}, fetch: {} },
        })],
        nextCursor: "1",
      },
      {
        data: [appServerMcpStatus({
          name: "user-tools",
          authStatus: "bearerToken",
          tools: {},
        })],
        nextCursor: null,
      },
    ];
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listMcpServers("thread-1")).resolves.toEqual([
      { name: "project-tools", authStatus: "oAuth", toolCount: 2 },
      { name: "user-tools", authStatus: "bearerToken", toolCount: 0 },
    ]);
    expect(
      transport.sent
        .filter((message) => message.method === "mcpServerStatus/list")
        .map((message) => message.params),
    ).toEqual([
      {
        limit: 100,
        detail: "toolsAndAuthOnly",
        threadId: "thread-1",
      },
      {
        limit: 100,
        detail: "toolsAndAuthOnly",
        threadId: "thread-1",
        cursor: "1",
      },
    ]);
  });

  it("preserves the official unknown MCP authentication status", async () => {
    const transport = new FakeTransport();
    transport.mcpPages = [{
      data: [appServerMcpStatus({ authStatus: "unknown" })],
      nextCursor: null,
    }];
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listMcpServers()).resolves.toEqual([
      { name: "local-tools", authStatus: "unknown", toolCount: 1 },
    ]);
  });

  it("maps full MCP details, starts OAuth, and reads bounded resources", async () => {
    const transport = new FakeTransport();
    transport.mcpPages = [{
      data: [appServerMcpStatus({
        name: "project-tools",
        authStatus: "notLoggedIn",
        serverInfo: {
          name: "project-tools",
          title: "Project Tools",
          version: "1.2.3",
          description: "Project MCP server",
        },
        tools: {
          search: {
            name: "search",
            title: "Search",
            description: "Search project data",
            annotations: { readOnlyHint: true },
          },
        },
        resources: [{
          uri: "project://readme",
          name: "readme",
          title: "README",
          description: "Project README",
          mimeType: "text/markdown",
        }],
        resourceTemplates: [{
          uriTemplate: "project://files/{path}",
          name: "files",
          title: "Files",
          description: "Project files",
          mimeType: "text/plain",
        }],
      })],
      nextCursor: null,
    }];
    transport.mcpResourceResult = {
      contents: [
        {
          uri: "project://readme",
          mimeType: "text/plain",
          text: "x".repeat(20_001),
        },
        {
          uri: "project://logo",
          mimeType: "image/png",
          blob: "YWJjZA==",
        },
      ],
    };
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listMcpServerDetails("thread-1")).resolves.toEqual([{
      name: "project-tools",
      authStatus: "notLoggedIn",
      toolCount: 1,
      serverTitle: "Project Tools",
      serverVersion: "1.2.3",
      serverDescription: "Project MCP server",
      tools: [{
        name: "search",
        title: "Search",
        description: "Search project data",
        access: "readOnly",
      }],
      resources: [{
        uri: "project://readme",
        name: "readme",
        title: "README",
        description: "Project README",
        mimeType: "text/markdown",
      }],
      resourceTemplates: [{
        uriTemplate: "project://files/{path}",
        name: "files",
        title: "Files",
        description: "Project files",
        mimeType: "text/plain",
      }],
    }]);
    await expect(client.startMcpOAuthLogin("project-tools", "thread-1"))
      .resolves.toEqual({
        server: "project-tools",
        authorizationUrl: "https://example.test/oauth",
      });
    const resource = await client.readMcpResource(
      "project-tools",
      "project://readme",
      "thread-1",
    );
    expect(resource.contents[0]).toMatchObject({
      kind: "text",
      truncated: true,
    });
    expect(resource.contents[0]).toHaveProperty("text", "x".repeat(8_000));
    expect(resource.contents[1]).toEqual({
      kind: "blob",
      uri: "project://logo",
      mimeType: "image/png",
      encodedCharacters: 8,
    });
    expect(resource.omittedContentCount).toBe(0);
    await expect(client.reloadMcpServers()).resolves.toBeUndefined();
    const reloadRequest = transport.sent.find(
      (message) => message.method === "config/mcpServer/reload",
    );
    expect(reloadRequest).toBeDefined();
    expect(reloadRequest).not.toHaveProperty("params");
    expect(transport.sent.find((message) => message.method === "mcpServerStatus/list")?.params)
      .toEqual({ limit: 100, detail: "full", threadId: "thread-1" });
    expect(transport.sent.find((message) => message.method === "mcpServer/oauth/login")?.params)
      .toEqual({ name: "project-tools", threadId: "thread-1" });
    expect(transport.sent.find((message) => message.method === "mcpServer/resource/read")?.params)
      .toEqual({ server: "project-tools", uri: "project://readme", threadId: "thread-1" });
  });

  it("normalizes multiline and oversized MCP descriptions without rejecting details", async () => {
    const transport = new FakeTransport();
    transport.mcpPages = [{
      data: [appServerMcpStatus({
        serverInfo: {
          name: "local-tools",
          title: "Local Tools",
          version: "1.0.0",
          description: " Server\n\tsummary ",
        },
        tools: {
          search: {
            name: "search",
            title: "Search",
            description: ` Search\n\ttool ${"x".repeat(12_700)} `,
          },
        },
        resources: [{
          uri: "local://readme",
          name: "readme",
          title: "README",
          description: " Resource\n\tsummary ",
          mimeType: "text/plain",
        }],
      })],
      nextCursor: null,
    }];
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    const [server] = await client.listMcpServerDetails();
    expect(server?.serverDescription).toBe("Server summary");
    expect(server?.tools[0]?.description).toHaveLength(2_000);
    expect(server?.tools[0]?.description).toMatch(/^Search tool x+$/u);
    expect(server?.resources[0]?.description).toBe("Resource summary");
  });

  it.each([
    { name: "NUL", value: "\u0000" },
    { name: "ESC", value: "\u001b" },
  ])("rejects $name in MCP descriptions", async ({ value }) => {
    const transport = new FakeTransport();
    transport.mcpPages = [{
      data: [appServerMcpStatus({
        tools: {
          search: {
            name: "search",
            title: "Search",
            description: `unsafe${value}description`,
          },
        },
      })],
      nextCursor: null,
    }];
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listMcpServerDetails())
      .rejects.toThrow("Codex 响应缺少有效 MCP tool description");
  });

  it("bounds MCP resource content count and aggregate visible text", async () => {
    const transport = new FakeTransport();
    transport.mcpResourceResult = {
      contents: Array.from({ length: 10 }, (_, index) => ({
        uri: `project://entry/${index + 1}`,
        mimeType: "text/plain",
        text: String(index + 1).repeat(3_000),
      })),
    };
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    const resource = await client.readMcpResource("project-tools", "project://all");
    expect(resource.contents).toHaveLength(3);
    expect(resource.contents.reduce(
      (characters, content) => characters + (content.kind === "text" ? content.text.length : 0),
      0,
    )).toBe(8_000);
    expect(resource.contents.at(-1)).toMatchObject({
      kind: "text",
      truncated: true,
    });
    expect(resource.omittedContentCount).toBe(7);
  });

  it("redacts credentials from MCP resource text before returning it", async () => {
    const transport = new FakeTransport();
    transport.mcpResourceResult = {
      contents: [{
        uri: "project://secrets",
        mimeType: "text/plain",
        text: [
          "Authorization: Bearer bearer-secret",
          "Cookie: session=cookie-secret",
          "API_TOKEN=environment-secret",
        ].join("\n"),
      }],
    };
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    const resource = await client.readMcpResource(
      "project-tools",
      "project://secrets",
    );
    expect(resource.contents[0]).toMatchObject({
      kind: "text",
      text: [
        "Authorization: Bearer [REDACTED]",
        "Cookie: [REDACTED]",
        "API_TOKEN=[REDACTED]",
      ].join("\n"),
    });
    expect(JSON.stringify(resource)).not.toMatch(
      /bearer-secret|cookie-secret|environment-secret/u,
    );
  });

  it("rejects an unsafe MCP OAuth authorization URL", async () => {
    const transport = new FakeTransport();
    transport.mcpOauthResult = { authorizationUrl: "http://example.test/oauth" };
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.startMcpOAuthLogin("project-tools"))
      .rejects.toThrow("Codex 响应缺少安全的 MCP OAuth authorization URL");
  });

  it("fails closed when MCP status lacks a required stable field", async () => {
    const transport = new FakeTransport();
    transport.mcpPages = [{
      data: [appServerMcpStatus({ authStatus: "invalid" })],
      nextCursor: null,
    }];
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listMcpServers())
      .rejects.toThrow("Codex 响应缺少有效 MCP server authStatus");
  });

  it("rejects repeated MCP pagination cursors", async () => {
    const transport = new FakeTransport();
    transport.mcpPages = [{
      data: [],
      nextCursor: "same-cursor",
    }];
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listMcpServers())
      .rejects.toThrow("mcpServerStatus/list 返回了循环分页游标");
  });

  it("maps and paginates Permission Profiles into stable options", async () => {
    const transport = new FakeTransport();
    transport.permissionPages = [
      {
        data: [{
          id: ":read-only",
          description: null,
          allowed: true,
        }],
        nextCursor: "1",
      },
      {
        data: [{
          id: "project",
          description: "Project policy",
          allowed: false,
        }],
        nextCursor: null,
      },
    ];
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listPermissionProfiles("/tmp/project")).resolves.toEqual([
      { id: ":read-only", description: null, allowed: true },
      { id: "project", description: "Project policy", allowed: false },
    ]);
    expect(
      transport.sent
        .filter((message) => message.method === "permissionProfile/list")
        .map((message) => message.params),
    ).toEqual([
      { cwd: "/tmp/project", limit: 100 },
      { cwd: "/tmp/project", limit: 100, cursor: "1" },
    ]);
  });

  it("fails closed when a Permission Profile lacks a required stable field", async () => {
    const transport = new FakeTransport();
    transport.permissionPages = [{
      data: [{ id: "", description: null, allowed: true }],
      nextCursor: null,
    }];
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listPermissionProfiles("/tmp/project"))
      .rejects.toThrow("Codex 响应缺少有效 permission profile id");
  });

  it("rejects repeated Permission Profile pagination cursors", async () => {
    const transport = new FakeTransport();
    transport.permissionPages = [{ data: [], nextCursor: "same-cursor" }];
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listPermissionProfiles("/tmp/project"))
      .rejects.toThrow("permissionProfile/list 返回了循环分页游标");
  });

  it("persists the Fast default through the App Server config API", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await client.writeDefaultFastMode(false);
    await client.writeDefaultFastMode(true);

    expect(
      transport.sent
        .filter((message) => message.method === "config/batchWrite")
        .map((message) => message.params),
    ).toEqual([
      {
        edits: [{
          keyPath: "service_tier",
          value: "default",
          mergeStrategy: "replace",
        }],
        reloadUserConfig: true,
      },
      {
        edits: [{
          keyPath: "service_tier",
          value: "fast",
          mergeStrategy: "replace",
        }],
        reloadUserConfig: true,
      },
    ]);
  });

  it("persists the default model and reasoning effort as one App Server config write", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await client.writeDefaultModelSettings("gpt-test", "high");

    expect(
      transport.sent
        .filter((message) => message.method === "config/batchWrite")
        .map((message) => message.params),
    ).toEqual([{
      edits: [{
        keyPath: "model",
        value: "gpt-test",
        mergeStrategy: "replace",
      }, {
        keyPath: "model_reasoning_effort",
        value: "high",
        mergeStrategy: "replace",
      }],
      reloadUserConfig: true,
    }]);
  });

  it("writes structured user settings and removals through one config transaction", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await client.writeUserConfigEdits([{
      keyPath: "features.multi_agent_v2",
      value: true,
    }, {
      keyPath: "agents.ds",
      value: {
        description: "DeepSeek role",
        config_file: "/tmp/ds.toml",
        nickname_candidates: ["DeepSeek"],
      },
    }, {
      keyPath: "agents.old",
      value: null,
    }]);

    expect(transport.sent.find((message) => message.method === "config/batchWrite")?.params)
      .toEqual({
        edits: [{
          keyPath: "features.multi_agent_v2",
          value: true,
          mergeStrategy: "replace",
        }, {
          keyPath: "agents.ds",
          value: {
            description: "DeepSeek role",
            config_file: "/tmp/ds.toml",
            nickname_candidates: ["DeepSeek"],
          },
          mergeStrategy: "replace",
        }, {
          keyPath: "agents.old",
          value: null,
          mergeStrategy: "replace",
        }],
        reloadUserConfig: true,
      });
  });

  it("reads the raw user config layer and guards a subsequent config write by version", async () => {
    const transport = new FakeTransport();
    transport.configLayers = [{
      name: { type: "user", file: "/tmp/config.toml", profile: null },
      version: "sha256:current",
      config: { agents: { ds: { config_file: "/tmp/ds.toml" } } },
      disabledReason: null,
    }];
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.readUserConfigSnapshot()).resolves.toEqual({
      config: { agents: { ds: { config_file: "/tmp/ds.toml" } } },
      version: "sha256:current",
    });
    await client.writeUserConfigEdits(
      [{ keyPath: "agents.ds", value: null }],
      { expectedVersion: "sha256:current" },
    );

    expect(transport.sent.find((message) => message.method === "config/read")?.params)
      .toEqual({ includeLayers: true });
    expect(transport.sent.find((message) => message.method === "config/batchWrite")?.params)
      .toMatchObject({ expectedVersion: "sha256:current" });
  });

  it("reads the default model and reasoning effort through the App Server config API", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.readDefaultModelSettings()).resolves.toEqual({
      model: "gpt-test",
      effort: "high",
    });
    expect(transport.sent.find((message) => message.method === "config/read")?.params)
      .toEqual({ includeLayers: false });
  });

  it("maps the effective Fast config to a stable service-tier value", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    const result = await client.readDefaultServiceTier("/tmp/project");

    expect(result).toBe("fast");
    expect(transport.sent.find((message) => message.method === "config/read")?.params)
      .toEqual({ cwd: "/tmp/project", includeLayers: false });
  });

  it("fails closed when the effective Fast config has an invalid service tier", async () => {
    const transport = new FakeTransport();
    transport.configServiceTier = 1;
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.readDefaultServiceTier("/tmp/project"))
      .rejects.toThrow("Codex 响应缺少有效 config service_tier");
  });

  it("tags Gateway user input with a client message id", async () => {
    const transport = new FakeTransport();
    const rpc = new JsonRpcClient(transport);
    const client = new CodexAppServerClient(rpc, {
      sandbox: "workspace-write",
    });
    await client.connect();

    await client.startTurn(
      "thread-1",
      [
        { type: "text", text: "测试输入" },
        { type: "localImage", path: "/tmp/screenshot.png" },
        { type: "localAudio", path: "/tmp/voice.ogg" },
        {
          type: "skill",
          name: "systematic-debugging",
          path: "/tmp/project/.codex/skills/systematic-debugging/SKILL.md",
        },
        {
          type: "plugin",
          name: "GitHub",
          path: "plugin://github@local",
        },
      ],
      "codex_connect:request-1",
      "/tmp/project",
      { model: "gpt-selected", effort: "high", serviceTier: null },
    );
    await client.startTurn(
      "thread-1",
      [{ type: "text", text: "开启 Fast" }],
      "codex_connect:request-fast",
      "/tmp/project",
      { serviceTier: "priority" },
    );
    await client.steerTurn(
      "thread-1",
      "turn-1",
      [{ type: "text", text: "补充输入" }],
      "codex_connect:request-2",
    );

    expect(transport.sent.find((message) => message.method === "turn/start")?.params)
      .toMatchObject({
        clientUserMessageId: "codex_connect:request-1",
        input: [
          { type: "text", text: "测试输入", text_elements: [] },
          { type: "localImage", path: "/tmp/screenshot.png" },
          { type: "localAudio", path: "/tmp/voice.ogg" },
          {
            type: "skill",
            name: "systematic-debugging",
            path: "/tmp/project/.codex/skills/systematic-debugging/SKILL.md",
          },
          {
            type: "mention",
            name: "GitHub",
            path: "plugin://github@local",
          },
        ],
        cwd: "/tmp/project",
        model: "gpt-selected",
        effort: "high",
        serviceTier: null,
      });
    expect(transport.sent.filter((message) => message.method === "turn/start")[1]?.params)
      .toMatchObject({
        clientUserMessageId: "codex_connect:request-fast",
        serviceTier: "priority",
      });
    expect(transport.sent.find((message) => message.method === "turn/steer")?.params)
      .toMatchObject({ clientUserMessageId: "codex_connect:request-2" });
  });

  it("lists official collaboration presets and sends the selected mode on turn/start", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listCollaborationModes()).resolves.toEqual([
      { name: "Default", mode: "default", model: null, effort: null },
      { name: "Plan", mode: "plan", model: null, effort: "medium" },
    ]);
    await client.startTurn(
      "thread-1",
      [{ type: "text", text: "设计发布流程" }],
      "codex_connect:plan-1",
      "/tmp/project",
      {
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-selected",
            effort: "medium",
            developerInstructions: null,
          },
        },
      },
    );

    expect(transport.sent.find((message) => message.method === "collaborationMode/list"))
      .toMatchObject({ params: {} });
    expect(transport.sent.find((message) => message.method === "turn/start")?.params)
      .toMatchObject({
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-selected",
            reasoning_effort: "medium",
            developer_instructions: null,
          },
        },
      });
  });

  it("maps Review and Goal responses to stable Application results", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    const review = await client.startReview("thread-1", {
      type: "commit",
      sha: "abc123",
      title: null,
    });
    const goal = await client.getGoal("thread-1");
    const updated = await client.setGoal("thread-1", "完成协议边界");
    await client.clearGoal("thread-1");
    await client.interruptTurn("thread-1", "turn-1");
    await client.setThreadName("thread-1", "新名称");
    await client.setThreadPinned("thread-1", false);
    await client.compactThread("thread-1");

    expect(review).toEqual({ threadId: "thread-1", turnId: "review-turn-1" });
    expect(goal).toEqual({
      threadId: "thread-1",
      objective: "完成协议边界",
      status: "active",
      tokenBudget: null,
      tokensUsed: 100,
      timeUsedSeconds: 10,
      createdAt: 1,
      updatedAt: 2,
    });
    expect(updated).toEqual(goal);
    expect(transport.sent.find((message) => message.method === "review/start")?.params)
      .toEqual({
        threadId: "thread-1",
        target: { type: "commit", sha: "abc123", title: null },
        delivery: "inline",
      });
    expect(transport.sent.find((message) => message.method === "thread/goal/set")?.params)
      .toEqual({
        threadId: "thread-1",
        objective: "完成协议边界",
        status: "active",
      });
    expect(transport.sent.find((message) => message.method === "turn/interrupt")?.params)
      .toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(transport.sent.find((message) => message.method === "thread/metadata/update")?.params)
      .toEqual(undefined);
  });

  it("fails closed when a Goal response lacks a required stable field", async () => {
    const transport = new FakeTransport();
    transport.goal = appServerGoal({ objective: undefined });
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.getGoal("thread-1"))
      .rejects.toThrow("Codex 响应缺少有效 goal objective");
  });

  it("uses CODEX_MODEL only when starting a new thread", async () => {
    const transport = new FakeTransport();
    const rpc = new JsonRpcClient(transport);
    const client = new CodexAppServerClient(rpc, {
      sandbox: "workspace-write",
      model: "gpt-configured",
    });
    await client.connect();

    await client.startThread("/tmp/project");
    await client.startTurn(
      "thread-1",
      [{ type: "text", text: "测试输入" }],
      "request-1",
      "/tmp/project",
    );

    const starts = transport.sent.filter((message) => message.method === "thread/start");
    expect(starts[0]?.params)
      .toMatchObject({ model: "gpt-configured", serviceName: "codex_connect" });
    expect(transport.sent.find((message) => message.method === "turn/start")?.params)
      .not.toHaveProperty("model");
  });

  it("starts a new thread with an explicit model provider", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await client.startThread("/tmp/project", {
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
    });

    expect(transport.sent.find((message) => message.method === "thread/start")?.params)
      .toMatchObject({
        model: "deepseek-v4-flash",
        modelProvider: "deepseek",
      });
  });

  it("starts a new thread with workspace permissions", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await client.startThread("/tmp/project", {
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });

    expect(transport.sent.find((message) => message.method === "thread/start")?.params)
      .toMatchObject({
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      });
  });

  it("prefers a permission profile over sandbox when starting a thread", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await client.startThread("/tmp/project", {
      permissions: ":read-only",
      sandbox: "workspace-write",
    });

    const params = transport.sent
      .find((message) => message.method === "thread/start")?.params;
    expect(params).toMatchObject({ permissions: ":read-only" });
    expect(params).not.toHaveProperty("sandbox");
  });

  it("resumes a thread with workspace permissions", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await client.resumeThread("thread-1", "/tmp/project", {
      sandbox: "read-only",
      approvalPolicy: "untrusted",
    });

    expect(transport.sent.find((message) => message.method === "thread/resume")?.params)
      .toMatchObject({
        sandbox: "read-only",
        approvalPolicy: "untrusted",
      });
  });

  it("forks a thread with an explicit model provider", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    const forked = await client.forkThread("thread-1", "/tmp/project", {
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
    });

    expect(forked).toMatchObject({
      model: "deepseek-v4-flash",
      modelProvider: "deepseek",
      thread: { id: "thread-forked" },
    });
    expect(transport.sent.find((message) => message.method === "thread/fork")?.params)
      .toMatchObject({
        threadId: "thread-1",
        model: "deepseek-v4-flash",
        modelProvider: "deepseek",
      });
  });

  it("rejects repeated pagination cursors", async () => {
    const transport = new FakeTransport();
    transport.circularModelCursor = true;
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listModels()).rejects.toThrow("model/list 返回了循环分页游标");
  });

  it("maps the official model catalog to the stable Application model shape", async () => {
    const transport = new FakeTransport();
    transport.modelListData = [
      appServerModel(),
      appServerModel({ id: "hidden", model: "hidden", hidden: true }),
    ];
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listModels()).resolves.toEqual([{
      id: "gpt-test",
      model: "gpt-test",
      displayName: "GPT Test",
      supportedReasoningEfforts: [{
        effort: "medium",
        description: "Medium",
      }],
      defaultReasoningEffort: "medium",
      serviceTiers: [{
        id: "priority",
        name: "Fast",
      }],
      defaultServiceTier: "default",
      isDefault: true,
      inputModalities: ["text"],
    }]);
  });

  it("fails closed when a model response lacks a required stable field", async () => {
    const transport = new FakeTransport();
    transport.modelListData = [appServerModel({ displayName: undefined })];
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listModels())
      .rejects.toThrow("Codex 响应缺少有效 model displayName");
  });

  it("fails closed when a model response contains an unknown input modality", async () => {
    const transport = new FakeTransport();
    transport.modelListData = [appServerModel({ inputModalities: ["text", "video"] })];
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listModels())
      .rejects.toThrow("Codex 响应包含未知 model inputModalities");
  });
});
