import type { Logger } from "pino";

import {
  ScheduledTaskApplicationService,
  ScheduledTaskToolService,
  type ScheduledTaskCreationContext,
  type TurnExecutionPort,
} from "../application/index.js";
import type {
  ProviderRoutingClient,
} from "../codex-client/index.js";
import {
  surfaceAccountKey,
  type ConversationCore,
  type ConversationTarget,
  type OutputEvent,
} from "../conversation-core/index.js";
import type { EventBus } from "../event-bus/index.js";
import type { WorkspaceRegistry } from "../policy/index.js";
import type { SessionRouter } from "../session-routing/index.js";
import type { SqliteBindingStore } from "../storage/index.js";
import {
  ScheduledTaskScheduler,
  scheduledTaskDatabasePath,
  AsyncSqliteScheduledTaskStore,
} from "../scheduled-tasks/index.js";
import { ScheduledTaskExecutor } from "./scheduled-task-executor.js";
import { ScheduledTaskRunCoordinator } from "./scheduled-task-run-coordinator.js";
import {
  createScheduledTaskToolRequestHandler,
  type ScheduledTaskToolLookup,
  type ScheduledTaskToolRequestHandler,
} from "./scheduled-task-tool-request.js";

export interface ScheduledTaskCompositionOptions {
  stateDatabasePath: string;
  registerConstructionCleanup?: (component: string, close: () => void | Promise<void>) => void;
  router: SessionRouter;
  codex: ProviderRoutingClient;
  turns?: TurnExecutionPort;
  acceptsExecution: (target: ConversationTarget) => boolean;
  bindings: SqliteBindingStore;
  workspaces: WorkspaceRegistry;
  core: ConversationCore;
  output: EventBus<OutputEvent>;
  logger: Logger;
  isSurfaceEnabled(target: ConversationTarget): boolean;
  creationContext(target: ConversationTarget): ScheduledTaskCreationContext;
  presentConfirmation: NonNullable<ScheduledTaskToolLookup["presentConfirmation"]>;
}

export class ScheduledTaskComposition {
  readonly service: ScheduledTaskApplicationService;
  readonly toolHandler: ScheduledTaskToolRequestHandler;
  readonly coordinator: ScheduledTaskRunCoordinator;
  private readonly store: AsyncSqliteScheduledTaskStore;
  private readonly scheduler: ScheduledTaskScheduler;
  private storePrepared = false;
  private storePreparation: Promise<void> | undefined;
  private recoveryPreparation: Promise<void> | undefined;
  private readonly preparationAbort = new AbortController();

  constructor(options: ScheduledTaskCompositionOptions) {
    this.store = new AsyncSqliteScheduledTaskStore(
      scheduledTaskDatabasePath(options.stateDatabasePath),
    );
    options.registerConstructionCleanup?.("Scheduled Task Store", () => this.store.close());
    const coordinatorRef: { current?: ScheduledTaskRunCoordinator } = {};
    const requireCoordinator = (): ScheduledTaskRunCoordinator => {
      if (!coordinatorRef.current) {
        throw new Error("计划任务恢复协调器尚未完成装配");
      }
      return coordinatorRef.current;
    };
    const executor: ScheduledTaskExecutor = new ScheduledTaskExecutor(
      options.router,
      options.turns ?? options.codex,
      options.bindings,
      options.workspaces,
      {
        isProviderConfigured: (provider) => options.codex.isProviderConfigured(provider),
        ensureProvider: (provider) => options.codex.ensureProviderAvailable(provider),
        isModelAvailable: (provider, model) =>
          options.codex.isModelAvailable(provider, model),
      },
      options.core,
      {
        isSurfaceEnabled: (target) => options.isSurfaceEnabled(target),
        acceptsExecution: options.acceptsExecution,
        onThreadStarted: (run, target, threadId) =>
          requireCoordinator().onThreadStarted(run, target, threadId),
        onTurnStarted: (run, target, threadId, turnId) =>
          requireCoordinator().onTurnStarted(run, target, threadId, turnId),
        onRunStateChanged: (run) => requireCoordinator().onRunStateChanged(run, this.preparationAbort.signal),
        logger: options.logger,
      },
    );
    const coordinator = new ScheduledTaskRunCoordinator(
      this.store.operations,
      options.router,
      options.codex,
      {
        validateRun: (task, signal) => executor.validateRun(task, signal),
        logger: options.logger,
        onRecovered: (run, target) => {
          const status = run.state === "completed" ? "已完成"
            : run.state === "interrupted" ? "已中断" : "失败";
          options.output.publish({
            type: "warning",
            target,
            threadId: run.threadId!,
            background: true,
            message: `计划任务在 Gateway 离线期间已结束，恢复确认：${status}。运行 ID：${run.runId}。Thread：${run.threadId}。可通过 /schedule runs ${run.taskId} 查看运行记录。`,
          }, true);
        },
      },
    );
    coordinatorRef.current = coordinator;
    this.coordinator = coordinator;
    this.scheduler = new ScheduledTaskScheduler(this.store.operations, executor, {
      onError: (error) => options.logger.error(
        { err: error },
        "Gateway 计划任务调度失败",
      ),
    });
    options.output.subscribe("scheduled-task-run-coordinator", (event) => {
      return this.coordinator.handleOutput(event);
    });
    options.output.observe((event) => this.coordinator.observeOutput(event));
    this.service = new ScheduledTaskApplicationService(this.store.operations, {
      isActorAuthorized: (target, actorId) =>
        options.bindings.conversations().some((candidate) =>
          surfaceAccountKey(candidate.surface, candidate.accountId)
            === surfaceAccountKey(target.surface, target.accountId)
          && candidate.conversationId === target.conversationId)
        && options.bindings.actors(target).includes(actorId),
      isProviderConfigured: (provider) => options.codex.isProviderConfigured(provider),
      creationContext: (target) => options.creationContext(target),
      runTaskNow: (taskId, operation) => this.scheduler.runTaskNow(taskId, undefined, operation),
      retryRun: (runId, operation) => this.scheduler.retryRun(runId, undefined, operation),
    }, Date.now);
    const toolService = new ScheduledTaskToolService(this.service, Date.now);
    this.toolHandler = createScheduledTaskToolRequestHandler({
      targetForThread: (threadId) => options.router.targetForThread(threadId),
      foregroundThreadId: (target) => options.router.foregroundThreadId(target),
      readThread: (threadId, signal) => options.router.readThread(threadId, signal),
      actorsForTarget: (target) => options.bindings.actors(target),
      rejectUnattended: (threadId) => this.coordinator.noteServerRequestRejected(threadId),
      execute: (target, actorId, args, operation) => toolService.execute(target, actorId, args, operation),
      cancelConfirmation: (token) => toolService.cancelConfirmation(token),
      presentConfirmation: options.presentConfirmation,
    });
  }

  /** Load unattended Thread associations before App Server can send requests. */
  async prepareStore(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.preparationAbort.signal.throwIfAborted();
    this.storePreparation ??= this.prepareStoreOnce(AbortSignal.any([signal, this.preparationAbort.signal]));
    await this.storePreparation;
    signal.throwIfAborted();
    this.preparationAbort.signal.throwIfAborted();
  }

  private async prepareStoreOnce(signal: AbortSignal): Promise<void> {
    await this.store.ready();
    signal.throwIfAborted();
    await this.scheduler.recoverAfterCrash(Date.now(), signal);
    signal.throwIfAborted();
    await this.coordinator.initialize(signal);
    signal.throwIfAborted();
    this.storePrepared = true;
  }

  async prepareRecovery(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.preparationAbort.signal.throwIfAborted();
    this.recoveryPreparation ??= this.prepareRecoveryOnce(AbortSignal.any([signal, this.preparationAbort.signal]));
    await this.recoveryPreparation;
    signal.throwIfAborted();
    this.preparationAbort.signal.throwIfAborted();
  }

  private async prepareRecoveryOnce(signal: AbortSignal): Promise<void> {
    await this.prepareStore(signal);
    signal.throwIfAborted();
    await this.coordinator.prepareRecovery(signal);
    signal.throwIfAborted();
  }

  start(): void {
    if (!this.storePrepared) throw new Error("计划任务存储尚未就绪");
    this.scheduler.start();
  }

  stop(): Promise<void> {
    this.toolHandler.close();
    this.preparationAbort.abort(new Error("计划任务组合正在停止"));
    this.storePrepared = false;
    return this.scheduler.stop();
  }

  close(): Promise<void> {
    this.toolHandler.close();
    this.preparationAbort.abort(new Error("计划任务组合已关闭"));
    this.storePrepared = false;
    return this.store.close();
  }
}
