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
  InvocableSkill,
  SkillQueryPort,
  McpQueryPort,
  McpOAuthLogin,
  McpResourceReadResult,
  McpServerDetail,
  McpServerSummary,
  InstalledPluginCatalog,
  InvocablePlugin,
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
  McpResourceReadResponse,
  McpServerOauthLoginResponse,
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
  ThreadSectionMoveResponse,
  ThreadSectionListResponse,
  ThreadSectionCreateResponse,
  ThreadSectionUpdateResponse,
  ThreadSectionDeleteResponse,
  ThreadUnsubscribeResponse,
  ThreadUnarchiveResponse,
  TurnStartResponse,
  TurnSteerResponse,
  JsonValue,
} from "../codex-protocol/index.js";
import type {
  ThreadLifecyclePort,
  ThreadQueryOptions,
  ThreadSession,
  ThreadStartOptions,
  ThreadSnapshot,
  ThreadSectionSnapshot,
} from "../session-routing/index.js";
import { JsonRpcClient, type RpcNotification, type ServerRequestHandler } from "./json-rpc.js";
import { codexConnectIntegrationId } from "./protocol-info.js";
import {
  PINNED_THREAD_SECTION_ID,
  toThreadSectionSnapshot,
  toThreadSession,
  toThreadSnapshot,
} from "./thread-adapter.js";
import {
  toProtocolReviewTarget,
  toProtocolTurnInput,
  toReviewStarted,
  toThreadGoal,
  toTurnStarted,
} from "./turn-adapter.js";
import { toModelOption } from "./model-adapter.js";
import { toAccountRateLimits, toAccountUsage } from "./account-adapter.js";
import {
  resolveInvocableSkill,
  toInstalledSkills,
} from "./skill-adapter.js";
import {
  toMcpOAuthLogin,
  toMcpResourceReadResult,
  toMcpServerDetailPage,
  toMcpServerSummaryPage,
} from "./mcp-adapter.js";
import {
  resolveInvocablePlugin,
  toInstalledPlugins,
} from "./plugin-adapter.js";
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
          modelProviders: [],
          sourceKinds: ["cli", "vscode", "appServer"],
          sortKey: options.sortKey ?? "updated_at",
          sortDirection: options.sortDirection ?? "desc",
          useStateDbOnly: !options.fullScan,
          archived: options.archived ?? false,
          ...(options.searchTerm ? { searchTerm: options.searchTerm } : {}),
          ...(options.sectionId ? { sectionId: options.sectionId } : {}),
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

  async startThread(cwd: string, options: ThreadStartOptions = {}): Promise<ThreadSession> {
    const response = await this.rpc.request<ThreadStartResponse>({
      method: "thread/start",
      params: {
        cwd,
        approvalPolicy: options.approvalPolicy ?? "on-request",
        serviceName: codexConnectIntegrationId,
        ...(options.permissions !== undefined
          ? { permissions: options.permissions }
          : { sandbox: options.sandbox ?? this.defaults.sandbox }),
        ...(options.model
          ? { model: options.model }
          : this.defaults.model ? { model: this.defaults.model } : {}),
        ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
      },
    }, { retryOverload: false });
    return toThreadSession(response);
  }

  async resumeThread(
    threadId: string,
    cwd: string,
    options: ThreadStartOptions = {},
  ): Promise<ThreadSession> {
    const response = await this.rpc.request<ThreadResumeResponse>({
      method: "thread/resume",
      params: {
        threadId,
        cwd,
        approvalPolicy: options.approvalPolicy ?? "on-request",
        ...(options.permissions !== undefined
          ? { permissions: options.permissions }
          : { sandbox: options.sandbox ?? this.defaults.sandbox }),
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

  async setThreadPinned(threadId: string, pinned: boolean): Promise<boolean> {
    const observed = await this.rpc.request<ThreadReadResponse>({
      method: "thread/read",
      params: { threadId, includeTurns: false },
    }, { retryOverload: true });
    const current = toThreadSnapshot(observed.thread);
    if (current.id !== threadId) {
      throw new Error("Codex Thread 固定状态更新目标不一致");
    }
    if (current.isPinned === pinned) {
      return false;
    }
    const updated = await this.applyThreadSectionMove(
      threadId,
      observed,
      pinned ? PINNED_THREAD_SECTION_ID : null,
    );
    if (updated.id !== threadId || updated.isPinned !== pinned) {
      throw new Error("Codex Thread 固定状态更新结果不一致");
    }
    return true;
  }

  async listThreadSections(): Promise<ThreadSectionSnapshot[]> {
    const sections: ThreadSectionSnapshot[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const response: ThreadSectionListResponse = await this.rpc.request<ThreadSectionListResponse>({
        method: "threadSection/list",
        params: { limit: 100, ...(cursor ? { cursor } : {}) },
      }, { retryOverload: true });
      sections.push(...response.data.map(toThreadSectionSnapshot));
      cursor = response.nextCursor;
      if (cursor) {
        if (cursors.has(cursor)) {
          throw new Error("Codex threadSection/list 返回了循环分页游标");
        }
        cursors.add(cursor);
      }
    } while (cursor);
    return sections;
  }

  async createThreadSection(name: string): Promise<ThreadSectionSnapshot> {
    const response = await this.rpc.request<ThreadSectionCreateResponse>({
      method: "threadSection/create",
      params: { name },
    }, { retryOverload: false });
    return toThreadSectionSnapshot(response.section);
  }

  async renameThreadSection(
    sectionId: string,
    name: string,
  ): Promise<ThreadSectionSnapshot> {
    const response = await this.rpc.request<ThreadSectionUpdateResponse>({
      method: "threadSection/update",
      params: { sectionId, name },
    }, { retryOverload: false });
    return toThreadSectionSnapshot(response.section);
  }

  async deleteThreadSection(sectionId: string): Promise<void> {
    await this.rpc.request<ThreadSectionDeleteResponse>({
      method: "threadSection/delete",
      params: { sectionId },
    }, { retryOverload: false });
  }

  async moveThreadToSection(
    threadId: string,
    sectionId: string | null,
    beforeThreadId?: string,
  ): Promise<void> {
    const observed = await this.rpc.request<ThreadReadResponse>({
      method: "thread/read",
      params: { threadId, includeTurns: false },
    }, { retryOverload: true });
    if (observed.thread.id !== threadId) {
      throw new Error("Codex Thread 分区更新目标不一致");
    }
    const updated = await this.applyThreadSectionMove(
      threadId,
      observed,
      sectionId,
      beforeThreadId,
    );
    if (updated.section?.id !== sectionId && !(updated.section === null && sectionId === null)) {
      throw new Error("Codex Thread 分区更新结果不一致");
    }
  }

  private async applyThreadSectionMove(
    threadId: string,
    observed: ThreadReadResponse,
    sectionId: string | null,
    beforeThreadId?: string,
  ): Promise<ThreadSnapshot> {
    const materialized = await this.rpc.request<ThreadMetadataUpdateResponse>({
      method: "thread/metadata/update",
      params: {
        threadId,
        gitInfo: { sha: observed.thread.gitInfo?.sha ?? null },
      },
    }, { retryOverload: false });
    const stored = toThreadSnapshot(materialized.thread);
    if (stored.id !== threadId) {
      throw new Error("Codex Thread 分区元数据更新目标不一致");
    }
    await this.rpc.request<ThreadSectionMoveResponse>({
      method: "thread/section/move",
      params: {
        threadId,
        sectionId,
        beforeThreadId: beforeThreadId ?? null,
      },
    }, { retryOverload: false });
    return this.readThread(threadId);
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
    await this.writeUserConfigEdits([{
      keyPath: "service_tier",
      value: enabled ? "fast" : "default",
    }]);
  }

  async writeDefaultModelSettings(model: string, effort: string): Promise<void> {
    await this.writeUserConfigEdits([{
      keyPath: "model",
      value: model,
    }, {
      keyPath: "model_reasoning_effort",
      value: effort,
    }]);
  }

  async readDefaultModelSettings(): Promise<{
    model: string | null;
    effort: string | null;
  }> {
    const params: ConfigReadParams = { includeLayers: false };
    const response = await this.rpc.request<ConfigReadResponse>({
      method: "config/read",
      params,
    }, { retryOverload: true });
    const model = response.config.model;
    const effort = response.config.model_reasoning_effort;
    if (
      (model !== null && (typeof model !== "string" || model.trim() === ""))
      || (effort !== null && (typeof effort !== "string" || effort.trim() === ""))
    ) {
      throw new Error("Codex 响应缺少有效的全局模型或思考等级");
    }
    return { model, effort };
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

  async writeUserConfigEdits(
    edits: Array<{ keyPath: string; value: JsonValue }>,
    options: { expectedVersion?: string } = {},
  ): Promise<void> {
    await this.rpc.request({
      method: "config/batchWrite",
      params: {
        edits: edits.map((edit) => ({
          ...edit,
          mergeStrategy: "replace" as const,
        })),
        ...(options.expectedVersion === undefined
          ? {}
          : { expectedVersion: options.expectedVersion }),
        reloadUserConfig: true,
      },
    }, { retryOverload: false });
  }

  async readUserConfigSnapshot(): Promise<{
    config: Record<string, JsonValue | undefined>;
    version: string;
  }> {
    const response = await this.rpc.request<ConfigReadResponse>({
      method: "config/read",
      params: { includeLayers: true },
    }, { retryOverload: true });
    const userLayer = response.layers?.find((layer) =>
      layer.name.type === "user" && layer.name.profile === null
    );
    if (userLayer === undefined) {
      throw new Error("Codex 响应缺少用户配置层");
    }
    if (
      userLayer.config === null
      || typeof userLayer.config !== "object"
      || Array.isArray(userLayer.config)
    ) {
      throw new Error("Codex 响应包含无效用户配置层");
    }
    if (userLayer.version.trim() === "") {
      throw new Error("Codex 响应缺少用户配置版本");
    }
    return {
      config: userLayer.config,
      version: userLayer.version,
    };
  }

  async forkThread(
    threadId: string,
    cwd: string,
    options: ThreadStartOptions = {},
  ): Promise<ThreadSession> {
    const response = await this.rpc.request<ThreadForkResponse>({
      method: "thread/fork",
      params: {
        threadId,
        cwd,
        sandbox: this.defaults.sandbox,
        approvalPolicy: "on-request",
        ...(options.model ? { model: options.model } : {}),
        ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
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
    const response = await this.readSkills(cwd);
    return toInstalledSkills(response, cwd);
  }

  async resolveSkill(
    cwd: string,
    name: string,
  ): Promise<InvocableSkill | undefined> {
    return resolveInvocableSkill(await this.readSkills(cwd), cwd, name);
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

  async listMcpServerDetails(threadId?: string): Promise<McpServerDetail[]> {
    const servers: McpServerDetail[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const response = await this.rpc.request<ListMcpServerStatusResponse>({
        method: "mcpServerStatus/list",
        params: {
          limit: 100,
          detail: "full",
          ...(threadId ? { threadId } : {}),
          ...(cursor ? { cursor } : {}),
        },
      }, { retryOverload: true });
      const page = toMcpServerDetailPage(response);
      servers.push(...page.servers);
      cursor = page.nextCursor;
      rememberCursor("mcpServerStatus/list", cursor, cursors);
    } while (cursor);
    return servers;
  }

  async reloadMcpServers(): Promise<void> {
    await this.rpc.request<Record<string, never>>({
      method: "config/mcpServer/reload",
      params: undefined,
    }, { retryOverload: false });
  }

  async startMcpOAuthLogin(
    name: string,
    threadId?: string,
  ): Promise<McpOAuthLogin> {
    const response = await this.rpc.request<McpServerOauthLoginResponse>({
      method: "mcpServer/oauth/login",
      params: { name, ...(threadId ? { threadId } : {}) },
    }, { retryOverload: false });
    return toMcpOAuthLogin(name, response);
  }

  async readMcpResource(
    server: string,
    uri: string,
    threadId?: string,
  ): Promise<McpResourceReadResult> {
    const response = await this.rpc.request<McpResourceReadResponse>({
      method: "mcpServer/resource/read",
      params: { server, uri, ...(threadId ? { threadId } : {}) },
    }, { retryOverload: true });
    return toMcpResourceReadResult(server, uri, response);
  }

  async listPlugins(cwd: string): Promise<InstalledPluginCatalog> {
    return toInstalledPlugins(await this.readInstalledPlugins(cwd));
  }

  async resolvePlugin(
    cwd: string,
    id: string,
  ): Promise<InvocablePlugin | undefined> {
    return resolveInvocablePlugin(await this.readInstalledPlugins(cwd), id);
  }

  private readInstalledPlugins(cwd: string): Promise<PluginInstalledResponse> {
    return this.rpc.request<PluginInstalledResponse>({
      method: "plugin/installed",
      params: { cwds: [cwd] },
    }, { retryOverload: true });
  }

  private readSkills(cwd: string): Promise<SkillsListResponse> {
    return this.rpc.request<SkillsListResponse>({
      method: "skills/list",
      params: { cwds: [cwd], forceReload: false },
    }, { retryOverload: true });
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
