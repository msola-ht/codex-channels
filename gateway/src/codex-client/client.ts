import type {
  GetAccountTokenUsageResponse,
  GetAccountRateLimitsResponse,
  InitializeResponse,
  ListMcpServerStatusResponse,
  ModelListResponse,
  PermissionProfileListResponse,
  PluginListResponse,
  ReviewStartResponse,
  ReviewTarget,
  SkillsListResponse,
  Thread,
  ThreadForkResponse,
  ThreadGoal,
  ThreadGoalGetResponse,
  ThreadGoalSetResponse,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  ThreadUnsubscribeResponse,
  TurnStartResponse,
  TurnSteerResponse,
} from "../codex-protocol/index.js";
import { JsonRpcClient, type RpcNotification, type ServerRequestHandler } from "./json-rpc.js";

export interface ThreadDefaults {
  cwd: string;
  model?: string;
  sandbox: "read-only" | "workspace-write";
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

  async listThreads(options: { fullScan?: boolean } = {}): Promise<Thread[]> {
    const threads: Thread[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const result: ThreadListResponse = await this.rpc.request<ThreadListResponse>(
        "thread/list",
        {
          cwd: this.defaults.cwd,
          sourceKinds: ["cli", "vscode", "appServer"],
          sortKey: "updated_at",
          sortDirection: "desc",
          useStateDbOnly: !options.fullScan,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        },
        { retryOverload: true },
      );
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
    const result = await this.rpc.request<ThreadReadResponse>(
      "thread/read",
      { threadId, includeTurns: false },
      { retryOverload: true },
    );
    return result.thread;
  }

  async startThread(): Promise<ThreadStartResponse> {
    return this.rpc.request<ThreadStartResponse>(
      "thread/start",
      {
        cwd: this.defaults.cwd,
        sandbox: this.defaults.sandbox,
        approvalPolicy: "on-request",
        serviceName: "codex_tg_gateway",
        ...(this.defaults.model ? { model: this.defaults.model } : {}),
      },
      { retryOverload: false },
    );
  }

  async resumeThread(threadId: string): Promise<ThreadResumeResponse> {
    return this.rpc.request<ThreadResumeResponse>(
      "thread/resume",
      {
        threadId,
        cwd: this.defaults.cwd,
        sandbox: this.defaults.sandbox,
        approvalPolicy: "on-request",
        ...(this.defaults.model ? { model: this.defaults.model } : {}),
      },
      { retryOverload: false },
    );
  }

  async unsubscribeThread(threadId: string): Promise<ThreadUnsubscribeResponse> {
    return this.rpc.request<ThreadUnsubscribeResponse>(
      "thread/unsubscribe",
      { threadId },
      { retryOverload: true },
    );
  }

  async startTurn(
    threadId: string,
    text: string,
    clientUserMessageId: string,
  ): Promise<TurnStartResponse> {
    return this.rpc.request<TurnStartResponse>(
      "turn/start",
      {
        threadId,
        clientUserMessageId,
        input: [{ type: "text", text, text_elements: [] }],
        cwd: this.defaults.cwd,
        ...(this.defaults.model ? { model: this.defaults.model } : {}),
      },
      { retryOverload: false },
    );
  }

  async steerTurn(
    threadId: string,
    turnId: string,
    text: string,
    clientUserMessageId: string,
  ): Promise<TurnSteerResponse> {
    return this.rpc.request<TurnSteerResponse>(
      "turn/steer",
      {
        threadId,
        expectedTurnId: turnId,
        clientUserMessageId,
        input: [{ type: "text", text, text_elements: [] }],
      },
      { retryOverload: false },
    );
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.rpc.request("turn/interrupt", { threadId, turnId }, { retryOverload: false });
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.rpc.request("thread/name/set", { threadId, name }, { retryOverload: false });
  }

  async compactThread(threadId: string): Promise<void> {
    await this.rpc.request("thread/compact/start", { threadId }, { retryOverload: false });
  }

  async listModels(): Promise<ModelListResponse["data"]> {
    const models: ModelListResponse["data"] = [];
    let cursor: string | null = null;
    do {
      const result: ModelListResponse = await this.rpc.request<ModelListResponse>(
        "model/list",
        { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) },
        { retryOverload: true },
      );
      models.push(...result.data);
      cursor = result.nextCursor;
    } while (cursor);
    return models;
  }

  async forkThread(threadId: string): Promise<ThreadForkResponse> {
    return this.rpc.request<ThreadForkResponse>(
      "thread/fork",
      {
        threadId,
        cwd: this.defaults.cwd,
        sandbox: this.defaults.sandbox,
        approvalPolicy: "on-request",
        ...(this.defaults.model ? { model: this.defaults.model } : {}),
      },
      { retryOverload: false },
    );
  }

  async startReview(threadId: string, target: ReviewTarget): Promise<ReviewStartResponse> {
    return this.rpc.request<ReviewStartResponse>(
      "review/start",
      { threadId, target, delivery: "inline" },
      { retryOverload: false },
    );
  }

  async listSkills(): Promise<SkillsListResponse["data"]> {
    const response = await this.rpc.request<SkillsListResponse>(
      "skills/list",
      { cwds: [this.defaults.cwd], forceReload: false },
      { retryOverload: true },
    );
    return response.data;
  }

  async listMcpServers(threadId?: string): Promise<ListMcpServerStatusResponse["data"]> {
    const servers: ListMcpServerStatusResponse["data"] = [];
    let cursor: string | null = null;
    do {
      const response: ListMcpServerStatusResponse =
        await this.rpc.request<ListMcpServerStatusResponse>(
          "mcpServerStatus/list",
          {
            limit: 100,
            detail: "toolsAndAuthOnly",
            ...(threadId ? { threadId } : {}),
            ...(cursor ? { cursor } : {}),
          },
          { retryOverload: true },
        );
      servers.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);
    return servers;
  }

  async listPlugins(): Promise<PluginListResponse> {
    return this.rpc.request<PluginListResponse>(
      "plugin/list",
      { cwds: [this.defaults.cwd] },
      { retryOverload: true },
    );
  }

  accountUsage(): Promise<GetAccountTokenUsageResponse> {
    return this.rpc.request<GetAccountTokenUsageResponse>(
      "account/usage/read",
      {},
      { retryOverload: true },
    );
  }

  accountRateLimits(): Promise<GetAccountRateLimitsResponse> {
    return this.rpc.request<GetAccountRateLimitsResponse>(
      "account/rateLimits/read",
      {},
      { retryOverload: true },
    );
  }

  async listPermissionProfiles(): Promise<PermissionProfileListResponse["data"]> {
    const profiles: PermissionProfileListResponse["data"] = [];
    let cursor: string | null = null;
    do {
      const response: PermissionProfileListResponse =
        await this.rpc.request<PermissionProfileListResponse>(
          "permissionProfile/list",
          { cwd: this.defaults.cwd, limit: 100, ...(cursor ? { cursor } : {}) },
          { retryOverload: true },
        );
      profiles.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);
    return profiles;
  }

  async getGoal(threadId: string): Promise<ThreadGoal | null> {
    const response = await this.rpc.request<ThreadGoalGetResponse>(
      "thread/goal/get",
      { threadId },
      { retryOverload: true },
    );
    return response.goal;
  }

  async setGoal(threadId: string, objective: string): Promise<ThreadGoal> {
    const response = await this.rpc.request<ThreadGoalSetResponse>(
      "thread/goal/set",
      { threadId, objective, status: "active" },
      { retryOverload: false },
    );
    return response.goal;
  }

  async clearGoal(threadId: string): Promise<void> {
    await this.rpc.request("thread/goal/clear", { threadId }, { retryOverload: false });
  }
}
