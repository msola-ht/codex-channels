import type { CodexAppServerClient } from "./client.js";
import type {
  RpcNotification,
  RpcServerRequest,
  ServerRequestHandler,
} from "./json-rpc.js";

type ProviderClientMethod =
  | "connect"
  | "reconnect"
  | "close"
  | "onNotification"
  | "onDisconnect"
  | "setServerRequestHandler"
  | "listThreads"
  | "listCollaborationModes"
  | "readThread"
  | "startThread"
  | "resumeThread"
  | "unsubscribeThread"
  | "deleteThread"
  | "archiveThread"
  | "unarchiveThread"
  | "startTurn"
  | "steerTurn"
  | "interruptTurn"
  | "setThreadName"
  | "setThreadPinned"
  | "listThreadSections"
  | "createThreadSection"
  | "renameThreadSection"
  | "deleteThreadSection"
  | "moveThreadToSection"
  | "compactThread"
  | "listModels"
  | "writeDefaultFastMode"
  | "readDefaultServiceTier"
  | "forkThread"
  | "startReview"
  | "listSkills"
  | "resolveSkill"
  | "listMcpServers"
  | "listMcpServerDetails"
  | "reloadMcpServers"
  | "startMcpOAuthLogin"
  | "readMcpResource"
  | "listPlugins"
  | "resolvePlugin"
  | "accountUsage"
  | "accountRateLimits"
  | "listPermissionProfiles"
  | "getGoal"
  | "setGoal"
  | "clearGoal";

export type ProviderClientInstance = Pick<CodexAppServerClient, ProviderClientMethod>;

type ThreadSnapshot = Awaited<ReturnType<ProviderClientInstance["readThread"]>>;

const SERVER_REQUEST_RESOLVED_METHOD = "serverRequest/resolved";

export class ProviderRoutingClient {
  private readonly threadProviders = new Map<string, string>();

  constructor(
    private readonly primaryProvider: string,
    private readonly clients: ReadonlyMap<string, ProviderClientInstance>,
  ) {
    if (!clients.has(primaryProvider)) {
      throw new Error(`缺少主模型 Provider App Server：${primaryProvider}`);
    }
  }

  async connect(): ReturnType<ProviderClientInstance["connect"]> {
    const entries = [...this.clients.entries()];
    try {
      const responses = await Promise.all(entries.map(([, client]) => client.connect()));
      return responses[entries.findIndex(([provider]) => provider === this.primaryProvider)]!;
    } catch (error) {
      await Promise.allSettled(entries.map(([, client]) => client.close()));
      throw error;
    }
  }

  async reconnectProvider(
    provider: string,
  ): ReturnType<ProviderClientInstance["reconnect"]> {
    return this.clientForProvider(provider).reconnect();
  }

  closeProvider(provider: string): ReturnType<ProviderClientInstance["close"]> {
    return this.clientForProvider(provider).close();
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.clients.values()].map((client) => client.close()),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
  }

  onNotification(handler: (notification: RpcNotification) => void): () => void {
    const removers = [...this.clients.entries()].map(([provider, client]) =>
      client.onNotification((notification) => {
        this.rememberNotificationProvider(provider, notification);
        const routed = routeNotification(provider, notification);
        if (routed) {
          handler(routed);
        }
      })
    );
    return () => removers.forEach((remove) => remove());
  }

  onDisconnect(handler: (error: Error, provider: string) => void): () => void {
    const removers = [...this.clients.entries()].map(([provider, client]) =>
      client.onDisconnect((error) => {
        handler(error, provider);
      })
    );
    return () => removers.forEach((remove) => remove());
  }

  setServerRequestHandler(handler: ServerRequestHandler): void {
    for (const [provider, client] of this.clients) {
      client.setServerRequestHandler((request) => handler({
        ...request,
        id: namespaceRequestId(provider, request.id),
      }));
    }
  }

  knownProvider(threadId: string): string | undefined {
    return this.threadProviders.get(threadId);
  }

  async listThreads(
    ...args: Parameters<ProviderClientInstance["listThreads"]>
  ): ReturnType<ProviderClientInstance["listThreads"]> {
    const entries = [...this.clients.entries()];
    const results = await Promise.allSettled(entries.map(async ([provider, client]) => ({
      provider,
      threads: await client.listThreads(...args),
    })));
    const pages = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    );
    if (pages.length === 0) {
      const failures: unknown[] = [];
      for (const result of results) {
        if (result.status === "rejected") {
          failures.push(result.reason as unknown);
        }
      }
      throw new AggregateError(
        failures,
        "所有模型 Provider App Server 的 Thread 列表查询均失败",
      );
    }
    const primary = pages.find((page) => page.provider === this.primaryProvider);
    const snapshots = new Map<string, ThreadSnapshot>();
    for (const page of pages) {
      for (const thread of page.threads) {
        if (this.clients.has(thread.modelProvider)) {
          this.rememberThread(thread);
        }
        if (
          thread.modelProvider === page.provider
          || (page.provider === this.primaryProvider && !this.clients.has(thread.modelProvider))
        ) {
          snapshots.set(thread.id, thread);
        }
      }
    }
    const orderedIds = [
      ...(primary?.threads ?? []).map((thread) => thread.id),
      ...pages.flatMap((page) => page.threads.map((thread) => thread.id)),
    ];
    return [...new Set(orderedIds)].flatMap((threadId) => {
      const thread = snapshots.get(threadId);
      return thread ? [thread] : [];
    });
  }

  async readThread(
    ...args: Parameters<ProviderClientInstance["readThread"]>
  ): ReturnType<ProviderClientInstance["readThread"]> {
    const [threadId] = args;
    const provider = this.threadProviders.get(threadId);
    if (provider) {
      const thread = await this.clientForProvider(provider).readThread(...args);
      this.rememberThread(thread);
      return thread;
    }
    const canonical = await this.primaryClient().readThread(...args);
    this.rememberThread(canonical);
    if (canonical.modelProvider === this.primaryProvider) {
      return canonical;
    }
    const thread = await this.clientForProvider(canonical.modelProvider).readThread(...args);
    this.rememberThread(thread);
    return thread;
  }

  async startThread(
    ...args: Parameters<ProviderClientInstance["startThread"]>
  ): ReturnType<ProviderClientInstance["startThread"]> {
    const provider = args[1]?.modelProvider ?? this.primaryProvider;
    const session = await this.clientForProvider(provider).startThread(...args);
    this.rememberThread(session.thread);
    return session;
  }

  async resumeThread(
    ...args: Parameters<ProviderClientInstance["resumeThread"]>
  ): ReturnType<ProviderClientInstance["resumeThread"]> {
    const [threadId, cwd] = args;
    const provider = await this.resolveThreadProvider(threadId, cwd);
    const session = await this.clientForProvider(provider).resumeThread(...args);
    this.rememberThread(session.thread);
    return session;
  }

  async unsubscribeThread(
    ...args: Parameters<ProviderClientInstance["unsubscribeThread"]>
  ): ReturnType<ProviderClientInstance["unsubscribeThread"]> {
    return this.callForThread(args[0], (client) => client.unsubscribeThread(...args));
  }

  async deleteThread(
    ...args: Parameters<ProviderClientInstance["deleteThread"]>
  ): ReturnType<ProviderClientInstance["deleteThread"]> {
    await this.callForThread(args[0], (client) => client.deleteThread(...args));
    this.threadProviders.delete(args[0]);
  }

  async archiveThread(
    ...args: Parameters<ProviderClientInstance["archiveThread"]>
  ): ReturnType<ProviderClientInstance["archiveThread"]> {
    return this.callForThread(args[0], (client) => client.archiveThread(...args));
  }

  async unarchiveThread(
    ...args: Parameters<ProviderClientInstance["unarchiveThread"]>
  ): ReturnType<ProviderClientInstance["unarchiveThread"]> {
    const thread = await this.callForThread(
      args[0],
      (client) => client.unarchiveThread(...args),
    );
    this.rememberThread(thread);
    return thread;
  }

  startTurn(
    ...args: Parameters<ProviderClientInstance["startTurn"]>
  ): ReturnType<ProviderClientInstance["startTurn"]> {
    return this.callForThread(args[0], (client) => client.startTurn(...args));
  }

  steerTurn(
    ...args: Parameters<ProviderClientInstance["steerTurn"]>
  ): ReturnType<ProviderClientInstance["steerTurn"]> {
    return this.callForThread(args[0], (client) => client.steerTurn(...args));
  }

  interruptTurn(
    ...args: Parameters<ProviderClientInstance["interruptTurn"]>
  ): ReturnType<ProviderClientInstance["interruptTurn"]> {
    return this.callForThread(args[0], (client) => client.interruptTurn(...args));
  }

  setThreadName(
    ...args: Parameters<ProviderClientInstance["setThreadName"]>
  ): ReturnType<ProviderClientInstance["setThreadName"]> {
    return this.callForThread(args[0], (client) => client.setThreadName(...args));
  }

  setThreadPinned(
    ...args: Parameters<ProviderClientInstance["setThreadPinned"]>
  ): ReturnType<ProviderClientInstance["setThreadPinned"]> {
    return this.callForThread(args[0], (client) => client.setThreadPinned(...args));
  }

  listThreadSections(
    ...args: Parameters<ProviderClientInstance["listThreadSections"]>
  ): ReturnType<ProviderClientInstance["listThreadSections"]> {
    return this.primaryClient().listThreadSections(...args);
  }

  createThreadSection(
    ...args: Parameters<ProviderClientInstance["createThreadSection"]>
  ): ReturnType<ProviderClientInstance["createThreadSection"]> {
    return this.primaryClient().createThreadSection(...args);
  }

  renameThreadSection(
    ...args: Parameters<ProviderClientInstance["renameThreadSection"]>
  ): ReturnType<ProviderClientInstance["renameThreadSection"]> {
    return this.primaryClient().renameThreadSection(...args);
  }

  deleteThreadSection(
    ...args: Parameters<ProviderClientInstance["deleteThreadSection"]>
  ): ReturnType<ProviderClientInstance["deleteThreadSection"]> {
    return this.primaryClient().deleteThreadSection(...args);
  }

  moveThreadToSection(
    ...args: Parameters<ProviderClientInstance["moveThreadToSection"]>
  ): ReturnType<ProviderClientInstance["moveThreadToSection"]> {
    return this.callForThread(args[0], (client) => client.moveThreadToSection(...args));
  }

  compactThread(
    ...args: Parameters<ProviderClientInstance["compactThread"]>
  ): ReturnType<ProviderClientInstance["compactThread"]> {
    return this.callForThread(args[0], (client) => client.compactThread(...args));
  }

  async forkThread(
    ...args: Parameters<ProviderClientInstance["forkThread"]>
  ): ReturnType<ProviderClientInstance["forkThread"]> {
    const provider = await this.resolveThreadProvider(args[0], args[1]);
    const requestedProvider = args[2]?.modelProvider;
    if (requestedProvider && requestedProvider !== provider) {
      throw new Error("Codex Thread 分支不能跨模型 Provider");
    }
    const session = await this.clientForProvider(provider).forkThread(...args);
    this.rememberThread(session.thread);
    return session;
  }

  startReview(
    ...args: Parameters<ProviderClientInstance["startReview"]>
  ): ReturnType<ProviderClientInstance["startReview"]> {
    return this.callForThread(args[0], (client) => client.startReview(...args));
  }

  listMcpServers(
    ...args: Parameters<ProviderClientInstance["listMcpServers"]>
  ): ReturnType<ProviderClientInstance["listMcpServers"]> {
    const threadId = args[0];
    return threadId
      ? this.callForThread(threadId, (client) => client.listMcpServers(...args))
      : this.primaryClient().listMcpServers(...args);
  }

  listMcpServerDetails(
    ...args: Parameters<ProviderClientInstance["listMcpServerDetails"]>
  ): ReturnType<ProviderClientInstance["listMcpServerDetails"]> {
    const threadId = args[0];
    return threadId
      ? this.callForThread(threadId, (client) => client.listMcpServerDetails(...args))
      : this.primaryClient().listMcpServerDetails(...args);
  }

  async reloadMcpServers(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.clients.values()].map((client) => client.reloadMcpServers()),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) {
      throw failure.reason;
    }
  }

  startMcpOAuthLogin(
    ...args: Parameters<ProviderClientInstance["startMcpOAuthLogin"]>
  ): ReturnType<ProviderClientInstance["startMcpOAuthLogin"]> {
    const threadId = args[1];
    return threadId
      ? this.callForThread(threadId, (client) => client.startMcpOAuthLogin(...args))
      : this.primaryClient().startMcpOAuthLogin(...args);
  }

  readMcpResource(
    ...args: Parameters<ProviderClientInstance["readMcpResource"]>
  ): ReturnType<ProviderClientInstance["readMcpResource"]> {
    const threadId = args[2];
    return threadId
      ? this.callForThread(threadId, (client) => client.readMcpResource(...args))
      : this.primaryClient().readMcpResource(...args);
  }

  getGoal(
    ...args: Parameters<ProviderClientInstance["getGoal"]>
  ): ReturnType<ProviderClientInstance["getGoal"]> {
    return this.callForThread(args[0], (client) => client.getGoal(...args));
  }

  setGoal(
    ...args: Parameters<ProviderClientInstance["setGoal"]>
  ): ReturnType<ProviderClientInstance["setGoal"]> {
    return this.callForThread(args[0], (client) => client.setGoal(...args));
  }

  clearGoal(
    ...args: Parameters<ProviderClientInstance["clearGoal"]>
  ): ReturnType<ProviderClientInstance["clearGoal"]> {
    return this.callForThread(args[0], (client) => client.clearGoal(...args));
  }

  listCollaborationModes(
    ...args: Parameters<ProviderClientInstance["listCollaborationModes"]>
  ): ReturnType<ProviderClientInstance["listCollaborationModes"]> {
    return this.primaryClient().listCollaborationModes(...args);
  }

  listModels(
    ...args: Parameters<ProviderClientInstance["listModels"]>
  ): ReturnType<ProviderClientInstance["listModels"]> {
    return this.primaryClient().listModels(...args);
  }

  writeDefaultFastMode(
    ...args: Parameters<ProviderClientInstance["writeDefaultFastMode"]>
  ): ReturnType<ProviderClientInstance["writeDefaultFastMode"]> {
    return this.primaryClient().writeDefaultFastMode(...args);
  }

  readDefaultServiceTier(
    cwd: string,
    modelProvider = this.primaryProvider,
  ): ReturnType<ProviderClientInstance["readDefaultServiceTier"]> {
    return this.clientForProvider(modelProvider).readDefaultServiceTier(cwd);
  }

  listSkills(
    ...args: Parameters<ProviderClientInstance["listSkills"]>
  ): ReturnType<ProviderClientInstance["listSkills"]> {
    return this.primaryClient().listSkills(...args);
  }

  resolveSkill(
    ...args: Parameters<ProviderClientInstance["resolveSkill"]>
  ): ReturnType<ProviderClientInstance["resolveSkill"]> {
    return this.primaryClient().resolveSkill(...args);
  }

  listPlugins(
    ...args: Parameters<ProviderClientInstance["listPlugins"]>
  ): ReturnType<ProviderClientInstance["listPlugins"]> {
    return this.primaryClient().listPlugins(...args);
  }

  resolvePlugin(
    ...args: Parameters<ProviderClientInstance["resolvePlugin"]>
  ): ReturnType<ProviderClientInstance["resolvePlugin"]> {
    return this.primaryClient().resolvePlugin(...args);
  }

  accountUsage(
    ...args: Parameters<ProviderClientInstance["accountUsage"]>
  ): ReturnType<ProviderClientInstance["accountUsage"]> {
    return this.primaryClient().accountUsage(...args);
  }

  accountRateLimits(
    ...args: Parameters<ProviderClientInstance["accountRateLimits"]>
  ): ReturnType<ProviderClientInstance["accountRateLimits"]> {
    return this.primaryClient().accountRateLimits(...args);
  }

  listPermissionProfiles(
    ...args: Parameters<ProviderClientInstance["listPermissionProfiles"]>
  ): ReturnType<ProviderClientInstance["listPermissionProfiles"]> {
    return this.primaryClient().listPermissionProfiles(...args);
  }

  private primaryClient(): ProviderClientInstance {
    return this.clientForProvider(this.primaryProvider);
  }

  private clientForProvider(provider: string): ProviderClientInstance {
    const client = this.clients.get(provider);
    if (!client) {
      throw new Error(`模型 Provider 未配置独立 App Server：${provider}`);
    }
    return client;
  }

  private async resolveThreadProvider(threadId: string, cwd?: string): Promise<string> {
    const known = this.threadProviders.get(threadId);
    if (known) {
      return known;
    }
    if (cwd) {
      let thread = (await this.primaryClient().listThreads(cwd))
        .find((candidate) => candidate.id === threadId);
      if (!thread) {
        thread = (await this.primaryClient().listThreads(cwd, { fullScan: true }))
          .find((candidate) => candidate.id === threadId);
      }
      if (thread) {
        this.rememberThread(thread);
        return thread.modelProvider;
      }
    }
    const thread = await this.primaryClient().readThread(threadId);
    this.rememberThread(thread);
    return thread.modelProvider;
  }

  private async callForThread<T>(
    threadId: string,
    operation: (client: ProviderClientInstance) => Promise<T>,
  ): Promise<T> {
    const provider = await this.resolveThreadProvider(threadId);
    return operation(this.clientForProvider(provider));
  }

  private rememberThread(thread: ThreadSnapshot): void {
    this.clientForProvider(thread.modelProvider);
    this.threadProviders.set(thread.id, thread.modelProvider);
  }

  private rememberNotificationProvider(provider: string, notification: RpcNotification): void {
    const params = asRecord(notification.params);
    const threadId = params && typeof params.threadId === "string"
      ? params.threadId
      : undefined;
    if (threadId) {
      this.threadProviders.set(threadId, provider);
    }
  }
}

function namespaceRequestId(provider: string, requestId: RpcServerRequest["id"]): string {
  return `${provider}:${requestId}`;
}

function namespaceResolvedNotification(
  provider: string,
  notification: RpcNotification,
): RpcNotification {
  if (notification.method !== SERVER_REQUEST_RESOLVED_METHOD) {
    return notification;
  }
  const params = asRecord(notification.params);
  if (!params || (typeof params.requestId !== "string" && typeof params.requestId !== "number")) {
    return notification;
  }
  return {
    ...notification,
    params: {
      ...params,
      requestId: namespaceRequestId(provider, params.requestId),
    },
  };
}

function routeNotification(
  provider: string,
  notification: RpcNotification,
): RpcNotification | undefined {
  const routed = namespaceResolvedNotification(provider, notification);
  if (
    routed.method === "account/updated"
    || routed.method === "account/rateLimits/updated"
  ) {
    return provider === "openai" ? { ...routed, provider } : undefined;
  }
  if (
    (
      routed.method === "mcpServer/oauthLogin/completed"
      || routed.method === "mcpServer/startupStatus/updated"
      || routed.method === "warning"
    )
    && typeof asRecord(routed.params)?.threadId !== "string"
  ) {
    return { ...routed, provider };
  }
  return routed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
