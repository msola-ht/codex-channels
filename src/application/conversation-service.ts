import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import type { CodexAppServerClient } from "../codex-client/index.js";
import type {
  GetAccountRateLimitsResponse,
  GetAccountTokenUsageResponse,
  ListMcpServerStatusResponse,
  PermissionProfileListResponse,
  PluginInstalledResponse,
  RateLimitSnapshot,
  ReviewTarget,
  SkillsListResponse,
  Thread,
  ThreadGoal,
  ThreadTokenUsage,
  UserInput,
} from "../codex-protocol/index.js";
import type { SessionRouter } from "../session-routing/index.js";
import type { Workspace } from "../policy/index.js";
import {
  ConversationCore,
  UserFacingError,
  conversationTargetKey,
  gatewayUserMessageClientIdPrefix,
  type ConversationTarget,
  type TurnArtifacts,
} from "../conversation-core/index.js";
import type { ModelSelectionService, ModelSelectionState } from "./model-selection-service.js";

export interface Submission {
  threadId: string;
  turnId: string;
  steered: boolean;
}

export interface ConversationInput {
  text?: string;
  localImages?: ReadonlyArray<{ path: string }>;
}

export interface ProjectRulesResult {
  projectRoot: string;
  rulesPath: string;
}

export interface ProjectRulesPort {
  initialize(projectRoot: string): Promise<ProjectRulesResult> | ProjectRulesResult;
  check(projectRoot: string): Promise<ProjectRulesResult> | ProjectRulesResult;
}

interface QueuedFollowUp {
  threadId: string;
  input: UserInput[];
}

const maximumQueuedFollowUpsPerConversation = 10;

export interface ConversationStatus {
  threadId?: string;
  turnId?: string;
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  model: string;
  effort: string | null;
  serviceTier: string | null;
  modelPending: boolean;
  effortPending: boolean;
  fastModePending: boolean;
  tokenUsage?: ThreadTokenUsage;
  weeklyLimit?: NonNullable<RateLimitSnapshot["secondary"]>;
}

export class ConversationService {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly queuedFollowUps = new Map<string, QueuedFollowUp[]>();

  constructor(
    private readonly codex: CodexAppServerClient,
    private readonly router: SessionRouter,
    private readonly core: ConversationCore,
    private readonly models: ModelSelectionService,
    private readonly projectRules?: ProjectRulesPort,
  ) {}

  submit(target: ConversationTarget, value: string | ConversationInput): Promise<Submission> {
    let input: UserInput[];
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
    return this.locked(target, async () => {
      const active = this.core.activeTurn(target);
      const clientUserMessageId = `${gatewayUserMessageClientIdPrefix}${randomUUID()}`;
      if (active) {
        await this.codex.steerTurn(active.threadId, active.turnId, input, clientUserMessageId);
        return { threadId: active.threadId, turnId: active.turnId, steered: true };
      }
      const binding = await this.router.ensure(target);
      const workspace = this.router.workspace(target);
      const overrides = this.models.turnOverrides(target);
      const result = await this.codex.startTurn(
        binding.threadId,
        input,
        clientUserMessageId,
        workspace.cwd,
        overrides,
      );
      this.models.markApplied(target);
      this.core.markTurnStarted(target, binding.threadId, result.turn.id);
      return { threadId: binding.threadId, turnId: result.turn.id, steered: false };
    });
  }

  queueFollowUp(
    target: ConversationTarget,
    value: string,
  ): Promise<{ position: number }> {
    let input: UserInput[];
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
      const overrides = this.models.turnOverrides(target);
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
        this.queuedFollowUps.delete(key);
        throw error;
      }
      queued.shift();
      if (queued.length === 0) {
        this.queuedFollowUps.delete(key);
      }
      this.models.markApplied(target);
      this.core.markTurnStarted(target, threadId, result.turn.id);
      return { threadId, turnId: result.turn.id, steered: false };
    });
  }

  listSessions(
    target: ConversationTarget,
    options: { archived?: boolean; searchTerm?: string } = {},
  ): Promise<Thread[]> {
    return this.router.list(target, options);
  }

  resume(target: ConversationTarget, selector: string): Promise<string> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      const sessions = await this.router.list(target);
      const selected = resolveThread(sessions, selector.trim());
      const binding = await this.router.resume(target, selected.id);
      this.models.clear(target);
      return binding.threadId;
    });
  }

  newSession(target: ConversationTarget): Promise<void> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      await this.router.newSession(target);
      this.models.clear(target);
    });
  }

  archive(target: ConversationTarget): Promise<string> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      const threadId = await this.router.archive(target);
      this.models.clear(target);
      return threadId;
    });
  }

  unarchive(target: ConversationTarget, selector: string): Promise<string> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      const sessions = await this.router.list(target, { archived: true });
      const selected = resolveThread(sessions, selector.trim(), "unarchive");
      const binding = await this.router.unarchive(target, selected.id);
      this.models.clear(target);
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
      const selected = this.router.resolveWorkspace(selector);
      const currentWorkspaceId = this.router.workspace(target).id;
      const workspace = await this.router.selectWorkspace(target, selected.id);
      if (workspace.id !== currentWorkspaceId) {
        this.models.clear(target);
      }
      return workspace;
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
      this.models.clear(target);
      return binding.threadId;
    });
  }

  review(target: ConversationTarget, reviewTarget: ReviewTarget): Promise<Submission> {
    return this.locked(target, async () => {
      this.requireIdle(target);
      const binding = await this.router.ensure(target);
      const result = await this.codex.startReview(binding.threadId, reviewTarget);
      this.core.markTurnStarted(target, result.reviewThreadId, result.turn.id);
      return { threadId: result.reviewThreadId, turnId: result.turn.id, steered: false };
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

  async listSkills(target: ConversationTarget): Promise<SkillsListResponse["data"]> {
    const entries = await this.codex.listSkills(this.router.workspace(target).cwd);
    return entries.map((entry) => ({
      ...entry,
      skills: entry.skills.filter(isDirectlyInstalledSkill),
    }));
  }

  listMcpServers(target: ConversationTarget): Promise<ListMcpServerStatusResponse["data"]> {
    return this.codex.listMcpServers(this.router.current(target)?.threadId);
  }

  listPlugins(target: ConversationTarget): Promise<PluginInstalledResponse> {
    return this.codex.listPlugins(this.router.workspace(target).cwd);
  }

  accountUsage(): Promise<GetAccountTokenUsageResponse> {
    return this.codex.accountUsage();
  }

  accountRateLimits(): Promise<GetAccountRateLimitsResponse> {
    return this.codex.accountRateLimits();
  }

  listPermissionProfiles(target: ConversationTarget): Promise<PermissionProfileListResponse["data"]> {
    return this.codex.listPermissionProfiles(this.router.workspace(target).cwd);
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
      return this.codex.setGoal(binding.threadId, normalized);
    });
  }

  clearGoal(target: ConversationTarget): Promise<void> {
    return this.locked(target, async () => {
      const binding = await this.router.ensure(target);
      await this.codex.clearGoal(binding.threadId);
    });
  }

  status(target: ConversationTarget): ConversationStatus {
    const binding = this.router.current(target);
    const active = this.core.activeTurn(target);
    const workspace = this.router.workspace(target);
    const tokenUsage = binding ? this.core.tokenUsage(binding.threadId) : undefined;
    const weeklyLimit = this.core.weeklyRateLimit();
    const model = this.models.status(target);
    return {
      ...(binding ? { threadId: binding.threadId } : {}),
      ...(active ? { turnId: active.turnId } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
      ...(weeklyLimit ? { weeklyLimit } : {}),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cwd: workspace.cwd,
      model: model.model,
      effort: model.effort,
      serviceTier: model.serviceTier,
      modelPending: model.modelPending,
      effortPending: model.effortPending,
      fastModePending: model.serviceTierPending,
    };
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
    const key = conversationTargetKey(target);
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

function isDirectlyInstalledSkill(
  skill: SkillsListResponse["data"][number]["skills"][number],
): boolean {
  const normalizedPath = skill.path.replaceAll("\\", "/");
  return skill.enabled
    && (skill.scope === "user" || skill.scope === "repo")
    && !normalizedPath.includes("/.codex/plugins/");
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
        : new Error(`项目规则${operation === "init" ? "生成" : "检查"}失败`);
  }
}

function normalizeInput(value: string | ConversationInput): UserInput[] {
  const normalized = typeof value === "string" ? { text: value } : value;
  const input: UserInput[] = [];
  const text = normalized.text?.trim();
  if (text) {
    input.push({ type: "text", text, text_elements: [] });
  }
  for (const image of normalized.localImages ?? []) {
    if (!isAbsolute(image.path)) {
      throw new UserFacingError("image.path.invalid", "本地图片路径必须是绝对路径");
    }
    input.push({ type: "localImage", path: image.path });
  }
  return input;
}

export function resolveThread(
  threads: Thread[],
  selector: string,
  command: "resume" | "unarchive" = "resume",
): Thread {
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
