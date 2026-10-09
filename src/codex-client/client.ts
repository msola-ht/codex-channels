import { lunaReserveModel } from "../application/index.js";
import type { ApprovalRequest } from "../approval/index.js";
import { FileChangeApprovalContext } from "./file-change-approval-context.js";
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
  ThreadQueueItem,
  ThreadQueueListOptions,
  ThreadQueuePage,
  ThreadHistoryPort,
  ThreadTurnsListOptions,
  ThreadTurnsPage,
  ThreadRevertResult,
  LunaReservePort,
  LunaReserveThreadSettings,
  ThreadApprovalsReviewerPort,
} from "../application/index.js";
import type {
  ConsumeAccountRateLimitResetCreditParams,
  ConsumeAccountRateLimitResetCreditResponse,
  ConfigReadParams,
  ConfigReadResponse,
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
  ThreadArchiveResponse,
  ThreadDeleteResponse,
  ThreadForkResponse,
  ThreadGoalGetResponse,
  ThreadGoalSetResponse,
  ThreadListResponse,
  ThreadListParams,
  ThreadLoadedListResponse,
  ThreadMetadataUpdateResponse,
  ThreadReadResponse,
  ThreadSettingsUpdateParams,
  ThreadSettingsUpdateResponse,
  ThreadQueueAddResponse,
  ThreadQueueAddParams,
  ThreadQueueDeleteResponse,
  ThreadQueueDeleteParams,
  ThreadQueueListResponse,
  ThreadQueueListParams,
  ThreadQueueReorderResponse,
  ThreadQueueReorderParams,
  ThreadQueueStartResponse,
  ThreadQueueStartParams,
  ThreadQueueUpdateResponse,
  ThreadQueueUpdateParams,
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
} from "../session-routing/index.js";
import { JsonRpcClient, JsonRpcError, type RpcNotification, type ServerRequestHandler } from "./json-rpc.js";
import { UserFacingError } from "../conversation-core/index.js";
import { ImageReferenceUpload } from "./image-reference-upload.js";
import { toThreadStateEvent } from "./notification-adapter.js";
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
  toThreadGoal,
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
import {
  toProtocolQueueText,
  toThreadQueueAddResult,
  toThreadQueueDeleteResult,
  toThreadQueuePage,
  toThreadQueueStartResult,
  toThreadQueueUpdateResult,
} from "./queue-adapter.js";
import {
  toThreadRevertResult,
  toThreadTurnsPage,
} from "./history-adapter.js";

export interface ThreadDefaults {
  model?: string;
  sandbox: "read-only" | "workspace-write";
}

export class CodexAppServerClient implements
  ThreadLifecyclePort,
  TurnExecutionPort,
  ModelSelectionPort,
  AccountQueryPort,
  LunaReservePort,
  CollaborationModeQueryPort,
  SkillQueryPort,
  McpQueryPort,
  PluginQueryPort,
  PermissionQueryPort,
  ThreadQueuePort,
  ThreadHistoryPort,
  ThreadApprovalsReviewerPort
{
  private readonly imageUpload: ImageReferenceUpload | undefined;
  private readonly fileChanges = new FileChangeApprovalContext();
  private readonly pendingReviewerUpdates = new Set<() => void>();

  constructor(
    private readonly rpc: JsonRpcClient,
    private readonly defaults: ThreadDefaults,
    imageUploadHttp?: { upload: typeof fetch; local?: typeof fetch },
  ) {
    this.rpc.onNotification(notification => this.fileChanges.observe(notification));
    this.rpc.onDisconnect(() => this.fileChanges.clear());
    this.imageUpload = imageUploadHttp ? new ImageReferenceUpload(rpc, imageUploadHttp.upload, imageUploadHttp.local ?? fetch,
      signal => this.rpc.request<GetAuthStatusResponse>({
        method: "getAuthStatus",
        params: { includeToken: true, refreshToken: false },
      }, { retryOverload: false, signal })) : undefined;
  }

  connect(): Promise<InitializeResponse> {
    return this.rpc.connect();
  }

  reconnect(): Promise<InitializeResponse> {
    for (const cancel of this.pendingReviewerUpdates) cancel();
    this.fileChanges.clear();
    return this.rpc.reconnect();
  }

  close(): Promise<void> {
    for (const cancel of this.pendingReviewerUpdates) cancel();
    this.fileChanges.clear();
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
    });
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

  private async listThreadPages(params: ThreadListParams): Promise<ThreadSnapshot[]> {
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

  async readThread(threadId: string, signal?: AbortSignal): Promise<ThreadSnapshot> {
    const result = await this.rpc.request<ThreadReadResponse>({
      method: "thread/read",
      params: { threadId, includeTurns: false },
    }, { retryOverload: true, ...(signal ? { signal } : {}) });
    return toThreadSnapshot(result.thread);
  }

  async startThread(cwd: string, options: ThreadStartOptions = {}): Promise<ThreadSession> {
    const response = await this.rpc.request<ThreadStartResponse>({
      method: "thread/start",
      params: {
        cwd,
        historyMode: "paginated",
        approvalPolicy: options.approvalPolicy ?? "on-request",
        ...(options.approvalsReviewer === undefined ? {} : { approvalsReviewer: options.approvalsReviewer }),
        ...(options.permissions !== undefined
          ? { permissions: options.permissions }
          : { sandbox: options.sandbox ?? this.defaults.sandbox }),
        ...(options.model
          ? { model: options.model }
          : this.defaults.model ? { model: this.defaults.model } : {}),
        ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
        ...(options.threadSource === "automation"
          ? { threadSource: options.threadSource }
          : {}),
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
    }, { retryOverload: true });
    const page = toThreadTurnsPage(response);
    if (page.turns.length > limit) {
      throw new Error("Codex Turn 列表响应超过请求页大小");
    }
    return page;
  }

  async revertThread(threadId: string, beforeTurnId: string): Promise<ThreadRevertResult> {
    const response = await this.rpc.request<ThreadRevertResponse>({
      method: "thread/revert",
      params: { threadId, beforeTurnId } satisfies ThreadRevertParams,
    }, { retryOverload: false });
    return toThreadRevertResult(response);
  }

  async resumeThread(
    threadId: string,
    cwd: string,
    options: ThreadStartOptions = {},
  ): Promise<ThreadResumeSession> {
    const settings = {
      cwd,
      approvalPolicy: options.approvalPolicy ?? "on-request",
      ...(options.approvalsReviewer === undefined ? {} : { approvalsReviewer: options.approvalsReviewer }),
      ...(options.permissions !== undefined
        ? { permissions: options.permissions }
        : { sandbox: options.sandbox ?? this.defaults.sandbox }),
    };
    const response = await this.rpc.request<ThreadResumeResponse>({
      method: "thread/resume",
      params: {
        threadId,
        ...settings,
      },
    }, { retryOverload: false });
    return toThreadResumeSession(response, settings);
  }

  async unsubscribeThread(threadId: string): Promise<void> {
    this.fileChanges.clearThread(threadId);
    this.cancelPendingInput(threadId);
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
    return this.submitTurnInput(threadId, input, async (protocolInput) => {
      const response = await this.rpc.request<TurnStartResponse>({
        method: "turn/start",
        params: {
          threadId,
          clientUserMessageId,
          input: protocolInput,
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
    });
  }

  async addQueueItem(
    threadId: string,
    text: string,
    clientUserMessageId: string,
  ): Promise<ThreadQueueItem> {
    const response = await this.rpc.request<ThreadQueueAddResponse>({
      method: "thread/queue/add",
      params: {
        threadId,
        input: toProtocolQueueText(text),
        clientUserMessageId,
      } satisfies ThreadQueueAddParams,
    }, { retryOverload: false });
    return toThreadQueueAddResult(response);
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
    }, { retryOverload: true });
    const page = toThreadQueuePage(response);
    if (page.items.length > limit) {
      throw new Error("Codex Queue 列表响应超过请求页大小");
    }
    return page;
  }

  async updateQueueItem(
    threadId: string,
    queuedSubmissionId: string,
    text: string,
  ): Promise<ThreadQueueItem> {
    const response = await this.rpc.request<ThreadQueueUpdateResponse>({
      method: "thread/queue/update",
      params: {
        threadId,
        queuedSubmissionId,
        input: toProtocolQueueText(text),
      } satisfies ThreadQueueUpdateParams,
    }, { retryOverload: false });
    return toThreadQueueUpdateResult(response);
  }

  async deleteQueueItem(
    threadId: string,
    queuedSubmissionId: string,
  ): Promise<{ deleted: boolean }> {
    const response = await this.rpc.request<ThreadQueueDeleteResponse>({
      method: "thread/queue/delete",
      params: { threadId, queuedSubmissionId } satisfies ThreadQueueDeleteParams,
    }, { retryOverload: false });
    return toThreadQueueDeleteResult(response);
  }

  async reorderQueue(threadId: string, queuedSubmissionIds: string[]): Promise<void> {
    await this.rpc.request<ThreadQueueReorderResponse>({
      method: "thread/queue/reorder",
      params: { threadId, queuedSubmissionIds } satisfies ThreadQueueReorderParams,
    }, { retryOverload: false });
  }

  async startQueueItem(
    threadId: string,
    queuedSubmissionId?: string,
  ): Promise<{ turnId: string }> {
    const response = await this.rpc.request<ThreadQueueStartResponse>({
      method: "thread/queue/start",
      params: {
        threadId,
        ...(queuedSubmissionId === undefined ? {} : { queuedSubmissionId }),
      } satisfies ThreadQueueStartParams,
    }, { retryOverload: false });
    return toThreadQueueStartResult(response);
  }

  async steerTurn(
    threadId: string,
    turnId: string,
    input: TurnInput[],
    clientUserMessageId: string,
  ): Promise<TurnStarted> {
    return this.submitTurnInput(threadId, input, async (protocolInput) => {
      const response = await this.rpc.request<TurnSteerResponse>({
        method: "turn/steer",
        params: {
          threadId,
          expectedTurnId: turnId,
          clientUserMessageId,
          input: protocolInput,
        },
      }, { retryOverload: false });
      return toTurnStarted(response);
    });
  }

  cancelPendingInput(threadId: string): boolean {
    return this.imageUpload?.cancel(threadId) ?? false;
  }

  private async submitTurnInput(
    threadId: string,
    input: TurnInput[],
    submit: (input: ReturnType<typeof toProtocolTurnInput>) => Promise<TurnStarted>,
  ): Promise<TurnStarted> {
    const protocolInput = toProtocolTurnInput(input);
    if (!this.imageUpload || !input.some(item => item.type === "image")) return submit(protocolInput);
    return this.imageUpload.submit(threadId, protocolInput, submit);
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.cancelPendingInput(threadId);
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
    return this.listModelCatalog(false);
  }

  async lunaReserveModel(): Promise<ModelOption | null> {
    const models = await this.listModelCatalog(true, true);
    return models.find((model) => model.model === lunaReserveModel) ?? null;
  }

  private async listModelCatalog(
    includeHidden: boolean,
    hiddenOnly = false,
  ): Promise<ModelOption[]> {
    const models: ModelOption[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const result: ModelListResponse = await this.rpc.request<ModelListResponse>({
        method: "model/list",
        params: { limit: 100, includeHidden, ...(cursor ? { cursor } : {}) },
      }, { retryOverload: true });
      for (const model of result.data) {
        const mapped = toModelOption(model, includeHidden);
        if (mapped && (!hiddenOnly || model.hidden)) {
          models.push(mapped);
        }
      }
      cursor = result.nextCursor;
      rememberCursor("model/list", cursor, cursors);
    } while (cursor);
    return models;
  }

  async writeDefaultServiceTier(tier: "fast" | "ultrafast" | "default"): Promise<void> {
    await this.writeUserConfigEdits([{
      keyPath: "service_tier",
      value: tier,
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

  async readDefaultReasoningEffort(cwd: string): Promise<string | null> {
    const params: ConfigReadParams = { cwd, includeLayers: false };
    const response = await this.rpc.request<ConfigReadResponse>({
      method: "config/read",
      params,
    }, { retryOverload: true });
    const effort = response.config.model_reasoning_effort;
    if (effort !== null && (typeof effort !== "string" || effort.trim() === "")) {
      throw new Error("Codex 响应缺少有效 config model_reasoning_effort");
    }
    return effort;
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

  async readUserConfigSnapshot(options: { includeApprovalsReviewerPolicy?: boolean } = {}): Promise<{
    config: Record<string, JsonValue | undefined>;
    version: string;
    toolConfig: Record<string, JsonValue | undefined>;
    approvalsReviewerPolicy?: { allowedReviewers: string[] | null; autoReviewDisabled: boolean };
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
    let approvalsReviewerPolicy;
    if (options.includeApprovalsReviewerPolicy) {
      try {
        const { requirements } = await this.rpc.request<ConfigRequirementsReadResponse>({
          method: "configRequirements/read",
          params: undefined,
        }, { retryOverload: true });
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
      } catch {
        // The optional policy is unavailable; retain the valid user snapshot.
        // Settings projection exposes this as read-only and rejects writes.
        approvalsReviewerPolicy = undefined;
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
        approvalPolicy: options.approvalPolicy ?? "on-request",
        ...(options.approvalsReviewer === undefined ? {} : { approvalsReviewer: options.approvalsReviewer }),
        ...(options.permissions !== undefined
          ? { permissions: options.permissions }
          : { sandbox: options.sandbox ?? this.defaults.sandbox }),
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

  async listMcpServers(threadId?: string, signal?: AbortSignal): Promise<McpServerSummary[]> {
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
        }, { retryOverload: true, ...(signal ? { signal } : {}) });
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

  async reloadMcpServers(signal?: AbortSignal): Promise<void> {
    await this.rpc.request<Record<string, never>>({
      method: "config/mcpServer/reload",
      params: undefined,
    }, { retryOverload: false, ...(signal ? { signal } : {}) });
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

  async openAiAccountRoute(signal?: AbortSignal): Promise<OpenAiAccountRoute> {
    const response = await this.rpc.request<GetAccountResponse>({
      method: "account/read",
      params: { refreshToken: false } satisfies GetAccountParams,
    }, signal === undefined
      ? { retryOverload: true }
      : { retryOverload: true, signal });
    return toOpenAiAccountRoute(response);
  }

  async accountThreadUsage(threadId: string): Promise<AccountThreadUsage> {
    if (threadId.length === 0) {
      throw new Error("Codex Thread 用量查询缺少 threadId");
    }
    const response = await this.rpc.request<GetAccountTokenUsageResponse>({
      method: "account/usage/read",
      params: { threadId } satisfies GetAccountTokenUsageParams,
    }, { retryOverload: true });
    return toAccountThreadUsage(response, threadId);
  }

  async accountRateLimits(
    options: { background?: boolean; signal?: AbortSignal } = {},
  ): Promise<AccountRateLimits> {
    const params = {
      supportsLunaReserve: true,
      ...(options.background ? { excludeResetCreditDetails: true } : {}),
    } satisfies GetAccountRateLimitsParams;
    const response = await this.rpc.request<GetAccountRateLimitsResponse>({
      method: "account/rateLimits/read",
      params,
    }, { retryOverload: true, ...(options.signal ? { signal: options.signal } : {}) });
    return toAccountRateLimits(response);
  }

  async readResetCredits(signal?: AbortSignal): Promise<OpenAiResetCreditSnapshot> {
    if (await this.openAiAccountRoute(signal) !== "chatgpt") throw new Error("ChatGPT account required");
    const response = await this.rpc.request<GetAccountRateLimitsResponse>({
      method: "account/rateLimits/read", params: { supportsLunaReserve: true, excludeResetCreditDetails: false },
    }, { retryOverload: true, ...(signal ? { signal } : {}) });
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

  async consumeResetCredit(creditId: string, idempotencyKey: string, signal?: AbortSignal): Promise<ResetCreditOutcome> {
    const response = await this.rpc.request<ConsumeAccountRateLimitResetCreditResponse>({
      method: "account/rateLimitResetCredit/consume",
      params: { creditId, idempotencyKey } satisfies ConsumeAccountRateLimitResetCreditParams,
    }, { retryOverload: false, ...(signal ? { signal } : {}) });
    if (!["reset", "nothingToReset", "noCredit", "alreadyRedeemed"].includes(response.outcome)) throw new Error("Invalid reset outcome");
    return response.outcome;
  }

  async updateLunaReserveThreadSettings(
    threadId: string,
    settings: LunaReserveThreadSettings,
  ): Promise<void> {
    await this.rpc.request({
      method: "thread/settings/update",
      params: {
        threadId,
        model: settings.model,
        effort: settings.effort,
        serviceTier: settings.serviceTier,
        collaborationMode: {
          mode: settings.collaborationMode,
          settings: {
            model: settings.model,
            reasoning_effort: settings.effort,
            developer_instructions: null,
          },
        },
      },
    }, { retryOverload: false });
  }

  async updateThreadApprovalsReviewer(threadId: string, reviewer: "user" | "auto_review"): Promise<void> {
    const controller = new AbortController();
    let acknowledged = false;
    let observed = false;
    let settled = false;
    let removeNotification = () => {};
    let removeDisconnect = () => {};
    let timer: NodeJS.Timeout | undefined;
    let cancel = () => {};
    const unconfirmed = () => new UserFacingError("autoreview.update-unconfirmed", "会话审批方式更新结果尚未确认，请重新查询状态");
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        removeNotification();
        removeDisconnect();
        this.pendingReviewerUpdates.delete(cancel);
        if (error) { controller.abort(error); reject(error); }
        else resolve();
      };
      cancel = () => finish(unconfirmed());
      this.pendingReviewerUpdates.add(cancel);
      removeNotification = this.rpc.onNotification(notification => {
        const event = toThreadStateEvent(notification);
        if (!event || event.threadId !== threadId) return;
        if (event.type === "thread.closed" || event.type === "thread.archived" || event.type === "thread.deleted") {
          cancel();
          return;
        }
        if (event.type !== "thread.settings.updated") return;
        observed = event.settings.approvalsReviewer === reviewer;
        if (acknowledged && observed) finish();
      });
      removeDisconnect = this.rpc.onDisconnect(cancel);
      timer = setTimeout(cancel, 10_000);
      void this.rpc.request<ThreadSettingsUpdateResponse>({
        method: "thread/settings/update",
        params: { threadId, approvalsReviewer: reviewer } satisfies ThreadSettingsUpdateParams,
      }, { retryOverload: false, signal: controller.signal }).then(() => {
        acknowledged = true;
        if (observed) finish();
      }, error => finish(error instanceof JsonRpcError
        ? new UserFacingError("autoreview.update-failed", "会话审批方式更新失败，请重新查询状态")
        : unconfirmed()));
    });
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
