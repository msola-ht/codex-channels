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
} from "../scheduled-tasks/index.js";
import type { SessionRouter } from "../session-routing/index.js";
import type { BindingStore } from "../storage/index.js";
import type { WorkspaceRegistry } from "../policy/index.js";

/** Provider/model preflight is injected at the composition root and may start a Provider App Server. */
export interface ScheduledTaskModelPort {
  isProviderConfigured(provider: string): boolean;
  ensureProvider(provider: string): Promise<void>;
  isModelAvailable(provider: string, model: string): Promise<boolean>;
}

export interface ScheduledTaskExecutorOptions {
  /** Return false when the configured Surface account is no longer running. */
  isSurfaceEnabled: (target: ConversationTarget) => boolean;
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
  private readonly isSurfaceEnabled: (target: ConversationTarget) => boolean;
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
    private readonly core: Pick<ConversationCore, "markTurnStarted">,
    options: ScheduledTaskExecutorOptions,
  ) {
    if (
      typeof models.isProviderConfigured !== "function"
      || typeof models.ensureProvider !== "function"
      || typeof models.isModelAvailable !== "function"
      || typeof options.isSurfaceEnabled !== "function"
      || typeof options.onThreadStarted !== "function"
      || typeof options.onTurnStarted !== "function"
      || typeof options.onRunStateChanged !== "function"
    ) {
      throw new Error("计划任务无人值守校验依赖不完整");
    }
    this.isSurfaceEnabled = options.isSurfaceEnabled;
    this.onThreadStarted = options.onThreadStarted;
    this.onTurnStarted = options.onTurnStarted;
    this.onRunStateChangedHook = options.onRunStateChanged;
    this.logger = options.logger;
  }

  onRunStateChanged(run: ScheduledRun): void | Promise<void> {
    return this.onRunStateChangedHook?.(run);
  }

  canStart(task: ScheduledTask): boolean {
    return this.router.backgroundBindings(toTarget(task)).length < 3;
  }

  availableCapacity(task: ScheduledTask): number {
    return Math.max(0, 3 - this.router.backgroundBindings(toTarget(task)).length);
  }

  async validateRun(task: ScheduledTask): Promise<ScheduledTaskRunValidation | undefined> {
    return await this.validate(task, toTarget(task));
  }

  async execute(
    task: ScheduledTask,
    run: ScheduledRun,
    signal: AbortSignal,
  ): Promise<ScheduledTaskExecutionResult> {
    const target = toTarget(task);
    const validation = await this.validate(task, target);
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

    const workspace = this.workspaces.require(task.workspaceId);
    const permission = task.permission;
    // Store v1 normalizes this field, but keep the executor closed if a test or
    // a future store implementation supplies an invalid value.
    if (
      permission === null
      || (permission.sandbox !== "read-only" && permission.sandbox !== "workspace-write")
      || permission.approvalPolicy !== "never"
    ) {
      return { kind: "failed", category: "authorization" };
    }

    const provider = task.modelProvider ?? "openai";
    const startOptions = {
      ...(task.model == null ? {} : { model: task.model }),
      ...(task.modelProvider == null ? {} : { modelProvider: provider }),
      ...(workspace.permissions !== undefined
        ? { permissions: workspace.permissions }
        : { sandbox: workspace.sandbox ?? "read-only" }),
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
      return writeFailure(error);
    }
    const threadId = started.binding.threadId;
    this.onThreadStarted?.(run, target, threadId);

    if (signal.aborted) {
      // Thread creation is known to have succeeded.  Do not start a Turn after
      // cancellation; a cleanup failure deliberately retains the binding for
      // a later unsubscribe/recovery attempt.
      await this.releaseFreshBackground(threadId);
      return { kind: "interrupted", threadId };
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
      ...(task.model == null ? {} : { model: task.model }),
      ...(task.reasoningEffort == null ? {} : { effort: task.reasoningEffort }),
      ...(task.serviceTier == null ? {} : { serviceTier: task.serviceTier }),
    };
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
      const result = writeFailure(error);
      if (result.kind === "failed") {
        await this.releaseFreshBackground(threadId);
      }
      return withThreadId(result, threadId);
    }

    this.onTurnStarted?.(run, target, threadId, turnId);
    this.core?.markTurnStarted(target, threadId, turnId);
    return { kind: "running", threadId, turnId };
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

  private async validate(
    task: ScheduledTask,
    target: ConversationTarget,
  ): Promise<ValidationFailure | undefined> {
    if (!isSupportedSurface(target.surface)) return permanent("authorization");
    if (!this.isSurfaceEnabled(target)) return permanent("authorization");
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
    if (workspace.sandbox === "danger-full-access") return permanent("authorization");
    if (workspace.approvalPolicy !== undefined && workspace.approvalPolicy !== "never") {
      return permanent("approval");
    }
    const provider = task.modelProvider ?? "openai";
    if (
      !this.models.isProviderConfigured(provider)
    ) {
      return permanent("provider");
    }
    try {
      await this.models.ensureProvider(provider);
    } catch {
      return {
        category: "provider",
        blockTask: false,
      };
    }
    if (task.model != null) {
      try {
        if (!await this.models.isModelAvailable(provider, task.model)) return permanent("model");
      } catch {
        return { category: "model", blockTask: false };
      }
    }
    return undefined;
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
    : result.kind === "failed"
      ? { ...result, threadId }
      : result;
}

function writeFailure(error: unknown): ScheduledTaskExecutionResult {
  if (error instanceof UserFacingError) {
    const category = error.code === "conversation.background-limit"
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
