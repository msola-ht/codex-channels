import type { ApprovalRequest } from "../approval/index.js";
import { FileChangeApprovalContext } from "./file-change-approval-context.js";
import type {
  ReviewTarget,
  TurnExecutionPort,
  TurnInput,
  TurnOverrides,
  TurnStarted,
  ReviewStarted,
  ModelSelectionPort,
  ModelOption,
  AccountQueryPort,
  OpenAiResetCreditSnapshot,
  ResetCreditOutcome,
  AccountRateLimits,
  AccountThreadUsage,
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
  ThreadQueuePort,
  ThreadQueueListOptions,
  ThreadQueuePage,
  ThreadHistoryPort,
  ThreadTurnsListOptions,
  ThreadTurnsPage,
  ThreadRevertResult,
  ThreadApprovalsReviewerPort,
  HookConfigPort,
  HookCatalog,
  HookAction,
} from "../application/index.js";
import type {
  ConsumeAccountRateLimitResetCreditParams,
  ConsumeAccountRateLimitResetCreditResponse,
  ConfigReadParams,
  ConfigReadResponse,
  ConfigWriteResponse,
  ConfigRequirementsReadResponse,
  CollaborationModeListResponse,
  GetAccountParams,
  GetAccountResponse,
  GetAuthStatusResponse,
  GetAccountTokenUsageParams,
  GetAccountTokenUsageResponse,
  GetAccountRateLimitsResponse,
  GetAccountRateLimitsParams,
  InitializeResponse,
  ListMcpServerStatusResponse,
  McpResourceReadResponse,
  McpServerOauthLoginResponse,
  ModelListResponse,
  PermissionProfileListResponse,
  PluginInstalledResponse,
  ReviewStartResponse,
  SkillsListResponse,
  HooksListParams,
  HooksListResponse,
  ThreadArchiveResponse,
  ThreadDeleteResponse,
  ThreadForkResponse,
  ThreadListResponse,
  ThreadListParams,
  ThreadLoadedListResponse,
  ThreadMetadataUpdateResponse,
  ThreadReadResponse,
  ThreadSettingsUpdateParams,
  ThreadSettingsUpdateResponse,
  ThreadQueueListResponse,
  ThreadQueueListParams,
  ThreadRevertResponse,
  ThreadTurnsListParams,
  ThreadTurnsListResponse,
  ThreadRevertParams,
  ThreadResumeResponse,
  ThreadStartResponse,
  ThreadSectionMoveResponse,
  ThreadUnsubscribeResponse,
  ThreadUnarchiveResponse,
  TurnStartResponse,
  TurnSteerResponse,
  JsonValue,
  DynamicToolSpec as ProtocolDynamicToolSpec,
} from "../codex-protocol/index.js";
import type {
  ThreadLifecyclePort,
  ThreadQueryOptions,
  ThreadDynamicToolSpec,
  ThreadSession,
  ThreadResumeSession,
  ThreadStartOptions,
  ThreadSnapshot,
  ThreadModelSettings,
} from "../session-routing/index.js";
import { isThreadExecutionSettled } from "../session-routing/index.js";
import { JsonRpcClient, JsonRpcError, type RpcNotification, type ServerRequestHandler } from "./json-rpc.js";
import { UserFacingError } from "../conversation-core/index.js";
import { ImageReferenceUpload, type ProviderImageUploadRoute } from "./image-reference-upload.js";
import { toConversationInputEvent, toThreadStateEvent } from "./notification-adapter.js";
import { asRecord, nonEmptyString } from "./notification-parse-helpers.js";
import {
  PINNED_THREAD_SECTION_ID,
  toThreadSession,
  toThreadResumeSession,
  toThreadSnapshot,
} from "./thread-adapter.js";
import {
  toProtocolReviewTarget,
  toProtocolTurnInput,
  toReviewStarted,
  toTurnStarted,
} from "./turn-adapter.js";
import { toModelOption } from "./model-adapter.js";
import {
  type OpenAiAccountRoute,
  toOpenAiAccountRoute,
  toAccountRateLimits,
  toAccountThreadUsage,
  toAccountUsage,
} from "./account-adapter.js";
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
import { toHookCatalog, toHookStateWrite } from "./hook-adapter.js";
import {
  rethrowThreadQueueError,
  toThreadQueuePage,
} from "./queue-adapter.js";
import {
  toThreadRevertResult,
  toThreadTurnsPage,
} from "./history-adapter.js";

export interface ThreadDefaults {
  model?: string;
}

type ObservedTurnState =
  | { type: "running"; turnId: string }
  | { type: "completed"; turnId: string }
  | { type: "unknown" };

export class CodexAppServerClient implements
  ThreadLifecyclePort,
  TurnExecutionPort,
  ModelSelectionPort,
  AccountQueryPort,
  CollaborationModeQueryPort,
  SkillQueryPort,
  McpQueryPort,
  PluginQueryPort,
  PermissionQueryPort,
  ThreadQueuePort,
  ThreadHistoryPort,
  ThreadApprovalsReviewerPort,
  HookConfigPort
{
  private readonly imageUpload: ImageReferenceUpload | undefined;
  private readonly fileChanges = new FileChangeApprovalContext();
  private readonly pendingSettingsUpdates = new Set<() => void>();
  private readonly observedTurns = new Map<string, ObservedTurnState>();

  constructor(
    private readonly rpc: JsonRpcClient,
    private readonly defaults: ThreadDefaults,
    imageUploadHttp?: { upload: typeof fetch; local?: typeof fetch;
      readProviderUploadRoute?: (provider: string, signal: AbortSignal) => Promise<ProviderImageUploadRoute> },
  ) {
    this.rpc.onNotification(notification => this.fileChanges.observe(notification));
    this.rpc.onNotification(notification => this.observeTurnState(notification));
    this.rpc.onDisconnect(() => {
      this.fileChanges.clear();
      this.observedTurns.clear();
    });
    this.imageUpload = imageUploadHttp ? new ImageReferenceUpload(rpc, imageUploadHttp.upload, imageUploadHttp.local ?? fetch,
      signal => this.rpc.request<GetAuthStatusResponse>({
        method: "getAuthStatus",
        params: { includeToken: true, refreshToken: false },
      }, { retryOverload: false, signal }), imageUploadHttp.readProviderUploadRoute) : undefined;
  }

  connect(): Promise<InitializeResponse> {
    return this.rpc.connect();
  }

  reconnect(): Promise<InitializeResponse> {
    for (const cancel of this.pendingSettingsUpdates) cancel();
    this.fileChanges.clear();
    this.observedTurns.clear();
    return this.rpc.reconnect();
  }

  close(): Promise<void> {
    for (const cancel of this.pendingSettingsUpdates) cancel();
    this.fileChanges.clear();
    this.observedTurns.clear();
    this.imageUpload?.cancelAll();
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

  fileApprovalChanges(request: Extract<ApprovalRequest, { type: "file" }>) {
    return this.fileChanges.get(request.threadId, request.turnId, request.itemId);
  }

  private observeTurnState(notification: RpcNotification): void {
    if (notification.method === "thread/started") {
      const threadId = nonEmptyString(asRecord(asRecord(notification.params)?.thread)?.id);
      if (threadId) this.observedTurns.delete(threadId);
      return;
    }
    if (!["turn/started", "turn/completed", "error", "thread/status/changed", "thread/closed",
      "thread/archived", "thread/deleted", "thread/reverted"].includes(notification.method)) return;
    const event = toConversationInputEvent(notification);
    const threadId = nonEmptyString(asRecord(notification.params)?.threadId);
    if (!threadId) return;
    const current = this.observedTurns.get(threadId);
    if (event?.type === "thread.closed" || event?.type === "thread.archived"
      || event?.type === "thread.deleted" || event?.type === "thread.reverted") {
      this.observedTurns.delete(threadId);
      return;
    }
    if (event?.type === "turn.started") {
      this.rememberTurnState(threadId, { type: "running", turnId: event.turnId });
    } else if (event?.type === "turn.completed" && event.status !== "inProgress") {
      // A completion for an old Turn must not settle a newer Turn. Requiring
      // its start also makes eviction and missed subscription intervals safe.
      if (current?.type === "running" && current.turnId === event.turnId) {
        this.rememberTurnState(threadId, { type: "completed", turnId: event.turnId });
      } else if (current?.type === "completed" && current.turnId !== event.turnId) {
        this.rememberTurnState(threadId, { type: "unknown" });
      }
    } else if (notification.method === "turn/started" || notification.method === "turn/completed") {
      // Malformed execution boundaries cannot preserve an older terminal proof.
      this.rememberTurnState(threadId, { type: "unknown" });
    } else if (notification.method === "error") {
      // Error notifications can describe a failed operation while a task stays
      // alive. Only a later completion of the known running Turn can settle it.
      if (event?.type !== "turn.error" || current?.type !== "running" || current.turnId !== event.turnId) {
        this.rememberTurnState(threadId, { type: "unknown" });
      }
    } else if (notification.method === "thread/status/changed") {
      if (event?.type !== "thread.status.changed" || event.status === "notLoaded") {
        this.observedTurns.delete(threadId);
      } else if (event.status === "active" && current?.type !== "running") {
        this.rememberTurnState(threadId, { type: "unknown" });
      }
    }
  }

  private rememberTurnState(threadId: string, state: ObservedTurnState): void {
    this.observedTurns.delete(threadId);
    if (this.observedTurns.size >= 2_000) {
      const oldest = this.observedTurns.keys().next().value;
      if (oldest !== undefined) this.observedTurns.delete(oldest);
    }
    this.observedTurns.set(threadId, state);
  }

  async listThreads(
    cwd: string,
    options: ThreadQueryOptions = {},
  ): Promise<ThreadSnapshot[]> {
    return this.listThreadPages({
      cwd,
      modelProviders: [],
      sourceKinds: ["cli", "vscode", "appServer"],
      sortKey: options.sortKey ?? "updated_at",
      sortDirection: options.sortDirection ?? "desc",
      useStateDbOnly: !options.fullScan,
      archived: options.archived ?? false,
      ...(options.searchTerm ? { searchTerm: options.searchTerm } : {}),
      ...(options.sectionId ? { sectionId: options.sectionId } : {}),
    }, options.beforeSubmit);
  }

  /** CLI archive preview: include descendants across cwd and source boundaries. */
  async listThreadDescendants(threadId: string, archived: boolean): Promise<ThreadSnapshot[]> {
    return this.listThreadPages({
      ancestorThreadId: threadId,
      modelProviders: [],
      sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
        "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"],
      archived,
      useStateDbOnly: false,
      sortKey: "created_at",
      sortDirection: "asc",
    });
  }

  private async listThreadPages(params: ThreadListParams, beforeSubmit?: () => void): Promise<ThreadSnapshot[]> {
    const threads: ThreadSnapshot[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const result: ThreadListResponse = await this.rpc.request<ThreadListResponse>({
        method: "thread/list",
        params: {
          ...params,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        },
      }, { retryOverload: true, ...(beforeSubmit ? { beforeSubmit } : {}) });
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

  async countActiveLoadedThreads(): Promise<number> {
    const activeThreadIds = new Set<string>();
    const loadedThreadIds = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const result: ThreadLoadedListResponse = await this.rpc.request<ThreadLoadedListResponse>({
        method: "thread/loaded/list",
        params: {
          limit: 100,
          ...(cursor ? { cursor } : {}),
        },
      }, { retryOverload: true });
      for (const threadId of result.data) {
        if (loadedThreadIds.has(threadId)) continue;
        loadedThreadIds.add(threadId);
        const thread = await this.readThread(threadId);
        if (thread.id !== threadId) {
          throw new Error("Codex 已加载 Thread 读取目标不一致");
        }
        if (thread.status.type === "active") activeThreadIds.add(thread.id);
      }
      cursor = result.nextCursor;
      if (cursor) {
        if (cursors.has(cursor)) {
          throw new Error("Codex 已加载 Thread 查询返回了循环分页游标");
        }
        cursors.add(cursor);
      }
    } while (cursor);
    return activeThreadIds.size;
  }

  async listCollaborationModes(beforeSubmit?: () => void): Promise<CollaborationModePreset[]> {
    const response = await this.rpc.request<CollaborationModeListResponse>({
      method: "collaborationMode/list",
      params: {},
    }, { retryOverload: true, ...(beforeSubmit ? { beforeSubmit } : {}) });
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

  async readThread(threadId: string, signal?: AbortSignal, beforeSubmit?: () => void): Promise<ThreadSnapshot> {
    const result = await this.rpc.request<ThreadReadResponse>({
      method: "thread/read",
      params: { threadId, includeTurns: false },
    }, { retryOverload: true, ...(signal ? { signal } : {}), ...(beforeSubmit ? { beforeSubmit } : {}) });
    if (result.thread.parentThreadId !== null
      && (typeof result.thread.parentThreadId !== "string" || !result.thread.parentThreadId.trim())) {
      throw new Error("Codex Thread 响应缺少有效 parentThreadId");
    }
    const snapshot = toThreadSnapshot(result.thread);
    if (snapshot.id !== threadId) throw new Error("Codex Thread 读取目标不一致");
    if (snapshot.status.type === "active" || snapshot.status.type === "notLoaded"
      || snapshot.activeTurnId !== null) {
      const current = this.observedTurns.get(threadId);
      if (current?.type === "completed") this.rememberTurnState(threadId, { type: "unknown" });
    }
    const observed = this.observedTurns.get(threadId);
    return observed?.type === "completed"
      ? { ...snapshot, observedTerminalTurnId: observed.turnId }
      : snapshot;
  }

  async hasActiveDescendants(threadId: string, signal?: AbortSignal): Promise<boolean> {
    const disconnected = new AbortController();
    const querySignal = AbortSignal.any([
      disconnected.signal,
      AbortSignal.timeout(10_000),
      ...(signal ? [signal] : []),
    ]);
    const removeDisconnect = this.rpc.onDisconnect((error) => disconnected.abort(error));
    try {
      return await this.queryActiveDescendants(threadId, querySignal);
    } finally {
      removeDisconnect();
    }
  }

  private async queryActiveDescendants(threadId: string, querySignal: AbortSignal): Promise<boolean> {
    const snapshots = new Map<string, ThreadSnapshot>();
    const read = async (id: string): Promise<ThreadSnapshot> => {
      querySignal.throwIfAborted();
      const cached = snapshots.get(id);
      if (cached) return cached;
      if (!id.trim() || snapshots.size >= 2_000) {
        throw new Error("Codex 后代活动查询包含无效身份或超过节点上限");
      }
      const thread = await this.readThread(id, querySignal);
      querySignal.throwIfAborted();
      if (thread.id !== id || !thread.sessionId.trim() || !thread.modelProvider.trim()) {
        throw new Error("Codex 后代活动查询的 Thread 身份不完整或不匹配");
      }
      snapshots.set(id, thread);
      return thread;
    };
    const root = await read(threadId);
    const loadedIds = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      querySignal.throwIfAborted();
      if (++pages > 20) throw new Error("Codex 后代活动查询超过分页上限");
      const result: ThreadLoadedListResponse = await this.rpc.request<ThreadLoadedListResponse>({
        method: "thread/loaded/list",
        params: { limit: 100, ...(cursor ? { cursor } : {}) },
      }, { retryOverload: true, signal: querySignal });
      if (!Array.isArray(result.data) || result.data.length > 100
        || (result.nextCursor !== null
          && (typeof result.nextCursor !== "string" || !result.nextCursor.trim()))) {
        throw new Error("Codex 后代活动查询返回了无效分页");
      }
      for (const id of result.data) {
        if (typeof id !== "string" || !id.trim() || loadedIds.has(id)) {
          throw new Error("Codex 后代活动查询返回了无效或重复 Thread 身份");
        }
        loadedIds.add(id);
        if (loadedIds.size > 2_000) throw new Error("Codex 后代活动查询超过节点上限");
      }
      cursor = result.nextCursor;
      if (cursor !== null) {
        if (result.data.length === 0 || cursors.has(cursor)) {
          throw new Error("Codex 后代活动查询返回了循环或空分页");
        }
        cursors.add(cursor);
      }
    } while (cursor !== null);

    for (const id of loadedIds) {
      if (id === threadId) continue;
      const thread = await read(id);
      if (isThreadExecutionSettled(thread)) continue;
      const ancestors = new Set<string>([id]);
      let parentId = thread.parentThreadId;
      let depth = 0;
      while (parentId != null) {
        querySignal.throwIfAborted();
        if (++depth > 64 || ancestors.has(parentId)) {
          throw new Error("Codex 后代活动查询包含循环关系或超过祖先深度上限");
        }
        if (parentId === threadId) {
          if (thread.modelProvider !== root.modelProvider || thread.sessionId !== root.sessionId) {
            throw new Error("Codex 活动后代的模型 Provider 或 Session 与根 Thread 不匹配");
          }
          return true;
        }
        ancestors.add(parentId);
        const parent = await read(parentId);
        if (parent.modelProvider !== thread.modelProvider || parent.sessionId !== thread.sessionId) {
          throw new Error("Codex 后代活动查询的祖先模型 Provider 或 Session 不匹配");
        }
        parentId = parent.parentThreadId;
      }
    }
    querySignal.throwIfAborted();
    return false;
  }

  async startThread(cwd: string, options: ThreadStartOptions = {}): Promise<ThreadSession> {
    options.beforeSubmit?.();
    if (!options.model && this.defaults.model) {
      const models = await this.listModels(options.beforeSubmit);
      options.beforeSubmit?.();
      if (!models.some(model => model.model === this.defaults.model && model.available !== false)) {
        throw new UserFacingError("model.configured-default.missing", "Configured default model unavailable in connected provider catalog", {
          model: this.defaults.model,
        });
      }
    }
    const response = await this.rpc.request<ThreadStartResponse>({
      method: "thread/start",
      params: {
        cwd,
        historyMode: "paginated",
        ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
        ...(options.approvalsReviewer === undefined ? {} : { approvalsReviewer: options.approvalsReviewer }),
        ...(options.permissions !== undefined
          ? { permissions: options.permissions }
          : options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
        ...(options.model
          ? { model: options.model }
          : this.defaults.model ? { model: this.defaults.model } : {}),
        ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
        // 与原生 CLI 一致标记普通会话；计划任务保留独立来源。
        threadSource: options.threadSource === "automation" ? "automation" : "user",
        ...(options.ephemeral === true ? { ephemeral: true } : {}),
        ...(options.dynamicTools?.length
          ? { dynamicTools: options.dynamicTools.map(toProtocolDynamicTool) }
          : {}),
      },
    }, { retryOverload: false });
    return toThreadSession(response);
  }

  async listThreadTurns(
    threadId: string,
    options: ThreadTurnsListOptions = {},
  ): Promise<ThreadTurnsPage> {
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Codex Turn 列表页大小必须在 1 到 100 之间");
    }
    const response = await this.rpc.request<ThreadTurnsListResponse>({
      method: "thread/turns/list",
      params: {
        threadId,
        ...(options.cursor ? { cursor: options.cursor } : {}),
        limit,
        sortDirection: options.sortDirection ?? "desc",
        itemsView: "summary",
      } satisfies ThreadTurnsListParams,
    }, { retryOverload: true, ...(options.signal ? { signal: options.signal } : {}), ...(options.beforeSubmit ? { beforeSubmit: options.beforeSubmit } : {}) });
    const page = toThreadTurnsPage(response);
    if (page.turns.length > limit) {
      throw new Error("Codex Turn 列表响应超过请求页大小");
    }
    return page;
  }

  async revertThread(threadId: string, beforeTurnId: string, beforeSubmit?: () => void): Promise<ThreadRevertResult> {
    const response = await this.rpc.request<ThreadRevertResponse>({
      method: "thread/revert",
      params: { threadId, beforeTurnId } satisfies ThreadRevertParams,
    }, { retryOverload: false, ...(beforeSubmit ? { beforeSubmit } : {}) });
    return toThreadRevertResult(response);
  }

  async resumeThread(
    threadId: string,
    cwd: string,
    options: ThreadStartOptions = {},
  ): Promise<ThreadResumeSession> {
    options.beforeSubmit?.();
    const settings = {
      cwd,
      ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
      ...(options.approvalsReviewer === undefined ? {} : { approvalsReviewer: options.approvalsReviewer }),
      ...(options.permissions !== undefined
        ? { permissions: options.permissions }
        : options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    };
    this.observedTurns.delete(threadId);
    const response = await this.rpc.request<ThreadResumeResponse>({
      method: "thread/resume",
      params: {
        threadId,
        ...settings,
      },
    }, { retryOverload: false }).catch((error: unknown) => {
      // Locked app-server rejects resume before subscription when stored history
      // is missing, including loaded, not-yet-materialized Threads.
      if (error instanceof JsonRpcError && error.code === -32600
        && error.message === `no rollout found for thread id ${threadId}`) {
        throw new UserFacingError("thread.resume.history-unavailable",
          "Codex Thread resume history is unavailable");
      }
      throw error;
    });
    return toThreadResumeSession(response, settings);
  }

  async unsubscribeThread(threadId: string, beforeSubmit?: () => void): Promise<void> {
    beforeSubmit?.();
    this.fileChanges.clearThread(threadId);
    this.cancelPendingInput(threadId);
    try {
      await this.rpc.request<ThreadUnsubscribeResponse>({
        method: "thread/unsubscribe",
        params: { threadId },
      }, { retryOverload: true, beforeSubmit: () => {
        beforeSubmit?.();
        this.observedTurns.delete(threadId);
      } });
    } finally {
      // Notifications already in flight may have arrived while unsubscribing;
      // none can prove continued observation across the subscription gap.
      this.observedTurns.delete(threadId);
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.rpc.request<ThreadDeleteResponse>({
      method: "thread/delete",
      params: { threadId },
    }, { retryOverload: false });
  }

  async archiveThread(threadId: string, beforeSubmit?: () => void): Promise<void> {
    await this.rpc.request<ThreadArchiveResponse>({
      method: "thread/archive",
      params: { threadId },
    }, { retryOverload: false, ...(beforeSubmit ? { beforeSubmit } : {}) });
  }

  async unarchiveThread(threadId: string, beforeSubmit?: () => void): Promise<ThreadSnapshot> {
    const response = await this.rpc.request<ThreadUnarchiveResponse>({
      method: "thread/unarchive",
      params: { threadId },
    }, { retryOverload: false, ...(beforeSubmit ? { beforeSubmit } : {}) });
    return toThreadSnapshot(response.thread);
  }

  async startTurn(
    threadId: string,
    input: TurnInput[],
    clientUserMessageId: string,
    cwd: string,
    overrides: TurnOverrides = {},
  ): Promise<TurnStarted> {
    return this.submitTurnInput(threadId, input, async (protocolInput) => {
      overrides.beforeSubmit?.();
      requireSynchronousAttempt(overrides.requestAttempted);
      if (overrides.requestAttempted) overrides.beforeSubmit?.();
      this.observedTurns.delete(threadId);
      const response = await this.rpc.request<TurnStartResponse>({
        method: "turn/start",
        params: {
          threadId,
          clientUserMessageId,
          input: protocolInput,
          cwd,
          ...(overrides.turnTrigger ? { turnTrigger: overrides.turnTrigger } : {}),
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
    }, overrides.beforeSubmit);
  }

  async listQueue(
    threadId: string,
    options: ThreadQueueListOptions = {},
  ): Promise<ThreadQueuePage> {
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Codex Queue 列表页大小必须在 1 到 100 之间");
    }
    const response = await this.rpc.request<ThreadQueueListResponse>({
      method: "thread/queue/list",
      params: {
        threadId,
        ...(options.cursor ? { cursor: options.cursor } : {}),
        limit,
      } satisfies ThreadQueueListParams,
    }, { retryOverload: true, ...(options.beforeSubmit ? { beforeSubmit: options.beforeSubmit } : {}) })
      .catch(rethrowThreadQueueError);
    const page = toThreadQueuePage(response);
    if (page.itemCount > limit) {
      throw new Error("Codex Queue 列表响应超过请求页大小");
    }
    return page;
  }

  async steerTurn(
    threadId: string,
    turnId: string,
    input: TurnInput[],
    clientUserMessageId: string,
    beforeSubmit?: () => void,
    requestAttempted?: () => undefined,
  ): Promise<TurnStarted> {
    return this.submitTurnInput(threadId, input, async (protocolInput) => {
      beforeSubmit?.();
      requireSynchronousAttempt(requestAttempted);
      if (requestAttempted) beforeSubmit?.();
      const response = await this.rpc.request<TurnSteerResponse>({
        method: "turn/steer",
        params: {
          threadId,
          expectedTurnId: turnId,
          clientUserMessageId,
          input: protocolInput,
        },
      }, { retryOverload: false });
      const result = toTurnStarted(response);
      if (result.turnId !== turnId) throw new Error("Codex 追加输入响应与预期 Turn 不一致");
      return result;
    }, beforeSubmit);
  }

  cancelPendingInput(threadId: string): boolean {
    return this.imageUpload?.cancel(threadId) ?? false;
  }

  private async submitTurnInput(
    threadId: string,
    input: TurnInput[],
    submit: (input: ReturnType<typeof toProtocolTurnInput>) => Promise<TurnStarted>,
    beforeSubmit?: () => void,
  ): Promise<TurnStarted> {
    const protocolInput = toProtocolTurnInput(input);
    if (!this.imageUpload || !input.some(item => item.type === "image")) return submit(protocolInput);
    return this.imageUpload.submit(threadId, protocolInput, submit, beforeSubmit);
  }

  async interruptTurn(threadId: string, turnId: string, beforeSubmit?: () => void): Promise<void> {
    beforeSubmit?.();
    this.cancelPendingInput(threadId);
    await this.rpc.request({
      method: "turn/interrupt",
      params: { threadId, turnId },
    }, { retryOverload: false });
  }

  async setThreadName(threadId: string, name: string, beforeSubmit?: () => void): Promise<void> {
    await this.rpc.request({
      method: "thread/name/set",
      params: { threadId, name },
    }, { retryOverload: false, ...(beforeSubmit ? { beforeSubmit } : {}) });
  }

  async setThreadPinned(threadId: string, pinned: boolean, beforeSubmit?: () => void): Promise<boolean> {
    const observed = await this.rpc.request<ThreadReadResponse>({
      method: "thread/read",
      params: { threadId, includeTurns: false },
    }, { retryOverload: true, ...(beforeSubmit ? { beforeSubmit } : {}) });
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
      undefined,
      beforeSubmit,
    );
    if (updated.id !== threadId || updated.isPinned !== pinned) {
      throw new Error("Codex Thread 固定状态更新结果不一致");
    }
    return true;
  }

  private async applyThreadSectionMove(
    threadId: string,
    observed: ThreadReadResponse,
    sectionId: string | null,
    beforeThreadId?: string,
    beforeSubmit?: () => void,
  ): Promise<ThreadSnapshot> {
    const materialized = await this.rpc.request<ThreadMetadataUpdateResponse>({
      method: "thread/metadata/update",
      params: {
        threadId,
        gitInfo: { sha: observed.thread.gitInfo?.sha ?? null },
      },
    }, { retryOverload: false, ...(beforeSubmit ? { beforeSubmit } : {}) });
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
    }, { retryOverload: false, ...(beforeSubmit ? { beforeSubmit } : {}) });
    // Reconcile a submitted move even if authorization changes after the write.
    return this.readThread(threadId);
  }

  async compactThread(threadId: string, beforeSubmit?: () => void): Promise<void> {
    await this.rpc.request({
      method: "thread/compact/start",
      params: { threadId },
    }, { retryOverload: false, ...(beforeSubmit ? { beforeSubmit } : {}) });
  }

  async listModels(beforeSubmit?: () => void): Promise<ModelOption[]> {
    const models: ModelOption[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const result: ModelListResponse = await this.rpc.request<ModelListResponse>({
        method: "model/list",
        params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) },
      }, { retryOverload: true, ...(beforeSubmit ? { beforeSubmit } : {}) });
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

  async writeDefaultServiceTier(tier: "fast" | "ultrafast" | "default", beforeSubmit?: () => void): Promise<void> {
    await this.writeUserConfigEdits([{
      keyPath: "service_tier",
      value: tier,
    }], { ...(beforeSubmit ? { beforeSubmit } : {}) });
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

  async readDefaultReasoningEffort(cwd: string, _modelProvider?: string, beforeSubmit?: () => void): Promise<string | null> {
    const params: ConfigReadParams = { cwd, includeLayers: false };
    const response = await this.rpc.request<ConfigReadResponse>({
      method: "config/read",
      params,
    }, { retryOverload: true, ...(beforeSubmit ? { beforeSubmit } : {}) });
    const effort = response.config.model_reasoning_effort;
    if (effort !== null && (typeof effort !== "string" || effort.trim() === "")) {
      throw new Error("Codex 响应缺少有效 config model_reasoning_effort");
    }
    return effort;
  }

  /** Preflight only; the created Thread's actual permissions must also be checked. */
  async readUnattendedPermissionSettings(
    cwd: string,
    signal?: AbortSignal,
    beforeSubmit?: () => void,
  ): Promise<{ sandbox: "read-only" | "workspace-write"; permissions: null }> {
    const response = await this.rpc.request<ConfigReadResponse>({
      method: "config/read",
      params: { cwd, includeLayers: false } satisfies ConfigReadParams,
    }, { retryOverload: true, ...(signal === undefined ? {} : { signal }), ...(beforeSubmit ? { beforeSubmit } : {}) });
    const sandbox = response.config.sandbox_mode;
    if (response.config.default_permissions != null || (sandbox !== "read-only" && sandbox !== "workspace-write")) {
      throw new UserFacingError("scheduled-task.state.invalid",
        "无法确认计划任务的原生权限：请在目标项目的 Codex 配置中显式设置受限 sandbox_mode；命名 Permission Profile 暂不支持无人值守预检");
    }
    return { sandbox, permissions: null };
  }

  async readDefaultServiceTier(cwd: string, modelProvider?: string, beforeSubmit?: () => void): Promise<string | null> {
    const settings = await this.readModelAccelerationSettings(cwd, modelProvider, beforeSubmit);
    return settings.serviceTier;
  }

  async readModelAccelerationSettings(cwd: string, _modelProvider?: string, beforeSubmit?: () => void): Promise<{ fastEnabled: boolean; ultrafastEnabled: boolean; serviceTier: string | null }> {
    const params: ConfigReadParams = { cwd, includeLayers: false };
    const response = await this.rpc.request<ConfigReadResponse>({
      method: "config/read",
      params,
    }, { retryOverload: true, ...(beforeSubmit ? { beforeSubmit } : {}) });
    const serviceTier = response.config.service_tier;
    if (serviceTier !== null && typeof serviceTier !== "string") {
      throw new Error("Codex 响应缺少有效 config service_tier");
    }
    return { serviceTier, ...await this.readAccelerationFlags(response.config.features, beforeSubmit) };
  }

  private async readAccelerationFlags(features: unknown, beforeSubmit?: () => void): Promise<{ fastEnabled: boolean; ultrafastEnabled: boolean }> {
    if (features !== undefined && (features === null || typeof features !== "object" || Array.isArray(features))) {
      throw new Error("Codex 响应包含无效 config features");
    }
    const configured = features as Record<string, unknown> | undefined;
    const { requirements, supportsIndependentSpeedModes } = await this.rpc.request<ConfigRequirementsReadResponse>({
      method: "configRequirements/read",
      params: undefined,
    }, { retryOverload: true, ...(beforeSubmit ? { beforeSubmit } : {}) });
    if (supportsIndependentSpeedModes !== true || requirements === undefined || (requirements !== null
      && (typeof requirements !== "object" || Array.isArray(requirements)
        || requirements.featureRequirements === undefined
        || (requirements.featureRequirements !== null && (typeof requirements.featureRequirements !== "object"
          || Array.isArray(requirements.featureRequirements)))))) {
      throw new Error("Codex 响应缺少有效加速策略要求");
    }
    const enabled = (key: "fast_mode" | "ultrafast_mode"): boolean => {
      const value = configured?.[key];
      const required = requirements?.featureRequirements?.[key];
      if ((value !== undefined && typeof value !== "boolean")
        || (required !== undefined && typeof required !== "boolean")) {
        throw new Error(`Codex 响应包含无效加速开关 ${key}`);
      }
      // Both stable features default to true in the locked CLI; exact policy wins.
      return required ?? value ?? true;
    };
    return { fastEnabled: enabled("fast_mode"), ultrafastEnabled: enabled("ultrafast_mode") };
  }

  async writeUserConfigEdits(
    edits: Array<{ keyPath: string; value: JsonValue }>,
    options: { expectedVersion?: string; beforeSubmit?: () => void } = {},
  ): Promise<Pick<ConfigWriteResponse, "status" | "version">> {
    const response = await this.rpc.request<ConfigWriteResponse>({
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
    }, { retryOverload: false, ...(options.beforeSubmit ? { beforeSubmit: options.beforeSubmit } : {}) });
    // Keep persistence/override semantics without exposing paths or source values.
    return { status: response.status, version: response.version };
  }

  async readUserConfigSnapshot(options: { includeApprovalsReviewerPolicy?: boolean; includeAcceleration?: boolean; beforeSubmit?: () => void } = {}): Promise<{
    config: Record<string, JsonValue | undefined>;
    version: string;
    toolConfig: Record<string, JsonValue | undefined>;
    approvalsReviewerPolicy?: { allowedReviewers: string[] | null; autoReviewDisabled: boolean };
    acceleration?: { fastEnabled: boolean; ultrafastEnabled: boolean };
  }> {
    let submissionDenied = false;
    const beforeSubmit = options.beforeSubmit && (() => {
      try { options.beforeSubmit!(); } catch (error) { submissionDenied = true; throw error; }
    });
    const response = await this.rpc.request<ConfigReadResponse>({
      method: "config/read",
      params: { includeLayers: true },
    }, { retryOverload: true, ...(beforeSubmit ? { beforeSubmit } : {}) });
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
    if (typeof userLayer.version !== "string" || userLayer.version.trim() === "") {
      throw new Error("Codex 响应缺少用户配置版本");
    }
    let approvalsReviewerPolicy;
    if (options.includeApprovalsReviewerPolicy) {
      try {
        const { requirements } = await this.rpc.request<ConfigRequirementsReadResponse>({
          method: "configRequirements/read",
          params: undefined,
        }, { retryOverload: true, ...(beforeSubmit ? { beforeSubmit } : {}) });
        if (requirements === undefined || (requirements !== null
          && (typeof requirements !== "object" || Array.isArray(requirements)
            || requirements.allowedApprovalsReviewers === undefined
            || (requirements.allowedApprovalsReviewers !== null && (!Array.isArray(requirements.allowedApprovalsReviewers)
              || !requirements.allowedApprovalsReviewers.every(value => typeof value === "string")))
            || requirements.featureRequirements === undefined
            || (requirements.featureRequirements !== null && (typeof requirements.featureRequirements !== "object"
              || Array.isArray(requirements.featureRequirements)
              || !Object.values(requirements.featureRequirements).every(value => typeof value === "boolean")))))) {
          throw new Error("Codex 响应缺少有效审批策略要求");
        }
        approvalsReviewerPolicy = {
          allowedReviewers: requirements?.allowedApprovalsReviewers ?? null,
          autoReviewDisabled: requirements?.featureRequirements?.auto_review === false
            || requirements?.featureRequirements?.guardian_approval === false,
        };
      } catch (error) {
        if (submissionDenied) throw error;
        // The optional policy is unavailable; retain the valid user snapshot.
        // Settings projection exposes this as read-only and rejects writes.
        approvalsReviewerPolicy = undefined;
      }
    }
    let acceleration;
    if (options.includeAcceleration) {
      try {
        acceleration = await this.readAccelerationFlags(response.config.features, beforeSubmit);
      } catch (error) {
        if (submissionDenied) throw error;
        // This optional capability must not hide the valid user configuration.
      }
    }
    return {
      config: userLayer.config,
      version: userLayer.version,
      toolConfig: {
        computer_use: response.config.computer_use,
        browser_use: response.config.browser_use,
        mcp_servers: response.config.mcp_servers,
        plugins: response.config.plugins,
      },
      ...(approvalsReviewerPolicy === undefined ? {} : { approvalsReviewerPolicy }),
      ...(acceleration === undefined ? {} : { acceleration }),
    };
  }

  async listHooks(cwd: string, _modelProvider: string, beforeSubmit?: () => void): Promise<HookCatalog> {
    void _modelProvider;
    const params: HooksListParams = { cwds: [cwd] };
    const response = await this.rpc.request<HooksListResponse>({
      method: "hooks/list",
      params,
    }, { retryOverload: true, ...(beforeSubmit ? { beforeSubmit } : {}) });
    return toHookCatalog(response, cwd);
  }

  async readHookConfigVersion(_modelProvider: string, beforeSubmit?: () => void): Promise<string> {
    void _modelProvider;
    return (await this.readUserConfigSnapshot({ ...(beforeSubmit ? { beforeSubmit } : {}) })).version;
  }

  async writeHookState(_modelProvider: string, input: {
    key: string;
    currentHash: string;
    action: HookAction;
    expectedVersion: string;
  }, beforeSubmit?: () => void): Promise<{ refreshFailedProviders: string[] }> {
    await this.rpc.request({
      method: "config/batchWrite",
      params: toHookStateWrite(input),
    }, { retryOverload: false, ...(beforeSubmit ? { beforeSubmit } : {}) });
    return { refreshFailedProviders: [] };
  }

  /** Empty edits refresh this instance without copying or rewriting Hook state. */
  async refreshHookConfig(): Promise<void> {
    await this.rpc.request({
      method: "config/batchWrite",
      params: { edits: [], reloadUserConfig: true },
    }, { retryOverload: false });
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
        // 用户显式派生是新的交互会话，不继承父会话的功能来源。
        threadSource: "user",
        ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
        ...(options.approvalsReviewer === undefined ? {} : { approvalsReviewer: options.approvalsReviewer }),
        ...(options.permissions !== undefined
          ? { permissions: options.permissions }
          : options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
        ...(options.model ? { model: options.model } : {}),
        ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
      },
    }, { retryOverload: false, ...(options.beforeSubmit ? { beforeSubmit: options.beforeSubmit } : {}) });
    return toThreadSession(response);
  }

  async startReview(threadId: string, target: ReviewTarget, beforeSubmit?: () => void, requestAttempted?: () => undefined): Promise<ReviewStarted> {
    const response = await this.rpc.request<ReviewStartResponse>({
      method: "review/start",
      params: { threadId, target: toProtocolReviewTarget(target), delivery: "inline" },
    }, { retryOverload: false, beforeSubmit: () => {
      beforeSubmit?.();
      requireSynchronousAttempt(requestAttempted);
      if (requestAttempted) beforeSubmit?.();
      this.observedTurns.delete(threadId);
    } });
    const result = toReviewStarted(response);
    if (result.threadId !== threadId || !result.turnId.trim()) throw new Error("Inline Review 响应与请求会话不一致或缺少有效 Turn");
    return result;
  }

  async listSkills(cwd: string, beforeSubmit?: () => void): Promise<InstalledSkill[]> {
    const response = await this.readSkills(cwd, beforeSubmit);
    return toInstalledSkills(response, cwd);
  }

  async resolveSkill(
    cwd: string,
    name: string,
    beforeSubmit?: () => void,
  ): Promise<InvocableSkill | undefined> {
    return resolveInvocableSkill(await this.readSkills(cwd, beforeSubmit), cwd, name);
  }

  async listMcpServers(threadId?: string, signal?: AbortSignal, beforeSubmit?: () => void): Promise<McpServerSummary[]> {
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
        }, { retryOverload: true, ...(signal ? { signal } : {}), ...(beforeSubmit ? { beforeSubmit } : {}) });
      const page = toMcpServerSummaryPage(response);
      servers.push(...page.servers);
      cursor = page.nextCursor;
      rememberCursor("mcpServerStatus/list", cursor, cursors);
    } while (cursor);
    return servers;
  }

  async listMcpServerDetails(threadId?: string, beforeSubmit?: () => void): Promise<McpServerDetail[]> {
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
      }, { retryOverload: true, ...(beforeSubmit ? { beforeSubmit } : {}) });
      const page = toMcpServerDetailPage(response);
      servers.push(...page.servers);
      cursor = page.nextCursor;
      rememberCursor("mcpServerStatus/list", cursor, cursors);
    } while (cursor);
    return servers;
  }

  async reloadMcpServers(signal?: AbortSignal, beforeSubmit?: () => void): Promise<void> {
    await this.rpc.request<Record<string, never>>({
      method: "config/mcpServer/reload",
      params: undefined,
    }, { retryOverload: false, ...(signal ? { signal } : {}), ...(beforeSubmit ? { beforeSubmit } : {}) });
  }

  async startMcpOAuthLogin(
    name: string,
    threadId?: string,
    beforeSubmit?: () => void,
  ): Promise<McpOAuthLogin> {
    const response = await this.rpc.request<McpServerOauthLoginResponse>({
      method: "mcpServer/oauth/login",
      params: { name, ...(threadId ? { threadId } : {}) },
    }, { retryOverload: false, ...(beforeSubmit ? { beforeSubmit } : {}) });
    return toMcpOAuthLogin(name, response);
  }

  async readMcpResource(
    server: string,
    uri: string,
    threadId?: string,
    beforeSubmit?: () => void,
  ): Promise<McpResourceReadResult> {
    const response = await this.rpc.request<McpResourceReadResponse>({
      method: "mcpServer/resource/read",
      params: { server, uri, ...(threadId ? { threadId } : {}) },
    }, { retryOverload: true, ...(beforeSubmit ? { beforeSubmit } : {}) });
    return toMcpResourceReadResult(server, uri, response);
  }

  async listPlugins(cwd: string, _modelProvider: string, beforeSubmit?: () => void): Promise<InstalledPluginCatalog> {
    return toInstalledPlugins(await this.readInstalledPlugins(cwd, beforeSubmit));
  }

  async resolvePlugin(
    cwd: string,
    id: string,
    _modelProvider: string,
    beforeSubmit?: () => void,
  ): Promise<InvocablePlugin | undefined> {
    return resolveInvocablePlugin(await this.readInstalledPlugins(cwd, beforeSubmit), id);
  }

  private readInstalledPlugins(cwd: string, beforeSubmit?: () => void): Promise<PluginInstalledResponse> {
    return this.rpc.request<PluginInstalledResponse>({
      method: "plugin/installed",
      params: { cwds: [cwd] },
    }, { retryOverload: true, ...(beforeSubmit ? { beforeSubmit } : {}) });
  }

  private readSkills(cwd: string, beforeSubmit?: () => void): Promise<SkillsListResponse> {
    return this.rpc.request<SkillsListResponse>({
      method: "skills/list",
      params: { cwds: [cwd], forceReload: false },
    }, { retryOverload: true, ...(beforeSubmit ? { beforeSubmit } : {}) });
  }

  async accountUsage(beforeSubmit?: () => void): Promise<AccountUsage> {
    const response = await this.rpc.request<GetAccountTokenUsageResponse>({
      method: "account/usage/read",
      params: undefined,
    }, { retryOverload: true, ...(beforeSubmit ? { beforeSubmit } : {}) });
    return toAccountUsage(response);
  }

  async openAiAccountRoute(signal?: AbortSignal, beforeSubmit?: () => void): Promise<OpenAiAccountRoute> {
    const response = await this.rpc.request<GetAccountResponse>({
      method: "account/read",
      params: { refreshToken: false } satisfies GetAccountParams,
    }, { retryOverload: true, ...(signal ? { signal } : {}), ...(beforeSubmit ? { beforeSubmit } : {}) });
    return toOpenAiAccountRoute(response);
  }

  async accountThreadUsage(threadId: string, beforeSubmit?: () => void): Promise<AccountThreadUsage> {
    if (threadId.length === 0) {
      throw new Error("Codex Thread 用量查询缺少 threadId");
    }
    const response = await this.rpc.request<GetAccountTokenUsageResponse>({
      method: "account/usage/read",
      params: { threadId } satisfies GetAccountTokenUsageParams,
    }, { retryOverload: true, ...(beforeSubmit ? { beforeSubmit } : {}) });
    return toAccountThreadUsage(response, threadId);
  }

  async accountRateLimits(
    options: { background?: boolean; signal?: AbortSignal; beforeSubmit?: () => void } = {},
  ): Promise<AccountRateLimits> {
    const params = {
      ...(options.background ? { excludeResetCreditDetails: true } : {}),
    } satisfies GetAccountRateLimitsParams;
    const response = await this.rpc.request<GetAccountRateLimitsResponse>({
      method: "account/rateLimits/read",
      params,
    }, { retryOverload: true, ...(options.signal ? { signal: options.signal } : {}), ...(options.beforeSubmit ? { beforeSubmit: options.beforeSubmit } : {}) });
    return toAccountRateLimits(response);
  }

  async readResetCredits(signal?: AbortSignal, beforeSubmit?: () => void): Promise<OpenAiResetCreditSnapshot> {
    if (await this.openAiAccountRoute(signal, beforeSubmit) !== "chatgpt") throw new Error("ChatGPT account required");
    const response = await this.rpc.request<GetAccountRateLimitsResponse>({
      method: "account/rateLimits/read", params: { excludeResetCreditDetails: false },
    }, { retryOverload: true, ...(signal ? { signal } : {}), ...(beforeSubmit ? { beforeSubmit } : {}) });
    const summary = response.rateLimitResetCredits;
    if (typeof response.accountId !== "string" || !response.accountId || !summary
      || !((typeof summary.availableCount === "bigint" && summary.availableCount >= 0n)
        || (typeof summary.availableCount === "number" && Number.isSafeInteger(summary.availableCount) && summary.availableCount >= 0))
      || !Array.isArray(summary.credits)) throw new Error("Reset credit details unavailable");
    const credits = summary.credits.filter(credit => credit.status === "available" && credit.resetType === "codexRateLimits");
    if (credits.length > 128 || response.accountId.length > 256) throw new Error("Reset credit response too large");
    return { accountId: response.accountId, availableCount: String(summary.availableCount),
      credits: credits.map(credit => {
        if (typeof credit.id !== "string" || !credit.id || credit.id.length > 256 || /[\0\r\n]/u.test(credit.id)
          || (credit.title !== null && (typeof credit.title !== "string" || credit.title.length > 256))
          || (credit.description !== null && (typeof credit.description !== "string" || credit.description.length > 2048))
          || (credit.expiresAt !== null && (!Number.isSafeInteger(credit.expiresAt) || credit.expiresAt < 0 || credit.expiresAt > 8_640_000_000_000))) throw new Error("Invalid reset credit");
        return { id: credit.id, expiresAt: credit.expiresAt, title: credit.title, description: credit.description };
      }).sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity)) };
  }

  async consumeResetCredit(creditId: string, idempotencyKey: string, signal?: AbortSignal, beforeSubmit?: () => void): Promise<ResetCreditOutcome> {
    const response = await this.rpc.request<ConsumeAccountRateLimitResetCreditResponse>({
      method: "account/rateLimitResetCredit/consume",
      params: { creditId, idempotencyKey } satisfies ConsumeAccountRateLimitResetCreditParams,
    }, { retryOverload: false, ...(signal ? { signal } : {}), ...(beforeSubmit ? { beforeSubmit } : {}) });
    if (!["reset", "nothingToReset", "noCredit", "alreadyRedeemed"].includes(response.outcome)) throw new Error("Invalid reset outcome");
    return response.outcome;
  }

  async updateThreadApprovalsReviewer(threadId: string, reviewer: "user" | "auto_review", beforeSubmit?: () => void): Promise<void> {
    beforeSubmit?.();
    await this.confirmThreadSettings(
      threadId,
      settings => settings.approvalsReviewer === reviewer,
      signal => {
        beforeSubmit?.();
        return this.rpc.request<ThreadSettingsUpdateResponse>({
        method: "thread/settings/update",
        params: { threadId, approvalsReviewer: reviewer } satisfies ThreadSettingsUpdateParams,
        }, { retryOverload: false, signal });
      },
      () => new UserFacingError("autoreview.update-unconfirmed", "会话审批方式更新结果尚未确认，请重新查询状态"),
      () => new UserFacingError("autoreview.update-failed", "会话审批方式更新失败，请重新查询状态"),
    );
  }

  private async confirmThreadSettings(
    threadId: string,
    matches: (settings: ThreadModelSettings) => boolean,
    submit: (signal: AbortSignal) => Promise<unknown>,
    unconfirmed: () => Error,
    failed: () => Error,
  ): Promise<void> {
    const controller = new AbortController();
    let acknowledged = false;
    let observed = false;
    let settled = false;
    let removeNotification = () => {};
    let removeDisconnect = () => {};
    let timer: NodeJS.Timeout | undefined;
    let cancel = () => {};
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        removeNotification();
        removeDisconnect();
        this.pendingSettingsUpdates.delete(cancel);
        if (error) { controller.abort(error); reject(error); }
        else resolve();
      };
      cancel = () => finish(unconfirmed());
      this.pendingSettingsUpdates.add(cancel);
      removeNotification = this.rpc.onNotification(notification => {
        const event = toThreadStateEvent(notification);
        if (!event || event.threadId !== threadId) return;
        if (event.type === "thread.closed" || event.type === "thread.archived" || event.type === "thread.deleted") {
          cancel();
          return;
        }
        if (event.type !== "thread.settings.updated") return;
        observed = matches(event.settings);
        if (acknowledged && observed) finish();
      });
      removeDisconnect = this.rpc.onDisconnect(cancel);
      timer = setTimeout(cancel, 10_000);
      // A local submission guard can throw before the RPC is sent. Clean up
      // subscriptions and the timeout in that case as well.
      let submitted: Promise<unknown>;
      try {
        submitted = submit(controller.signal);
      } catch (error) {
        finish(error instanceof Error ? error : unconfirmed());
        return;
      }
      void submitted.then(() => {
        acknowledged = true;
        if (observed) finish();
      }, error => finish(error instanceof JsonRpcError
        ? failed()
        : unconfirmed()));
    });
  }

  async listPermissionProfiles(cwd: string, beforeSubmit?: () => void): Promise<PermissionProfileOption[]> {
    const profiles: PermissionProfileOption[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const response: PermissionProfileListResponse =
        await this.rpc.request<PermissionProfileListResponse>({
          method: "permissionProfile/list",
          params: { cwd, limit: 100, ...(cursor ? { cursor } : {}) },
        }, { retryOverload: true, ...(beforeSubmit ? { beforeSubmit } : {}) });
      const page = toPermissionProfilePage(response);
      profiles.push(...page.profiles);
      cursor = page.nextCursor;
      rememberCursor("permissionProfile/list", cursor, cursors);
    } while (cursor);
    return profiles;
  }
}

function requireSynchronousAttempt(callback?: () => undefined): void {
  if (!callback) return;
  const result: unknown = callback();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => undefined);
    throw new Error("提交请求观察必须同步返回 undefined");
  }
}

function toProtocolDynamicTool(spec: ThreadDynamicToolSpec): ProtocolDynamicToolSpec {
  return {
    type: "function",
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema as JsonValue,
    ...(spec.deferLoading === true ? { deferLoading: true } : {}),
  };
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
