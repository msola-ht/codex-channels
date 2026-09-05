import { BaseTransport } from "../../src/codex-client/transport.js";


export const pinnedThreadSection = {
  id: "01984de2-8f74-7c91-a3b2-5c5e937cf318",
  name: "Pinned",
};

export function appServerThread(
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
    historyMode: "legacy",
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

export function appServerGoal(
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

export function appServerModel(
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
    multiAgentVersion: null,
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

export function appServerRateLimit(
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

export function appServerMcpStatus(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "local-tools",
    runtimeStatus: null,
    pluginId: null,
    serverInfo: null,
    tools: { search: {} },
    resources: [],
    resourceTemplates: [],
    authStatus: "unsupported",
    ...overrides,
  };
}

export function appServerPlugin(
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

export class FakeTransport extends BaseTransport {
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
    } else if (decoded.method === "thread/metadata/update") {
      queueMicrotask(() =>
        this.emitMessage(JSON.stringify({
          id: decoded.id,
          result: { thread: this.metadataUpdateThreadData ?? this.threadReadData },
        })),
      );
    } else if (decoded.method === "thread/section/move") {
      const params = decoded.params as { sectionId: string | null };
      const section = params.sectionId === pinnedThreadSection.id
        ? pinnedThreadSection
        : null;
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
