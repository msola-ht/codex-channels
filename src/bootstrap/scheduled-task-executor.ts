import type { Logger } from "pino";

import type {
  ConversationTarget,
  ConversationCore,
} from "../conversation-core/index.js";
import { UserFacingError } from "../conversation-core/index.js";
import type {
  TurnExecutionPort,
  TurnOverrides,
} from "../application/index.js";
import {
  JsonRpcError,
} from "../codex-client/index.js";
import type { ScheduledTaskRunValidation } from "./scheduled-task-run-coordinator.js";
import type {
  ScheduledRun,
  ScheduledRunErrorCategory,
  ScheduledTask,
  ScheduledTaskExecutionPort,
  ScheduledTaskExecutionResult,
  ScheduledTaskOperationContext,
  ScheduledTaskSandbox,
} from "../scheduled-tasks/index.js";
import type { SessionRouter } from "../session-routing/index.js";
import type { BindingStore } from "../storage/index.js";
import type { WorkspaceRegistry } from "../policy/index.js";

/** Provider/model preflight is injected at the composition root and may start a Provider App Server. */
export interface ScheduledTaskModelPort {
  isProviderConfigured(provider: string): boolean;
  ensureProvider(provider: string): Promise<void>;
  isModelAvailable(provider: string, model: string): Promise<boolean>;
  readPermissionSettings(cwd: string, provider: string, signal?: AbortSignal): Promise<{
    readonly sandbox: ScheduledTaskSandbox;
    readonly permissions: null;
  }>;
}

export interface ScheduledTaskExecutorOptions {
  /** Return false when the configured Surface account is no longer running. */
  isSurfaceEnabled: (target: ConversationTarget) => boolean;
  isActorAuthorized: (target: ConversationTarget, actorId: string) => boolean;
  /** Temporary output pressure does not revoke task authorization. */
  acceptsExecution: (target: ConversationTarget) => boolean;
  /** Associate a fresh Thread before the Turn-start write begins. */
  onThreadStarted: (run: ScheduledRun, target: ConversationTarget, threadId: string) => void;
  /** Complete the Thread association once the Turn-start response is known. */
  onTurnStarted: (
    run: ScheduledRun,
    target: ConversationTarget,
    threadId: string,
    turnId: string,
  ) => void;
  /** Forward durable scheduler transitions to the Run coordinator. */
  onRunStateChanged: (run: ScheduledRun) => void | Promise<void>;
  logger?: Logger;
}

/**
 * The unattended App Server boundary.
 *
 * Validation is repeated for every Run.  This class never calls ensure(), never
 * retries thread/start or turn/start, and only exposes text input to a fresh
 * automation Thread.  A transport/timeout failure after a write is represented
 * as uncertain so the scheduler cannot duplicate an external side effect.
 */
export class ScheduledTaskExecutor implements ScheduledTaskExecutionPort {
  private readonly acceptsExecution: (target: ConversationTarget) => boolean;
  private readonly isSurfaceEnabled: (target: ConversationTarget) => boolean;
  private readonly isActorAuthorized: ScheduledTaskExecutorOptions["isActorAuthorized"];
  private readonly onThreadStarted: ScheduledTaskExecutorOptions["onThreadStarted"];
  private readonly onTurnStarted: ScheduledTaskExecutorOptions["onTurnStarted"];
  private readonly onRunStateChangedHook: ScheduledTaskExecutorOptions["onRunStateChanged"];
  private readonly logger: Logger | undefined;

  constructor(
    private readonly router: SessionRouter,
    private readonly turns: TurnExecutionPort,
    private readonly bindings: BindingStore,
    private readonly workspaces: WorkspaceRegistry,
    private readonly models: ScheduledTaskModelPort,
    private readonly core: Pick<ConversationCore, "trackThreadActivity">,
    options: ScheduledTaskExecutorOptions,
  ) {
    if (
      typeof models.isProviderConfigured !== "function"
      || typeof models.ensureProvider !== "function"
      || typeof models.isModelAvailable !== "function"
      || typeof models.readPermissionSettings !== "function"
      || typeof options.isSurfaceEnabled !== "function"
      || typeof options.isActorAuthorized !== "function"
      || typeof options.acceptsExecution !== "function"
      || typeof options.onThreadStarted !== "function"
      || typeof options.onTurnStarted !== "function"
      || typeof options.onRunStateChanged !== "function"
    ) {
      throw new Error("计划任务无人值守校验依赖不完整");
    }
    this.isSurfaceEnabled = options.isSurfaceEnabled;
    this.isActorAuthorized = options.isActorAuthorized;
    this.acceptsExecution = options.acceptsExecution;
    this.onThreadStarted = options.onThreadStarted;
    this.onTurnStarted = options.onTurnStarted;
    this.onRunStateChangedHook = options.onRunStateChanged;
    this.logger = options.logger;
  }

  onRunStateChanged(run: ScheduledRun): void | Promise<void> {
    return this.onRunStateChangedHook?.(run);
  }

  canStart(task: ScheduledTask): boolean {
    return this.availableCapacity(task) > 0;
  }

  availableCapacity(task: ScheduledTask): number {
    return this.acceptsExecution(toTarget(task))
      ? this.router.availableBackgroundCapacity(toTarget(task)) : 0;
  }

  async validateRun(task: ScheduledTask, signal?: AbortSignal): Promise<ScheduledTaskRunValidation | undefined> {
    // Recovery settles an existing Turn. Current native permission settings
    // govern only a fresh execution and cannot establish that Turn's outcome.
    return this.validateAuthorization(task, toTarget(task), signal);
  }

  async execute(
    task: ScheduledTask,
    run: ScheduledRun,
    signal: AbortSignal,
    operation?: ScheduledTaskOperationContext,
  ): Promise<ScheduledTaskExecutionResult> {
    const target = toTarget(task);
    if (!this.acceptsExecution(target)) return { kind: "failed", category: "capacity" };
    let prepared: Awaited<ReturnType<ScheduledTaskExecutor["validate"]>>;
    try {
      operation?.assertCurrent();
      prepared = await this.validate(task, target, signal);
      operation?.assertCurrent();
    }
    catch (error) {
      if (signal.aborted) return { kind: "interrupted" };
      throw error;
    }
    if ("category" in prepared) {
      return {
        kind: "failed",
        category: prepared.category,
        ...(prepared.blockTask ? { blockTask: true } : {}),
      };
    }
    const validation = this.validateCurrent(task, target);
    if (validation) {
      return {
        kind: "failed",
        category: validation.category,
        ...(validation.blockTask ? { blockTask: true } : {}),
      };
    }
    if (signal.aborted) {
      return { kind: "interrupted" };
    }

    // Provider/model validation can await network I/O; recheck before creating a Thread.
    if (!this.acceptsExecution(target)) return { kind: "failed", category: "capacity" };
    const workspace = this.workspaces.require(task.workspaceId);
    if (workspace.cwd !== prepared.cwd) return { kind: "failed", category: "workspace" };
    const rejectedBeforeSubmit = new Error("计划任务在提交前已失效");
    let submissionRejection: ScheduledTaskExecutionResult = { kind: "interrupted" };
    const beforeSubmit = (): void => {
      try {
        signal.throwIfAborted();
        operation?.assertCurrent();
      } catch {
        throw rejectedBeforeSubmit;
      }
      const currentValidation = this.validateCurrent(task, target);
      const currentWorkspace = this.workspaces.get(task.workspaceId);
      const workspaceChanged = currentWorkspace?.cwd !== workspace.cwd;
      if (currentValidation || workspaceChanged || !this.acceptsExecution(target)) {
        submissionRejection = {
          kind: "failed",
          category: currentValidation?.category ?? (workspaceChanged ? "workspace" : "capacity"),
          ...(currentValidation?.blockTask ? { blockTask: true } : {}),
        };
        throw rejectedBeforeSubmit;
      }
    };
    const provider = task.modelProvider ?? "openai";
    const startOptions = {
      beforeSubmit,
      ...(task.model == null ? {} : { model: task.model }),
      ...(task.modelProvider == null ? {} : { modelProvider: provider }),
      approvalPolicy: "never" as const,
      threadSource: "automation" as const,
    };

    let started: Awaited<ReturnType<SessionRouter["startBackground"]>>;
    try {
      started = await this.router.startBackground(
        target,
        startOptions,
        task.workspaceId,
      );
    } catch (error) {
      if (error === rejectedBeforeSubmit) return submissionRejection;
      return writeFailure(error);
    }
    const threadId = started.binding.threadId;
    this.onThreadStarted?.(run, target, threadId);

    // Recheck after Thread creation and again at the final Turn RPC boundary.
    try { beforeSubmit(); }
    catch (error) {
      if (error !== rejectedBeforeSubmit) throw error;
      await this.releaseFreshBackground(threadId);
      return withThreadId(submissionRejection, threadId);
    }

    const effective = started.session.effectiveSettings;
    if (
      effective.cwd !== workspace.cwd
      || effective.approvalPolicy !== "never"
      || effective.sandbox !== prepared.permission.sandbox
      || effective.permissions !== prepared.permission.permissions
    ) {
      this.logger?.error({ threadId }, "计划任务 Thread 的实际权限与原生受限预检不一致");
      await this.releaseFreshBackground(threadId);
      return { kind: "failed", category: "authorization", threadId };
    }

    const actualProvider = started.session.modelProvider ?? started.session.thread.modelProvider;
    if (task.modelProvider != null && actualProvider !== task.modelProvider) {
      this.logger?.error(
        { threadId, expectedProvider: task.modelProvider, actualProvider },
        "计划任务 Thread 返回了不同的模型 Provider",
      );
      await this.releaseFreshBackground(threadId);
      return { kind: "failed", category: "provider", threadId };
    }
    if (task.model != null && started.session.model !== task.model) {
      this.logger?.error(
        { threadId, expectedModel: task.model, actualModel: started.session.model },
        "计划任务 Thread 返回了不同的模型",
      );
      await this.releaseFreshBackground(threadId);
      return { kind: "failed", category: "model", threadId };
    }

    const overrides: TurnOverrides = {
      beforeSubmit,
      ...(task.model == null ? {} : { model: task.model }),
      ...(task.reasoningEffort == null ? {} : { effort: task.reasoningEffort }),
      ...(task.serviceTier == null ? {} : { serviceTier: task.serviceTier }),
    };
    const activity = this.core.trackThreadActivity(threadId);
    try {
      let turnId: string;
      try {
        const turn = await this.turns.startTurn(
          threadId,
          [{ type: "text", text: task.prompt }],
          `scheduled-run-${run.runId}`,
          workspace.cwd,
          overrides,
        );
        turnId = turn.turnId;
      } catch (error) {
        if (error === rejectedBeforeSubmit) {
          await this.releaseFreshBackground(threadId);
          return withThreadId(submissionRejection, threadId);
        }
        const result = writeFailure(error);
        if (result.kind === "failed") {
          await this.releaseFreshBackground(threadId);
        }
        return withThreadId(result, threadId);
      }

      this.onTurnStarted?.(run, target, threadId, turnId);
      activity.restore(target, turnId);
      return { kind: "running", threadId, turnId };
    } finally {
      activity.stop();
    }
  }

  private async releaseFreshBackground(threadId: string): Promise<void> {
    try {
      await this.router.releaseBackground(threadId);
    } catch (error) {
      this.logger?.warn(
        { err: error, threadId },
        "计划任务 Thread 清理订阅失败，已保留绑定供后续重试",
      );
    }
  }

  private validateCurrent(task: ScheduledTask, target: ConversationTarget): ValidationFailure | undefined {
    if (!isSupportedSurface(target.surface)) return permanent("authorization");
    if (!this.isSurfaceEnabled(target)) return permanent("authorization");
    if (!this.isActorAuthorized(target, task.actorId)) return permanent("authorization");
    if (!this.bindings.conversations().some((candidate) => sameTarget(candidate, target))) {
      return permanent("authorization");
    }
    if (!this.bindings.actors(target).includes(task.actorId)) {
      return permanent("authorization");
    }
    const permission = task.permission;
    if (
      permission === null
      || (permission.sandbox !== "read-only" && permission.sandbox !== "workspace-write")
      || permission.approvalPolicy !== "never"
    ) {
      return permanent("authorization");
    }
    const workspace = this.workspaces.get(task.workspaceId);
    if (!workspace) return permanent("workspace");
    const provider = task.modelProvider ?? "openai";
    if (
      !this.models.isProviderConfigured(provider)
    ) {
      return permanent("provider");
    }
    return undefined;
  }

  private async validate(
    task: ScheduledTask,
    target: ConversationTarget,
    signal?: AbortSignal,
  ): Promise<ValidationFailure | {
    readonly cwd: string;
    readonly permission: { readonly sandbox: ScheduledTaskSandbox; readonly permissions: null };
  }> {
    const authorization = await this.validateAuthorization(task, target, signal);
    if (authorization) return authorization;
    signal?.throwIfAborted();
    const current = this.validateCurrent(task, target);
    if (current) return current;
    const provider = task.modelProvider ?? "openai";
    const cwd = this.workspaces.require(task.workspaceId).cwd;
    let permission: { readonly sandbox: ScheduledTaskSandbox; readonly permissions: null };
    try {
      permission = await this.models.readPermissionSettings(cwd, provider, signal);
      signal?.throwIfAborted();
    } catch (error) {
      signal?.throwIfAborted();
      return { category: "authorization", blockTask: error instanceof UserFacingError };
    }
    const afterRead = this.validateCurrent(task, target);
    if (afterRead) return afterRead;
    if (this.workspaces.require(task.workspaceId).cwd !== cwd) {
      return { category: "workspace", blockTask: false };
    }
    return { cwd, permission };
  }

  private async validateAuthorization(
    task: ScheduledTask,
    target: ConversationTarget,
    signal?: AbortSignal,
  ): Promise<ValidationFailure | undefined> {
    signal?.throwIfAborted();
    const current = this.validateCurrent(task, target);
    if (current) return current;
    const provider = task.modelProvider ?? "openai";
    try {
      await this.models.ensureProvider(provider);
      signal?.throwIfAborted();
    } catch {
      signal?.throwIfAborted();
      return {
        category: "provider",
        blockTask: false,
      };
    }
    if (task.model != null) {
      try {
        const available = await this.models.isModelAvailable(provider, task.model);
        signal?.throwIfAborted();
        if (!available) return permanent("model");
      } catch {
        signal?.throwIfAborted();
        return { category: "model", blockTask: false };
      }
    }
    return this.validateCurrent(task, target);
  }
}

interface ValidationFailure {
  readonly category: ScheduledRunErrorCategory;
  readonly blockTask: boolean;
}

function permanent(category: ScheduledRunErrorCategory): ValidationFailure {
  return { category, blockTask: true };
}

function toTarget(task: ScheduledTask): ConversationTarget {
  return {
    surface: task.surface,
    accountId: task.accountId,
    conversationId: task.conversationId,
  };
}

function isSupportedSurface(surface: string): surface is ConversationTarget["surface"] {
  return surface === "telegram" || surface === "feishu" || surface === "weixin";
}

function sameTarget(left: ConversationTarget, right: ConversationTarget): boolean {
  return left.surface === right.surface
    && left.accountId === right.accountId
    && left.conversationId === right.conversationId;
}

function withThreadId(
  result: ScheduledTaskExecutionResult,
  threadId: string,
): ScheduledTaskExecutionResult {
  return result.kind === "uncertain"
    ? { ...result, threadId }
    : result.kind === "failed" || result.kind === "interrupted"
      ? { ...result, threadId }
      : result;
}

function writeFailure(error: unknown): ScheduledTaskExecutionResult {
  if (error instanceof UserFacingError) {
    const category = error.code === "conversation.background-limit" || error.code === "delivery.overloaded"
      ? "capacity"
      : error.code.startsWith("workspace.") || error.code === "thread.takeover.workspace"
        ? "workspace"
        : "authorization";
    return {
      kind: "failed",
      category,
      ...(category !== "capacity" ? { blockTask: true } : {}),
    };
  }
  if (!isDefiniteRpcFailure(error)) {
    return { kind: "uncertain" };
  }
  return { kind: "failed", category: classifyRpcFailure(error) };
}

function isDefiniteRpcFailure(error: unknown): boolean {
  return error instanceof JsonRpcError;
}

function classifyRpcFailure(error: unknown): ScheduledRunErrorCategory {
  const message = error instanceof Error ? error.message : String(error);
  if (/permission|approval|authorize|unauthor/i.test(message)) return "authorization";
  if (/workspace|sandbox|cwd/i.test(message)) return "workspace";
  if (/model/i.test(message)) return "model";
  if (/provider/i.test(message)) return "provider";
  if (/capacity|background.limit/i.test(message)) return "capacity";
  return "unknown";
}
