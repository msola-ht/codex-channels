import { randomUUID } from "node:crypto";
import { ConversationHookService } from "./conversation-hook-service.js";
import type { HookConfigPort, HookCommandView, HookReviewPolicy } from "./hook-port.js";
import { isAbsolute } from "node:path";

import {
  type RequestMetricsQueryPort,
  type RequestMetricsCommandQuery,
  type RequestMetricsResult,
  type TurnErrorPhase,
  type TurnErrorRecorder,
} from "./request-metrics-port.js";
import type {
  AccountQueryPort,
  AccountRateLimits,
  AccountUsage,
  ProviderAccountLimits,
  ProviderAccountQueryPort,
  ProviderAccountUsage,
} from "./account-port.js";
import type { InstalledSkill } from "./skill-port.js";
import type {
  McpLoginResult,
  McpHealthReport,
  McpResourceReadResult,
  McpServerDetail,
  McpServerSummary,
} from "./mcp-port.js";
import type {
  InstalledPlugin,
  InstalledPluginCatalog,
  PluginHealthReport,
} from "./plugin-port.js";
import type {
  PermissionProfileOption,
} from "./permission-port.js";
import type {
  SessionRouter,
} from "../session-routing/index.js";
import type {
  ThreadOccupancyPort,
  ThreadOccupancyReleaseResult,
} from "./thread-occupancy-port.js";
import type { Workspace } from "../policy/index.js";
import {
  ConversationCore,
  UserFacingError,
  conversationTargetKey,
  gatewayUserMessageClientIdPrefix,
  usesOpenAiAccount,
  type ConversationTarget,
  type RateLimitSnapshot,
  type SurfaceId,
  type ThreadGoal,
  type ThreadApprovalsReviewer,
  type ThreadTokenUsage,
  type TurnStartIdentity,
  type TurnArtifacts,
} from "../conversation-core/index.js";
import type {
  ModelSelectionPreference,
  ModelSelectionIdentity,
  ModelSelectionService,
  ModelSelectionState,
} from "./model-selection-service.js";
import type {
  ReviewTarget,
  TurnExecutionPort,
  ThreadApprovalsReviewerPort,
  TurnInput,
} from "./turn-port.js";
import type {
  ThreadQueueItem,
  ThreadQueuePort,
} from "./thread-queue-port.js";
import type {
  ThreadHistoryPort,
  ThreadRevertListResult,
  ThreadRevertPreview,
} from "./thread-history-port.js";
import type {
  CollaborationModeSelectionService,
  CollaborationModeState,
} from "./collaboration-mode-service.js";
import { ConversationLockCoordinator } from "./conversation-lock-coordinator.js";
import {
  ThreadQueueService,
  queueUserFacingError,
  type ThreadQueueListResult,
  type ThreadQueueReorderResult,
} from "./thread-queue-service.js";
import { ThreadRevertService } from "./thread-revert-service.js";
import type { SessionDisplayCachePort } from "../conversation-core/index.js";
import {
  LunaReserveService,
  type LunaReserveServiceOptions,
} from "./luna-reserve-service.js";
import { ConversationAccountMetricsService } from "./conversation-account-metrics-service.js";
import {
  ConversationExtensionQueryService,
  type ConversationExtensionQueryPort,
} from "./conversation-extension-query-service.js";

import {
  ConversationSessionQueryService,
  pinnedFirst,
  resolveThread,
  type ConversationSession,
  type ConversationSessionQuery,
  type SessionDisplayCacheOperation,
} from "./conversation-session-query-service.js";
import { turnErrorCode, turnErrorMessage, turnErrorType } from "./turn-errors.js";

export type { ConversationSession, ConversationSessionQuery } from "./conversation-session-query-service.js";
export type {
  ThreadQueueListResult,
  ThreadQueueReorderResult,
} from "./thread-queue-service.js";

export interface Submission {
  threadId: string;
  turnId: string;
  steered: boolean;
}

export interface ConversationInput {
  text?: string;
  images?: ReadonlyArray<{ url: string }>;
  localAudios?: ReadonlyArray<{ path: string }>;
}

export interface WorkspaceStatusPort {
  currentGitBranch(projectRoot: string, signal?: AbortSignal): Promise<string | undefined>;
}

export interface ConversationTransferPort {
  hasPendingInteraction(threadId: string): boolean;
  notifyTransferred(event: {
    previousTarget: ConversationTarget;
    nextTarget: ConversationTarget;
    threadId: string;
  }): void;
}

export interface ConversationResumeResult {
  threadId: string;
  backgroundedThreadId?: string;
  transferredFrom?: SurfaceId;
  queuePending?: boolean;
}

export type ConversationIdleReleaseResult =
  | { status: "unbound" }
  | { status: "busy"; threadId: string }
  | { status: "released"; threadId: string };

export interface ConversationIdleReleaseCondition {
  threadId: string;
  lastActivityAt: number;
  signal: AbortSignal;
  isCurrent(): boolean;
  canRestore(): boolean;
  restoreRequired?(): void;
}

export type ConversationQueryPort =
  & AccountQueryPort
  & HookConfigPort
  & ConversationExtensionQueryPort;

export interface AgentRoleEntry {
  name: string;
  description: string | null;
}

export interface AgentRolePort {
  listAgentRoles(): AgentRoleEntry[];
}

const builtInAgentRoles: AgentRoleEntry[] = [
  { name: "default", description: "默认角色，继承当前模型与配置" },
  { name: "explorer", description: "代码库探查：快速回答具体的代码库问题" },
  { name: "worker", description: "执行与实现：完成归属明确的实现、修复或测试任务" },
];

export interface ConversationStatus {
  threadId?: string;
  threadName?: string | null;
  turnId?: string;
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  gitBranch?: string;
  model: string;
  modelProvider?: string;
  effort: string | null;
  serviceTier: string | null;
  approvalsReviewer?: ThreadApprovalsReviewer | null;
  modelPending: boolean;
  effortPending: boolean;
  fastModePending: boolean;
  collaborationMode: "default" | "plan";
  collaborationModePending: boolean;
  goal?: ThreadGoal;
  contextCompactionCount?: number;
  tokenUsage?: ThreadTokenUsage;
  weeklyLimit?: NonNullable<RateLimitSnapshot["secondary"]>;
}

export interface ConversationAutoReviewState {
  threadId: string | null;
  reviewer: ThreadApprovalsReviewer | null;
  updated: boolean;
}

/** Stable Turn and user-input lifecycle boundary. */
export interface PreparedAttachmentSubmission {
  readonly signal: AbortSignal;
  readonly mayHaveSubmitted: boolean;
  captureTarget(): void;
  submit(value: string | ConversationInput): Promise<Submission>;
  dispose(): void;
}

export interface ConversationTurnUseCases {
  touchActivity?(target: ConversationTarget): void;
  prepareAttachmentSubmission?(target: ConversationTarget, isAllowed: () => boolean, kind?: "video" | "audio"): PreparedAttachmentSubmission;
  submit(target: ConversationTarget, value: string | ConversationInput, isAllowed?: () => boolean): Promise<Submission>;
  stop(target: ConversationTarget): Promise<boolean>;
  rename(target: ConversationTarget, name: string): Promise<void>;
  setPinned(target: ConversationTarget, pinned: boolean): Promise<boolean>;
  compact(target: ConversationTarget): Promise<void>;
  fork(target: ConversationTarget, assertAuthorized?: () => void): Promise<string>;
  togglePlanMode(target: ConversationTarget): Promise<CollaborationModeState>;
  startPlan(target: ConversationTarget, prompt: string): Promise<Submission>;
  review(target: ConversationTarget, reviewTarget: ReviewTarget): Promise<Submission>;
  getGoal(target: ConversationTarget): Promise<ThreadGoal | null>;
  setGoal(target: ConversationTarget, objective: string): Promise<ThreadGoal>;
  clearGoal(target: ConversationTarget): Promise<void>;
}

/** Stable model and installed-extension boundary. */
export interface ConversationExtensionUseCases {
  hooks(target: ConversationTarget, input: string, actorId?: string): Promise<HookCommandView>;
  invokeSkill(
    target: ConversationTarget,
    selector: string,
    task: string,
  ): Promise<Submission & { skillName: string }>;
  invokePlugin(
    target: ConversationTarget,
    selector: string,
    task: string,
  ): Promise<Submission & { pluginName: string }>;
  listAgentRoles(): AgentRoleEntry[];
  invokeAgent(
    target: ConversationTarget,
    selector: string,
    task: string,
  ): Promise<Submission & { roleName: string }>;
  modelState(target: ConversationTarget, assertAuthorized?: () => void): Promise<ModelSelectionState>;
  clearModelBrowse(target: ConversationTarget, assertAuthorized?: () => void): Promise<ModelSelectionState>;
  browseProviderModels(target: ConversationTarget, provider: string, assertAuthorized?: () => void): Promise<ModelSelectionState>;
  clearModelSelection(target: ConversationTarget, assertAuthorized?: () => void): Promise<ModelSelectionState>;
  selectModel(target: ConversationTarget, selector: string | ModelSelectionIdentity, assertAuthorized?: () => void): Promise<ModelSelectionState>;
  selectEffort(target: ConversationTarget, selector: string, assertAuthorized?: () => void): Promise<ModelSelectionState>;
  selectFastMode(target: ConversationTarget, selector: string, assertAuthorized?: () => void): Promise<ModelSelectionState>;
  listSkills(target: ConversationTarget): Promise<InstalledSkill[]>;
  listMcpServers(target: ConversationTarget): Promise<McpServerSummary[]>;
  mcpServerDetail(target: ConversationTarget, selector: string): Promise<McpServerDetail>;
  mcpHealth(target: ConversationTarget): Promise<McpHealthReport>;
  reloadMcpServers(target: ConversationTarget): Promise<void>;
  loginMcpServer(target: ConversationTarget, selector: string): Promise<McpLoginResult>;
  readMcpResource(
    target: ConversationTarget,
    selector: string,
    uri: string,
  ): Promise<McpResourceReadResult>;
  listPlugins(target: ConversationTarget): Promise<InstalledPluginCatalog>;
  pluginHealth(target: ConversationTarget): Promise<PluginHealthReport>;
  pluginDetail(target: ConversationTarget, selector: string): Promise<InstalledPlugin>;
  listPermissionProfiles(target: ConversationTarget): Promise<PermissionProfileOption[]>;
}

/** Stable native Queue and paginated Revert boundary. */
export interface ConversationQueueRevertUseCases {
  queueAdd(target: ConversationTarget, value: string, assertAuthorized?: () => void): Promise<ThreadQueueItem>;
  queueList(target: ConversationTarget, page?: number, assertAuthorized?: () => void): Promise<ThreadQueueListResult>;
  queueUpdate(
    target: ConversationTarget,
    selector: string,
    value: string,
    assertAuthorized?: () => void,
  ): Promise<ThreadQueueItem>;
  queueDelete(target: ConversationTarget, selector: string, assertAuthorized?: () => void): Promise<{ deleted: boolean }>;
  queueReorder(
    target: ConversationTarget,
    selector: string,
    position: number,
    assertAuthorized?: () => void,
  ): Promise<ThreadQueueReorderResult>;
  queueStart(target: ConversationTarget, selector?: string, assertAuthorized?: () => void): Promise<{ turnId: string }>;
  revertList(target: ConversationTarget, page?: number): Promise<ThreadRevertListResult>;
  revertPreview(
    target: ConversationTarget,
    selector: string,
    actorId?: string,
  ): Promise<ThreadRevertPreview>;
  revertConfirm(
    target: ConversationTarget,
    token: string,
    actorId?: string,
  ): Promise<{ threadId: string; beforeTurnId: string }>;
}

/** Stable Session, Workspace and local project boundary. */
export interface ConversationSessionUseCases {
  autoReview(target: ConversationTarget): ConversationAutoReviewState;
  updateAutoReview(target: ConversationTarget, enabled: boolean, expectedThreadId?: string, assertAuthorized?: () => void): Promise<ConversationAutoReviewState>;
  listSessions(
    target: ConversationTarget,
    options?: ConversationSessionQuery,
  ): Promise<ConversationSession[]>;
  backgroundThreadIds?(target: ConversationTarget): string[];
  resume(target: ConversationTarget, selector: string, assertAuthorized?: () => void): Promise<ConversationResumeResult>;
  newSession(target: ConversationTarget, assertAuthorized?: () => void): Promise<{
    previousThreadId?: string;
    backgroundedThreadId?: string;
  }>;
  archive(target: ConversationTarget, assertAuthorized?: () => void): Promise<string>;
  /** Invalidate derived session display statistics after an external App Server event. */
  invalidateSessionDisplayCache?(threadId: string): void;
  unarchive(target: ConversationTarget, selector: string, assertAuthorized?: () => void): Promise<string>;
  artifacts(target: ConversationTarget): TurnArtifacts | undefined;
  listWorkspaces(): Workspace[];
  selectedWorkspaceId(target: ConversationTarget): string;
  selectWorkspace(target: ConversationTarget, selector: string, assertAuthorized?: () => void): Promise<Workspace>;
  releaseThread(
    target: ConversationTarget,
    force?: boolean,
  ): Promise<ThreadOccupancyReleaseResult>;
  releaseIdle?(
    target: ConversationTarget,
    condition?: ConversationIdleReleaseCondition,
  ): Promise<ConversationIdleReleaseResult>;
  status(target: ConversationTarget): ConversationStatus;
  statusForDisplay(target: ConversationTarget, signal?: AbortSignal): Promise<ConversationStatus>;
}

/** Stable account and local request-metrics boundary. */
export interface ConversationAccountMetricsUseCases {
  accountUsage(): Promise<AccountUsage>;
  accountRateLimits(): Promise<AccountRateLimits>;
  providerAccountUsage(target: ConversationTarget): Promise<ProviderAccountUsage>;
  providerAccountLimits(target: ConversationTarget): Promise<ProviderAccountLimits>;
  requestMetrics(
    target: ConversationTarget,
    query?: RequestMetricsCommandQuery,
  ): Promise<RequestMetricsResult | null>;
}

export class ConversationService implements
  ConversationTurnUseCases,
  ConversationSessionUseCases,
  ConversationQueueRevertUseCases,
  ConversationExtensionUseCases,
  ConversationAccountMetricsUseCases {
  private readonly locks = new ConversationLockCoordinator();
  private readonly attachmentInputs = new Map<string, Set<AbortController>>();
  private readonly hookUseCases: ConversationHookService;
  private readonly queueUseCases: ThreadQueueService;
  private readonly revertUseCases: ThreadRevertService;
  private readonly extensionQueries: ConversationExtensionQueryService;
  private readonly accountMetrics: ConversationAccountMetricsService;
  private readonly lunaReserve: LunaReserveService | undefined;
  private readonly pendingBackgroundReleases = new Map<string, boolean>();
  private readonly backgroundReleaseAttempts = new Map<string, Promise<boolean>>();
  private idleReleaseEnabled = true;
  private idleReleaseGeneration = 0;
  private readonly sessionQueries: ConversationSessionQueryService;

  constructor(
    private readonly codex: TurnExecutionPort,
    private readonly router: SessionRouter,
    private readonly core: ConversationCore,
    private readonly models: ModelSelectionService,
    private readonly queries: ConversationQueryPort,
    private readonly workspaceStatus?: WorkspaceStatusPort,
    private readonly collaborationModes?: CollaborationModeSelectionService,
    private readonly transfers?: ConversationTransferPort,
    providerAccounts?: ProviderAccountQueryPort,
    requestMetricsQuery?: RequestMetricsQueryPort,
    private readonly turnErrorRecorder?: TurnErrorRecorder,
    private readonly agentRoles?: AgentRolePort,
    private readonly threadOccupancy?: ThreadOccupancyPort,
    private readonly threadQueue?: ThreadQueuePort,
    threadHistory?: ThreadHistoryPort,
    private readonly hasPendingSubagentRuns?: (parentThreadId: string) => boolean,
    sessionDisplayCache?: SessionDisplayCachePort,
    lunaReserveOptions?: Omit<
      LunaReserveServiceOptions,
      "router" | "models" | "collaborationModes" | "activity" | "locks"
    >,
    private readonly threadApprovalsReviewer?: ThreadApprovalsReviewerPort,
    hookAuthorization?: (target: ConversationTarget, actorId: string) => void,
    hookReviewPolicy?: HookReviewPolicy,
    private readonly bindingLifecycle?: {
      backgrounded(threadId: string): void;
      restoreRequired(threadId: string): void;
    },
    onSessionDisplayCacheError?: (operation: SessionDisplayCacheOperation) => void,
  ) {
    this.hookUseCases = new ConversationHookService(this.locks, router, models, queries, hookAuthorization ?? (() => {
      throw new UserFacingError("hooks.forbidden", "Hook 管理授权不可用");
    }), hookReviewPolicy);
    this.sessionQueries = new ConversationSessionQueryService(
      router, threadHistory, requestMetricsQuery, sessionDisplayCache, onSessionDisplayCacheError,
    );
    this.extensionQueries = new ConversationExtensionQueryService(
      router,
      models,
      queries,
    );
    this.accountMetrics = new ConversationAccountMetricsService(
      queries,
      router,
      models,
      providerAccounts,
      requestMetricsQuery,
    );
    this.queueUseCases = new ThreadQueueService(
      this.locks,
      router,
      models,
      collaborationModes,
      threadQueue,
    );
    this.revertUseCases = new ThreadRevertService(
      this.locks,
      router,
      threadQueue,
      threadHistory,
    );
    this.lunaReserve = lunaReserveOptions
      ? new LunaReserveService({
          ...lunaReserveOptions,
          router,
          models,
          ...(collaborationModes ? { collaborationModes } : {}),
          activity: {
            hasActiveTurn: (threadId) => core.activeTurnForThread(threadId) !== undefined,
          },
          locks: this.locks,
        })
      : undefined;
  }

  markLunaReserveUsageLimit(threadId: string, turnId: string): void {
    this.lunaReserve?.markUsageLimit(threadId, turnId);
  }

  recoverLunaReserveAfterTurn(threadId: string, turnId: string): void {
    this.lunaReserve?.recoverAfterTurn(threadId, turnId);
  }

  clearLunaReserveThread(threadId: string): void {
    this.lunaReserve?.clearThread(threadId);
  }

  clearLunaReserveAccountState(): void {
    this.lunaReserve?.clearAccountState();
  }

  closeLunaReserve(): Promise<void> {
    return this.lunaReserve?.close() ?? Promise.resolve();
  }

  releaseThread(
    target: ConversationTarget,
    force?: boolean,
  ): Promise<ThreadOccupancyReleaseResult> {
    if (!this.threadOccupancy) {
      return Promise.reject(new UserFacingError(
        "release.unsupported",
        "当前环境不支持释放会话占用",
      ));
    }
    return this.threadOccupancy.releaseThread(target, force);
  }

  touchActivity(target: ConversationTarget): void {
    if (!this.idleReleaseEnabled) {
      return;
    }
    this.router.touchActivity?.(target, Date.now());
  }

  setIdleReleaseEnabled(enabled: boolean): void {
    if (this.idleReleaseEnabled !== enabled) this.idleReleaseGeneration += 1;
    this.idleReleaseEnabled = enabled;
  }

  releaseIdle(
    target: ConversationTarget,
    condition?: ConversationIdleReleaseCondition,
  ): Promise<ConversationIdleReleaseResult> {
    const original = this.router.current(target);
    const expected = original ? { ...original } : undefined;
    const lastActivityAt = condition?.lastActivityAt ?? this.router.idleState(target).lastActivityAt;
    const generation = this.idleReleaseGeneration;
    return this.locked(target, async () => {
      const binding = this.router.current(target);
      if (!binding) {
        return { status: "unbound" };
      }
      const current = { ...binding };
      const isCurrent = () => {
        const latest = this.router.current(target);
        const idle = this.router.idleState(target);
        return this.idleReleaseEnabled && generation === this.idleReleaseGeneration
          && !condition?.signal.aborted && (condition?.isCurrent() ?? true)
          && current.threadId === (condition?.threadId ?? expected?.threadId)
          && latest?.threadId === current.threadId
          && latest?.sessionId === expected?.sessionId
          && latest?.workspaceId === expected?.workspaceId
          && idle.lastActivityAt === lastActivityAt && !idle.forceNew;
      };
      const isLocallyBusy = () => this.core.activeTurn(target) !== undefined
        || this.hasPendingSubagentRuns?.(current.threadId) === true
        || this.transfers?.hasPendingInteraction(current.threadId) === true;
      const busy = (): ConversationIdleReleaseResult => ({ status: "busy", threadId: current.threadId });
      if (!isCurrent()) return busy();
      if (isLocallyBusy()) {
        this.touchActivity(target);
        return busy();
      }
      if (await this.probeNativeQueueItems(current.threadId)) {
        this.touchActivity(target);
        return busy();
      }
      if (!isCurrent() || isLocallyBusy()) return busy();
      const snapshot = await this.router.readThread(current.threadId, condition?.signal);
      if (!isCurrent() || isLocallyBusy()) return busy();
      if (
        snapshot.status.type !== "idle"
        && snapshot.status.type !== "notLoaded"
      ) {
        this.touchActivity(target);
        return { status: "busy", threadId: current.threadId };
      }
      if (await this.router.hasActiveDescendants(current.threadId, condition?.signal)) {
        this.touchActivity(target);
        return busy();
      }
      if (!isCurrent() || isLocallyBusy()) return busy();
      const modelPreference = this.models.capturePreference?.(target);
      const activity = this.core.trackThreadActivity?.(current.threadId);
      try {
        const released = await this.router.releaseIdle(target, current, snapshot, {
          isCurrent: () => isCurrent() && !isLocallyBusy(),
          verifyIdle: async () => {
            if (!isCurrent() || isLocallyBusy()) return false;
            if (await this.probeNativeQueueItems(current.threadId)) {
              this.touchActivity(target);
              return false;
            }
            if (!isCurrent() || isLocallyBusy()) return false;
            const latest = await this.router.readThread(current.threadId, condition?.signal);
            return isCurrent() && !isLocallyBusy()
              && (latest.status.type === "idle" || latest.status.type === "notLoaded")
              && !await this.router.hasActiveDescendants(current.threadId, condition?.signal)
              && isCurrent() && !isLocallyBusy();
          },
          canRestore: () => !condition?.signal.aborted && (condition?.canRestore() ?? true),
          restored: (thread) => activity?.restore(target, thread.activeTurnId),
        }, modelPreference);
        if (!released) return busy();
      } catch {
        if (condition?.canRestore() && !condition.signal.aborted) condition.restoreRequired?.();
        return busy();
      } finally {
        activity?.stop();
      }
      this.invalidateRevertSnapshot(target);
      this.invalidateQueueSnapshot(current.threadId);
      this.restoreSelectionsAfterBindingChange(target, modelPreference);
      return { status: "released", threadId: current.threadId };
    });
  }

  requestMetrics(
    target: ConversationTarget,
    query: RequestMetricsCommandQuery = { view: "session" },
  ): Promise<RequestMetricsResult | null> {
    return this.accountMetrics.requestMetrics(target, query);
  }

  async submit(target: ConversationTarget, value: string | ConversationInput, isAllowed?: () => boolean): Promise<Submission> {
    let input: TurnInput[];
    try {
      input = normalizeInput(value);
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error("消息输入规范化失败"),
      );
    }
    if (input.length === 0) {
      return Promise.reject(new UserFacingError("message.empty", "消息不能为空"));
    }
    const workspace = this.router.workspace(target);
    const assertAllowed = () => {
      const current = this.router.workspace(target);
      if (isAllowed?.() === false || current.id !== workspace.id || current.cwd !== workspace.cwd) {
        throw new UserFacingError("input.authorization-changed", "输入授权或工作区已变化，请重新发送。");
      }
    };
    assertAllowed();
    return this.locked(target, () => {
      assertAllowed();
      return this.submitInputLocked(target, input, undefined, assertAllowed, assertAllowed);
    });
  }

  closeSessionQueries(): void {
    this.sessionQueries.close();
  }

  prepareAttachmentSubmission(target: ConversationTarget, isAllowed: () => boolean, kind: "video" | "audio" = "video"): PreparedAttachmentSubmission {
    const key = conversationTargetKey(target);
    const pending = this.attachmentInputs.get(key) ?? new Set<AbortController>();
    if (!isAllowed() || pending.size >= 4 || (!this.attachmentInputs.has(key) && this.attachmentInputs.size >= 1000)) {
      throw new UserFacingError(`${kind}.unavailable`, "附件输入未获授权或正在处理过多附件");
    }
    const controller = new AbortController();
    pending.add(controller);
    this.attachmentInputs.set(key, pending);
    let disposed = false;
    let used = false;
    let mayHaveSubmitted = false;
    let captured: { workspaceId: string; workspaceCwd: string; threadId: string | undefined } | undefined;
    const assertAllowed = () => {
      if (controller.signal.aborted || !isAllowed()) {
        throw new UserFacingError(`${kind}.unavailable`, "附件输入已取消、超时或授权变化，请重新发送");
      }
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      pending.delete(controller);
      if (pending.size === 0) this.attachmentInputs.delete(key);
      controller.abort();
    };
    const timer = setTimeout(dispose, 120_000);
    timer.unref();
    controller.signal.addEventListener("abort", dispose, { once: true });
    return {
      signal: controller.signal,
      get mayHaveSubmitted() { return mayHaveSubmitted; },
      dispose,
      captureTarget: () => {
        assertAllowed();
        if (captured || used) throw new UserFacingError(`${kind}.unavailable`, "附件目标已捕获");
        // Register cancellation before flushing earlier Surface input; that input
        // may create the first Thread, which becomes this attachment's target.
        const workspace = this.router.workspace(target);
        captured = { workspaceId: workspace.id, workspaceCwd: workspace.cwd,
          threadId: this.router.current(target)?.threadId };
      },
      submit: (value) => this.locked(target, () => {
        const snapshot = captured;
        if (!snapshot) throw new UserFacingError(`${kind}.unavailable`, "附件尚未捕获提交目标");
        const assertCurrent = () => {
          assertAllowed();
          const currentWorkspace = this.router.workspace(target);
          if (currentWorkspace.id !== snapshot.workspaceId || currentWorkspace.cwd !== snapshot.workspaceCwd
            || (snapshot.threadId !== undefined && this.router.current(target)?.threadId !== snapshot.threadId)) {
            throw new UserFacingError(`${kind}.unavailable`, "附件输入的工作区或会话已变化，请重新发送");
          }
        };
        assertCurrent();
        if (used) throw new UserFacingError(`${kind}.unavailable`, "附件提交入口已使用");
        used = true;
        if (this.router.current(target)?.threadId !== snapshot.threadId) {
          throw new UserFacingError(`${kind}.unavailable`, "附件下载期间会话发生变化，请重新发送");
        }
        const input = normalizeInput(value);
        if (!input.length) throw new UserFacingError("message.empty", "消息不能为空");
        // ensureSession may create the first Thread under this same conversation lock.
        return this.submitInputLocked(target, input, undefined, (submissionThreadId) => {
          assertCurrent();
          if (this.router.current(target)?.threadId !== submissionThreadId) {
            throw new UserFacingError(`${kind}.unavailable`, "附件的实际提交会话已失效，请重新发送");
          }
          // Once the RPC may start, a lost acknowledgment must not delete its file.
          mayHaveSubmitted = true;
        }, assertAllowed);
      }),
    };
  }

  submitAsyncAnswer(target: ConversationTarget, threadId: string, text: string, isCurrent: () => boolean): Promise<Submission> {
    return this.locked(target, () => {
      const assertCurrent = () => {
        if (!isCurrent() || this.router.current(target)?.threadId !== threadId) {
          throw new UserFacingError("conversation.missing", "问题已失效或所属会话已切换，回答未发送。");
        }
      };
      assertCurrent();
      const input = normalizeInput(text);
      if (input.length === 0) {
        throw new UserFacingError("message.empty", "回答不能为空");
      }
      return this.submitInputLocked(target, input, undefined, assertCurrent, assertCurrent);
    });
  }

  async invokeSkill(
    target: ConversationTarget,
    selector: string,
    task: string,
  ): Promise<Submission & { skillName: string }> {
    const normalizedSelector = selector.trim();
    const normalizedTask = task.trim();
    if (!normalizedSelector || !normalizedTask) {
      throw new UserFacingError(
        "skill.usage",
        "需要提供 Skill 名称或序号及任务内容",
      );
    }
    return this.locked(target, async () => {
      const workspace = this.router.workspace(target);
      const skillName = await this.extensionQueries.resolveSkillName(
        workspace.cwd,
        normalizedSelector,
      );
      const skill = await this.queries.resolveSkill(workspace.cwd, skillName);
      if (!skill) {
        throw new UserFacingError(
          "skill.not-found",
          "指定的 Skill 不存在、未启用或不属于当前 Workspace",
        );
      }
      const submission = await this.submitInputLocked(target, [
        {
          type: "text",
          text: `$${skill.name} ${normalizedTask}`,
        },
        {
          type: "skill",
          name: skill.name,
          path: skill.path,
        },
      ], { kind: "skill", name: skill.name });
      return { ...submission, skillName: skill.name };
    });
  }

  async invokePlugin(
    target: ConversationTarget,
    selector: string,
    task: string,
  ): Promise<Submission & { pluginName: string }> {
    const normalizedSelector = selector.trim();
    const normalizedTask = task.trim();
    if (!normalizedSelector || !normalizedTask) {
      throw new UserFacingError(
        "plugin.usage",
        "需要提供 Plugin 名称或序号及任务内容",
      );
    }
    return this.locked(target, async () => {
      if ((this.models.status(target).modelProvider ?? "openai") !== "openai") {
        throw new UserFacingError(
          "plugin.provider.unsupported",
          "Plugin 调用当前只支持 OpenAI Session",
        );
      }
      const workspace = this.router.workspace(target);
      const plugin = await this.extensionQueries.resolvePlugin(
        workspace.cwd,
        normalizedSelector,
      );
      const resolved = await this.queries.resolvePlugin(workspace.cwd, plugin.id);
      if (!resolved) {
        throw new UserFacingError(
          "plugin.unavailable",
          "指定的 Plugin 未启用、被管理员禁用或暂不可调用",
        );
      }
      const submission = await this.submitInputLocked(target, [
        {
          type: "text",
          text: `@${resolved.name} ${normalizedTask}`,
        },
        {
          type: "plugin",
          name: resolved.displayName,
          path: resolved.path,
        },
      ], { kind: "plugin", name: resolved.displayName });
      return { ...submission, pluginName: resolved.displayName };
    });
  }

  listAgentRoles(): AgentRoleEntry[] {
    let configured: AgentRoleEntry[];
    try {
      configured = this.agentRoles?.listAgentRoles() ?? [];
    } catch {
      throw new UserFacingError(
        "agents.config-unreadable",
        "Codex 子代理角色配置无法安全读取；请检查 ~/.codex/config.toml",
      );
    }
    const configuredByName = new Map(
      configured.map((role) => [role.name.toLowerCase(), role]),
    );
    const builtIn = builtInAgentRoles.map(
      (role) => configuredByName.get(role.name.toLowerCase()) ?? role,
    );
    return [
      ...builtIn,
      ...configured.filter(
        (role) => !builtInAgentRoles.some(
          (candidate) => candidate.name.toLowerCase() === role.name.toLowerCase(),
        ),
      ),
    ];
  }

  async invokeAgent(
    target: ConversationTarget,
    selector: string,
    task: string,
  ): Promise<Submission & { roleName: string }> {
    const normalizedSelector = selector.trim();
    const normalizedTask = task.trim();
    if (!normalizedSelector || !normalizedTask) {
      throw new UserFacingError(
        "agents.usage",
        "需要提供子代理角色名称或序号及任务内容",
      );
    }
    const roles = this.listAgentRoles();
    const role = resolveAgentRole(roles, normalizedSelector);
    if (!role) {
      throw new UserFacingError(
        "agents.not-found",
        "指定的子代理角色不存在；使用 /agents 查看可用角色",
      );
    }
    const submission = await this.submitInput(target, [
      {
        type: "text",
        text: `请使用 agent_type="${role.name}"、fork_turns="1" 的子代理执行以下任务，子代理完成后把最终结果回复给我：\n\n${normalizedTask}`,
      },
    ], { kind: "agent", name: role.name });
    return { ...submission, roleName: role.name };
  }

  private submitInput(
    target: ConversationTarget,
    input: TurnInput[],
    identity?: TurnStartIdentity,
  ): Promise<Submission> {
    this.touchActivity(target);
    return this.locked(
      target,
      () => this.submitInputLocked(target, input, identity),
    );
  }

  private async submitInputLocked(
    target: ConversationTarget,
    input: TurnInput[],
    identity?: TurnStartIdentity,
    assertCurrent?: (threadId: string) => void,
    assertAuthorized?: () => void,
  ): Promise<Submission> {
    assertAuthorized?.();
    this.touchActivity(target);
    if (input.some((item) => item.type === "image")) {
      await this.models.requireInputModality(target, "image", assertAuthorized);
    }
    if (input.some((item) => item.type === "localAudio")) {
      await this.models.requireInputModality(target, "audio", assertAuthorized);
    }
    const active = this.core.activeTurn(target);
    const clientUserMessageId = `${gatewayUserMessageClientIdPrefix}${randomUUID()}`;
    if (active) {
      assertCurrent?.(active.threadId);
      this.sessionQueries.invalidateSessionDisplayCache(active.threadId);
      try {
        await this.codex.steerTurn(active.threadId, active.turnId, input, clientUserMessageId,
          () => { assertAuthorized?.(); assertCurrent?.(active.threadId); });
      } catch (error) {
        this.recordTurnError("steer", target, active.threadId, active.turnId, error);
        throw error;
      }
      return { threadId: active.threadId, turnId: active.turnId, steered: true };
    }
    return this.startNewTurn(target, input, clientUserMessageId, identity, assertCurrent, assertAuthorized);
  }

  queueAdd(target: ConversationTarget, value: string, assertAuthorized?: () => void): Promise<ThreadQueueItem> {
    return this.queueUseCases.add(target, value, assertAuthorized);
  }

  queueList(target: ConversationTarget, page = 1, assertAuthorized?: () => void): Promise<ThreadQueueListResult> {
    return this.queueUseCases.list(target, page, assertAuthorized);
  }

  queueUpdate(
    target: ConversationTarget,
    selector: string,
    value: string,
    assertAuthorized?: () => void,
  ): Promise<ThreadQueueItem> {
    return this.queueUseCases.update(target, selector, value, assertAuthorized);
  }

  queueDelete(target: ConversationTarget, selector: string, assertAuthorized?: () => void): Promise<{ deleted: boolean }> {
    return this.queueUseCases.delete(target, selector, assertAuthorized);
  }

  queueReorder(
    target: ConversationTarget,
    selector: string,
    position: number,
    assertAuthorized?: () => void,
  ): Promise<ThreadQueueReorderResult> {
    return this.queueUseCases.reorder(target, selector, position, assertAuthorized);
  }

  queueStart(target: ConversationTarget, selector?: string, assertAuthorized?: () => void): Promise<{ turnId: string }> {
    return this.queueUseCases.start(target, selector, assertAuthorized);
  }

  revertList(target: ConversationTarget, page = 1): Promise<ThreadRevertListResult> {
    return this.revertUseCases.list(target, page);
  }

  revertPreview(
    target: ConversationTarget,
    selector: string,
    actorId?: string,
  ): Promise<ThreadRevertPreview> {
    return this.revertUseCases.preview(target, selector, actorId);
  }

  revertConfirm(
    target: ConversationTarget,
    token: string,
    actorId?: string,
  ): Promise<{ threadId: string; beforeTurnId: string }> {
    return this.revertUseCases.confirm(target, token, actorId);
  }

  invalidateQueueSnapshot(threadId: string): void {
    this.queueUseCases.invalidateSnapshot(threadId);
  }

  invalidateRevertSnapshot(threadId: string): void;
  invalidateRevertSnapshot(target: ConversationTarget): void;
  invalidateRevertSnapshot(value: string | ConversationTarget): void {
    this.revertUseCases.invalidate(value);
  }

  /**
   * Clear only the pending selections owned by the Conversation whose current
   * Thread started. Background or unrelated Threads must not consume them.
   */
  clearPendingSelectionsForThread(threadId: string): void {
    const target = this.router.targetForThread(threadId);
    if (target && this.router.current(target)?.threadId === threadId) {
      this.clearPendingSelections(target);
    }
  }

  listSessions(
    target: ConversationTarget,
    options: ConversationSessionQuery = {},
  ): Promise<ConversationSession[]> {
    return this.sessionQueries.listSessions(target, options);
  }

  backgroundThreadIds(target: ConversationTarget): string[] {
    return (this.router.backgroundBindings?.(target) ?? []).map((binding) => binding.threadId);
  }

  async resume(
    target: ConversationTarget,
    selector: string,
    assertAuthorized?: () => void,
  ): Promise<ConversationResumeResult> {
    assertAuthorized?.();
    this.touchActivity(target);
    const { selected, selectionCwd } = await this.authorizedLocked(target, assertAuthorized, async () => ({
      selectionCwd: this.router.workspace(target).cwd,
      selected: resolveThread(pinnedFirst(await this.router.list(target, { ...(assertAuthorized ? { beforeSubmit: assertAuthorized } : {}) })), selector.trim()),
    }));
    assertAuthorized?.();
    const owner = this.router.targetForThread(selected.id);
    if (owner && conversationTargetKey(owner) !== conversationTargetKey(target)) {
      if (this.router.isBackgroundThread?.(selected.id)) {
        throw new UserFacingError(
          "thread.takeover.busy",
          "运行中的后台 Session 不能跨渠道接管",
        );
      }
      if (owner.surface === target.surface) {
        throw new UserFacingError(
          "thread.bound",
          "该 Codex Session 已绑定到同一渠道中的其他会话",
        );
      }
      if (!this.transfers) {
        throw new UserFacingError(
          "thread.bound",
          "当前服务没有启用跨渠道 Session 接管",
        );
      }
      const transfers = this.transfers;
      return this.lockedTargets([owner, target], async () => {
        assertAuthorized?.();
        if (selected.cwd !== this.router.workspace(target).cwd) {
          throw new UserFacingError("thread.takeover.workspace", "只能接管当前 Workspace 中的 Codex Thread");
        }
        const currentOwner = this.router.targetForThread(selected.id);
        if (
          !currentOwner
          || conversationTargetKey(currentOwner) !== conversationTargetKey(owner)
        ) {
          throw new UserFacingError(
            "thread.takeover.changed",
            "Codex Session 绑定已变化，请重新选择",
          );
        }
        this.requireIdle(owner);
        this.requireIdle(target);
        const destination = this.router.current(target);
        const ownerHasQueue = await this.probeNativeQueueItems(selected.id, assertAuthorized);
        const destinationHasQueue = destination
          && destination.threadId !== selected.id
          ? await this.probeNativeQueueItems(destination.threadId, assertAuthorized)
          : false;
        this.requireIdle(owner);
        this.requireIdle(target);
        if (ownerHasQueue || destinationHasQueue) {
          throw new UserFacingError(
            "thread.takeover.busy",
            "原渠道或当前渠道仍有排队消息，暂不能接管",
          );
        }
        if (
          transfers.hasPendingInteraction(selected.id)
          || (
            destination
            && transfers.hasPendingInteraction(destination.threadId)
          )
        ) {
          throw new UserFacingError(
            "thread.takeover.busy",
            "原渠道或当前渠道仍有待处理交互，暂不能接管",
          );
        }
        const transfer = await this.router.transferBinding(target, selected.id, assertAuthorized);
        this.clearConversationState(owner);
        this.clearConversationState(target);
        transfers.notifyTransferred({
          previousTarget: owner,
          nextTarget: target,
          threadId: transfer.binding.threadId,
        });
        return {
          threadId: transfer.binding.threadId,
          transferredFrom: owner.surface,
        };
      });
    }
    return this.authorizedLocked(target, assertAuthorized, async () => {
      const currentCwd = this.router.workspace(target).cwd;
      if (currentCwd !== selectionCwd || selected.cwd !== selectionCwd) {
        throw new UserFacingError("thread.takeover.changed", "Workspace 已变化，请重新选择会话");
      }
      const modelPreference = this.models.capturePreference?.(target);
      const currentOwner = this.router.targetForThread(selected.id);
      if (
        currentOwner
        && conversationTargetKey(currentOwner) !== conversationTargetKey(target)
      ) {
        throw new UserFacingError(
          "thread.takeover.changed",
          "Codex Session 绑定已变化，请重新选择",
        );
      }
      const current = this.router.current?.(target);
      const leavesCurrent = current !== undefined && current.threadId !== selected.id;
      if (leavesCurrent && current && await this.probeNativeQueueItems(current.threadId, assertAuthorized)) {
        throw new UserFacingError(
          "conversation.background-queued",
          "当前任务仍有下一 Turn 排队消息，暂不能转入后台",
        );
      }
      const selectedHasQueue = await this.probeNativeQueueItems(selected.id, assertAuthorized);
      const active = this.core.activeTurn(target);
      const preserveCurrent = leavesCurrent && current !== undefined && !await this.isThreadIdle(current.threadId);
      const activity = this.core.trackThreadActivity(selected.id);
      const previousActivity = leavesCurrent && current ? this.core.trackThreadActivity(current.threadId) : undefined;
      let binding;
      try {
        binding = await this.router.resume(target, selected.id, preserveCurrent, selected.cwd,
          {
            assertCurrent: () => {
              if (this.router.workspace(target).cwd !== currentCwd
                || this.router.current?.(target)?.threadId !== current?.threadId
                || (leavesCurrent && this.core.activeTurn(target)?.turnId !== active?.turnId)
                || (leavesCurrent && current && !preserveCurrent && this.hasLocalThreadWork(current.threadId))) {
                throw new UserFacingError("thread.takeover.changed", "当前会话或工作区已变化，请重新选择");
              }
            },
            restored: (restored, thread) => activity.restore(restored.target, thread.activeTurnId),
            ...(leavesCurrent && current ? {
              verifyPreviousIdle: () => this.isThreadIdle(current.threadId),
              restoredPrevious: (thread: Awaited<ReturnType<SessionRouter["readThread"]>>) => previousActivity?.restore(target, thread.activeTurnId),
              restorePreviousFailed: () => this.bindingLifecycle?.restoreRequired(current.threadId),
            } : {}),
          }, assertAuthorized);
      } finally {
        activity.stop();
        previousActivity?.stop();
      }
      this.invalidateRevertSnapshot(target);
      if (preserveCurrent && current) {
        this.pendingBackgroundReleases.set(current.threadId, false);
        this.bindingLifecycle?.backgrounded(current.threadId);
      }
      if (selectedHasQueue) {
        this.clearPendingSelections(target);
      } else {
        this.restoreSelectionsAfterBindingChange(target, modelPreference);
      }
      return {
        threadId: binding.threadId,
        ...(preserveCurrent && current ? { backgroundedThreadId: current.threadId } : {}),
        ...(selectedHasQueue ? { queuePending: true } : {}),
      };
    });
  }

  newSession(target: ConversationTarget, assertAuthorized?: () => void): Promise<{
    previousThreadId?: string;
    backgroundedThreadId?: string;
  }> {
    return this.authorizedLocked(target, assertAuthorized, async () => {
      const modelPreference = this.models.capturePreference?.(target);
      const current = this.router.current?.(target);
      if (current && await this.probeNativeQueueItems(current.threadId, assertAuthorized)) {
        throw new UserFacingError(
          "conversation.background-queued",
          "当前任务仍有下一 Turn 排队消息，暂不能转入后台",
        );
      }
      const preserveCurrent = current !== undefined && !await this.isThreadIdle(current.threadId);
      const activity = current ? this.core.trackThreadActivity(current.threadId) : undefined;
      try {
        await this.router.newSession(target, preserveCurrent, modelPreference, current ? {
          isCurrent: () => this.router.current(target)?.threadId === current.threadId && !this.hasLocalThreadWork(current.threadId),
          verifyIdle: () => this.isThreadIdle(current.threadId),
          canRestore: () => this.router.current(target)?.threadId === current.threadId,
          restored: thread => activity?.restore(target, thread.activeTurnId),
          restoreRequired: () => this.bindingLifecycle?.restoreRequired(current.threadId),
        } : undefined, assertAuthorized);
      } finally { activity?.stop(); }
      if (preserveCurrent && current) {
        this.pendingBackgroundReleases.set(current.threadId, false);
        this.bindingLifecycle?.backgrounded(current.threadId);
      }
      this.invalidateRevertSnapshot(target);
      this.restoreSelectionsAfterBindingChange(target, modelPreference);
      return {
        ...(current?.threadId
          ? { previousThreadId: current.threadId }
          : {}),
        ...(preserveCurrent && current
          ? { backgroundedThreadId: current.threadId }
          : {}),
      };
    });
  }

  archive(target: ConversationTarget, assertAuthorized?: () => void): Promise<string> {
    return this.authorizedLocked(target, assertAuthorized, async () => {
      this.requireIdle(target);
      const threadId = await this.router.archive(target, assertAuthorized);
      this.sessionQueries.removeSessionDisplayCache(threadId);
      this.invalidateRevertSnapshot(target);
      this.clearPendingSelections(target);
      return threadId;
    });
  }

  refreshSessionDisplayCache(threadId: string): Promise<void> {
    return this.sessionQueries.refreshSessionDisplayCache(threadId);
  }

  invalidateSessionDisplayCache(threadId: string): void {
    this.sessionQueries.invalidateSessionDisplayCache(threadId);
  }

  unarchive(target: ConversationTarget, selector: string, assertAuthorized?: () => void): Promise<string> {
    return this.authorizedLocked(target, assertAuthorized, async () => {
      this.requireIdle(target);
      const current = this.router.current?.(target);
      if (current && await this.probeNativeQueueItems(current.threadId, assertAuthorized)) {
        throw new UserFacingError(
          "conversation.background-queued",
          "当前会话仍有排队消息，暂不能切换 Session",
        );
      }
      this.requireIdle(target);
      const sessions = pinnedFirst(
        await this.router.list(target, { archived: true, ...(assertAuthorized ? { beforeSubmit: assertAuthorized } : {}) }),
      );
      const selected = resolveThread(sessions, selector.trim(), "unarchive");
      this.requireIdle(target);
      const binding = await this.router.unarchive(target, selected.id, assertAuthorized);
      this.invalidateRevertSnapshot(target);
      this.clearPendingSelections(target);
      return binding.threadId;
    });
  }

  artifacts(target: ConversationTarget): TurnArtifacts | undefined {
    const binding = this.router.current(target);
    return binding ? this.core.artifacts(binding.threadId) : undefined;
  }

  listWorkspaces(): Workspace[] {
    return this.router.listWorkspaces();
  }

  selectedWorkspaceId(target: ConversationTarget): string {
    return this.router.selectedWorkspaceId(target);
  }

  selectWorkspace(target: ConversationTarget, selector: string, assertAuthorized?: () => void): Promise<Workspace> {
    return this.authorizedLocked(target, assertAuthorized, async () => {
      this.requireIdle(target);
      if ((this.router.backgroundBindings?.(target).length ?? 0) > 0) {
        throw new UserFacingError(
          "conversation.busy",
          "仍有后台任务运行，暂不能切换 Workspace",
        );
      }
      const selected = this.router.resolveWorkspace(selector);
      const currentWorkspaceId = this.router.selectedWorkspaceId(target);
      const current = this.router.current?.(target);
      if (current && currentWorkspaceId !== selected.id
        && await this.probeNativeQueueItems(current.threadId)) {
        throw new UserFacingError(
          "conversation.background-queued",
          "当前会话仍有排队消息，暂不能切换 Workspace",
        );
      }
      this.requireIdle(target);
      const modelPreference = selected.id === currentWorkspaceId
        ? undefined
        : this.models.capturePreference?.(target);
      const workspace = await this.router.selectWorkspace(target, selected.id, modelPreference, assertAuthorized);
      if (workspace.id !== currentWorkspaceId) {
        this.invalidateRevertSnapshot(target);
        this.restoreSelectionsAfterBindingChange(target, modelPreference);
      }
      return workspace;
    });
  }

  autoReview(target: ConversationTarget): ConversationAutoReviewState {
    const threadId = this.router.current(target)?.threadId ?? null;
    return { threadId, reviewer: threadId ? this.router.modelSettingsForThread(threadId)?.approvalsReviewer ?? null : null, updated: false };
  }

  updateAutoReview(target: ConversationTarget, enabled: boolean, expectedThreadId?: string, assertAuthorized?: () => void): Promise<ConversationAutoReviewState> {
    return this.authorizedLocked(target, assertAuthorized, async () => {
      const state = this.autoReview(target);
      if (expectedThreadId !== undefined && expectedThreadId !== state.threadId) {
        throw new UserFacingError("autoreview.stale-selection", "当前会话已变化，请重新发送 /autoreview");
      }
      if (!state.threadId) throw new UserFacingError("conversation.missing", "当前没有已绑定的会话");
      this.requireIdle(target);
      if (this.transfers?.hasPendingInteraction(state.threadId)) {
        throw new UserFacingError("conversation.busy", "当前会话有待处理审批，请先处理审批", { reason: "pending-interaction" });
      }
      if (state.reviewer !== "user" && state.reviewer !== "auto_review") {
        throw new UserFacingError("autoreview.unavailable", "当前会话审批方式不可修改，请重新查询状态");
      }
      const reviewer = enabled ? "auto_review" : "user";
      if (state.reviewer === reviewer) return state;
      if (!this.threadApprovalsReviewer) throw new UserFacingError("autoreview.unavailable", "当前 Gateway 不支持修改会话审批方式");
      const beforeSubmit = () => {
        assertAuthorized?.();
        if (this.router.current(target)?.threadId !== state.threadId) {
          throw new UserFacingError("autoreview.stale-selection", "当前会话已变化，请重新发送 /autoreview");
        }
        this.requireIdle(target);
        if (this.transfers?.hasPendingInteraction(state.threadId)) {
          throw new UserFacingError("conversation.busy", "当前会话有待处理审批，请先处理审批", { reason: "pending-interaction" });
        }
      };
      try {
        await this.threadApprovalsReviewer.updateThreadApprovalsReviewer(state.threadId, reviewer, beforeSubmit);
      } catch (error) {
        if (error instanceof UserFacingError && ["autoreview.update-failed", "autoreview.update-unconfirmed", "autoreview.stale-selection", "command.authorization-changed", "conversation.busy"].includes(error.code)) throw error;
        throw new UserFacingError("autoreview.update-failed", "会话审批方式更新失败，请重新查询状态");
      }
      // The injected port waits for both Client confirmation and shared inbound
      // reduction. Read the latest actual state, including concurrent overrides.
      const confirmed = this.autoReview(target);
      if (confirmed.threadId !== state.threadId) {
        throw new UserFacingError("autoreview.stale-selection", "当前会话已变化，请重新发送 /autoreview");
      }
      if (confirmed.reviewer === null) {
        throw new UserFacingError("autoreview.update-unconfirmed", "会话审批方式更新结果尚未确认，请重新查询状态");
      }
      return { ...confirmed, updated: true };
    });
  }

  async stop(target: ConversationTarget): Promise<boolean> {
    const attachments = this.attachmentInputs.get(conversationTargetKey(target));
    const cancelledAttachments = (attachments?.size ?? 0) > 0;
    for (const controller of [...attachments ?? []]) controller.abort();
    const active = this.core.activeTurn(target);
    const threadId = active?.threadId ?? (this.codex.cancelPendingInput ? this.router.current(target)?.threadId : undefined);
    const cancelled = threadId ? (this.codex.cancelPendingInput?.(threadId) ?? false) : false;
    if (!active) {
      return cancelled || cancelledAttachments;
    }
    await this.codex.interruptTurn(active.threadId, active.turnId);
    return true;
  }

  rename(target: ConversationTarget, name: string): Promise<void> {
    const normalized = name.trim();
    if (!normalized || normalized.length > 64) {
      return Promise.reject(
        new UserFacingError("conversation.name.invalid", "会话名称必须为 1–64 个字符"),
      );
    }
    return this.locked(target, async () => {
      this.requireIdle(target);
      const binding = this.router.current(target);
      if (!binding) {
        throw new UserFacingError("conversation.missing", "当前还没有 Codex Session");
      }
      await this.codex.setThreadName(binding.threadId, normalized);
    });
  }

  setPinned(target: ConversationTarget, pinned: boolean): Promise<boolean> {
    return this.locked(target, async () => {
      const binding = this.router.current(target);
      if (!binding) {
        throw new UserFacingError("conversation.missing", "当前还没有 Codex Session");
      }
      return this.codex.setThreadPinned(binding.threadId, pinned);
    });
  }

  compact(target: ConversationTarget): Promise<void> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      const binding = await this.ensureSession(target, true);
      this.requireIdle(target);
      await this.codex.compactThread(binding.threadId);
    });
  }

  fork(target: ConversationTarget, assertAuthorized?: () => void): Promise<string> {
    return this.authorizedLocked(target, assertAuthorized, async () => {
      this.requireIdle(target);
      const current = await this.ensureSession(target, true, assertAuthorized);
      if (await this.probeNativeQueueItems(current.threadId, assertAuthorized)) {
        throw new UserFacingError(
          "conversation.background-queued",
          "当前会话仍有排队消息，暂不能分叉 Session",
        );
      }
      this.requireIdle(target);
      const binding = await this.router.fork(target, {}, assertAuthorized);
      this.invalidateRevertSnapshot(target);
      this.clearPendingSelections(target);
      return binding.threadId;
    });
  }

  togglePlanMode(target: ConversationTarget): Promise<CollaborationModeState> {
    return this.withGuardedSelection(target, () => this.requireCollaborationModes().toggle(target));
  }

  startPlan(target: ConversationTarget, prompt: string): Promise<Submission> {
    const normalized = prompt.trim();
    if (!normalized) {
      return Promise.reject(new UserFacingError("plan.prompt.empty", "Plan 需求不能为空"));
    }
    return this.locked(target, async () => {
      this.requireIdle(target);
      await this.rejectQueueWhenPendingOverrideChanges(target);
      await this.requireCollaborationModes().select(target, "plan");
      try {
        await this.rejectQueueWhenPendingOverrideChanges(target);
      } catch (error) {
        this.clearPendingSelections(target);
        throw error;
      }
      return this.startNewTurn(
        target,
        [{ type: "text", text: normalized }],
        `${gatewayUserMessageClientIdPrefix}${randomUUID()}`,
      );
    });
  }

  review(target: ConversationTarget, reviewTarget: ReviewTarget): Promise<Submission> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      const binding = await this.ensureSession(target, true);
      this.requireIdle(target);
      const result = await this.codex.startReview(binding.threadId, reviewTarget);
      this.core.markTurnStarted(target, result.threadId, result.turnId);
      return { threadId: result.threadId, turnId: result.turnId, steered: false };
    });
  }

  modelState(target: ConversationTarget, assertAuthorized?: () => void): Promise<ModelSelectionState> {
    return this.extensionQueries.modelState(target, assertAuthorized);
  }

  hooks(target: ConversationTarget, input: string, actorId?: string): Promise<HookCommandView> {
    return this.hookUseCases.execute(target, input, actorId);
  }

  clearModelBrowse(target: ConversationTarget, assertAuthorized?: () => void): Promise<ModelSelectionState> {
    return this.extensionQueries.clearModelBrowse(target, assertAuthorized);
  }

  browseProviderModels(target: ConversationTarget, provider: string, assertAuthorized?: () => void): Promise<ModelSelectionState> {
    return this.extensionQueries.browseProviderModels(target, provider, assertAuthorized);
  }

  clearModelSelection(target: ConversationTarget, assertAuthorized?: () => void): Promise<ModelSelectionState> {
    return this.extensionQueries.clearModelSelection(target, assertAuthorized);
  }

  selectModel(target: ConversationTarget, selector: string | ModelSelectionIdentity, assertAuthorized?: () => void): Promise<ModelSelectionState> {
    return this.withGuardedSelection(target, () => this.models.selectModel(target, selector, assertAuthorized), assertAuthorized);
  }

  selectEffort(target: ConversationTarget, selector: string, assertAuthorized?: () => void): Promise<ModelSelectionState> {
    return this.withGuardedSelection(target, () => this.models.selectEffort(target, selector, assertAuthorized), assertAuthorized);
  }

  selectFastMode(target: ConversationTarget, selector: string, assertAuthorized?: () => void): Promise<ModelSelectionState> {
    if (selector.trim().toLowerCase() === "status") {
      return this.models.selectFastMode(target, selector, assertAuthorized);
    }
    return this.withGuardedSelection(target, () => this.models.selectFastMode(target, selector, assertAuthorized), assertAuthorized);
  }

  listSkills(target: ConversationTarget): Promise<InstalledSkill[]> {
    return this.extensionQueries.listSkills(target);
  }

  listMcpServers(target: ConversationTarget): Promise<McpServerSummary[]> {
    return this.extensionQueries.listMcpServers(target);
  }

  mcpHealth(target: ConversationTarget): Promise<McpHealthReport> {
    return this.extensionQueries.mcpHealth(target);
  }

  reloadMcpServers(target: ConversationTarget): Promise<void> {
    void target;
    return this.extensionQueries.reloadMcpServers();
  }

  mcpServerDetail(
    target: ConversationTarget,
    selector: string,
  ): Promise<McpServerDetail> {
    return this.extensionQueries.mcpServerDetail(target, selector);
  }

  loginMcpServer(
    target: ConversationTarget,
    selector: string,
  ): Promise<McpLoginResult> {
    return this.extensionQueries.loginMcpServer(target, selector);
  }

  readMcpResource(
    target: ConversationTarget,
    selector: string,
    uri: string,
  ): Promise<McpResourceReadResult> {
    return this.extensionQueries.readMcpResource(target, selector, uri);
  }

  listPlugins(target: ConversationTarget): Promise<InstalledPluginCatalog> {
    return this.extensionQueries.listPlugins(target);
  }

  pluginHealth(target: ConversationTarget): Promise<PluginHealthReport> {
    return this.extensionQueries.pluginHealth(target);
  }

  pluginDetail(
    target: ConversationTarget,
    selector: string,
  ): Promise<InstalledPlugin> {
    return this.extensionQueries.pluginDetail(target, selector);
  }

  accountUsage(): Promise<AccountUsage> {
    return this.accountMetrics.accountUsage();
  }

  accountRateLimits(): Promise<AccountRateLimits> {
    return this.accountMetrics.accountRateLimits();
  }

  providerAccountUsage(target: ConversationTarget): Promise<ProviderAccountUsage> {
    return this.accountMetrics.providerAccountUsage(target);
  }

  providerAccountLimits(target: ConversationTarget): Promise<ProviderAccountLimits> {
    return this.accountMetrics.providerAccountLimits(target);
  }

  listPermissionProfiles(target: ConversationTarget): Promise<PermissionProfileOption[]> {
    return this.extensionQueries.listPermissionProfiles(target);
  }

  getGoal(target: ConversationTarget): Promise<ThreadGoal | null> {
    return this.locked(target, async () => {
      const binding = await this.ensureSession(target);
      return this.codex.getGoal(binding.threadId);
    });
  }

  setGoal(target: ConversationTarget, objective: string): Promise<ThreadGoal> {
    const normalized = objective.trim();
    if (!normalized) {
      return Promise.reject(new UserFacingError("goal.empty", "目标不能为空"));
    }
    return this.locked(target, async () => {
      const binding = await this.ensureSession(target);
      const goal = await this.codex.setGoal(binding.threadId, normalized);
      this.core.handle({
        type: "thread.goal.updated",
        threadId: binding.threadId,
        goal,
      });
      return goal;
    });
  }

  clearGoal(target: ConversationTarget): Promise<void> {
    return this.locked(target, async () => {
      const binding = await this.ensureSession(target);
      await this.codex.clearGoal(binding.threadId);
      this.core.handle({
        type: "thread.goal.cleared",
        threadId: binding.threadId,
      });
    });
  }

  status(target: ConversationTarget): ConversationStatus {
    const binding = this.router.current(target);
    const active = this.core.activeTurn(target);
    const workspace = this.router.workspace(target);
    const tokenUsage = binding ? this.core.tokenUsage(binding.threadId) : undefined;
    const goal = binding ? this.core.goal(binding.threadId) : undefined;
    const contextCompactionCount = binding
      ? this.core.contextCompactionCount(binding.threadId)
      : undefined;
    const model = this.models.status(target);
    const weeklyLimit = usesOpenAiAccount(model.modelProvider)
      ? this.core.weeklyRateLimit()
      : undefined;
    const collaborationMode = this.collaborationModes?.status(target) ?? {
      mode: "default" as const,
      pending: false,
    };
    return {
      ...(binding ? { threadId: binding.threadId } : {}),
      ...(binding ? { threadName: this.router.threadNameForThread?.(binding.threadId) ?? null } : {}),
      ...(active ? { turnId: active.turnId } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
      ...(goal ? { goal } : {}),
      ...(contextCompactionCount !== undefined ? { contextCompactionCount } : {}),
      ...(weeklyLimit ? { weeklyLimit } : {}),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cwd: workspace.cwd,
      model: model.model,
      ...(model.modelProvider ? { modelProvider: model.modelProvider } : {}),
      effort: model.effort,
      serviceTier: model.serviceTier,
      approvalsReviewer: binding
        ? this.router.modelSettingsForThread(binding.threadId)?.approvalsReviewer ?? null
        : null,
      modelPending: model.modelPending,
      effortPending: model.effortPending,
      fastModePending: model.serviceTierPending,
      collaborationMode: collaborationMode.mode,
      collaborationModePending: collaborationMode.pending,
    };
  }

  async workspaceGitBranch(target: ConversationTarget, signal?: AbortSignal): Promise<string | undefined> {
    const workspace = this.router.workspace(target);
    if (signal?.aborted) return undefined;
    return this.workspaceStatus?.currentGitBranch(workspace.cwd, signal);
  }

  async statusForDisplay(target: ConversationTarget, signal?: AbortSignal): Promise<ConversationStatus> {
    const status = this.status(target);
    const gitBranch = await this.workspaceGitBranch(target, signal);
    signal?.throwIfAborted();
    // Recheck the current Workspace after asynchronous IO; outer callers own authorization.
    const workspace = this.router.workspace(target);
    if (workspace.id !== status.workspaceId || workspace.cwd !== status.cwd) return this.status(target);
    return gitBranch ? { ...status, gitBranch } : status;
  }

  private async ensureSession(target: ConversationTarget, requireIdle = false, assertAuthorized?: () => void) {
    assertAuthorized?.();
    await this.models.validateUnboundPreference?.(target, assertAuthorized);
    assertAuthorized?.();
    const preference = !this.router.current?.(target) ? this.models.capturePreference?.(target) : undefined;
    const options = { ...this.models.threadStartOptions?.(target),
      ...(assertAuthorized ? { beforeSubmit: assertAuthorized } : {}) };
    const current = this.router.current(target);
    const activity = current ? this.core.trackThreadActivity(current.threadId) : undefined;
    try {
      const binding = await this.router.ensure(target, options, (restored, thread) => {
        if (requireIdle && thread.status.type === "active" && thread.activeTurnId === null) {
          throw new UserFacingError("conversation.busy", "会话仍有运行中的任务，请稍后重试或显式恢复会话", { reason: "activity-restored" });
        }
        if (restored.threadId === current?.threadId) {
          activity?.restore(restored.target, thread.activeTurnId);
        }
      });
      if (preference) this.models.restorePreference?.(target, preference);
      return binding;
    } finally {
      activity?.stop();
    }
  }

  private async startNewTurn(
    target: ConversationTarget,
    input: TurnInput[],
    clientUserMessageId: string,
    identity?: TurnStartIdentity,
    assertCurrent?: (threadId: string) => void,
    assertAuthorized?: () => void,
  ): Promise<Submission> {
    this.touchActivity(target);
    const binding = await this.ensureSession(target, true, assertAuthorized);
    // Subscription restoration can publish an active Turn while ensure waits.
    // Do not start a new Turn using the idle decision made before that await.
    if (this.core.activeTurn(target)) {
      throw new UserFacingError("conversation.busy", "会话活动状态已恢复，请重新发送消息", { reason: "activity-restored" });
    }
    this.sessionQueries.invalidateSessionDisplayCache(binding.threadId);
    const workspace = this.router.workspace(target);
    const overrides = this.turnOverrides(target);
    if (overrides.modelProvider != null) {
      const threadProvider = this.router.modelSettings(target)?.modelProvider ?? "openai";
      if (overrides.modelProvider !== threadProvider) {
        throw new UserFacingError(
          "model.provider.mismatch",
          `当前线程运行在 ${threadProvider} 账户，不能使用 ${overrides.modelProvider} Provider 的模型 ${overrides.model ?? "当前模型"}；请新建会话切换模型，或改回当前会话可用模型。`,
          {
            provider: overrides.modelProvider,
            threadProvider,
            ...(overrides.model == null ? {} : { model: overrides.model }),
          },
        );
      }
    }
    let result;
    try {
      assertCurrent?.(binding.threadId);
      result = await this.codex.startTurn(
        binding.threadId,
        input,
        clientUserMessageId,
        workspace.cwd,
        { ...overrides, beforeSubmit: () => { assertAuthorized?.(); assertCurrent?.(binding.threadId); } },
      );
    } catch (error) {
      this.recordTurnError("start", target, binding.threadId, null, error);
      throw error;
    }
    this.models.markApplied(target);
    this.collaborationModes?.markApplied(target);
    if (identity) {
      this.core.markTurnStarted(target, binding.threadId, result.turnId, identity);
    } else {
      this.core.markTurnStarted(target, binding.threadId, result.turnId);
    }
    return { threadId: binding.threadId, turnId: result.turnId, steered: false };
  }

  private recordTurnError(
    phase: TurnErrorPhase,
    target: ConversationTarget,
    threadId: string | null,
    turnId: string | null,
    error: unknown,
  ): void {
    if (!this.turnErrorRecorder) return;
    const status = this.models.status(target);
    this.turnErrorRecorder.recordTurnError({
      provider: status.modelProvider ?? "openai",
      model: status.model ?? null,
      threadId,
      turnId,
      phase,
      errorType: turnErrorType(error, phase),
      errorCode: turnErrorCode(error),
      message: turnErrorMessage(error),
      recordedAtMs: Date.now(),
    });
  }

  private turnOverrides(target: ConversationTarget) {
    const collaborationMode = this.collaborationModes?.turnOverride(target);
    return {
      ...this.models.turnOverrides(target),
      ...(collaborationMode ? { collaborationMode } : {}),
    };
  }

  /** Local selection guard; native clients can still change Queue concurrently. */
  private withGuardedSelection<T>(target: ConversationTarget, select: () => Promise<T>, assertAuthorized?: () => void): Promise<T> {
    const threadId = this.router.current(target)?.threadId;
    return this.locked(target, async () => {
      assertAuthorized?.();
      if (this.router.current(target)?.threadId !== threadId) {
        throw new UserFacingError("command.authorization-changed", "模型选择期间会话已变化");
      }
      this.requireIdle(target);
      await this.rejectQueueWhenPendingOverrideChanges(target, assertAuthorized);
      assertAuthorized?.();
      if (this.router.current(target)?.threadId !== threadId) {
        throw new UserFacingError("command.authorization-changed", "模型选择期间会话已变化");
      }
      try {
        const state = await select();
        assertAuthorized?.();
        await this.rejectQueueWhenPendingOverrideChanges(target, assertAuthorized);
        assertAuthorized?.();
        return state;
      } catch (error) {
        if (error instanceof UserFacingError && error.code === "queue.pending-overrides") {
          this.clearPendingSelections(target);
        }
        throw error;
      }
    });
  }

  private clearPendingSelections(target: ConversationTarget): void {
    this.models.clear(target);
    this.collaborationModes?.clear(target);
  }

  private async rejectQueueWhenPendingOverrideChanges(target: ConversationTarget, assertAuthorized?: () => void): Promise<void> {
    await this.queueUseCases.rejectPendingOverrideChange(target, assertAuthorized);
  }

  private async probeNativeQueueItems(threadId: string, assertAuthorized?: () => void): Promise<boolean> {
    return this.queueUseCases.hasItems(threadId, assertAuthorized);
  }

  async releaseBackgroundIfComplete(
    threadId: string,
    options: { dispatchQueued?: boolean; isCurrent?: () => boolean } = {},
  ): Promise<boolean> {
    // Retries must keep the latest completion's dispatch policy: interruption
    // preserves Queue entries even when subagent settlement delays release.
    this.pendingBackgroundReleases.set(threadId, options.dispatchQueued !== false);
    const current = this.backgroundReleaseAttempts.get(threadId);
    if (current) return current;
    const attempt = this.performBackgroundRelease(threadId, options.isCurrent);
    this.backgroundReleaseAttempts.set(threadId, attempt);
    try {
      return await attempt;
    } finally {
      if (this.backgroundReleaseAttempts.get(threadId) === attempt) {
        this.backgroundReleaseAttempts.delete(threadId);
      }
    }
  }

  private async performBackgroundRelease(
    threadId: string,
    canRelease: () => boolean = () => true,
  ): Promise<boolean> {
    if (!canRelease()) return false;
    if (!this.router.isBackgroundThread(threadId)) {
      this.pendingBackgroundReleases.delete(threadId);
      return false;
    }
    if (this.hasPendingSubagentRuns?.(threadId)) {
      return false;
    }
    if (this.pendingBackgroundReleases.get(threadId) !== false) {
      const queueState = await this.dispatchNativeQueueBeforeRelease(threadId);
      if (queueState !== "empty" && queueState !== "unavailable") {
        return false;
      }
    } else if (await this.probeNativeQueueItems(threadId)) {
      return false;
    }
    const target = this.router.targetForThread(threadId);
    if (!target || !canRelease() || this.hasLocalThreadWork(threadId)) return false;
    const activity = this.core.trackThreadActivity(threadId);
    let released;
    try {
      released = await this.router.releaseBackground(threadId, {
        isCurrent: () => canRelease() && !this.hasLocalThreadWork(threadId),
        verifyIdle: () => this.isThreadIdle(threadId),
        canRestore: canRelease,
        restored: thread => activity.restore(target, thread.activeTurnId),
      });
    } finally { activity.stop(); }
    if (!released) return false;
    this.pendingBackgroundReleases.delete(threadId);
    return true;
  }

  private hasLocalThreadWork(threadId: string): boolean {
    return this.core.activeTurnForThread(threadId) !== undefined
      || this.hasPendingSubagentRuns?.(threadId) === true
      || this.transfers?.hasPendingInteraction(threadId) === true;
  }

  private async isThreadIdle(threadId: string): Promise<boolean> {
    if (this.hasLocalThreadWork(threadId)) return false;
    const signal = AbortSignal.timeout(10_000);
    const snapshot = await this.router.readThread(threadId, signal);
    if (snapshot.status.type !== "idle" && snapshot.status.type !== "notLoaded") return false;
    if (await this.router.hasActiveDescendants(threadId, signal)) return false;
    if (await this.probeNativeQueueItems(threadId)) return false;
    return !this.hasLocalThreadWork(threadId);
  }

  /**
   * Retry a completion that raced the App Server's idle transition. The caller
   * must invoke this from a later lifecycle event; this method never waits in
   * the App Server notification reader itself.
   */
  retryPendingBackgroundRelease(threadId: string, isCurrent?: () => boolean): Promise<boolean> {
    const dispatchQueued = this.pendingBackgroundReleases.get(threadId);
    if (dispatchQueued === undefined) {
      return Promise.resolve(false);
    }
    return this.releaseBackgroundIfComplete(threadId, { dispatchQueued, ...(isCurrent ? { isCurrent } : {}) });
  }

  private async dispatchNativeQueueBeforeRelease(
    threadId: string,
  ): Promise<"empty" | "started" | "busy" | "unavailable"> {
    const queue = this.threadQueue;
    if (!queue) return "unavailable";
    try {
      // `thread/queue/start` takes the same per-Thread dispatch lock as the
      // 0.148 idle contributor. It is used here as a completion barrier: an
      // already queued item is either started or observed empty only after
      // the native dispatcher has finished its own start/delete sequence.
      await queue.startQueueItem(threadId);
      return "started";
    } catch (error) {
      const mapped = queueUserFacingError(error, "start");
      if (mapped.code === "queue.empty") return "empty";
      if (mapped.code === "queue.unavailable") return "unavailable";
      if (mapped.code === "queue.busy") return "busy";
      if (mapped.code === "queue.item-not-found") return "busy";
      throw mapped;
    }
  }

  private restoreSelectionsAfterBindingChange(
    target: ConversationTarget,
    modelPreference: ModelSelectionPreference | undefined,
  ): void {
    if (this.models.restorePreference) {
      this.models.restorePreference(target, modelPreference);
    } else {
      this.models.clear?.(target);
    }
    this.collaborationModes?.clear(target);
  }

  private clearConversationState(target: ConversationTarget): void {
    this.clearPendingSelections(target);
    this.queueUseCases.clearSnapshot(target);
    this.invalidateRevertSnapshot(target);
  }

  private requireCollaborationModes(): CollaborationModeSelectionService {
    if (!this.collaborationModes) {
      throw new UserFacingError("collaboration-mode.unavailable", "Plan 模式服务不可用");
    }
    return this.collaborationModes;
  }

  private requireIdle(target: ConversationTarget): void {
    if (this.core.activeTurn(target)) {
      throw new UserFacingError("conversation.busy", "当前任务运行中，请先停止当前任务");
    }
  }

  private async locked<T>(
    target: ConversationTarget,
    action: () => Promise<T> | T,
  ): Promise<T> {
    return this.locks.forConversation(target, action);
  }

  private async authorizedLocked<T>(target: ConversationTarget, assertAuthorized: (() => void) | undefined,
    action: () => Promise<T> | T): Promise<T> {
    assertAuthorized?.();
    const threadId = this.router.current(target)?.threadId;
    return this.locked(target, () => {
      assertAuthorized?.();
      if (this.router.current(target)?.threadId !== threadId) {
        throw new UserFacingError("command.authorization-changed", "命令等待期间会话已变化");
      }
      return action();
    });
  }

  private lockedTargets<T>(
    targets: readonly ConversationTarget[],
    action: () => Promise<T> | T,
  ): Promise<T> {
    return this.locks.forConversations(targets, action);
  }
}

function normalizeInput(value: string | ConversationInput): TurnInput[] {
  const normalized = typeof value === "string" ? { text: value } : value;
  const input: TurnInput[] = [];
  const text = normalized.text?.trim();
  if (text) {
    input.push({ type: "text", text });
  }
  for (const image of normalized.images ?? []) {
    if (!isInlineImageDataUrl(image.url)) {
      throw new UserFacingError(
        "image.url.invalid",
        "图片必须使用 PNG、JPEG、WebP 或非动画 GIF Base64 Data URL",
      );
    }
    input.push({ type: "image", url: image.url });
  }
  for (const audio of normalized.localAudios ?? []) {
    if (!isAbsolute(audio.path)) {
      throw new UserFacingError("audio.path.invalid", "本地音频路径必须是绝对路径");
    }
    input.push({ type: "localAudio", path: audio.path });
  }
  return input;
}

function isInlineImageDataUrl(value: string): boolean {
  return /^data:image\/(?:png|jpeg|gif|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/u.test(value);
}

function resolveAgentRole(
  roles: readonly AgentRoleEntry[],
  selector: string,
): AgentRoleEntry | undefined {
  const normalized = selector.trim().toLowerCase();
  const exact = roles.find((role) => role.name.toLowerCase() === normalized);
  if (exact) return exact;
  if (/^\d+$/u.test(normalized)) {
    const index = Number(normalized) - 1;
    return roles[index];
  }
  return undefined;
}
