import type { Logger } from "pino";

import {
  ScheduledTaskApplicationService,
  ScheduledTaskToolService,
  type ScheduledTaskCreationContext,
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
      options.codex,
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
        validateRun: (task) => executor.validateRun(task),
        logger: options.logger,
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
    }, Date.now);
    const toolService = new ScheduledTaskToolService(this.service, Date.now);
    this.toolHandler = createScheduledTaskToolRequestHandler({
      targetForThread: (threadId) => options.router.targetForThread(threadId),
      actorsForTarget: (target) => options.bindings.actors(target),
      execute: (target, actorId, args) => toolService.execute(target, actorId, args),
      presentConfirmation: options.presentConfirmation,
    });
  }

  async prepareRecovery(): Promise<void> {
    this.scheduler.recoverAfterCrash();
    this.coordinator.initialize();
    await this.coordinator.prepareRecovery();
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
