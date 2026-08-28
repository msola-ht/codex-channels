import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  estimateWeeklyLimit,
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
import type { RemoteQuotaSummary } from "../conversation-core/index.js";
import type { InstalledSkill, SkillQueryPort } from "./skill-port.js";
import type {
  McpLoginResult,
  McpHealthReport,
  McpQueryPort,
  McpResourceReadResult,
  McpServerDetail,
  McpServerSummary,
} from "./mcp-port.js";
import { supportsMcpOAuthLogin } from "./mcp-port.js";
import type {
  InstalledPlugin,
  InstalledPluginCatalog,
  PluginHealthReport,
  PluginQueryPort,
} from "./plugin-port.js";
import type {
  PermissionProfileOption,
  PermissionQueryPort,
} from "./permission-port.js";
import type {
  SessionRouter,
  ThreadSectionSnapshot,
} from "../session-routing/index.js";
import type {
  ThreadOccupancyPort,
  ThreadOccupancyReleaseResult,
} from "./thread-occupancy-port.js";
import type { Workspace } from "../policy/index.js";
import type {
  WorkspacePermissionPort,
  WorkspacePermissionUpdate,
} from "./workspace-permission-port.js";
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
  type ThreadTokenUsage,
  type TurnStartIdentity,
  type TurnArtifacts,
} from "../conversation-core/index.js";
import type {
  ModelSelectionPreference,
  ModelSelectionService,
  ModelSelectionState,
} from "./model-selection-service.js";
import type {
  ReviewTarget,
  TurnExecutionPort,
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

export interface ConversationSession {
  selector?: string;
  id: string;
  preview: string;
  name: string | null;
  isPinned: boolean;
  section?: ThreadSectionSnapshot | null;
  modelProvider?: string;
  status: { type: "notLoaded" | "idle" | "systemError" | "active" };
  model?: string;
}

export interface ConversationSessionQuery {
  archived?: boolean;
  searchTerm?: string;
  filter?: "all" | "running" | "pinned" | "unsectioned";
  provider?: string;
  sectionSelector?: string;
}

export interface ThreadSectionView extends ThreadSectionSnapshot {
  currentWorkspaceActiveCount: number;
  currentWorkspaceArchivedCount: number;
}

export interface ThreadSectionDeletePreview {
  section: ThreadSectionView;
}

export interface ProjectRulesResult {
  projectRoot: string;
  rulesPath: string;
}

export interface ProjectRulesPort {
  initialize(projectRoot: string): Promise<ProjectRulesResult> | ProjectRulesResult;
  check(projectRoot: string): Promise<ProjectRulesResult> | ProjectRulesResult;
}

export interface WorkspaceStatusPort {
  currentGitBranch(projectRoot: string): string | undefined;
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

export type ConversationQueryPort =
  & AccountQueryPort
  & SkillQueryPort
  & McpQueryPort
  & PluginQueryPort
  & PermissionQueryPort;

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

const maximumBackgroundThreadsPerConversation = 3;

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

/** Stable application boundary consumed by commands and external Surfaces. */
export interface ConversationUseCases {
  submit(target: ConversationTarget, value: string | ConversationInput): Promise<Submission>;
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
  queueAdd(target: ConversationTarget, value: string): Promise<ThreadQueueItem>;
  queueList(target: ConversationTarget, page?: number): Promise<ThreadQueueListResult>;
  queueUpdate(
    target: ConversationTarget,
    selector: string,
    value: string,
  ): Promise<ThreadQueueItem>;
  queueDelete(target: ConversationTarget, selector: string): Promise<{ deleted: boolean }>;
  queueReorder(
    target: ConversationTarget,
    selector: string,
    position: number,
  ): Promise<ThreadQueueReorderResult>;
  queueStart(target: ConversationTarget, selector?: string): Promise<{ turnId: string }>;
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
  listSessions(
    target: ConversationTarget,
    options?: ConversationSessionQuery,
  ): Promise<ConversationSession[]>;
  listThreadSections(target: ConversationTarget): Promise<ThreadSectionView[]>;
  createThreadSection(target: ConversationTarget, name: string): Promise<ThreadSectionSnapshot>;
  renameThreadSection(
    target: ConversationTarget,
    selector: string,
    name: string,
  ): Promise<ThreadSectionSnapshot>;
  moveCurrentThreadToSection(
    target: ConversationTarget,
    selector: string,
    beforeThreadSelector?: string,
  ): Promise<ThreadSectionSnapshot>;
  removeCurrentThreadSection(target: ConversationTarget): Promise<void>;
  previewThreadSectionDelete(
    target: ConversationTarget,
    selector: string,
  ): Promise<ThreadSectionDeletePreview>;
  deleteThreadSection(target: ConversationTarget, selector: string): Promise<ThreadSectionSnapshot>;
  backgroundThreadIds?(target: ConversationTarget): string[];
  resume(target: ConversationTarget, selector: string): Promise<ConversationResumeResult>;
  newSession(target: ConversationTarget): Promise<string | undefined>;
  archive(target: ConversationTarget): Promise<string>;
  unarchive(target: ConversationTarget, selector: string): Promise<string>;
  artifacts(target: ConversationTarget): TurnArtifacts | undefined;
  listWorkspaces(): Workspace[];
  selectWorkspace(target: ConversationTarget, selector: string): Promise<Workspace>;
  updateWorkspacePermissions(
    target: ConversationTarget,
    update: WorkspacePermissionUpdate,
  ): Promise<Workspace>;
  stop(target: ConversationTarget): Promise<boolean>;
  rename(target: ConversationTarget, name: string): Promise<void>;
  setPinned(target: ConversationTarget, pinned: boolean): Promise<boolean>;
  compact(target: ConversationTarget): Promise<void>;
  fork(target: ConversationTarget): Promise<string>;
  togglePlanMode(target: ConversationTarget): Promise<CollaborationModeState>;
  startPlan(target: ConversationTarget, prompt: string): Promise<Submission>;
  review(target: ConversationTarget, reviewTarget: ReviewTarget): Promise<Submission>;
  modelState(target: ConversationTarget): Promise<ModelSelectionState>;
  clearModelSelection(target: ConversationTarget): Promise<ModelSelectionState>;
  selectModel(target: ConversationTarget, selector: string): Promise<ModelSelectionState>;
  selectEffort(target: ConversationTarget, selector: string): Promise<ModelSelectionState>;
  selectFastMode(target: ConversationTarget, selector: string): Promise<ModelSelectionState>;
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
  accountUsage(): Promise<AccountUsage>;
  accountRateLimits(): Promise<AccountRateLimits>;
  providerAccountUsage(target: ConversationTarget): Promise<ProviderAccountUsage>;
  providerAccountLimits(target: ConversationTarget): Promise<ProviderAccountLimits>;
  requestMetrics(
    target: ConversationTarget,
    query?: RequestMetricsCommandQuery,
  ): RequestMetricsResult | null;
  listPermissionProfiles(target: ConversationTarget): Promise<PermissionProfileOption[]>;
  initializeProjectRules(target: ConversationTarget): Promise<ProjectRulesResult>;
  checkProjectRules(target: ConversationTarget): Promise<ProjectRulesResult>;
  getGoal(target: ConversationTarget): Promise<ThreadGoal | null>;
  setGoal(target: ConversationTarget, objective: string): Promise<ThreadGoal>;
  clearGoal(target: ConversationTarget): Promise<void>;
  releaseThread(
    target: ConversationTarget,
    force?: boolean,
  ): Promise<ThreadOccupancyReleaseResult>;
  status(
    target: ConversationTarget,
    options?: { includeGitBranch?: boolean },
  ): ConversationStatus;
}

export class ConversationService implements ConversationUseCases {
  private readonly locks = new ConversationLockCoordinator();
  private readonly queueUseCases: ThreadQueueService;
  private readonly revertUseCases: ThreadRevertService;
  private readonly pendingBackgroundReleases = new Set<string>();
  private readonly backgroundReleaseAttempts = new Map<string, Promise<boolean>>();

  constructor(
    private readonly codex: TurnExecutionPort,
    private readonly router: SessionRouter,
    private readonly core: ConversationCore,
    private readonly models: ModelSelectionService,
    private readonly queries: ConversationQueryPort,
    private readonly projectRules?: ProjectRulesPort,
    private readonly workspaceStatus?: WorkspaceStatusPort,
    private readonly collaborationModes?: CollaborationModeSelectionService,
    private readonly transfers?: ConversationTransferPort,
    private readonly providerAccounts?: ProviderAccountQueryPort,
    private readonly requestMetricsQuery?: RequestMetricsQueryPort,
    private readonly workspacePermissions?: WorkspacePermissionPort,
    private readonly turnErrorRecorder?: TurnErrorRecorder,
    private readonly agentRoles?: AgentRolePort,
    private readonly experimentalFeatures: { pluginApiEnabled: boolean } = {
      pluginApiEnabled: false,
    },
    private readonly threadOccupancy?: ThreadOccupancyPort,
    private readonly threadQueue?: ThreadQueuePort,
    threadHistory?: ThreadHistoryPort,
    private readonly remoteQuotaReader?: (
      provider: string,
      resetsAt: number,
    ) => Promise<RemoteQuotaSummary | undefined>,
  ) {
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

  requestMetrics(
    target: ConversationTarget,
    query: RequestMetricsCommandQuery = { view: "session" },
  ): RequestMetricsResult | null {
    if (!this.requestMetricsQuery) return null;
    if (query.view === "errors") {
      return this.requestMetricsQuery.errors(query.range ?? "24h");
    }
    if (query.view !== "session") {
      return this.requestMetricsQuery.aggregate(
        query.view,
        query.range ?? "24h",
      );
    }
    const threadId = this.router.current(target)?.threadId;
    return threadId ? this.requestMetricsQuery.forThread(threadId) : null;
  }

  submit(target: ConversationTarget, value: string | ConversationInput): Promise<Submission> {
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
    return this.submitInput(target, input);
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
      const skillName = await this.resolveSkillName(
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
    this.requirePluginApiEnabled();
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
          "开发中的 Plugin 调用当前只支持 OpenAI Thread",
        );
      }
      const workspace = this.router.workspace(target);
      const plugin = await this.resolvePlugin(
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
    return this.locked(
      target,
      () => this.submitInputLocked(target, input, identity),
    );
  }

  private async submitInputLocked(
    target: ConversationTarget,
    input: TurnInput[],
    identity?: TurnStartIdentity,
  ): Promise<Submission> {
    if (input.some((item) => item.type === "image")) {
      await this.models.requireInputModality(target, "image");
    }
    if (input.some((item) => item.type === "localAudio")) {
      await this.models.requireInputModality(target, "audio");
    }
    const active = this.core.activeTurn(target);
    const clientUserMessageId = `${gatewayUserMessageClientIdPrefix}${randomUUID()}`;
    if (active) {
      try {
        await this.codex.steerTurn(active.threadId, active.turnId, input, clientUserMessageId);
      } catch (error) {
        this.recordTurnError("steer", target, active.threadId, active.turnId, error);
        throw error;
      }
      return { threadId: active.threadId, turnId: active.turnId, steered: true };
    }
    return this.startNewTurn(target, input, clientUserMessageId, identity);
  }

  queueAdd(target: ConversationTarget, value: string): Promise<ThreadQueueItem> {
    return this.queueUseCases.add(target, value);
  }

  queueList(target: ConversationTarget, page = 1): Promise<ThreadQueueListResult> {
    return this.queueUseCases.list(target, page);
  }

  queueUpdate(
    target: ConversationTarget,
    selector: string,
    value: string,
  ): Promise<ThreadQueueItem> {
    return this.queueUseCases.update(target, selector, value);
  }

  queueDelete(target: ConversationTarget, selector: string): Promise<{ deleted: boolean }> {
    return this.queueUseCases.delete(target, selector);
  }

  queueReorder(
    target: ConversationTarget,
    selector: string,
    position: number,
  ): Promise<ThreadQueueReorderResult> {
    return this.queueUseCases.reorder(target, selector, position);
  }

  queueStart(target: ConversationTarget, selector?: string): Promise<{ turnId: string }> {
    return this.queueUseCases.start(target, selector);
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

  async listSessions(
    target: ConversationTarget,
    options: ConversationSessionQuery = {},
  ): Promise<ConversationSession[]> {
    const sectionId = options.sectionSelector
      ? resolveThreadSection(await this.codex.listThreadSections(), options.sectionSelector).id
      : null;
    const archiveOptions = options.archived === undefined ? {} : { archived: options.archived };
    const needsCompleteCatalog = Boolean(
      sectionId
      || options.searchTerm
      || options.provider
      || (options.filter && options.filter !== "all"),
    );
    const all = pinnedFirst(await this.router.list(target, {
      ...archiveOptions,
      ...(needsCompleteCatalog ? { fullScan: true } : {}),
    }));
    const ordered = sectionId
      ? await this.router.list(target, {
          ...archiveOptions,
          fullScan: true,
          sectionId,
          sortKey: "section_position",
          sortDirection: "asc",
          ...(options.searchTerm ? { searchTerm: options.searchTerm } : {}),
        })
      : options.searchTerm
        ? await this.router.list(target, {
            ...archiveOptions,
            fullScan: true,
            searchTerm: options.searchTerm,
          })
        : all;
    const selectors = new Map(all.map((thread, index) => [thread.id, String(index + 1)]));
    const normalizedProvider = options.provider?.trim().toLowerCase() || null;
    return ordered.map((thread) => ({ thread, selector: selectors.get(thread.id) }))
      .filter(({ thread }) => {
        if (normalizedProvider && thread.modelProvider.toLowerCase() !== normalizedProvider) {
          return false;
        }
        if (sectionId && thread.section?.id !== sectionId) return false;
        if (options.filter === "running" && thread.status.type !== "active") return false;
        if (options.filter === "pinned" && !thread.isPinned) return false;
        if (options.filter === "unsectioned" && thread.section != null) return false;
        return true;
      })
      .map(({ thread: { id, preview, name, isPinned, section, modelProvider, status }, selector }) => {
        const model = this.router.modelSettingsForThread(id)?.model;
        return {
          ...(selector ? { selector } : {}),
          id,
          preview,
          name,
          isPinned,
          ...(section === undefined ? {} : { section }),
          modelProvider,
          status,
          ...(model ? { model } : {}),
        };
      });
  }

  async listThreadSections(target: ConversationTarget): Promise<ThreadSectionView[]> {
    const [sections, active, archived] = await Promise.all([
      this.codex.listThreadSections(),
      this.router.list(target, { fullScan: true }),
      this.router.list(target, { archived: true, fullScan: true }),
    ]);
    return sections.map((section) => ({
      ...section,
      currentWorkspaceActiveCount: active.filter((thread) =>
        thread.section?.id === section.id
      ).length,
      currentWorkspaceArchivedCount: archived.filter((thread) =>
        thread.section?.id === section.id
      ).length,
    }));
  }

  createThreadSection(
    target: ConversationTarget,
    name: string,
  ): Promise<ThreadSectionSnapshot> {
    const normalized = normalizeThreadSectionName(name);
    return this.lockedThreadSections(
      target,
      () => this.codex.createThreadSection(normalized),
    );
  }

  renameThreadSection(
    target: ConversationTarget,
    selector: string,
    name: string,
  ): Promise<ThreadSectionSnapshot> {
    const normalized = normalizeThreadSectionName(name);
    return this.lockedThreadSections(target, async () => {
      const section = resolveMutableThreadSection(
        await this.codex.listThreadSections(),
        selector,
      );
      return this.codex.renameThreadSection(section.id, normalized);
    });
  }

  moveCurrentThreadToSection(
    target: ConversationTarget,
    selector: string,
    beforeThreadSelector?: string,
  ): Promise<ThreadSectionSnapshot> {
    return this.lockedThreadSections(target, async () => {
      const binding = this.router.current(target);
      if (!binding) {
        throw new UserFacingError("conversation.missing", "当前还没有 Codex Thread");
      }
      const section = resolveThreadSection(
        await this.codex.listThreadSections(),
        selector,
      );
      let beforeThreadId: string | undefined;
      if (beforeThreadSelector) {
        const sessions = pinnedFirst(await this.router.list(target, { fullScan: true }));
        const before = resolveThread(sessions, beforeThreadSelector);
        if (before.section?.id !== section.id) {
          throw new UserFacingError(
            "thread-section.before.invalid",
            "排序目标 Thread 不在所选分区中",
          );
        }
        beforeThreadId = before.id;
      }
      await this.codex.moveThreadToSection(binding.threadId, section.id, beforeThreadId);
      return section;
    });
  }

  removeCurrentThreadSection(target: ConversationTarget): Promise<void> {
    return this.lockedThreadSections(target, async () => {
      const binding = this.router.current(target);
      if (!binding) {
        throw new UserFacingError("conversation.missing", "当前还没有 Codex Thread");
      }
      await this.codex.moveThreadToSection(binding.threadId, null);
    });
  }

  async previewThreadSectionDelete(
    target: ConversationTarget,
    selector: string,
  ): Promise<ThreadSectionDeletePreview> {
    const sections = await this.listThreadSections(target);
    return { section: resolveMutableThreadSection(sections, selector) };
  }

  deleteThreadSection(
    target: ConversationTarget,
    selector: string,
  ): Promise<ThreadSectionSnapshot> {
    return this.lockedThreadSections(target, async () => {
      const section = resolveMutableThreadSection(
        await this.codex.listThreadSections(),
        selector,
      );
      if (selector.trim() !== section.id) {
        throw new UserFacingError(
          "thread-section.delete-confirmation.invalid",
          "删除确认必须使用预览返回的完整 Thread 分区 ID",
        );
      }
      await this.codex.deleteThreadSection(section.id);
      return section;
    });
  }

  backgroundThreadIds(target: ConversationTarget): string[] {
    return (this.router.backgroundBindings?.(target) ?? []).map((binding) => binding.threadId);
  }

  async resume(
    target: ConversationTarget,
    selector: string,
  ): Promise<ConversationResumeResult> {
    const sessions = pinnedFirst(await this.router.list(target));
    const selected = resolveThread(sessions, selector.trim());
    const owner = this.router.targetForThread(selected.id);
    if (owner && conversationTargetKey(owner) !== conversationTargetKey(target)) {
      if (this.router.isBackgroundThread?.(selected.id)) {
        throw new UserFacingError(
          "thread.takeover.busy",
          "运行中的后台 Thread 不能跨渠道接管",
        );
      }
      if (owner.surface === target.surface) {
        throw new UserFacingError(
          "thread.bound",
          "该 Codex Thread 已绑定到同一渠道中的其他会话",
        );
      }
      if (!this.transfers) {
        throw new UserFacingError(
          "thread.bound",
          "当前服务没有启用跨渠道 Thread 接管",
        );
      }
      const transfers = this.transfers;
      return this.lockedTargets([owner, target], async () => {
        const currentOwner = this.router.targetForThread(selected.id);
        if (
          !currentOwner
          || conversationTargetKey(currentOwner) !== conversationTargetKey(owner)
        ) {
          throw new UserFacingError(
            "thread.takeover.changed",
            "Codex Thread 绑定已变化，请重新选择",
          );
        }
        this.requireIdle(owner);
        this.requireIdle(target);
        const destination = this.router.current(target);
        const ownerHasQueue = await this.probeNativeQueueItems(selected.id);
        const destinationHasQueue = destination
          && destination.threadId !== selected.id
          ? await this.probeNativeQueueItems(destination.threadId)
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
        const transfer = await this.router.transferBinding(target, selected.id);
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
    return this.locked(target, async () => {
      const modelPreference = this.models.capturePreference?.(target);
      const currentOwner = this.router.targetForThread(selected.id);
      if (
        currentOwner
        && conversationTargetKey(currentOwner) !== conversationTargetKey(target)
      ) {
        throw new UserFacingError(
          "thread.takeover.changed",
          "Codex Thread 绑定已变化，请重新选择",
        );
      }
      const current = this.router.current?.(target);
      const leavesCurrent = current !== undefined && current.threadId !== selected.id;
      if (leavesCurrent && current && await this.probeNativeQueueItems(current.threadId)) {
        throw new UserFacingError(
          "conversation.background-queued",
          "当前任务仍有下一 Turn 排队消息，暂不能转入后台",
        );
      }
      const selectedHasQueue = await this.probeNativeQueueItems(selected.id);
      const active = this.core.activeTurn(target);
      const preserveCurrent = active !== undefined && leavesCurrent;
      if (
        preserveCurrent
        && !this.router.isBackgroundThread?.(selected.id)
        && (this.router.backgroundBindings?.(target).length ?? 0) >= maximumBackgroundThreadsPerConversation
      ) {
        throw new UserFacingError(
          "conversation.background-limit",
          `后台任务已满，最多同时运行 ${maximumBackgroundThreadsPerConversation} 个`,
        );
      }
      const binding = preserveCurrent
        ? await this.router.resume(target, selected.id, true)
        : await this.router.resume(target, selected.id);
      this.invalidateRevertSnapshot(target);
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

  newSession(target: ConversationTarget): Promise<string | undefined> {
    return this.locked(target, async () => {
      const modelPreference = this.models.capturePreference?.(target);
      const current = this.router.current?.(target);
      if (current && await this.probeNativeQueueItems(current.threadId)) {
        throw new UserFacingError(
          "conversation.background-queued",
          "当前任务仍有下一 Turn 排队消息，暂不能转入后台",
        );
      }
      const active = this.core.activeTurn(target);
      if (
        active
        && (this.router.backgroundBindings?.(target).length ?? 0) >= maximumBackgroundThreadsPerConversation
      ) {
        throw new UserFacingError(
          "conversation.background-limit",
          `后台任务已满，最多同时运行 ${maximumBackgroundThreadsPerConversation} 个`,
        );
      }
      await this.router.newSession(target, active !== undefined);
      this.invalidateRevertSnapshot(target);
      this.restoreSelectionsAfterBindingChange(target, modelPreference);
      return active?.threadId;
    });
  }

  archive(target: ConversationTarget): Promise<string> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      const threadId = await this.router.archive(target);
      this.invalidateRevertSnapshot(target);
      this.clearPendingSelections(target);
      return threadId;
    });
  }

  unarchive(target: ConversationTarget, selector: string): Promise<string> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      const current = this.router.current?.(target);
      if (current && await this.probeNativeQueueItems(current.threadId)) {
        throw new UserFacingError(
          "conversation.background-queued",
          "当前会话仍有排队消息，暂不能切换 Thread",
        );
      }
      this.requireIdle(target);
      const sessions = pinnedFirst(
        await this.router.list(target, { archived: true }),
      );
      const selected = resolveThread(sessions, selector.trim(), "unarchive");
      this.requireIdle(target);
      const binding = await this.router.unarchive(target, selected.id);
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

  selectWorkspace(target: ConversationTarget, selector: string): Promise<Workspace> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      if ((this.router.backgroundBindings?.(target).length ?? 0) > 0) {
        throw new UserFacingError(
          "conversation.busy",
          "仍有后台任务运行，暂不能切换 Workspace",
        );
      }
      const selected = this.router.resolveWorkspace(selector);
      const currentWorkspaceId = this.router.workspace(target).id;
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
      const workspace = await this.router.selectWorkspace(target, selected.id);
      if (workspace.id !== currentWorkspaceId) {
        this.invalidateRevertSnapshot(target);
        this.restoreSelectionsAfterBindingChange(target, modelPreference);
      }
      return workspace;
    });
  }

  updateWorkspacePermissions(
    target: ConversationTarget,
    update: WorkspacePermissionUpdate,
  ): Promise<Workspace> {
    if (!this.workspacePermissions) {
      throw new UserFacingError(
        "workspace.permission.unavailable",
        "当前 Gateway 不支持修改工作区权限",
      );
    }
    return this.locked(target, () => {
      const workspaceId = this.router.workspace(target).id;
      return this.workspacePermissions!.updateWorkspacePermissions(
        workspaceId,
        update,
      );
    });
  }

  stop(target: ConversationTarget): Promise<boolean> {
    return this.locked(target, async () => {
      const active = this.core.activeTurn(target);
      if (!active) {
        return false;
      }
      await this.codex.interruptTurn(active.threadId, active.turnId);
      return true;
    });
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
        throw new UserFacingError("conversation.missing", "当前还没有 Codex Thread");
      }
      await this.codex.setThreadName(binding.threadId, normalized);
    });
  }

  setPinned(target: ConversationTarget, pinned: boolean): Promise<boolean> {
    return this.locked(target, async () => {
      const binding = this.router.current(target);
      if (!binding) {
        throw new UserFacingError("conversation.missing", "当前还没有 Codex Thread");
      }
      return this.codex.setThreadPinned(binding.threadId, pinned);
    });
  }

  compact(target: ConversationTarget): Promise<void> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      const binding = await this.router.ensure(target);
      await this.codex.compactThread(binding.threadId);
    });
  }

  fork(target: ConversationTarget): Promise<string> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      const current = await this.router.ensure(target);
      if (await this.probeNativeQueueItems(current.threadId)) {
        throw new UserFacingError(
          "conversation.background-queued",
          "当前会话仍有排队消息，暂不能分叉 Thread",
        );
      }
      this.requireIdle(target);
      const binding = await this.router.fork(target);
      this.invalidateRevertSnapshot(target);
      this.clearPendingSelections(target);
      return binding.threadId;
    });
  }

  togglePlanMode(target: ConversationTarget): Promise<CollaborationModeState> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      await this.rejectQueueWhenPendingOverrideChanges(target);
      try {
        const state = await this.requireCollaborationModes().toggle(target);
        await this.rejectQueueWhenPendingOverrideChanges(target);
        return state;
      } catch (error) {
        if (error instanceof UserFacingError && error.code === "queue.pending-overrides") {
          this.clearPendingSelections(target);
        }
        throw error;
      }
    });
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
      const binding = await this.router.ensure(target);
      const result = await this.codex.startReview(binding.threadId, reviewTarget);
      this.core.markTurnStarted(target, result.threadId, result.turnId);
      return { threadId: result.threadId, turnId: result.turnId, steered: false };
    });
  }

  modelState(target: ConversationTarget): Promise<ModelSelectionState> {
    return this.models.state(target);
  }

  clearModelSelection(target: ConversationTarget): Promise<ModelSelectionState> {
    this.models.clear(target);
    return this.models.state(target);
  }

  selectModel(target: ConversationTarget, selector: string): Promise<ModelSelectionState> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      await this.rejectQueueWhenPendingOverrideChanges(target);
      try {
        const state = await this.models.selectModel(target, selector);
        await this.rejectQueueWhenPendingOverrideChanges(target);
        return state;
      } catch (error) {
        if (error instanceof UserFacingError && error.code === "queue.pending-overrides") {
          this.clearPendingSelections(target);
        }
        throw error;
      }
    });
  }

  selectEffort(target: ConversationTarget, selector: string): Promise<ModelSelectionState> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      await this.rejectQueueWhenPendingOverrideChanges(target);
      try {
        const state = await this.models.selectEffort(target, selector);
        await this.rejectQueueWhenPendingOverrideChanges(target);
        return state;
      } catch (error) {
        if (error instanceof UserFacingError && error.code === "queue.pending-overrides") {
          this.clearPendingSelections(target);
        }
        throw error;
      }
    });
  }

  selectFastMode(target: ConversationTarget, selector: string): Promise<ModelSelectionState> {
    if (selector.trim().toLowerCase() === "status") {
      return this.models.selectFastMode(target, selector);
    }
    return this.locked(target, async () => {
      this.requireIdle(target);
      await this.rejectQueueWhenPendingOverrideChanges(target);
      try {
        const state = await this.models.selectFastMode(target, selector);
        await this.rejectQueueWhenPendingOverrideChanges(target);
        return state;
      } catch (error) {
        if (error instanceof UserFacingError && error.code === "queue.pending-overrides") {
          this.clearPendingSelections(target);
        }
        throw error;
      }
    });
  }

  listSkills(target: ConversationTarget): Promise<InstalledSkill[]> {
    return this.queries.listSkills(this.router.workspace(target).cwd);
  }

  private async resolveSkillName(
    cwd: string,
    selector: string,
  ): Promise<string> {
    if (!/^[1-9]\d*$/u.test(selector)) {
      return selector;
    }
    const index = Number(selector);
    if (!Number.isSafeInteger(index)) {
      throw new UserFacingError("skill.not-found", "Skill 序号不存在");
    }
    const skill = (await this.queries.listSkills(cwd))[index - 1];
    if (!skill) {
      throw new UserFacingError("skill.not-found", "Skill 序号不存在");
    }
    return skill.name;
  }

  listMcpServers(target: ConversationTarget): Promise<McpServerSummary[]> {
    return this.queries.listMcpServers(this.router.current(target)?.threadId);
  }

  async mcpHealth(target: ConversationTarget): Promise<McpHealthReport> {
    const servers = await this.queries.listMcpServerDetails(
      this.router.current(target)?.threadId,
    );
    return {
      serverCount: servers.length,
      toolCount: servers.reduce((total, server) => total + server.tools.length, 0),
      resourceCount: servers.reduce(
        (total, server) => total + server.resources.length,
        0,
      ),
      resourceTemplateCount: servers.reduce(
        (total, server) => total + server.resourceTemplates.length,
        0,
      ),
      actions: servers.flatMap((server, index) =>
        server.authStatus === "notLoggedIn"
          ? [{
              type: "loginRequired" as const,
              server: server.name,
              selector: String(index + 1),
            }]
          : []
      ),
      notices: servers.flatMap((server, index) => [
        ...(server.authStatus === "unknown"
          ? [{
              type: "authUnknown" as const,
              server: server.name,
              selector: String(index + 1),
            }]
          : []),
        ...(server.authStatus !== "notLoggedIn"
          && server.authStatus !== "unknown"
          && server.tools.length === 0
          && server.resources.length === 0
          && server.resourceTemplates.length === 0
          ? [{
              type: "noCapabilities" as const,
              server: server.name,
              selector: String(index + 1),
            }]
          : []),
      ]),
    };
  }

  reloadMcpServers(target: ConversationTarget): Promise<void> {
    void target;
    return this.queries.reloadMcpServers();
  }

  async mcpServerDetail(
    target: ConversationTarget,
    selector: string,
  ): Promise<McpServerDetail> {
    const threadId = this.router.current(target)?.threadId;
    return resolveMcpServer(
      selector,
      await this.queries.listMcpServerDetails(threadId),
    );
  }

  async loginMcpServer(
    target: ConversationTarget,
    selector: string,
  ): Promise<McpLoginResult> {
    const threadId = this.router.current(target)?.threadId;
    const server = resolveMcpServer(
      selector,
      await this.queries.listMcpServers(threadId),
    );
    if (server.authStatus === "bearerToken") {
      return {
        type: "bearerToken",
        server: server.name,
      };
    }
    if (!supportsMcpOAuthLogin(server.authStatus)) {
      throw new UserFacingError(
        "mcp.oauth.unsupported",
        "该 MCP Server 不支持 OAuth 登录",
      );
    }
    if (!threadId) {
      throw new UserFacingError(
        "mcp.thread.required",
        "请先发送消息创建 Thread，或使用 /resume 恢复 Thread 后再登录 MCP Server",
      );
    }
    return {
      type: "oauth",
      ...await this.queries.startMcpOAuthLogin(server.name, threadId),
    };
  }

  async readMcpResource(
    target: ConversationTarget,
    selector: string,
    uri: string,
  ): Promise<McpResourceReadResult> {
    const normalizedUri = uri.trim();
    if (
      normalizedUri.length === 0
      || normalizedUri.length > 4_096
      || hasControlCharacters(normalizedUri)
    ) {
      throw new UserFacingError("mcp.resource.usage", "需要提供有效的 MCP Resource URI");
    }
    const threadId = this.router.current(target)?.threadId;
    const server = resolveMcpServer(
      selector,
      await this.queries.listMcpServers(threadId),
    );
    return this.queries.readMcpResource(
      server.name,
      normalizedUri,
      threadId,
    );
  }

  listPlugins(target: ConversationTarget): Promise<InstalledPluginCatalog> {
    this.requirePluginApiEnabled();
    return this.queries.listPlugins(this.router.workspace(target).cwd);
  }

  async pluginHealth(target: ConversationTarget): Promise<PluginHealthReport> {
    const catalog = await this.listPlugins(target);
    const issues: PluginHealthReport["issues"] = [];
    catalog.plugins.forEach((plugin, index) => {
      if (!plugin.available) {
        issues.push({
          type: "unavailable",
          plugin: plugin.displayName,
          selector: String(index + 1),
          reason: plugin.disabledReason,
        });
      } else if (!plugin.enabled) {
        issues.push({
          type: "notEnabled",
          plugin: plugin.displayName,
          selector: String(index + 1),
          reason: null,
        });
      }
    });
    return {
      installedCount: catalog.plugins.length,
      enabledCount: catalog.plugins.filter((plugin) => plugin.enabled).length,
      callableCount: catalog.plugins.filter((plugin) =>
        plugin.enabled && plugin.available
      ).length,
      marketplaceLoadErrorCount: catalog.loadErrorCount,
      issues,
    };
  }

  pluginDetail(
    target: ConversationTarget,
    selector: string,
  ): Promise<InstalledPlugin> {
    this.requirePluginApiEnabled();
    return this.resolvePlugin(this.router.workspace(target).cwd, selector);
  }

  private async resolvePlugin(
    cwd: string,
    selector: string,
  ): Promise<InstalledPlugin> {
    const { plugins } = await this.queries.listPlugins(cwd);
    if (/^[1-9]\d*$/u.test(selector)) {
      const index = Number(selector);
      const plugin = Number.isSafeInteger(index) ? plugins[index - 1] : undefined;
      if (!plugin) {
        throw new UserFacingError("plugin.not-found", "Plugin 序号不存在");
      }
      return plugin;
    }
    const normalized = selector.toLowerCase();
    const matches = plugins.filter((plugin) =>
      plugin.id.toLowerCase() === normalized
      || plugin.name.toLowerCase() === normalized
      || plugin.displayName.toLowerCase() === normalized
    );
    if (matches.length !== 1) {
      throw new UserFacingError(
        matches.length === 0 ? "plugin.not-found" : "plugin.ambiguous",
        matches.length === 0
          ? "指定的 Plugin 不存在"
          : "Plugin 名称不唯一，请使用序号或完整 ID",
      );
    }
    return matches[0]!;
  }

  private requirePluginApiEnabled(): void {
    if (!this.experimentalFeatures.pluginApiEnabled) {
      throw new UserFacingError(
        "plugin.disabled",
        "开发中的 Plugin API 已关闭；请在 [experimental] 中启用 plugin_api 后重启 Gateway",
      );
    }
  }

  accountUsage(): Promise<AccountUsage> {
    return this.queries.accountUsage();
  }

  accountRateLimits(): Promise<AccountRateLimits> {
    return this.queries.accountRateLimits();
  }

  providerAccountUsage(target: ConversationTarget): Promise<ProviderAccountUsage> {
    const binding = this.router.current(target);
    const model = this.models.status(target);
    const provider = model.modelProvider ?? "openai";
    const threadProvider = binding
      ? this.router.modelSettings(target)?.modelProvider ?? provider
      : undefined;
    const threadId = usesOpenAiAccount(provider) && usesOpenAiAccount(threadProvider)
      ? binding?.threadId
      : undefined;
    if (!this.providerAccounts) {
      return Promise.resolve({ kind: "unsupported", provider });
    }
    return threadId === undefined
      ? this.providerAccounts.accountUsage(provider)
      : this.providerAccounts.accountUsage(provider, threadId);
  }

  async providerAccountLimits(target: ConversationTarget): Promise<ProviderAccountLimits> {
    const provider = this.models.status(target).modelProvider ?? "openai";
    const resolved: ProviderAccountLimits = this.providerAccounts
      ? await this.providerAccounts.accountLimits(provider)
      : { kind: "unsupported", provider };
    if (resolved.kind !== "rate-limits" || !this.requestMetricsQuery) {
      return resolved;
    }
    const nowMs = Date.now();
    const weeklyEstimates = resolved.limits.limits.flatMap((limit) => {
      if (limit.limitId !== "codex") return [];
      const window = [limit.primary, limit.secondary].find(
        (candidate) => candidate?.windowDurationMins === 10_080,
      );
      if (!window || window.resetsAt === null) return [];
      const observation = this.requestMetricsQuery?.weeklyQuotaEstimate(
        "openai",
        limit.limitId,
        window.resetsAt,
        nowMs,
      ) ?? null;
      const estimate = estimateWeeklyLimit(limit, observation);
      return estimate === null ? [] : [estimate];
    });
    const estimates = this.remoteQuotaReader === undefined
      ? weeklyEstimates
      : await Promise.all(weeklyEstimates.map(async (estimate) => {
          const remote = await this.remoteQuotaReader!("openai", estimate.endAtMs / 1_000);
          if (!remote) return estimate;
          return {
            ...estimate,
            source: "center" as const,
            deviceCount: remote.deviceCount,
            periodRequestCount: remote.requestCount,
            periodTotalTokens: remote.totalTokens,
            periodTotalCostNanos: remote.totalCostNanos,
            totalTokensPerPercent: remote.tokensPerPercent ?? estimate.totalTokensPerPercent,
            costPerPercentNanos: remote.costPerPercentNanos ?? estimate.costPerPercentNanos,
          };
        }));
    return estimates.length === 0
      ? resolved
      : { ...resolved, weeklyEstimates: estimates };
  }

  listPermissionProfiles(target: ConversationTarget): Promise<PermissionProfileOption[]> {
    return this.queries.listPermissionProfiles(this.router.workspace(target).cwd);
  }

  async initializeProjectRules(target: ConversationTarget): Promise<ProjectRulesResult> {
    if (!this.projectRules) {
      throw new UserFacingError("rules.unavailable", "项目规则服务不可用");
    }
    try {
      return await this.projectRules.initialize(this.router.workspace(target).cwd);
    } catch (error) {
      throw projectRulesUserError(error, "init");
    }
  }

  async checkProjectRules(target: ConversationTarget): Promise<ProjectRulesResult> {
    if (!this.projectRules) {
      throw new UserFacingError("rules.unavailable", "项目规则服务不可用");
    }
    try {
      return await this.projectRules.check(this.router.workspace(target).cwd);
    } catch (error) {
      throw projectRulesUserError(error, "check");
    }
  }

  getGoal(target: ConversationTarget): Promise<ThreadGoal | null> {
    return this.locked(target, async () => {
      const binding = await this.router.ensure(target);
      return this.codex.getGoal(binding.threadId);
    });
  }

  setGoal(target: ConversationTarget, objective: string): Promise<ThreadGoal> {
    const normalized = objective.trim();
    if (!normalized) {
      return Promise.reject(new UserFacingError("goal.empty", "目标不能为空"));
    }
    return this.locked(target, async () => {
      const binding = await this.router.ensure(target);
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
      const binding = await this.router.ensure(target);
      await this.codex.clearGoal(binding.threadId);
      this.core.handle({
        type: "thread.goal.cleared",
        threadId: binding.threadId,
      });
    });
  }

  status(
    target: ConversationTarget,
    options: { includeGitBranch?: boolean } = {},
  ): ConversationStatus {
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
    const gitBranch = options.includeGitBranch
      ? this.workspaceStatus?.currentGitBranch(workspace.cwd)
      : undefined;
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
      ...(gitBranch ? { gitBranch } : {}),
      model: model.model,
      ...(model.modelProvider ? { modelProvider: model.modelProvider } : {}),
      effort: model.effort,
      serviceTier: model.serviceTier,
      modelPending: model.modelPending,
      effortPending: model.effortPending,
      fastModePending: model.serviceTierPending,
      collaborationMode: collaborationMode.mode,
      collaborationModePending: collaborationMode.pending,
    };
  }

  private async startNewTurn(
    target: ConversationTarget,
    input: TurnInput[],
    clientUserMessageId: string,
    identity?: TurnStartIdentity,
  ): Promise<Submission> {
    const threadStartOptions = this.models.threadStartOptions?.(target) ?? {};
    const binding = Object.keys(threadStartOptions).length > 0
      ? await this.router.ensure(target, threadStartOptions)
      : await this.router.ensure(target);
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
      result = await this.codex.startTurn(
        binding.threadId,
        input,
        clientUserMessageId,
        workspace.cwd,
        overrides,
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

  private clearPendingSelections(target: ConversationTarget): void {
    this.models.clear(target);
    this.collaborationModes?.clear(target);
  }

  private async rejectQueueWhenPendingOverrideChanges(target: ConversationTarget): Promise<void> {
    await this.queueUseCases.rejectPendingOverrideChange(target);
  }

  private async probeNativeQueueItems(threadId: string): Promise<boolean> {
    return this.queueUseCases.hasItems(threadId);
  }

  async releaseBackgroundIfComplete(
    threadId: string,
    options: { dispatchQueued?: boolean } = {},
  ): Promise<boolean> {
    const current = this.backgroundReleaseAttempts.get(threadId);
    if (current) return current;
    const attempt = this.performBackgroundRelease(threadId, options);
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
    options: { dispatchQueued?: boolean },
  ): Promise<boolean> {
    if (!this.router.isBackgroundThread(threadId)) {
      this.pendingBackgroundReleases.delete(threadId);
      return false;
    }
    this.pendingBackgroundReleases.add(threadId);
    if (options.dispatchQueued !== false) {
      const queueState = await this.dispatchNativeQueueBeforeRelease(threadId);
      if (queueState !== "empty" && queueState !== "unavailable") {
        return false;
      }
    } else if (await this.probeNativeQueueItems(threadId)) {
      return false;
    }
    const active = this.core.activeTurnForThread(threadId);
    if (active) {
      return false;
    }
    const readThread = this.router.readThread?.bind(this.router);
    if (readThread) {
      const snapshot = await readThread(threadId);
      if (snapshot.status.type === "active") {
        return false;
      }
    }
    await this.router.releaseBackground(threadId);
    this.pendingBackgroundReleases.delete(threadId);
    return true;
  }

  /**
   * Retry a completion that raced the App Server's idle transition. The caller
   * must invoke this from a later lifecycle event; this method never waits in
   * the App Server notification reader itself.
   */
  retryPendingBackgroundRelease(threadId: string): Promise<boolean> {
    if (!this.pendingBackgroundReleases.has(threadId)) {
      return Promise.resolve(false);
    }
    return this.releaseBackgroundIfComplete(threadId);
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
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (message.includes("queue is empty")) {
        return "empty";
      }
      const mapped = queueUserFacingError(error, "start");
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

  private lockedThreadSections<T>(
    target: ConversationTarget,
    action: () => Promise<T>,
  ): Promise<T> {
    return this.locks.forThreadSections(target, action);
  }

  private lockedTargets<T>(
    targets: readonly ConversationTarget[],
    action: () => Promise<T> | T,
  ): Promise<T> {
    return this.locks.forConversations(targets, action);
  }
}

function projectRulesUserError(error: unknown, operation: "init" | "check"): Error {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
  switch (code) {
    case "exists":
      return new UserFacingError("rules.exists", "当前 Workspace 已有项目规则");
    case "missing":
      return new UserFacingError("rules.missing", "当前 Workspace 尚未生成项目规则");
    case "unsafe-path":
      return new UserFacingError("rules.unsafe-path", "项目规则路径不能使用符号链接");
    case "check-failed":
      return new UserFacingError("rules.check-failed", "项目规则检查失败");
    default:
      return error instanceof UserFacingError
        ? error
        : new Error(
            `项目规则${operation === "init" ? "生成" : "检查"}失败`,
            { cause: error },
          );
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

export function resolveThread<T extends Pick<ConversationSession, "id" | "name">>(
  threads: T[],
  selector: string,
  command: "resume" | "unarchive" = "resume",
): T {
  if (!selector) {
    throw new UserFacingError(
      "session.selector.required",
      "需要提供会话序号、名称或 Thread ID",
      { command },
    );
  }
  if (/^\d+$/.test(selector)) {
    const index = Number(selector) - 1;
    const thread = threads[index];
    if (thread) {
      return thread;
    }
  }
  const exact = threads.filter((thread) => thread.id === selector || thread.name === selector);
  if (exact.length === 1) {
    return exact[0]!;
  }
  const prefix = threads.filter((thread) => thread.id.startsWith(selector));
  if (prefix.length === 1) {
    return prefix[0]!;
  }
  const ambiguous = prefix.length > 1 || exact.length > 1;
  throw new UserFacingError(
    ambiguous ? "session.selector.ambiguous" : "session.selector.not-found",
    ambiguous ? "会话选择不唯一" : "找不到指定会话",
  );
}

function pinnedFirst<T extends { isPinned: boolean }>(
  sessions: readonly T[],
): T[] {
  return sessions.toSorted((left, right) =>
    Number(right.isPinned) - Number(left.isPinned));
}

function normalizeThreadSectionName(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > 64
    || [...normalized].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 0x1f || code === 0x7f);
    })
  ) {
    throw new UserFacingError(
      "thread-section.name.invalid",
      "Thread 分区名称必须为 1–64 个不含控制字符的字符",
    );
  }
  return normalized;
}

function resolveThreadSection<T extends ThreadSectionSnapshot>(
  sections: readonly T[],
  selector: string,
): T {
  const normalized = selector.trim();
  if (/^[1-9]\d*$/u.test(normalized)) {
    const section = sections[Number(normalized) - 1];
    if (section) return section;
  }
  const lowered = normalized.toLowerCase();
  const exact = sections.filter((section) =>
    section.id.toLowerCase() === lowered || section.name.toLowerCase() === lowered
  );
  if (exact.length === 1) return exact[0]!;
  const prefixes = sections.filter((section) => section.id.toLowerCase().startsWith(lowered));
  if (prefixes.length === 1) return prefixes[0]!;
  throw new UserFacingError(
    exact.length > 1 || prefixes.length > 1
      ? "thread-section.selector.ambiguous"
      : "thread-section.selector.not-found",
    exact.length > 1 || prefixes.length > 1
      ? "Thread 分区选择不唯一，请使用序号或完整 ID"
      : "找不到指定 Thread 分区",
  );
}

function resolveMutableThreadSection<T extends ThreadSectionSnapshot>(
  sections: readonly T[],
  selector: string,
): T {
  const section = resolveThreadSection(sections, selector);
  if (section.builtIn === "pinned") {
    throw new UserFacingError(
      "thread-section.pinned.immutable",
      "官方内置 Pinned 分区不能改名或删除",
    );
  }
  return section;
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

export function turnErrorType(error: unknown, phase: TurnErrorPhase): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("You've hit your usage limit")) {
    return "usage_limit_reached";
  }
  if (phase === "start") return "turn_start_error";
  if (phase === "steer") return "turn_steer_error";
  return "turn_notification_error";
}

export function turnErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "number" && Number.isSafeInteger(code)) {
    return `rpc:${code}`;
  }
  return typeof code === "string" && code.length > 0 && code.length <= 64
    ? code
    : null;
}

export function turnErrorMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const message = error.message.replace(/\s+/gu, " ").trim();
  if (message.length === 0) return null;
  return message.length <= 500 ? message : `${message.slice(0, 500)}…`;
}

function resolveMcpServer<T extends McpServerSummary>(
  selector: string,
  servers: readonly T[],
): T {
  const normalizedSelector = selector.trim();
  if (!normalizedSelector) {
    throw new UserFacingError("mcp.server.usage", "需要提供 MCP Server 名称或序号");
  }
  if (/^[1-9]\d*$/u.test(normalizedSelector)) {
    const index = Number(normalizedSelector);
    const server = Number.isSafeInteger(index) ? servers[index - 1] : undefined;
    if (server) return server;
  } else {
    const server = servers.find((candidate) =>
      candidate.name.toLowerCase() === normalizedSelector.toLowerCase()
    );
    if (server) return server;
  }
  throw new UserFacingError("mcp.server.not-found", "指定的 MCP Server 不存在");
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}
