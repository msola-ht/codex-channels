import type {
  ConfigReadParams,
  ConfigReadResponse,
  GetAccountTokenUsageResponse,
  GetAccountRateLimitsResponse,
  InitializeResponse,
  ListMcpServerStatusResponse,
  ModelListResponse,
  PermissionProfileListResponse,
  PluginInstalledResponse,
  ReviewStartResponse,
  ReviewTarget,
  SkillsListResponse,
  Thread,
  ThreadArchiveResponse,
  ThreadDeleteResponse,
  ThreadForkResponse,
  ThreadGoal,
  ThreadGoalGetResponse,
  ThreadGoalSetResponse,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  ThreadUnsubscribeResponse,
  ThreadUnarchiveResponse,
  TurnStartResponse,
  TurnSteerResponse,
  UserInput,
} from "../codex-protocol/index.js";
import { JsonRpcClient, type RpcNotification, type ServerRequestHandler } from "./json-rpc.js";

export interface ThreadDefaults {
  model?: string;
  sandbox: "read-only" | "workspace-write";
}

export interface TurnOverrides {
  model?: string;
  effort?: string;
  serviceTier?: string | null;
}

export class CodexAppServerClient {
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
    options: { fullScan?: boolean; archived?: boolean; searchTerm?: string } = {},
  ): Promise<Thread[]> {
    const threads: Thread[] = [];
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
      threads.push(...result.data);
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

  async readThread(threadId: string): Promise<Thread> {
    const result = await this.rpc.request<ThreadReadResponse>({
      method: "thread/read",
      params: { threadId, includeTurns: false },
    }, { retryOverload: true });
    return result.thread;
  }

  async startThread(cwd: string): Promise<ThreadStartResponse> {
    return this.rpc.request<ThreadStartResponse>({
      method: "thread/start",
      params: {
        cwd,
        sandbox: this.defaults.sandbox,
        approvalPolicy: "on-request",
        serviceName: "codex_connect_gateway",
        ...(this.defaults.model ? { model: this.defaults.model } : {}),
      },
    }, { retryOverload: false });
  }

  async resumeThread(threadId: string, cwd: string): Promise<ThreadResumeResponse> {
    return this.rpc.request<ThreadResumeResponse>({
      method: "thread/resume",
      params: {
        threadId,
        cwd,
        sandbox: this.defaults.sandbox,
        approvalPolicy: "on-request",
      },
    }, { retryOverload: false });
  }

  async unsubscribeThread(threadId: string): Promise<ThreadUnsubscribeResponse> {
    return this.rpc.request<ThreadUnsubscribeResponse>({
      method: "thread/unsubscribe",
      params: { threadId },
    }, { retryOverload: true });
  }

  async deleteThread(threadId: string): Promise<ThreadDeleteResponse> {
    return this.rpc.request<ThreadDeleteResponse>({
      method: "thread/delete",
      params: { threadId },
    }, { retryOverload: false });
  }

  async archiveThread(threadId: string): Promise<ThreadArchiveResponse> {
    return this.rpc.request<ThreadArchiveResponse>({
      method: "thread/archive",
      params: { threadId },
    }, { retryOverload: false });
  }

  async unarchiveThread(threadId: string): Promise<ThreadUnarchiveResponse> {
    return this.rpc.request<ThreadUnarchiveResponse>({
      method: "thread/unarchive",
      params: { threadId },
    }, { retryOverload: false });
  }

  async startTurn(
    threadId: string,
    input: UserInput[],
    clientUserMessageId: string,
    cwd: string,
    overrides: TurnOverrides = {},
  ): Promise<TurnStartResponse> {
    return this.rpc.request<TurnStartResponse>({
      method: "turn/start",
      params: {
        threadId,
        clientUserMessageId,
        input,
        cwd,
        ...(overrides.model ? { model: overrides.model } : {}),
        ...(overrides.effort ? { effort: overrides.effort } : {}),
        ...(Object.hasOwn(overrides, "serviceTier")
          ? { serviceTier: overrides.serviceTier ?? null }
          : {}),
      },
    }, { retryOverload: false });
  }

  async steerTurn(
    threadId: string,
    turnId: string,
    input: UserInput[],
    clientUserMessageId: string,
  ): Promise<TurnSteerResponse> {
    return this.rpc.request<TurnSteerResponse>({
      method: "turn/steer",
      params: {
        threadId,
        expectedTurnId: turnId,
        clientUserMessageId,
        input,
      },
    }, { retryOverload: false });
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

  async compactThread(threadId: string): Promise<void> {
    await this.rpc.request({
      method: "thread/compact/start",
      params: { threadId },
    }, { retryOverload: false });
  }

  async listModels(): Promise<ModelListResponse["data"]> {
    const models: ModelListResponse["data"] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const result: ModelListResponse = await this.rpc.request<ModelListResponse>({
        method: "model/list",
        params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) },
      }, { retryOverload: true });
      models.push(...result.data);
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

  async readConfig(cwd: string): Promise<ConfigReadResponse> {
    const params: ConfigReadParams = { cwd, includeLayers: false };
    return this.rpc.request<ConfigReadResponse>({
      method: "config/read",
      params,
    }, { retryOverload: true });
  }

  async forkThread(threadId: string, cwd: string): Promise<ThreadForkResponse> {
    return this.rpc.request<ThreadForkResponse>({
      method: "thread/fork",
      params: {
        threadId,
        cwd,
        sandbox: this.defaults.sandbox,
        approvalPolicy: "on-request",
      },
    }, { retryOverload: false });
  }

  async startReview(threadId: string, target: ReviewTarget): Promise<ReviewStartResponse> {
    return this.rpc.request<ReviewStartResponse>({
      method: "review/start",
      params: { threadId, target, delivery: "inline" },
    }, { retryOverload: false });
  }

  async listSkills(cwd: string): Promise<SkillsListResponse["data"]> {
    const response = await this.rpc.request<SkillsListResponse>({
      method: "skills/list",
      params: { cwds: [cwd], forceReload: false },
    }, { retryOverload: true });
    return response.data;
  }

  async listMcpServers(threadId?: string): Promise<ListMcpServerStatusResponse["data"]> {
    const servers: ListMcpServerStatusResponse["data"] = [];
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
      servers.push(...response.data);
      cursor = response.nextCursor;
      rememberCursor("mcpServerStatus/list", cursor, cursors);
    } while (cursor);
    return servers;
  }

  async listPlugins(cwd: string): Promise<PluginInstalledResponse> {
    return this.rpc.request<PluginInstalledResponse>({
      method: "plugin/installed",
      params: { cwds: [cwd] },
    }, { retryOverload: true });
  }

  accountUsage(): Promise<GetAccountTokenUsageResponse> {
    return this.rpc.request<GetAccountTokenUsageResponse>({
      method: "account/usage/read",
      params: undefined,
    }, { retryOverload: true });
  }

  accountRateLimits(): Promise<GetAccountRateLimitsResponse> {
    return this.rpc.request<GetAccountRateLimitsResponse>({
      method: "account/rateLimits/read",
      params: undefined,
    }, { retryOverload: true });
  }

  async listPermissionProfiles(cwd: string): Promise<PermissionProfileListResponse["data"]> {
    const profiles: PermissionProfileListResponse["data"] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const response: PermissionProfileListResponse =
        await this.rpc.request<PermissionProfileListResponse>({
          method: "permissionProfile/list",
          params: { cwd, limit: 100, ...(cursor ? { cursor } : {}) },
        }, { retryOverload: true });
      profiles.push(...response.data);
      cursor = response.nextCursor;
      rememberCursor("permissionProfile/list", cursor, cursors);
    } while (cursor);
    return profiles;
  }

  async getGoal(threadId: string): Promise<ThreadGoal | null> {
    const response = await this.rpc.request<ThreadGoalGetResponse>({
      method: "thread/goal/get",
      params: { threadId },
    }, { retryOverload: true });
    return response.goal;
  }

  async setGoal(threadId: string, objective: string): Promise<ThreadGoal> {
    const response = await this.rpc.request<ThreadGoalSetResponse>({
      method: "thread/goal/set",
      params: { threadId, objective, status: "active" },
    }, { retryOverload: false });
    return response.goal;
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
