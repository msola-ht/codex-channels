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
import type { InstalledSkill, SkillQueryPort } from "./skill-port.js";
import type {
  McpOAuthLogin,
  McpQueryPort,
  McpResourceReadResult,
  McpServerDetail,
  McpServerSummary,
} from "./mcp-port.js";
import { supportsMcpOAuthLogin } from "./mcp-port.js";
import type { InstalledPlugin, PluginQueryPort } from "./plugin-port.js";
import type {
  PermissionProfileOption,
  PermissionQueryPort,
} from "./permission-port.js";
import type { SessionRouter } from "../session-routing/index.js";
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
  type TurnArtifacts,
} from "../conversation-core/index.js";
import type { ModelSelectionService, ModelSelectionState } from "./model-selection-service.js";
import type {
  ReviewTarget,
  TurnExecutionPort,
  TurnInput,
} from "./turn-port.js";
import type {
  CollaborationModeSelectionService,
  CollaborationModeState,
} from "./collaboration-mode-service.js";
import {
  replaceLocalImagesWithVisionContext,
  visionUserPrompt,
  type VisionRecognitionPort,
} from "./vision-port.js";

export interface Submission {
  threadId: string;
  turnId: string;
  steered: boolean;
}

export interface ConversationInput {
  text?: string;
  localImages?: ReadonlyArray<{ path: string }>;
  localAudios?: ReadonlyArray<{ path: string }>;
}

export interface ConversationSession {
  id: string;
  preview: string;
  name: string | null;
  isPinned: boolean;
  status: { type: "notLoaded" | "idle" | "systemError" | "active" };
  model?: string;
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

interface QueuedFollowUp {
  threadId: string;
  input: TurnInput[];
}

const maximumQueuedFollowUpsPerConversation = 10;
const maximumBackgroundThreadsPerConversation = 3;
const maximumConcurrentVisionRecognitions = 2;
const visionHeartbeatInitialDelayMs = 10_000;
const visionHeartbeatIntervalMs = 20_000;

export interface ConversationStatus {
  threadId?: string;
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
  queueFollowUp(target: ConversationTarget, value: string): Promise<{ position: number }>;
  handleTurnCompleted(
    target: ConversationTarget,
    threadId: string,
  ): Promise<Submission | undefined>;
  listSessions(
    target: ConversationTarget,
    options?: { archived?: boolean; searchTerm?: string },
  ): Promise<ConversationSession[]>;
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
  setPinned(target: ConversationTarget, pinned: boolean): Promise<void>;
  compact(target: ConversationTarget): Promise<void>;
  fork(target: ConversationTarget): Promise<string>;
  togglePlanMode(target: ConversationTarget): Promise<CollaborationModeState>;
  startPlan(target: ConversationTarget, prompt: string): Promise<Submission>;
  review(target: ConversationTarget, reviewTarget: ReviewTarget): Promise<Submission>;
  modelState(target: ConversationTarget): Promise<ModelSelectionState>;
  selectModel(target: ConversationTarget, selector: string): Promise<ModelSelectionState>;
  selectEffort(target: ConversationTarget, selector: string): Promise<ModelSelectionState>;
  selectFastMode(target: ConversationTarget, selector: string): Promise<ModelSelectionState>;
  listSkills(target: ConversationTarget): Promise<InstalledSkill[]>;
  listMcpServers(target: ConversationTarget): Promise<McpServerSummary[]>;
  mcpServerDetail(target: ConversationTarget, selector: string): Promise<McpServerDetail>;
  startMcpOAuthLogin(target: ConversationTarget, selector: string): Promise<McpOAuthLogin>;
  readMcpResource(
    target: ConversationTarget,
    selector: string,
    uri: string,
  ): Promise<McpResourceReadResult>;
  listPlugins(target: ConversationTarget): Promise<InstalledPlugin[]>;
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
  status(
    target: ConversationTarget,
    options?: { includeGitBranch?: boolean },
  ): ConversationStatus;
}

export class ConversationService implements ConversationUseCases {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly queuedFollowUps = new Map<string, QueuedFollowUp[]>();
  private activeVisionRecognitions = 0;

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
    private readonly vision?: VisionRecognitionPort,
    private readonly requestMetricsQuery?: RequestMetricsQueryPort,
    private readonly workspacePermissions?: WorkspacePermissionPort,
    private readonly turnErrorRecorder?: TurnErrorRecorder,
    private readonly agentRoles?: AgentRolePort,
    private readonly experimentalFeatures: { pluginApiEnabled: boolean } = {
      pluginApiEnabled: true,
    },
  ) {}

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
      ]);
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
    if ((this.models.status(target).modelProvider ?? "openai") !== "openai") {
      throw new UserFacingError(
        "plugin.provider.unsupported",
        "开发中的 Plugin 调用当前只支持 OpenAI Thread",
      );
    }
    return this.locked(target, async () => {
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
      ]);
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
    ]);
    return { ...submission, roleName: role.name };
  }

  private submitInput(
    target: ConversationTarget,
    input: TurnInput[],
  ): Promise<Submission> {
    return this.locked(
      target,
      () => this.submitInputLocked(target, input),
    );
  }

  private async submitInputLocked(
    target: ConversationTarget,
    input: TurnInput[],
  ): Promise<Submission> {
    if (input.some((item) => item.type === "localImage")) {
      try {
        await this.models.requireInputModality(target, "image");
      } catch (error) {
        if (
          !(error instanceof UserFacingError)
          || error.code !== "model.input.image.unsupported"
          || !this.vision
        ) {
          throw error;
        }
        const images = input.flatMap((item) =>
          item.type === "localImage" ? [{ path: item.path }] : []
        );
        const releaseVisionRecognition = this.reserveVisionRecognition();
        let result;
        let stopHeartbeat = (): void => {};
        let requestStarted = false;
        try {
          const threadId = this.router.current(target)?.threadId ?? null;
          result = await this.vision.recognize({
            images,
            userPrompt: visionUserPrompt(input),
            threadId,
            reasoningEffort: threadId === null
              ? null
              : this.router.modelSettingsForThread(threadId)?.effort ?? null,
            onRequestStarted: () => {
              if (requestStarted) return;
              requestStarted = true;
              this.core.visionStarted(target, { imageCount: images.length });
              stopHeartbeat = this.startVisionHeartbeat(target);
            },
          });
          this.core.visionCompleted(target, {
            provider: result.provider,
            model: result.model,
            ...(result.elapsedMs === undefined
              ? {}
              : { elapsedMs: result.elapsedMs }),
            ...(result.upstreamDurationMs === undefined
              ? {}
              : { upstreamDurationMs: result.upstreamDurationMs }),
            ...(result.serviceTier === undefined
              ? {}
              : { serviceTier: result.serviceTier }),
            ...(result.usage === undefined ? {} : { usage: result.usage }),
          });
        } catch {
          throw new UserFacingError("vision.failed", "图片识别失败");
        } finally {
          stopHeartbeat();
          releaseVisionRecognition();
        }
        input = replaceLocalImagesWithVisionContext(input, result);
      }
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
    return this.startNewTurn(target, input, clientUserMessageId);
  }

  queueFollowUp(
    target: ConversationTarget,
    value: string,
  ): Promise<{ position: number }> {
    let input: TurnInput[];
    try {
      input = normalizeInput(value);
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error("排队输入规范化失败"),
      );
    }
    if (input.length === 0) {
      return Promise.reject(new UserFacingError("message.empty", "消息不能为空"));
    }
    return this.locked(target, () => {
      const active = this.core.activeTurn(target);
      if (!active) {
        throw new UserFacingError("queue.inactive", "当前没有运行中的任务");
      }
      const key = conversationTargetKey(target);
      const queued = this.queuedFollowUps.get(key) ?? [];
      if (queued.length >= maximumQueuedFollowUpsPerConversation) {
        throw new UserFacingError(
          "queue.full",
          `下一 Turn 队列已满，最多 ${maximumQueuedFollowUpsPerConversation} 条`,
        );
      }
      queued.push({ threadId: active.threadId, input });
      this.queuedFollowUps.set(key, queued);
      return { position: queued.length };
    });
  }

  handleTurnCompleted(
    target: ConversationTarget,
    threadId: string,
  ): Promise<Submission | undefined> {
    return this.locked(target, async () => {
      if (this.router.isBackgroundThread?.(threadId)) {
        return undefined;
      }
      if (this.core.activeTurn(target)) {
        return undefined;
      }
      const key = conversationTargetKey(target);
      const queued = this.queuedFollowUps.get(key);
      const next = queued?.[0];
      if (!next) {
        return undefined;
      }
      if (next.threadId !== threadId) {
        this.queuedFollowUps.delete(key);
        throw new UserFacingError(
          "queue.thread-changed",
          "排队消息所属的 Codex Thread 已切换",
        );
      }
      const binding = this.router.current(target);
      if (!binding || binding.threadId !== threadId) {
        this.queuedFollowUps.delete(key);
        throw new UserFacingError(
          "queue.thread-changed",
          "排队消息所属的 Codex Thread 已切换",
        );
      }
      const workspace = this.router.workspace(target);
      const overrides = this.turnOverrides(target);
      let result;
      try {
        result = await this.codex.startTurn(
          threadId,
          next.input,
          `${gatewayUserMessageClientIdPrefix}${randomUUID()}`,
          workspace.cwd,
          overrides,
        );
      } catch (error) {
        this.recordTurnError("start", target, threadId, null, error);
        this.queuedFollowUps.delete(key);
        throw error;
      }
      queued.shift();
      if (queued.length === 0) {
        this.queuedFollowUps.delete(key);
      }
      this.models.markApplied(target);
      this.collaborationModes?.markApplied(target);
      this.core.markTurnStarted(target, threadId, result.turnId);
      return { threadId, turnId: result.turnId, steered: false };
    });
  }

  async listSessions(
    target: ConversationTarget,
    options: { archived?: boolean; searchTerm?: string } = {},
  ): Promise<ConversationSession[]> {
    const sessions = pinnedFirst(await this.router.list(target, options));
    return sessions.map(({ id, preview, name, isPinned, status }) => {
      const model = this.router.modelSettingsForThread(id)?.model;
      return {
        id,
        preview,
        name,
        isPinned,
        status,
        ...(model ? { model } : {}),
      };
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
        if (this.hasQueuedFollowUps(owner) || this.hasQueuedFollowUps(target)) {
          throw new UserFacingError(
            "thread.takeover.busy",
            "原渠道或当前渠道仍有排队消息，暂不能接管",
          );
        }
        const destination = this.router.current(target);
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
      const active = this.core.activeTurn(target);
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
      const preserveCurrent = active !== undefined && current?.threadId !== selected.id;
      if (preserveCurrent && this.hasQueuedFollowUps(target)) {
        throw new UserFacingError(
          "conversation.background-queued",
          "当前任务仍有下一 Turn 排队消息，暂不能转入后台",
        );
      }
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
      this.clearPendingSelections(target);
      return {
        threadId: binding.threadId,
        ...(preserveCurrent && current ? { backgroundedThreadId: current.threadId } : {}),
      };
    });
  }

  newSession(target: ConversationTarget): Promise<string | undefined> {
    return this.locked(target, async () => {
      const active = this.core.activeTurn(target);
      if (active && this.hasQueuedFollowUps(target)) {
        throw new UserFacingError(
          "conversation.background-queued",
          "当前任务仍有下一 Turn 排队消息，暂不能转入后台",
        );
      }
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
      this.clearPendingSelections(target);
      return active?.threadId;
    });
  }

  archive(target: ConversationTarget): Promise<string> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      const threadId = await this.router.archive(target);
      this.clearPendingSelections(target);
      return threadId;
    });
  }

  unarchive(target: ConversationTarget, selector: string): Promise<string> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      const sessions = pinnedFirst(
        await this.router.list(target, { archived: true }),
      );
      const selected = resolveThread(sessions, selector.trim(), "unarchive");
      const binding = await this.router.unarchive(target, selected.id);
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
      const workspace = await this.router.selectWorkspace(target, selected.id);
      if (workspace.id !== currentWorkspaceId) {
        this.clearPendingSelections(target);
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

  setPinned(target: ConversationTarget, pinned: boolean): Promise<void> {
    return this.locked(target, async () => {
      const binding = this.router.current(target);
      if (!binding) {
        throw new UserFacingError("conversation.missing", "当前还没有 Codex Thread");
      }
      await this.codex.setThreadPinned(binding.threadId, pinned);
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
      await this.router.ensure(target);
      const binding = await this.router.fork(target);
      this.clearPendingSelections(target);
      return binding.threadId;
    });
  }

  togglePlanMode(target: ConversationTarget): Promise<CollaborationModeState> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      return this.requireCollaborationModes().toggle(target);
    });
  }

  startPlan(target: ConversationTarget, prompt: string): Promise<Submission> {
    const normalized = prompt.trim();
    if (!normalized) {
      return Promise.reject(new UserFacingError("plan.prompt.empty", "Plan 需求不能为空"));
    }
    return this.locked(target, async () => {
      this.requireIdle(target);
      await this.requireCollaborationModes().select(target, "plan");
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

  selectModel(target: ConversationTarget, selector: string): Promise<ModelSelectionState> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      return this.models.selectModel(target, selector);
    });
  }

  selectEffort(target: ConversationTarget, selector: string): Promise<ModelSelectionState> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      return this.models.selectEffort(target, selector);
    });
  }

  selectFastMode(target: ConversationTarget, selector: string): Promise<ModelSelectionState> {
    if (selector.trim().toLowerCase() === "status") {
      return this.models.selectFastMode(target, selector);
    }
    return this.locked(target, async () => {
      this.requireIdle(target);
      return this.models.selectFastMode(target, selector);
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

  async startMcpOAuthLogin(
    target: ConversationTarget,
    selector: string,
  ): Promise<McpOAuthLogin> {
    const threadId = this.router.current(target)?.threadId;
    const server = resolveMcpServer(
      selector,
      await this.queries.listMcpServers(threadId),
    );
    if (!supportsMcpOAuthLogin(server.authStatus)) {
      throw new UserFacingError(
        "mcp.oauth.unsupported",
        "该 MCP Server 不支持 OAuth 登录",
      );
    }
    return this.queries.startMcpOAuthLogin(
      server.name,
      threadId,
    );
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

  listPlugins(target: ConversationTarget): Promise<InstalledPlugin[]> {
    this.requirePluginApiEnabled();
    return this.queries.listPlugins(this.router.workspace(target).cwd);
  }

  private async resolvePlugin(
    cwd: string,
    selector: string,
  ): Promise<InstalledPlugin> {
    const plugins = await this.queries.listPlugins(cwd);
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
    const provider = this.models.status(target).modelProvider ?? "openai";
    return this.providerAccounts
      ? this.providerAccounts.accountUsage(provider)
      : Promise.resolve({ kind: "unsupported", provider });
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
    return weeklyEstimates.length === 0
      ? resolved
      : { ...resolved, weeklyEstimates };
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
  ): Promise<Submission> {
    const threadStartOptions = this.models.threadStartOptions?.(target) ?? {};
    const binding = Object.keys(threadStartOptions).length > 0
      ? await this.router.ensure(target, threadStartOptions)
      : await this.router.ensure(target);
    const workspace = this.router.workspace(target);
    let result;
    try {
      result = await this.codex.startTurn(
        binding.threadId,
        input,
        clientUserMessageId,
        workspace.cwd,
        this.turnOverrides(target),
      );
    } catch (error) {
      this.recordTurnError("start", target, binding.threadId, null, error);
      throw error;
    }
    this.models.markApplied(target);
    this.collaborationModes?.markApplied(target);
    this.core.markTurnStarted(target, binding.threadId, result.turnId);
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

  private clearConversationState(target: ConversationTarget): void {
    this.clearPendingSelections(target);
    this.queuedFollowUps.delete(conversationTargetKey(target));
  }

  private hasQueuedFollowUps(target: ConversationTarget): boolean {
    return (this.queuedFollowUps.get(conversationTargetKey(target))?.length ?? 0) > 0;
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

  private startVisionHeartbeat(target: ConversationTarget): () => void {
    const startedAt = Date.now();
    let interval: NodeJS.Timeout | undefined;
    const publish = (): void => {
      this.core.visionProgress(target, {
        elapsedSeconds: Math.max(1, Math.round((Date.now() - startedAt) / 1_000)),
      });
    };
    const initial = setTimeout(() => {
      publish();
      interval = setInterval(publish, visionHeartbeatIntervalMs);
      interval.unref();
    }, visionHeartbeatInitialDelayMs);
    initial.unref();
    return () => {
      clearTimeout(initial);
      if (interval) clearInterval(interval);
    };
  }

  private reserveVisionRecognition(): () => void {
    if (this.activeVisionRecognitions >= maximumConcurrentVisionRecognitions) {
      throw new UserFacingError(
        "vision.busy",
        "视觉识别任务繁忙，请稍后重试",
      );
    }
    this.activeVisionRecognitions += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeVisionRecognitions -= 1;
    };
  }

  private async locked<T>(
    target: ConversationTarget,
    action: () => Promise<T> | T,
  ): Promise<T> {
    return this.lockedKey(conversationTargetKey(target), action);
  }

  private lockedTargets<T>(
    targets: readonly ConversationTarget[],
    action: () => Promise<T> | T,
  ): Promise<T> {
    const keys = [...new Set(targets.map(conversationTargetKey))].sort();
    const acquire = (index: number): Promise<T> => {
      const key = keys[index];
      return key === undefined
        ? Promise.resolve(action())
        : this.lockedKey(key, () => acquire(index + 1));
    };
    return acquire(0);
  }

  private async lockedKey<T>(
    key: string,
    action: () => Promise<T> | T,
  ): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => current);
    this.locks.set(key, chain);
    await previous;
    try {
      return await action();
    } finally {
      release?.();
      if (this.locks.get(key) === chain) {
        this.locks.delete(key);
      }
    }
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
  for (const image of normalized.localImages ?? []) {
    if (!isAbsolute(image.path)) {
      throw new UserFacingError("image.path.invalid", "本地图片路径必须是绝对路径");
    }
    input.push({ type: "localImage", path: image.path });
  }
  for (const audio of normalized.localAudios ?? []) {
    if (!isAbsolute(audio.path)) {
      throw new UserFacingError("audio.path.invalid", "本地音频路径必须是绝对路径");
    }
    input.push({ type: "localAudio", path: audio.path });
  }
  return input;
}

export function resolveThread(
  threads: ConversationSession[],
  selector: string,
  command: "resume" | "unarchive" = "resume",
): ConversationSession {
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
