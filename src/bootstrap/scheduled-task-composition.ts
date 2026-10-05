import type { Logger } from "pino";

import {
  ScheduledTaskApplicationService,
  ScheduledTaskToolService,
  type ScheduledTaskCreationContext,
  type TurnExecutionPort,
} from "../application/index.js";
import type {
  ProviderRoutingClient,
  ServerRequestHandler,
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
  SqliteScheduledTaskStore,
} from "../scheduled-tasks/index.js";
import { ScheduledTaskExecutor } from "./scheduled-task-executor.js";
import { ScheduledTaskRunCoordinator } from "./scheduled-task-run-coordinator.js";
import {
  createScheduledTaskToolRequestHandler,
  type ScheduledTaskToolLookup,
} from "./scheduled-task-tool-request.js";

export interface ScheduledTaskCompositionOptions {
  stateDatabasePath: string;
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
  readonly toolHandler: ServerRequestHandler;
  readonly coordinator: ScheduledTaskRunCoordinator;
  private readonly store: SqliteScheduledTaskStore;
  private readonly scheduler: ScheduledTaskScheduler;

  constructor(options: ScheduledTaskCompositionOptions) {
    this.store = new SqliteScheduledTaskStore(
      scheduledTaskDatabasePath(options.stateDatabasePath),
    );
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
        onRunStateChanged: (run) => requireCoordinator().onRunStateChanged(run),
        logger: options.logger,
      },
    );
    const coordinator = new ScheduledTaskRunCoordinator(
      this.store,
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
    this.scheduler = new ScheduledTaskScheduler(this.store, executor, {
      onError: (error) => options.logger.error(
        { err: error },
        "Gateway 计划任务调度失败",
      ),
    });
    options.output.subscribe("scheduled-task-run-coordinator", (event) => {
      this.coordinator.handleOutput(event);
    });
    options.output.observe((event) => this.coordinator.observeOutput(event));
    this.service = new ScheduledTaskApplicationService(this.store, {
      isActorAuthorized: (target, actorId) =>
        options.bindings.conversations().some((candidate) =>
          surfaceAccountKey(candidate.surface, candidate.accountId)
            === surfaceAccountKey(target.surface, target.accountId)
          && candidate.conversationId === target.conversationId)
        && options.bindings.actors(target).includes(actorId),
      isProviderConfigured: (provider) => options.codex.isProviderConfigured(provider),
      creationContext: (target) => options.creationContext(target),
      runTaskNow: (taskId) => this.scheduler.runTaskNow(taskId),
      retryRun: (runId) => this.scheduler.retryRun(runId),
    }, Date.now);
    const toolService = new ScheduledTaskToolService(this.service, Date.now);
    this.toolHandler = createScheduledTaskToolRequestHandler({
      targetForThread: (threadId) => options.router.targetForThread(threadId),
      actorsForTarget: (target) => options.bindings.actors(target),
      execute: (target, actorId, args) => toolService.execute(target, actorId, args),
      presentConfirmation: options.presentConfirmation,
    });
  }

  async prepareRecovery(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    this.scheduler.recoverAfterCrash();
    this.coordinator.initialize();
    await this.coordinator.prepareRecovery(signal);
  }

  start(): void {
    this.scheduler.start();
  }

  stop(): Promise<void> {
    return this.scheduler.stop();
  }

  close(): void {
    this.store.close();
  }
}
