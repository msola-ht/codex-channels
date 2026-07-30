import type {
  ReviewTarget,
  ThreadGoal,
  TurnExecutionPort,
  TurnInput,
  TurnOverrides,
  TurnStarted,
  ReviewStarted,
  ModelSelectionPort,
  ModelOption,
  AccountQueryPort,
  AccountRateLimits,
  AccountUsage,
  CollaborationModeQueryPort,
  CollaborationModePreset,
  InstalledSkill,
  SkillQueryPort,
  McpQueryPort,
  McpServerSummary,
  InstalledPlugin,
  PluginQueryPort,
  PermissionProfileOption,
  PermissionQueryPort,
} from "../application/index.js";
import type {
  ConfigReadParams,
  ConfigReadResponse,
  CollaborationModeListResponse,
  GetAccountTokenUsageResponse,
  GetAccountRateLimitsResponse,
  InitializeResponse,
  ListMcpServerStatusResponse,
  ModelListResponse,
  PermissionProfileListResponse,
  PluginInstalledResponse,
  ReviewStartResponse,
  SkillsListResponse,
  ThreadArchiveResponse,
  ThreadDeleteResponse,
  ThreadForkResponse,
  ThreadGoalGetResponse,
  ThreadGoalSetResponse,
  ThreadListResponse,
  ThreadMetadataUpdateResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  ThreadUnsubscribeResponse,
  ThreadUnarchiveResponse,
  TurnStartResponse,
  TurnSteerResponse,
} from "../codex-protocol/index.js";
import type {
  ThreadLifecyclePort,
  ThreadQueryOptions,
  ThreadSession,
  ThreadSnapshot,
} from "../session-routing/index.js";
import { JsonRpcClient, type RpcNotification, type ServerRequestHandler } from "./json-rpc.js";
import { toThreadSession, toThreadSnapshot } from "./thread-adapter.js";
import {
  toProtocolReviewTarget,
  toProtocolTurnInput,
  toReviewStarted,
  toThreadGoal,
  toTurnStarted,
} from "./turn-adapter.js";
import { toModelOption } from "./model-adapter.js";
import { toAccountRateLimits, toAccountUsage } from "./account-adapter.js";
import { toInstalledSkills } from "./skill-adapter.js";
import { toMcpServerSummaryPage } from "./mcp-adapter.js";
import { toInstalledPlugins } from "./plugin-adapter.js";
import { toPermissionProfilePage } from "./permission-adapter.js";

export interface ThreadDefaults {
  model?: string;
  sandbox: "read-only" | "workspace-write";
}

export class CodexAppServerClient implements
  ThreadLifecyclePort,
  TurnExecutionPort,
  ModelSelectionPort,
  AccountQueryPort,
  CollaborationModeQueryPort,
  SkillQueryPort,
  McpQueryPort,
  PluginQueryPort,
  PermissionQueryPort
{
  constructor(
    private readonly rpc: JsonRpcClient,
    private readonly defaults: ThreadDefaults,
  ) {}

  connect(): Promise<InitializeResponse> {
    return this.rpc.connect();
  }

  reconnect(): Promise<InitializeResponse> {
    return this.rpc.reconnect();
  }

  close(): Promise<void> {
    return this.rpc.close();
  }

  onNotification(handler: (notification: RpcNotification) => void): () => void {
    return this.rpc.onNotification(handler);
  }

  onDisconnect(handler: (error: Error) => void): () => void {
    return this.rpc.onDisconnect(handler);
  }

  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.rpc.setServerRequestHandler(handler);
  }

  async listThreads(
    cwd: string,
    options: ThreadQueryOptions = {},
  ): Promise<ThreadSnapshot[]> {
    const threads: ThreadSnapshot[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const result: ThreadListResponse = await this.rpc.request<ThreadListResponse>({
        method: "thread/list",
        params: {
          cwd,
          sourceKinds: ["cli", "vscode", "appServer"],
          sortKey: "updated_at",
          sortDirection: "desc",
          useStateDbOnly: !options.fullScan,
          archived: options.archived ?? false,
          ...(options.searchTerm ? { searchTerm: options.searchTerm } : {}),
          limit: 100,
          ...(cursor ? { cursor } : {}),
        },
      }, { retryOverload: true });
      threads.push(...result.data.map(toThreadSnapshot));
      cursor = result.nextCursor;
      if (cursor) {
        if (cursors.has(cursor)) {
          throw new Error("Codex thread/list 返回了循环分页游标");
        }
        cursors.add(cursor);
      }
    } while (cursor);
    return threads;
  }

  async listCollaborationModes(): Promise<CollaborationModePreset[]> {
    const response = await this.rpc.request<CollaborationModeListResponse>({
      method: "collaborationMode/list",
      params: {},
    }, { retryOverload: true });
    return response.data.flatMap((preset) => {
      if (preset.mode !== "default" && preset.mode !== "plan") {
        return [];
      }
      return [{
        name: preset.name,
        mode: preset.mode,
        model: preset.model,
        effort: preset.reasoning_effort,
      }];
    });
  }

  async readThread(threadId: string): Promise<ThreadSnapshot> {
    const result = await this.rpc.request<ThreadReadResponse>({
      method: "thread/read",
      params: { threadId, includeTurns: false },
    }, { retryOverload: true });
    return toThreadSnapshot(result.thread);
  }

  async startThread(cwd: string): Promise<ThreadSession> {
    const response = await this.rpc.request<ThreadStartResponse>({
      method: "thread/start",
      params: {
        cwd,
        sandbox: this.defaults.sandbox,
        approvalPolicy: "on-request",
        serviceName: "codex_connect_gateway",
        ...(this.defaults.model ? { model: this.defaults.model } : {}),
      },
    }, { retryOverload: false });
    return toThreadSession(response);
  }

  async resumeThread(threadId: string, cwd: string): Promise<ThreadSession> {
    const response = await this.rpc.request<ThreadResumeResponse>({
      method: "thread/resume",
      params: {
        threadId,
        cwd,
        sandbox: this.defaults.sandbox,
        approvalPolicy: "on-request",
      },
    }, { retryOverload: false });
    return toThreadSession(response);
  }

  async unsubscribeThread(threadId: string): Promise<void> {
    await this.rpc.request<ThreadUnsubscribeResponse>({
      method: "thread/unsubscribe",
      params: { threadId },
    }, { retryOverload: true });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.rpc.request<ThreadDeleteResponse>({
      method: "thread/delete",
      params: { threadId },
    }, { retryOverload: false });
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.rpc.request<ThreadArchiveResponse>({
      method: "thread/archive",
      params: { threadId },
    }, { retryOverload: false });
  }

  async unarchiveThread(threadId: string): Promise<ThreadSnapshot> {
    const response = await this.rpc.request<ThreadUnarchiveResponse>({
      method: "thread/unarchive",
      params: { threadId },
    }, { retryOverload: false });
    return toThreadSnapshot(response.thread);
  }

  async startTurn(
    threadId: string,
    input: TurnInput[],
    clientUserMessageId: string,
    cwd: string,
    overrides: TurnOverrides = {},
  ): Promise<TurnStarted> {
    const response = await this.rpc.request<TurnStartResponse>({
      method: "turn/start",
      params: {
        threadId,
        clientUserMessageId,
        input: toProtocolTurnInput(input),
        cwd,
        ...(overrides.model ? { model: overrides.model } : {}),
        ...(overrides.effort ? { effort: overrides.effort } : {}),
        ...(Object.hasOwn(overrides, "serviceTier")
          ? { serviceTier: overrides.serviceTier ?? null }
          : {}),
        ...(overrides.collaborationMode
          ? {
              collaborationMode: {
                mode: overrides.collaborationMode.mode,
                settings: {
                  model: overrides.collaborationMode.settings.model,
                  reasoning_effort: overrides.collaborationMode.settings.effort,
                  developer_instructions:
                    overrides.collaborationMode.settings.developerInstructions,
                },
              },
            }
          : {}),
      },
    }, { retryOverload: false });
    return toTurnStarted(response);
  }

  async steerTurn(
    threadId: string,
    turnId: string,
    input: TurnInput[],
    clientUserMessageId: string,
  ): Promise<TurnStarted> {
    const response = await this.rpc.request<TurnSteerResponse>({
      method: "turn/steer",
      params: {
        threadId,
        expectedTurnId: turnId,
        clientUserMessageId,
        input: toProtocolTurnInput(input),
      },
    }, { retryOverload: false });
    return toTurnStarted(response);
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.rpc.request({
      method: "turn/interrupt",
      params: { threadId, turnId },
    }, { retryOverload: false });
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.rpc.request({
      method: "thread/name/set",
      params: { threadId, name },
    }, { retryOverload: false });
  }

  async setThreadPinned(threadId: string, pinned: boolean): Promise<void> {
    const response = await this.rpc.request<ThreadMetadataUpdateResponse>({
      method: "thread/metadata/update",
      params: { threadId, isPinned: pinned },
    }, { retryOverload: false });
    const updated = toThreadSnapshot(response.thread);
    if (updated.id !== threadId || updated.isPinned !== pinned) {
      throw new Error("Codex Thread 固定状态更新结果不一致");
    }
  }

  async compactThread(threadId: string): Promise<void> {
    await this.rpc.request({
      method: "thread/compact/start",
      params: { threadId },
    }, { retryOverload: false });
  }

  async listModels(): Promise<ModelOption[]> {
    const models: ModelOption[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const result: ModelListResponse = await this.rpc.request<ModelListResponse>({
        method: "model/list",
        params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) },
      }, { retryOverload: true });
      for (const model of result.data) {
        const mapped = toModelOption(model);
        if (mapped) {
          models.push(mapped);
        }
      }
      cursor = result.nextCursor;
      rememberCursor("model/list", cursor, cursors);
    } while (cursor);
    return models;
  }

  async writeDefaultFastMode(enabled: boolean): Promise<void> {
    await this.rpc.request({
      method: "config/batchWrite",
      params: {
        edits: [{
          keyPath: "service_tier",
          value: enabled ? "fast" : "default",
          mergeStrategy: "replace",
        }],
        reloadUserConfig: true,
      },
    }, { retryOverload: false });
  }

  async readDefaultServiceTier(cwd: string): Promise<string | null> {
    const params: ConfigReadParams = { cwd, includeLayers: false };
    const response = await this.rpc.request<ConfigReadResponse>({
      method: "config/read",
      params,
    }, { retryOverload: true });
    const serviceTier = response.config.service_tier;
    if (serviceTier !== null && typeof serviceTier !== "string") {
      throw new Error("Codex 响应缺少有效 config service_tier");
    }
    return serviceTier;
  }

  async forkThread(threadId: string, cwd: string): Promise<ThreadSession> {
    const response = await this.rpc.request<ThreadForkResponse>({
      method: "thread/fork",
      params: {
        threadId,
        cwd,
        sandbox: this.defaults.sandbox,
        approvalPolicy: "on-request",
      },
    }, { retryOverload: false });
    return toThreadSession(response);
  }

  async startReview(threadId: string, target: ReviewTarget): Promise<ReviewStarted> {
    const response = await this.rpc.request<ReviewStartResponse>({
      method: "review/start",
      params: { threadId, target: toProtocolReviewTarget(target), delivery: "inline" },
    }, { retryOverload: false });
    return toReviewStarted(response);
  }

  async listSkills(cwd: string): Promise<InstalledSkill[]> {
    const response = await this.rpc.request<SkillsListResponse>({
      method: "skills/list",
      params: { cwds: [cwd], forceReload: false },
    }, { retryOverload: true });
    return toInstalledSkills(response);
  }

  async listMcpServers(threadId?: string): Promise<McpServerSummary[]> {
    const servers: McpServerSummary[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const response: ListMcpServerStatusResponse =
        await this.rpc.request<ListMcpServerStatusResponse>({
          method: "mcpServerStatus/list",
          params: {
            limit: 100,
            detail: "toolsAndAuthOnly",
            ...(threadId ? { threadId } : {}),
            ...(cursor ? { cursor } : {}),
          },
        }, { retryOverload: true });
      const page = toMcpServerSummaryPage(response);
      servers.push(...page.servers);
      cursor = page.nextCursor;
      rememberCursor("mcpServerStatus/list", cursor, cursors);
    } while (cursor);
    return servers;
  }

  async listPlugins(cwd: string): Promise<InstalledPlugin[]> {
    const response = await this.rpc.request<PluginInstalledResponse>({
      method: "plugin/installed",
      params: { cwds: [cwd] },
    }, { retryOverload: true });
    return toInstalledPlugins(response);
  }

  async accountUsage(): Promise<AccountUsage> {
    const response = await this.rpc.request<GetAccountTokenUsageResponse>({
      method: "account/usage/read",
      params: undefined,
    }, { retryOverload: true });
    return toAccountUsage(response);
  }

  async accountRateLimits(): Promise<AccountRateLimits> {
    const response = await this.rpc.request<GetAccountRateLimitsResponse>({
      method: "account/rateLimits/read",
      params: undefined,
    }, { retryOverload: true });
    return toAccountRateLimits(response);
  }

  async listPermissionProfiles(cwd: string): Promise<PermissionProfileOption[]> {
    const profiles: PermissionProfileOption[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const response: PermissionProfileListResponse =
        await this.rpc.request<PermissionProfileListResponse>({
          method: "permissionProfile/list",
          params: { cwd, limit: 100, ...(cursor ? { cursor } : {}) },
        }, { retryOverload: true });
      const page = toPermissionProfilePage(response);
      profiles.push(...page.profiles);
      cursor = page.nextCursor;
      rememberCursor("permissionProfile/list", cursor, cursors);
    } while (cursor);
    return profiles;
  }

  async getGoal(threadId: string): Promise<ThreadGoal | null> {
    const response = await this.rpc.request<ThreadGoalGetResponse>({
      method: "thread/goal/get",
      params: { threadId },
    }, { retryOverload: true });
    return response.goal ? toThreadGoal(response.goal) : null;
  }

  async setGoal(threadId: string, objective: string): Promise<ThreadGoal> {
    const response = await this.rpc.request<ThreadGoalSetResponse>({
      method: "thread/goal/set",
      params: { threadId, objective, status: "active" },
    }, { retryOverload: false });
    return toThreadGoal(response.goal);
  }

  async clearGoal(threadId: string): Promise<void> {
    await this.rpc.request({
      method: "thread/goal/clear",
      params: { threadId },
    }, { retryOverload: false });
  }
}

function rememberCursor(method: string, cursor: string | null, cursors: Set<string>): void {
  if (!cursor) {
    return;
  }
  if (cursors.has(cursor)) {
    throw new Error(`Codex ${method} 返回了循环分页游标`);
  }
  cursors.add(cursor);
}
