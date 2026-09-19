import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

import type { Logger } from "pino";

import { assertAppServerSocketPathSupported } from "../../runtime/app-server-runtime.mjs";
import {
  ensureAppServerProvider,
  releaseAppServerProvider,
} from "../../runtime/app-server-supervisor.mjs";
import { hasCodexAuthFile } from "../../runtime/codex-home.mjs";
import {
  effectiveCodexBinary,
  executableInvocation,
  resolveExecutable,
} from "../../runtime/executable.mjs";
import {
  checkProjectRulesAtRoot,
  initializeProjectRulesAtRoot,
} from "../../runtime/project-rules.mjs";
import {
  loadManagedModelProviderDefinitions,
} from "../../runtime/model-provider-definitions.mjs";
import {
  loadConfiguredCustomPrimaryModelProvider,
  loadConfiguredCustomSwitchingModelProviders,
  loadManagedModelProviders,
  loadOpenAiBaseUrl,
  loadPrimaryModelProvider,
  loadManagedModelWindow,
  readCodexConfigModelOverride,
  managedProviderDirectory,
  providerAppServerSocketPath,
  providerMetricsSocketPath,
} from "../../runtime/model-provider-runtime.mjs";
import {
  inspectThreadWriterLock,
  terminateThreadWriterHolder,
} from "../../runtime/thread-writer-lock.mjs";
import { terminateChildProcess } from "../../runtime/process-lifecycle.mjs";
import {
  inspectAppServerSupervisor,
  inspectAppServerSupervisorState,
} from "../../runtime/app-server-supervisor.mjs";
import {
  opencodeGoAccountIdFromProvider,
} from "../../runtime/opencode-go-accounts.mjs";
import { listConfiguredAgentRoles } from "../../runtime/agent-roles.mjs";
import { ApprovalCoordinator, InteractionRouter } from "../approval/index.js";
import {
  CodexAppServerClient,
  createAppServerTransport,
  ProviderRoutingClient,
  codexCliVersion,
  handleApprovalServerRequest,
  JsonRpcError,
  loadManagedModelOptions,
  JsonRpcClient,
  supportedCodexCliVersion,
  toConversationInputEvent,
  toThreadQueueChangedEvent,
  toThreadStateEvent,
  type CodexTransport,
  type RpcNotification,
} from "../codex-client/index.js";
import {
  configChange,
  includesConfigChange,
  type ConfigChange,
  type GatewayConfig,
} from "../config/index.js";
import {
  CollaborationModeSelectionService,
  ConversationCommandService,
  ConversationService,
  ModelSelectionService,
  ProviderAccountService,
  scheduledTaskToolSpec,
  createOpenAiAccountAdapter,
  type ThreadLockHolder,
  type ThreadOccupancyReleaseResult,
} from "../application/index.js";
import {
  ConversationCore,
  UserFacingError,
  isCriticalOutputEvent,
  type ConversationTarget,
  type OutputEvent,
  type TurnErrorCode,
  type TurnTaskMetricsSummary,
} from "../conversation-core/index.js";
import { EventBus } from "../event-bus/index.js";
import {
  BufferedModelRequestMetricsWriter,
  modelRequestMetricsDatabasePath,
  SqliteModelRequestMetricsStore,
} from "../observability/index.js";
import { WorkspaceRegistry } from "../policy/index.js";
import {
  SessionRouter,
  ThreadStateSynchronizer,
} from "../session-routing/index.js";
import {
  SqliteBindingStore,
  SqliteSessionDisplayCache,
} from "../storage/index.js";
import {
  formatProviderIdleReleaseNotice,
  setConfiguredCustomPrimaryProviderId,
  type SurfaceAdapter,
} from "../surfaces/index.js";
import { ChannelImageSpool } from "./channel-image-spool.js";
import { ConversationIdleReleaser } from "./conversation-idle-releaser.js";
import {
  createSurfaceModules,
} from "./surface-composition.js";
import type { SurfaceRuntimeModule } from "./surface-plugin.js";
import { SurfaceManager } from "./surface-manager.js";
import { createProxyFetch } from "./proxy-fetch.js";
import {
  checkOpenAiConnectivity,
  type OpenAiConnectivityStatus,
} from "./openai-connectivity.js";
import { ProviderMetricsComposition } from "./provider-metrics-composition.js";
import { ProviderIdleReleaser } from "./provider-idle-releaser.js";
import { enqueueTurnErrorMetric } from "./turn-error-metrics.js";
import { mergeCompletionTiming } from "./completion-timing.js";
import { TomlWorkspacePermissionWriter } from "./workspace-permission-writer.js";
import { SubagentCompletionTracker } from "./subagent-completion-tracker.js";
import { createScheduledTaskServerRequestHandler } from "./scheduled-task-server-request.js";
import { ScheduledTaskComposition } from "./scheduled-task-composition.js";
import { RequestMetricsQueryAdapter } from "./request-metrics-query-adapter.js";
import {
  createManagedProviderAccountAdapters,
} from "./managed-provider-capabilities.js";
import {
  BindingRestoreCoordinator,
  type PendingBindingRestore,
} from "./binding-restore-coordinator.js";

export abstract class GatewayComponentGraph {
  private readonly transport: CodexTransport;
  protected readonly codex: ProviderRoutingClient;
  private readonly primaryProvider: string;
  private readonly customPrimaryProviderId: string | undefined;
  private readonly inbound: EventBus<RpcNotification>;
  private readonly output: EventBus<OutputEvent>;
  protected readonly surfaceModules: SurfaceRuntimeModule[];
  private readonly surfaces: SurfaceAdapter[];
  protected readonly surfaceManager: SurfaceManager;
  private readonly channelImageSpool: ChannelImageSpool;
  private readonly interactions: InteractionRouter;
  private readonly approval: ApprovalCoordinator;
  private readonly router: SessionRouter;
  private readonly threadState: ThreadStateSynchronizer;
  private readonly core: ConversationCore;
  private readonly conversations: ConversationService;
  private readonly providerMetrics: ProviderMetricsComposition;
  private readonly providerIdleReleaser: ProviderIdleReleaser;
  private readonly conversationIdleReleaser?: ConversationIdleReleaser;
  private readonly providerAccounts?: ProviderAccountService;
  private readonly bindings: SqliteBindingStore;
  private readonly sessionDisplayCache?: SqliteSessionDisplayCache;
  protected readonly workspaces: WorkspaceRegistry;
  private readonly workspacePermissions: TomlWorkspacePermissionWriter | undefined;
  private readonly subagentCompletion: SubagentCompletionTracker;
  private readonly scheduledTasks: ScheduledTaskComposition | undefined;
  private bindingRestore: BindingRestoreCoordinator | undefined;
  protected removeRpcNotification: (() => void) | undefined;
  protected removeRpcDisconnect: (() => void) | undefined;
  private shutdownTask: Promise<void> | undefined;
  protected reconnecting: Promise<void> | undefined;
  protected reconnectAbort: AbortController | undefined;
  private readonly disconnectedProviders = new Set<string>();
  private readonly disconnectedBindingsByProvider = new Map<string, Set<string>>();
  private readonly pendingBindingRestores = new Map<string, PendingBindingRestore>();
  private readonly restoringThreadIds = new Set<string>();
  private bindingRestoreAttempt = 0;
  private readonly queueLifecycleTasks = new Set<Promise<void>>();
  private codexUpstreamUserAgent: string | undefined;
  private openAiConnectivity: OpenAiConnectivityStatus = "not-applicable";
  protected openAiConnectivityAbort: AbortController | undefined;
  protected stopping = false;

  protected abstract requestStop(): Promise<void>;

  constructor(
    protected config: GatewayConfig,
    protected readonly logger: Logger,
    configPath?: string,
  ) {
    verifyCodexVersion(config);
    this.workspacePermissions = configPath === undefined
      ? undefined
      : new TomlWorkspacePermissionWriter(configPath);
    const primaryProvider = loadPrimaryModelProvider();
    const customPrimaryProvider = loadConfiguredCustomPrimaryModelProvider();
    const customSwitchingProviders = loadConfiguredCustomSwitchingModelProviders();
    const managedProviders = loadManagedModelProviders();
    const providerDefinitions = loadManagedModelProviderDefinitions();
    const configuredProviders = new Set<string>([
      primaryProvider,
      ...managedProviders.map(({ provider }) => provider),
    ]);
    const supplementaryModels = providerDefinitions.flatMap((definition) =>
      loadManagedModelOptions(
        managedProviderDirectory(process.env, definition),
        configuredProviders.has(definition.id),
        definition,
      ));
    const codexBinary = resolveExecutable(effectiveCodexBinary(config.codexBinary));
    const createCodexProcessInvocation = (args: readonly string[]) =>
      executableInvocation(codexBinary, args);
    const createTransport = (socketPath: string): CodexTransport =>
      {
        assertAppServerSocketPathSupported(socketPath);
        return createAppServerTransport(
          { kind: "local-app-server", socketPath },
          {
            codexBinary,
            createCodexProcessInvocation,
            terminateCodexProcess: terminateChildProcess,
          },
        );
      };
    this.transport = createTransport(config.codexSocketPath);
    this.primaryProvider = primaryProvider;
    const customProviderIds = customPrimaryProvider === undefined
      ? customSwitchingProviders.map(({ id }) => id)
      : [customPrimaryProvider.id];
    this.customPrimaryProviderId = customPrimaryProvider?.id;
    setConfiguredCustomPrimaryProviderId(customProviderIds);
    const clients = new Map<string, CodexAppServerClient>();
    clients.set(primaryProvider, new CodexAppServerClient(
      new JsonRpcClient(this.transport, 60_000, logger, 64, config.codexClientIdentity),
      {
      sandbox: config.codexSandbox,
      ...(config.codexModel ? { model: config.codexModel } : {}),
      },
    ));
    for (const managedProvider of managedProviders) {
      const providerTransport = createTransport(
        providerAppServerSocketPath(config.codexSocketPath, managedProvider.provider),
      );
      clients.set(managedProvider.provider, new CodexAppServerClient(
        new JsonRpcClient(providerTransport, 60_000, logger, 64, config.codexClientIdentity),
        {
          sandbox: config.codexSandbox,
        },
      ));
    }
    for (const customSwitchingProvider of customSwitchingProviders) {
      const providerTransport = createTransport(
        providerAppServerSocketPath(config.codexSocketPath, customSwitchingProvider.provider),
      );
      clients.set(customSwitchingProvider.provider, new CodexAppServerClient(
        new JsonRpcClient(providerTransport, 60_000, logger, 64, config.codexClientIdentity),
        { sandbox: config.codexSandbox },
      ));
    }
    this.codex = new ProviderRoutingClient(
      primaryProvider,
      clients,
      async (provider) => {
        this.providerIdleReleaser?.markLaunching(provider);
        try {
          if (provider === primaryProvider) {
            const supervisor = await inspectAppServerSupervisorState(
              config.codexSocketPath,
            );
            if (supervisor.status === "missing") return;
            if (supervisor.status === "incompatible") {
              throw new Error(
                "App Server 监管协议版本不匹配；请运行 codexc service restart all 后重试",
              );
            }
          }
          await ensureAppServerProvider(config.codexSocketPath, provider);
        } finally {
          this.providerIdleReleaser?.finishLaunching(provider);
        }
      },
      customPrimaryProvider === undefined
        ? undefined
        : new Set([customPrimaryProvider.id]),
      customPrimaryProvider?.id ?? primaryProvider,
      (provider, mode, operation) => {
        if (!this.providerIdleReleaser) return operation();
        return mode === "activity"
          ? this.providerIdleReleaser.runActivity(provider, operation)
          : this.providerIdleReleaser.runOperation(provider, operation);
      },
    );
    this.inbound = new EventBus<RpcNotification>(logger, 2_000);
    this.output = new EventBus<OutputEvent>(logger, 1_000);
    this.bindings = new SqliteBindingStore(config.stateDatabasePath);
    this.sessionDisplayCache = new SqliteSessionDisplayCache(
      join(dirname(config.stateDatabasePath), "session-display-cache.sqlite3"),
    );
    this.workspaces = new WorkspaceRegistry(config.workspaces, config.defaultWorkspaceId);
    this.router = new SessionRouter(
      this.codex,
      this.bindings,
      this.workspaces,
      config.scheduledTasksEnabled ? [scheduledTaskToolSpec] : [],
      () => {
        void this.providerIdleReleaser?.closeIfIdle().catch((error) => {
          this.logger.warn(
            { err: error },
            "会话绑定变化后的全局 Client 空闲检查失败",
          );
        });
      },
    );
    this.threadState = new ThreadStateSynchronizer(this.router);
    this.core = new ConversationCore(this.router, this.output);
    const metricsStore = new SqliteModelRequestMetricsStore(
      modelRequestMetricsDatabasePath(config.stateDatabasePath),
      undefined,
      {
        retentionDays: config.metricsStorage.retentionDays,
        maximumRows: config.metricsStorage.maxRows,
      },
    );
    const metricsWriter = new BufferedModelRequestMetricsWriter(
      metricsStore,
      (error) => logger.warn({ err: error }, "模型请求指标后台写入失败"),
    );
    const recordTurnErrorMetric = (
      provider: string,
      model: string | null,
      threadId: string | null,
      turnId: string | null,
      phase: "start" | "steer" | "notification",
      error: unknown,
      structuredErrorCode?: TurnErrorCode,
    ): void => {
      try {
        enqueueTurnErrorMetric(
          metricsWriter,
          provider,
          model,
          threadId,
          turnId,
          phase,
          error,
          structuredErrorCode,
        );
      } catch (cause) {
        logger.warn({ err: cause }, "Turn 级错误指标写入失败");
      }
    };
    this.providerMetrics = new ProviderMetricsComposition({
      providers: [
        customPrimaryProvider?.id ?? primaryProvider,
        ...managedProviders.map(({ provider }) => provider),
        ...customSwitchingProviders.map(({ provider }) => provider),
      ],
      socketPath: (provider) =>
        providerMetricsSocketPath(
          config.codexSocketPath,
          provider === customPrimaryProvider?.id ? primaryProvider : provider,
        ),
      writer: {
        enqueue: (sample) => {
          metricsWriter.enqueue(sample);
          if (sample.threadId) {
            this.subagentCompletion?.metricsAvailable(
              sample.threadId,
              sample.turnId ?? undefined,
            );
          }
        },
        close: () => metricsWriter.close(),
      },
      resolveModelSettings: (threadId) =>
        this.router.modelSettingsForThread(threadId),
      onModelTiming: (event) => this.core.handle(event),
      logger,
    });
    this.subagentCompletion = new SubagentCompletionTracker({
      readSummary: (agentThreadId, terminalTurnId) => {
        if (!terminalTurnId) return metricsStore.threadSummary(agentThreadId);
        const latestTurn = metricsStore.threadTurnSummary(
          agentThreadId,
          terminalTurnId,
        );
        return {
          latestTurn,
          threadAggregate: metricsStore.threadTurnTaskSummary(
            agentThreadId,
            terminalTurnId,
          ) ?? latestTurn,
        };
      },
      waitForMetrics: (agentThreadId, agentTurnId) =>
        metricsWriter.waitForCurrentWrites(agentThreadId, agentTurnId),
      onRunStarted: (details) => {
        try {
          metricsStore.recordSubagentTurn(details);
        } catch (error) {
          logger.warn(
            {
              err: error,
              agentThreadId: details.agentThreadId,
              agentTurnId: details.agentTurnId,
              parentThreadId: details.parentThreadId,
              parentTurnId: details.parentTurnId,
            },
            "子代理运行指标归属写入失败",
          );
        }
      },
      publish: (event) => {
        this.output.publish(event, isCriticalOutputEvent(event));
      },
      onReadError: (error, agentThreadId) => {
        logger.warn({ err: error, agentThreadId }, "子代理完成统计读取失败");
      },
      onMissingMetrics: (agentThreadId) => {
        logger.warn({ agentThreadId }, "子代理已结束但没有可用的模型指标");
      },
      onCompleted: (event) => {
        logger.info(
          {
            agentThreadId: event.agentThreadId,
            agentPath: event.agentPath,
            requestCount: event.requestCount,
            status: event.status,
          },
          "子代理完成卡片已生成",
        );
      },
    });
    this.output.subscribe("subagent-metrics", (event) => {
      if (event.type === "subagent.spawned") {
        try {
          metricsStore.recordSubagentThread({
            agentThreadId: event.agentThreadId,
            parentThreadId: event.threadId,
            parentTurnId: event.turnId,
            agentPath: event.agentPath,
          });
        } catch (error) {
          logger.warn(
            {
              err: error,
              threadId: event.threadId,
              agentThreadId: event.agentThreadId,
            },
            "子代理指标标注写入失败",
          );
        }
        logger.info(
          { agentThreadId: event.agentThreadId, agentPath: event.agentPath },
          "子代理活动已登记，等待官方终态",
        );
      }
      this.subagentCompletion.handle(event);
    });
    this.interactions = new InteractionRouter(logger);
    const models = new ModelSelectionService(
      this.codex,
      this.router,
      config.codexModel,
      supplementaryModels,
      customPrimaryProvider?.id ?? primaryProvider,
      customSwitchingProviders.map((provider) => ({
        provider: provider.provider,
        displayName: provider.provider,
        defaultModel: provider.model,
      })),
      () => hasCodexAuthFile(process.env),
      () => new Set(metricsStore.latestAccountSnapshots()
        .filter((snapshot) => snapshot.provider.startsWith("ocg-")
          && snapshot.usage !== null && typeof snapshot.usage === "object"
          && "kind" in snapshot.usage && snapshot.usage.kind === "subscription-required")
        .map((snapshot) => snapshot.provider)),
    );
    const collaborationModes = new CollaborationModeSelectionService(
      this.codex,
      this.router,
      models,
    );
    const accountAdapters = [
      createOpenAiAccountAdapter(this.codex),
      ...createManagedProviderAccountAdapters(
        providerDefinitions,
        {
          environment: process.env,
          fetchImpl: createProxyFetch(config.networkProxy),
          metricsDatabasePath: modelRequestMetricsDatabasePath(
            config.stateDatabasePath,
          ),
        },
      ),
    ];
    this.providerAccounts = new ProviderAccountService(accountAdapters, {
      writeOfficialAccountSnapshot: (snapshot) => {
        const definition = providerDefinitions.find(
          (candidate) => candidate.id === snapshot.provider,
        );
        const definitionAccountId = definition
          && "accountId" in definition
          && typeof definition.accountId === "string"
          ? definition.accountId
          : undefined;
        const accountId = snapshot.accountId
          ?? definitionAccountId
          ?? opencodeGoAccountIdFromProvider(snapshot.provider)
          ?? null;
        metricsStore.upsertAccountSnapshot?.({
          sourceId: `${snapshot.provider}:${accountId ?? "default"}`,
          provider: snapshot.provider,
          accountId,
          displayName: definition?.displayName ?? snapshot.provider,
          enabled: true,
          observedAtMs: snapshot.observedAtMs,
          available: snapshot.available,
          usage: snapshot.usage,
          limits: snapshot.limits,
        });
      },
    });
    const service = new ConversationService(
      this.codex,
      this.router,
      this.core,
      models,
      this.codex,
      {
        initialize: (projectRoot) => initializeProjectRulesAtRoot({ projectRoot }),
        check: (projectRoot) => checkProjectRulesAtRoot({
          projectRoot,
          codexBinary: effectiveCodexBinary(config.codexBinary),
        }),
      },
      {
        currentGitBranch,
      },
      collaborationModes,
      {
        hasPendingInteraction: (threadId) =>
          this.interactions.hasPendingForThread(threadId),
        notifyTransferred: ({ previousTarget, nextTarget, threadId }) => {
          this.logger.info({
            threadId,
            previousSurface: previousTarget.surface,
            nextSurface: nextTarget.surface,
          }, "Codex Thread 外部会话绑定已跨渠道转移");
          this.output.publish({
            type: "warning",
            target: previousTarget,
            threadId,
            message: `当前 Codex Thread 已转移到${surfaceLabel(nextTarget.surface)}。本渠道已解除绑定，下一条普通消息将创建新会话。`,
          }, true);
        },
      },
      this.providerAccounts,
      new RequestMetricsQueryAdapter(metricsStore, this.router),
      this.workspacePermissions,
      {
        recordTurnError: (record) => {
          const error = new Error(record.message ?? "Turn 错误");
          if (record.errorCode !== null) {
            (error as { code?: unknown }).code = record.errorCode;
          }
          recordTurnErrorMetric(
            record.provider,
            record.model,
            record.threadId,
            record.turnId,
            record.phase,
            error,
          );
        },
      },
      {
        listAgentRoles: () => listConfiguredAgentRoles(process.env),
      },
      {
        pluginApiEnabled: config.pluginApiEnabled,
      },
      {
        releaseThread: (target, force) => this.releaseThread(target, force),
      },
      this.codex,
      this.codex,
      (parentThreadId) =>
        this.subagentCompletion.hasPendingForParentThread(parentThreadId),
      this.sessionDisplayCache,
      {
        port: this.codex,
        output: this.output,
        onError: (error, threadId) => {
          this.logger.warn(
            { err: error, threadId },
            "Luna Reserve 自动切换状态刷新失败",
          );
        },
      },
    );
    this.conversations = service;
    service.setIdleReleaseEnabled(config.idleReleaseMinutes > 0);
    if (config.idleReleaseMinutes > 0) {
      this.conversationIdleReleaser = new ConversationIdleReleaser({
        logger,
        idleThresholdMs: config.idleReleaseMinutes * 60_000,
        isBindingRestoring: (threadId) => this.isBindingRestoring(threadId),
        listForegroundBindings: () =>
          this.router.allBindings().filter(
            (binding) => !this.router.isBackgroundThread(binding.threadId),
          ),
        idleState: (target) => this.router.idleState(target),
        ensureIdleState: (target, atMs) =>
          this.router.ensureIdleState(target, atMs),
        releaseIdle: (target) => service.releaseIdle(target),
        notifyReleased: (target, threadId) => {
          this.output.publish({
            type: "conversation.idle.released",
            target,
            threadId,
            minutes: config.idleReleaseMinutes,
          }, true);
          void this.providerIdleReleaser.closeIfIdle(true).catch((error) => {
            this.logger.warn(
              { err: error },
              "渠道会话空闲解除后的全局 Client 空闲检查失败",
            );
          });
        },
      });
      this.output.subscribe("conversation-idle-activity", (event) => {
        this.router.touchActivity(event.target, Date.now());
      });
    }
    this.output.subscribe("conversation-background-release", async (event) => {
      const threadId = event.type === "turn.completed"
        ? event.threadId
        : event.type === "subagent.completed"
          ? event.parentThreadId
          : undefined;
      if (!threadId || !this.router.isBackgroundThread(threadId)) {
        return;
      }
      try {
        await this.trackQueueLifecycleTask(() => event.type === "turn.completed"
          ? service.releaseBackgroundIfComplete(threadId, {
              // 0.148 deliberately keeps Queue entries after an interrupted turn;
              // only normal/failed completion participates in native idle dispatch.
              dispatchQueued: event.status !== "interrupted",
            })
          : service.retryPendingBackgroundRelease(threadId));
        void this.providerIdleReleaser.closeIfIdle().catch((error) => {
          this.logger.warn(
            { err: error },
            "后台任务终态后的全局 Client 空闲检查失败",
          );
        });
      } catch (error) {
        this.logger.warn(
          { err: error, threadId },
          "后台 Thread 终态后的订阅清理失败，已保留绑定供后续重试",
        );
        this.output.publish({
          type: "warning",
          target: event.target,
          threadId,
          background: true,
          message: "后台任务已完成，但订阅清理暂时失败；Gateway 重启后会重试。",
        }, true);
      }
    });
    this.output.subscribe("session-display-cache-refresh", (event) => {
      if (event.type !== "turn.completed") return;
      void this.trackQueueLifecycleTask(() =>
        service.refreshSessionDisplayCache(event.threadId)
      ).catch((error) => {
        this.logger.warn(
          { err: error, threadId: event.threadId, turnId: event.turnId },
          "Turn 完成后的会话轮数缓存刷新失败",
        );
      });
    });
    this.providerIdleReleaser = new ProviderIdleReleaser({
      logger,
      listConnectedProviders: () => this.codex.connectedProviderIds(),
      closeProvider: (provider) => this.codex.closeProvider(provider),
      releaseProvider: async (provider) => {
        const supervisor = await inspectAppServerSupervisorState(
          config.codexSocketPath,
        );
        if (supervisor.status !== "ready") {
          if (supervisor.status === "incompatible") {
            this.logger.warn(
              { provider },
              "App Server 监管协议版本不匹配，跳过空闲停止；"
              + "请运行 codexc service restart all 后重试",
            );
          }
          return;
        }
        const result = await releaseAppServerProvider(
          config.codexSocketPath,
          provider,
        );
        this.logger.info(
          { provider, ...result },
          result.released
            ? "App Server 已因 Gateway 全局空闲停止"
            : "App Server 未因租约占用或未运行而停止",
        );
      },
      listReleasableAppServers: async () => {
        const state = await inspectAppServerSupervisorState(config.codexSocketPath);
        if (state.status !== "ready") return [];
        const leased = new Set(state.topology.leasedProviders);
        return state.topology.runningProviders.filter(
          (provider) => !leased.has(provider),
        );
      },
      listBindings: () => this.bindings.list(),
      gracePeriodMs: 60_000,
      notifyBeforeClose: (providers) => {
        const seen = new Set<string>();
        const targets: ConversationTarget[] = [];
        for (const module of this.surfaceModules) {
          for (const target of module.notificationTargets?.() ?? []) {
            const key = `${target.surface}:${target.accountId}:${target.conversationId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            targets.push(target);
          }
        }
        if (targets.length === 0) {
          this.logger.info(
            { providers },
            "全局空闲释放即将开始，但没有已知渠道会话需要通知",
          );
          return;
        }
        for (const target of targets) {
          this.output.publish({
            type: "warning",
            target,
            message: formatProviderIdleReleaseNotice(),
            globalIdle: true,
          }, true);
        }
        this.logger.info(
          { providers, targetCount: targets.length },
          "全局空闲释放通知已投递到已知渠道会话",
        );
      },
    });
    this.scheduledTasks = config.scheduledTasksEnabled
      ? new ScheduledTaskComposition({
          stateDatabasePath: config.stateDatabasePath,
          router: this.router,
          codex: this.codex,
          bindings: this.bindings,
          workspaces: this.workspaces,
          core: this.core,
          output: this.output,
          logger,
          isSurfaceEnabled: (target) => this.surfaces.some((surface) =>
            surface.surface === target.surface && surface.accountId === target.accountId),
          creationContext: (target) => {
            const status = service.status(target);
            const workspace = this.workspaces.require(status.workspaceId);
            const sandbox = workspace.sandbox ?? "read-only";
            if (sandbox === "danger-full-access") {
              throw new UserFacingError(
                "scheduled-task.state.invalid",
                "计划任务不允许使用 danger-full-access Workspace",
              );
            }
            if (
              workspace.approvalPolicy !== undefined
              && workspace.approvalPolicy !== "never"
            ) {
              throw new UserFacingError(
                "scheduled-task.state.invalid",
                "当前 Workspace 不能形成 approvalPolicy=never 的无人值守环境",
              );
            }
            return {
              workspaceId: workspace.id,
              workspaceName: workspace.name,
              cwd: workspace.cwd,
              modelProvider: status.modelProvider ?? "openai",
              model: status.model,
              reasoningEffort: status.effort,
              serviceTier: status.serviceTier,
              sandbox,
              approvalPolicy: "never",
              permissions: workspace.permissions ?? null,
              modelPending: status.modelPending,
              effortPending: status.effortPending,
              serviceTierPending: status.fastModePending,
            };
          },
          presentConfirmation: (target, actorId, preview) => {
            this.surfaceManager.presentScheduledTaskConfirmation(target, actorId, preview);
          },
        })
      : undefined;
    const scheduledTaskUseCases = this.scheduledTasks?.service;
    const scheduledTaskToolHandler = this.scheduledTasks?.toolHandler;
    const commands = new ConversationCommandService(service, scheduledTaskUseCases);
    this.surfaceModules = createSurfaceModules({
      config,
      service,
      commands,
      bindings: this.bindings,
      logger,
      gatewayVersion: codexCliVersion,
      codexUpstreamUserAgent: () => this.codexUpstreamUserAgent,
      openAiConnectivity: () => this.openAiConnectivity,
      onFatal: (surface, accountId, error) => this.handleSurfaceFatal(
        surface,
        accountId,
        error,
      ),
      autoCompactPercent: (provider, model) => this.resolveAutoCompactPercent(provider, model),
    });
    this.surfaces = this.surfaceModules.map((module) => module.adapter);
    this.surfaceManager = new SurfaceManager(
      this.surfaces,
      this.output,
      logger,
      (target) => service.status(target, { includeGitBranch: true }).gitBranch,
      {
        setInteractionAvailable: (
          surface,
          accountId,
          available,
          outcome,
        ) => this.interactions.setAvailable(
          surface,
          accountId,
          available,
          outcome,
        ),
        completionTiming: async (threadId, turnId, current) => {
          const persisted = await metricsWriter.waitForCurrentWrites(threadId, turnId);
          if (!persisted) return current;
          const summary = metricsStore.threadSummary(threadId);
          return mergeCompletionTiming(summary.latestTurn, turnId, current);
        },
        taskAggregate: async (threadId, turnId): Promise<TurnTaskMetricsSummary | undefined> => {
          let summary = metricsStore.threadTurnTaskSummary(threadId, turnId);
          if (summary === null) return undefined;
          // The completion event can outrun the buffered request writer. Once
          // a child is known, wait for the current queue watermark so the
          // parent task total includes the root Turn's just-finished samples.
          const persisted = await metricsWriter.waitForCurrentWrites(threadId);
          if (!persisted) return undefined;
          summary = metricsStore.threadTurnTaskSummary(threadId, turnId);
          if (summary === null) return undefined;
          return {
            requestCount: summary.requestCount,
            unsuccessfulRequestCount: summary.unsuccessfulRequestCount,
            inputTokens: summary.inputTokens,
            cachedInputTokens: summary.cachedInputTokens,
            outputTokens: summary.outputTokens,
            reasoningOutputTokens: summary.reasoningOutputTokens,
          };
        },
        sessionAggregate: async (threadId): Promise<TurnTaskMetricsSummary | undefined> => {
          const persisted = await metricsWriter.waitForCurrentWrites(threadId);
          if (!persisted) return undefined;
          const aggregate = metricsStore.threadSummary(threadId).threadAggregate;
          if (aggregate === null) return undefined;
          return {
            requestCount: aggregate.requestCount,
            unsuccessfulRequestCount: aggregate.unsuccessfulRequestCount,
            inputTokens: aggregate.inputTokens,
            cachedInputTokens: aggregate.cachedInputTokens,
            outputTokens: aggregate.outputTokens,
            reasoningOutputTokens: aggregate.reasoningOutputTokens,
          };
        },
      },
    );
    this.channelImageSpool = new ChannelImageSpool({
      directory: join(dirname(config.stateDatabasePath), "channel-outbox"),
      resolveTarget: (threadId) => this.router.targetForThread(threadId),
      sendImage: (target, imagePath) =>
        this.surfaceManager.sendChannelImage(target, imagePath),
      logger,
    });
    for (const surface of this.surfaces) {
      this.interactions.register(surface.surface, surface.accountId, surface.interactions);
      this.interactions.setAvailable(surface.surface, surface.accountId, false);
    }
    this.approval = new ApprovalCoordinator(
      this.router,
      this.interactions,
      config.approvalTimeoutMs,
      logger,
    );
    this.inbound.subscribe("conversation-core", (notification) => {
      const queueChanged = toThreadQueueChangedEvent(notification);
      if (queueChanged) {
        service.invalidateQueueSnapshot(queueChanged.threadId);
        service.invalidateRevertSnapshot(queueChanged.threadId);
      }
      const coreEvent = toConversationInputEvent(notification);
      if (coreEvent) {
        if (
          coreEvent.type === "turn.started"
          || coreEvent.type === "turn.completed"
          || coreEvent.type === "thread.reverted"
          || coreEvent.type === "thread.closed"
          || coreEvent.type === "thread.archived"
          || coreEvent.type === "thread.deleted"
        ) {
          service.invalidateRevertSnapshot(coreEvent.threadId);
        }
        if (
          coreEvent.type === "turn.started"
          || coreEvent.type === "turn.completed"
          || coreEvent.type === "thread.reverted"
        ) {
          // The display cache is derived data. Invalidate before any list command
          // can observe a stale count, including Turns started by the native TUI.
          service.invalidateSessionDisplayCache(coreEvent.threadId);
        }
        if (coreEvent.type === "turn.started") {
          // A TUI or another App Server client may have consumed a native Queue
          // entry. Pending model/effort/Fast/Plan choices are Conversation-local
          // and must not leak into the next direct Turn after that dispatch.
          service.clearPendingSelectionsForThread(coreEvent.threadId);
        }
        if (
          coreEvent.type === "turn.error"
          && !coreEvent.willRetry
          && coreEvent.errorCode === "usageLimitExceeded"
        ) {
          service.markLunaReserveUsageLimit(coreEvent.threadId, coreEvent.turnId);
        }
        if (
          coreEvent.type === "turn.completed"
          && coreEvent.errorCode === "usageLimitExceeded"
        ) {
          service.markLunaReserveUsageLimit(coreEvent.threadId, coreEvent.turnId);
        }
        if (
          coreEvent.type === "thread.closed"
          || coreEvent.type === "thread.archived"
          || coreEvent.type === "thread.deleted"
        ) {
          service.clearLunaReserveThread(coreEvent.threadId);
        }
        if (
          coreEvent.type === "account.updated"
          && (coreEvent.modelProvider ?? "openai") === "openai"
        ) {
          service.clearLunaReserveAccountState();
        }
        if (coreEvent.type === "thread.status.changed" && coreEvent.status !== "active") {
          // A completion can race the native idle contributor. Retry only a
          // marked background release, without making the App Server reader
          // await any RPC or platform output.
          void this.trackQueueLifecycleTask(() =>
            service.retryPendingBackgroundRelease(coreEvent.threadId)
          ).catch((error) => {
            this.logger.warn(
              { err: error, threadId: coreEvent.threadId },
              "后台 Thread 空闲状态后的订阅清理失败，已保留绑定供后续重试",
            );
          });
        }
        this.subagentCompletion.handleInput(coreEvent);
        if (
          coreEvent.type === "item.subagentActivity"
          && (coreEvent.kind === "completed" || coreEvent.kind === "interrupted")
          && this.router.isBackgroundThread(coreEvent.threadId)
        ) {
          void this.trackQueueLifecycleTask(() =>
            service.retryPendingBackgroundRelease(coreEvent.threadId)
          ).catch((error) => {
            this.logger.warn(
              { err: error, threadId: coreEvent.threadId },
              "子代理终态后的后台 Thread 订阅清理失败，已保留绑定供后续重试",
            );
          });
        }
        this.core.handle(coreEvent);
        if (coreEvent.type === "turn.completed") {
          service.recoverLunaReserveAfterTurn(coreEvent.threadId, coreEvent.turnId);
        }
        if (coreEvent.type === "turn.error" && !coreEvent.willRetry) {
          const modelSettings = this.router.modelSettingsForThread(coreEvent.threadId);
          recordTurnErrorMetric(
            modelSettings?.modelProvider ?? "openai",
            modelSettings?.model ?? null,
            coreEvent.threadId,
            coreEvent.turnId,
            "notification",
            new Error(coreEvent.message),
            coreEvent.errorCode,
          );
        }
      }
      const threadStateEvent = toThreadStateEvent(notification);
      if (threadStateEvent) {
        this.threadState.handle(threadStateEvent);
      }
      if (
        !coreEvent
        && !threadStateEvent
        && notification.method !== "serverRequest/resolved"
        && !isHighFrequencyNotification(notification.method)
      ) {
        this.logger.debug(
          { method: notification.method },
          "忽略未支持或无效的 Codex Notification",
        );
      }
    });
    this.inbound.subscribe("approval-resolution", (notification) => {
      if (notification.method === "serverRequest/resolved") {
        const params = notification.params as { requestId?: string | number };
        if (params.requestId !== undefined) {
          this.approval.resolved(params.requestId);
        }
      }
    });
    const approvalHandler = (request: Parameters<typeof handleApprovalServerRequest>[0]) =>
      handleApprovalServerRequest(request, this.approval);
    const appServerRequestHandler: Parameters<typeof this.codex.setServerRequestHandler>[0] =
      async (request) => {
        if (request.method === "item/tool/call") {
          if (!scheduledTaskToolHandler) {
            throw new JsonRpcError(-32601, "计划任务动态工具未启用");
          }
          return scheduledTaskToolHandler(request);
        }
        return approvalHandler(request);
      };
    this.codex.setServerRequestHandler(
      this.scheduledTasks === undefined
        ? appServerRequestHandler
        : createScheduledTaskServerRequestHandler(
            this.scheduledTasks.coordinator,
            appServerRequestHandler,
        ),
    );
    this.bindingRestoreCoordinator();
  }

  protected bindingRestoreCoordinator(): BindingRestoreCoordinator {
    this.bindingRestore ??= new BindingRestoreCoordinator({
      codex: this.codex,
      router: this.router,
      output: this.output,
      enabledSurfaces: () => this.surfaces,
      scheduledRecovery: () => this.scheduledTasks?.coordinator,
      markTurnStarted: (target, threadId, turnId) => {
        this.core.markTurnStarted(target, threadId, turnId);
      },
      logger: this.logger,
    }, {
      disconnectedProviders: this.disconnectedProviders,
      disconnectedBindingsByProvider: this.disconnectedBindingsByProvider,
      pendingBindingRestores: this.pendingBindingRestores,
      restoringThreadIds: this.restoringThreadIds,
      restoreAttempt: this.bindingRestoreAttempt,
    });
    return this.bindingRestore;
  }

  hasActiveTurns(): boolean {
    return this.core.hasActiveTurns();
  }

  refreshAccountSnapshot(provider: string): Promise<boolean> {
    this.requireRunning();
    if (provider === "openai") return Promise.resolve(false);
    return this.providerAccounts?.refreshAccountSnapshot(provider)
      ?? Promise.resolve(false);
  }

  notifyProviderSettingsChange(
    action:
      | "provider-settings-scheduled"
      | "provider-settings-restarting"
      | "provider-settings-applied"
      | "provider-settings-failed",
    providers: readonly string[],
  ): void {
    this.surfaceManager.configurationChanged({
      action,
      changes: [configChange("provider.settings")],
      addedWorkspaces: [],
      providers,
    });
  }

  protected async startInternal(): Promise<void> {
    try {
      this.requireRunning();
      await this.providerMetrics.start();
      this.removeRpcNotification = this.codex.onNotification((notification) => {
        this.inbound.publish(notification, isCriticalNotification(notification.method));
      });
      this.removeRpcDisconnect = this.codex.onDisconnect((error, provider) => {
        void this.handleCodexDisconnect(error, provider);
      });
      const initialized = await this.codex.connect();
      this.requireRunning();
      this.codexUpstreamUserAgent = initialized.userAgent;
      if (this.primaryProvider === "openai" && this.customPrimaryProviderId === undefined) {
        const connectivityAbort = new AbortController();
        this.openAiConnectivityAbort = connectivityAbort;
        const [connectivity] = await Promise.all([
          this.probeOpenAiConnectivity(connectivityAbort.signal),
          this.refreshRateLimits(),
        ]).finally(() => {
          if (this.openAiConnectivityAbort === connectivityAbort) {
            this.openAiConnectivityAbort = undefined;
          }
        });
        this.openAiConnectivity = connectivity;
        if (connectivity === "unreachable") {
          this.logger.warn(
            { connectivity },
            "OpenAI 启动连通探测失败，渠道启动通知将显示提醒",
          );
        } else if (connectivity !== "reachable" && connectivity !== "not-applicable") {
          this.logger.warn(
            { connectivity },
            "OpenAI 启动线路探测返回警告，渠道启动通知将显示提醒",
          );
        }
      }
      this.requireRunning();
      await this.scheduledTasks?.prepareRecovery();
      await this.restoreBindings();
      this.requireRunning();
      this.logger.info(
        {
          transport: this.transport.kind,
          socketPath: this.config.codexSocketPath,
          platformFamily: initialized.platformFamily,
          platformOs: initialized.platformOs,
        },
        "Codex App Server 已连接",
      );
      await this.surfaceManager.start();
      void this.providerAccounts?.refreshSnapshots().catch((error) => {
        this.logger.warn({ err: error }, "账户快照异步预热失败");
      });
      await this.channelImageSpool.start();
      this.scheduledTasks?.start();
      this.conversationIdleReleaser?.start();
      this.providerIdleReleaser?.start();
      this.scheduleBindingRestore();
      void this.providerIdleReleaser?.closeIfIdle().catch((error) => {
        this.logger.warn(
          { err: error },
          "启动完成后的全局 Client 空闲检查失败",
        );
      });
      this.requireRunning();
    } catch (error) {
      this.stopping = true;
      this.reconnectAbort?.abort();
      await this.shutdownComponents().catch((cleanupError) => {
        this.logger.error({ err: cleanupError }, "Gateway 启动失败后的资源清理不完整");
      });
      throw error;
    }
  }

  protected shutdownComponents(): Promise<void> {
    this.shutdownTask ??= this.shutdownComponentsOnce();
    return this.shutdownTask;
  }

  private async shutdownComponentsOnce(): Promise<void> {
    this.openAiConnectivityAbort?.abort();
    this.openAiConnectivityAbort = undefined;
    this.removeRpcNotification?.();
    this.removeRpcNotification = undefined;
    this.removeRpcDisconnect?.();
    this.removeRpcDisconnect = undefined;
    this.subagentCompletion?.close();
    const failures: unknown[] = [];
    for (const [component, close] of [
      ["Scheduled Task Scheduler", () => this.scheduledTasks?.stop()],
      ["Queue Lifecycle", () => this.closeQueueLifecycleTasks()],
      ["Channel Image Spool", () => this.channelImageSpool.stop()],
      ["Provider Idle Releaser", () => this.providerIdleReleaser?.stop()],
      ["Conversation Idle Releaser", () => this.conversationIdleReleaser?.stop()],
      ["Luna Reserve", () => this.conversations?.closeLunaReserve()],
      ["Surface", () => this.surfaceManager.stop()],
      ["Provider Proxy Metrics", () => this.providerMetrics.close()],
      ["Inbound Event Bus", () => this.inbound.close()],
      ["Output Event Bus", () => this.output.close()],
      ["Codex Client", () => this.codex.close()],
      ["Binding Store", () => Promise.resolve(this.bindings.close())],
      ["Session Display Cache", () => Promise.resolve(this.sessionDisplayCache?.close())],
      ["Scheduled Task Store", () => Promise.resolve(this.scheduledTasks?.close())],
    ] as const) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
        this.logger.error({ err: error, component }, "Gateway 组件关闭失败");
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Gateway 资源未完全关闭");
    }
  }

  private trackQueueLifecycleTask(operation: () => Promise<unknown>): Promise<void> {
    if (this.stopping) {
      return Promise.resolve();
    }
    const task = operation().then(() => undefined);
    const tracked = task.finally(() => {
      this.queueLifecycleTasks.delete(tracked);
    });
    this.queueLifecycleTasks.add(tracked);
    return tracked;
  }

  private async closeQueueLifecycleTasks(): Promise<void> {
    if (this.queueLifecycleTasks.size === 0) {
      return;
    }
    const settled = Promise.allSettled([...this.queueLifecycleTasks]).then(() => undefined);
    if (!(await waitAtMost(settled, 5_000))) {
      throw new Error("等待 Queue 生命周期任务停止超时");
    }
  }

  deliverAddedWorkspaceNotifications(
    workspaces: readonly GatewayConfig["workspaces"][number][],
  ): Promise<void> {
    return this.surfaceManager.deliverConfigurationChange({
      action: "reloaded",
      changes: [configChange("workspace.registry")],
      addedWorkspaces: workspaces,
    });
  }

  notifyConfigReloadFailure(): void {
    this.surfaceManager.configurationChanged({
      action: "reload-failed",
      changes: [],
      addedWorkspaces: [],
    });
  }

  private beginReconnect(): void {
    if (this.reconnecting) {
      return;
    }
    const controller = new AbortController();
    this.reconnectAbort = controller;
    const task = this.reconnect(controller.signal)
      .catch((error) => {
        if (this.stopping || controller.signal.aborted) {
          return;
        }
        this.logger.fatal({ err: error }, "Codex App Server 重连次数耗尽，Gateway 将停止");
        process.exitCode = 1;
        void this.requestStop().catch((stopError) => {
          this.logger.error({ err: stopError }, "Codex 重连失败后停止 Gateway 失败");
        });
      })
      .finally(() => {
        if (this.reconnecting === task) {
          this.reconnecting = undefined;
        }
        if (this.reconnectAbort === controller) {
          this.reconnectAbort = undefined;
        }
        if (!this.stopping && this.bindingRestoreCoordinator().hasDisconnectedProviders()) {
          queueMicrotask(() => this.beginReconnect());
        }
      });
    this.reconnecting = task;
  }

  private async reconnect(signal: AbortSignal): Promise<void> {
    while (
      this.bindingRestoreCoordinator().hasDisconnectedProviders()
      && !this.stopping
      && !signal.aborted
    ) {
      const provider = this.bindingRestoreCoordinator().nextDisconnectedProvider();
      if (provider === undefined) return;
      await this.reconnectProvider(provider, signal);
    }
  }

  private async handleCodexDisconnect(error: Error, provider: string): Promise<void> {
    if (this.stopping) return;
    const affectedThreadIds = new Set(
      this.router.allBindings()
        .map((binding) => binding.threadId)
        .filter((threadId) => this.codex.knownProvider(threadId) === provider),
    );
    let intentionallyReleased = false;
    try {
      const topology = await inspectAppServerSupervisor(this.config.codexSocketPath);
      intentionallyReleased = topology?.releasedProviders.some(
        (releasedProvider) => releasedProvider === provider,
      ) === true;
    } catch (inspectError) {
      this.logger.warn(
        { err: inspectError, provider },
        "无法确认模型 Provider 是否主动停止，将按意外断线恢复",
      );
    }
    if (this.stopping) return;
    if (intentionallyReleased) {
      try {
        await this.codex.closeProvider(provider);
      } catch (closeError) {
        this.logger.warn({ err: closeError, provider }, "主动停止的 Provider Client 清理失败");
      }
      this.interactions.cancelThreads(affectedThreadIds);
      this.core.connectionLost(
        `${provider} App Server 已主动停止；再次使用时将自动启动`,
        affectedThreadIds,
      );
      this.logger.info({ provider }, "模型 Provider App Server 已主动停止");
      return;
    }
    this.bindingRestoreCoordinator().markProviderDisconnected(provider, affectedThreadIds);
    this.logger.warn({ err: error, provider }, "Codex App Server 连接已断开");
    this.interactions.cancelThreads(affectedThreadIds);
    this.core.connectionLost(
      `${provider} App Server 连接已断开，正在恢复连接`,
      affectedThreadIds,
    );
    this.beginReconnect();
  }

  private async reconnectProvider(provider: string, signal: AbortSignal): Promise<void> {
    const maximumAttempts = 12;
    for (
      let attempt = 1;
      attempt <= maximumAttempts && !this.stopping && !signal.aborted;
      attempt += 1
    ) {
      if (attempt > 1) {
        const ceiling = Math.min(30_000, 500 * 2 ** (attempt - 2));
        await abortableDelay(
          Math.floor(ceiling / 2 + Math.random() * ceiling / 2),
          signal,
        );
      }
      if (this.stopping || signal.aborted) {
        return;
      }
      try {
        const initialized = await this.codex.reconnectProvider(provider);
        if (this.stopping || signal.aborted) {
          return;
        }
        this.codexUpstreamUserAgent = initialized.userAgent;
        if (provider === "openai" && this.customPrimaryProviderId === undefined) {
          await this.refreshRateLimits();
        }
        if (this.stopping || signal.aborted) {
          return;
        }
        await this.restoreBindings(provider);
        this.scheduleBindingRestore();
        if (this.stopping || signal.aborted) {
          return;
        }
        const restoredThreadIds = this.bindingRestoreCoordinator()
          .affectedThreadsForProvider(provider);
        if (restoredThreadIds !== undefined && restoredThreadIds.size > 0) {
          this.core.connectionRestored(
            `${provider} App Server 已重新连接`,
            restoredThreadIds,
          );
        }
        this.bindingRestoreCoordinator().completeProviderReconnect(provider);
        this.logger.info(
          {
            attempt,
            provider,
            platformFamily: initialized.platformFamily,
            platformOs: initialized.platformOs,
          },
          "模型 Provider App Server 已重新连接",
        );
        return;
      } catch (error) {
        if (this.stopping || signal.aborted) {
          return;
        }
        this.logger.warn(
          { err: error, provider, attempt, maximumAttempts },
          "模型 Provider App Server 重连失败",
        );
      }
    }
    if (!this.stopping && !signal.aborted) {
      throw new Error(`${provider} App Server 重连 ${maximumAttempts} 次后仍然失败`);
    }
  }

  private requireRunning(): void {
    if (this.stopping) {
      throw new Error("Gateway 正在停止");
    }
  }

  private handleSurfaceFatal(surface: string, accountId: string, error: Error): void {
    if (this.stopping) {
      return;
    }
    this.surfaceManager.reportFatal(surface, accountId, error);
  }

  private resolveAutoCompactPercent(
    _provider: string | null | undefined,
    model: string | null | undefined,
  ): number | null {
    if (!model) return null;
    // 受管第三方 Provider 只配置模型窗口，压缩阈值由上游按窗口推导。
    const managed = loadManagedModelWindow(process.env).some(
      (candidate: { model: string }) => candidate.model === model,
    );
    if (managed) return null;
    const override = readCodexConfigModelOverride(process.env);
    if (
      override.contextWindow !== null
      && override.autoCompactTokenLimit !== null
      && override.contextWindow > 0
    ) {
      return Math.round(Math.min(100, override.autoCompactTokenLimit * 100 / override.contextWindow));
    }
    // 官方模型未在主配置覆盖时使用上游默认 95%。
    return 95;
  }

  private async refreshRateLimits(): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.codex.accountRateLimits({ background: true }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("读取 Codex 周限超时")), 5_000);
          timeout.unref();
        }),
      ]);
      this.core.rememberRateLimits(result.limits);
    } catch (error) {
      this.logger.warn({ err: error }, "读取 Codex 周限失败，启动通知暂不显示周限");
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async probeOpenAiConnectivity(
    signal?: AbortSignal,
  ): Promise<OpenAiConnectivityStatus> {
    const openAiBaseUrl = loadOpenAiBaseUrl();
    const deadlineMs = 12_000;
    const deadlineAt = Date.now() + deadlineMs;
    const deadlineController = new AbortController();
    const abortForShutdown = () => deadlineController.abort(
      signal?.reason ?? new Error("Gateway 正在停止"),
    );
    signal?.addEventListener("abort", abortForShutdown, { once: true });
    if (signal?.aborted) abortForShutdown();
    const deadline = setTimeout(
      () => deadlineController.abort(new Error("OpenAI 启动连通探测超时")),
      deadlineMs,
    );
    deadline.unref();
    try {
      const accountRoute = openAiBaseUrl === undefined
        ? await this.codex.openAiAccountRoute(deadlineController.signal)
        : "api";
      if (accountRoute === "not-required") {
        return "not-applicable";
      }
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) return "unreachable";
      return await checkOpenAiConnectivity({
        proxy: this.config.networkProxy,
        route: accountRoute,
        ...(openAiBaseUrl === undefined ? {} : { baseUrl: openAiBaseUrl }),
        deadlineMs: remainingMs,
        signal: deadlineController.signal,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      if (deadlineController.signal.aborted) {
        return "unreachable";
      }
      this.logger.warn({ err: error }, "读取 OpenAI 当前认证线路失败，无法执行启动连通探测");
      return "indeterminate";
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abortForShutdown);
    }
  }

  private isBindingRestoring(threadId: string): boolean {
    return this.bindingRestoreCoordinator().isRestoring(threadId);
  }

  private restoreBindings(
    provider?: string,
    requestedThreadIds?: ReadonlySet<string>,
  ): Promise<void> {
    return this.bindingRestoreCoordinator().restore(provider, requestedThreadIds);
  }

  private async releaseThread(
    target: ConversationTarget,
    force?: boolean,
  ): Promise<ThreadOccupancyReleaseResult> {
    const current = this.router.current(target);
    if (!current) {
      return { status: "unbound" };
    }
    const threadId = current.threadId;
    const inspection = inspectThreadWriterLock(threadId);
    if (!inspection.held) {
      this.retryPendingBindingRestore(threadId);
      return { status: "free", threadId };
    }
    if (inspection.holder === null) {
      return { status: "unidentifiable", threadId };
    }
    const holder = inspection.holder;
    const releasable = isReleaseableThreadWriterHolder(holder);
    const stuck = this.bindingRestoreCoordinator().hasPending(threadId);
    if (!force || !releasable) {
      return {
        status: "held",
        threadId,
        holder,
        releasable,
        stuck,
      };
    }
    const recheck = inspectThreadWriterLock(threadId);
    if (!recheck.held) {
      this.retryPendingBindingRestore(threadId);
      return { status: "released", threadId, holder };
    }
    const recheckedReleasable = recheck.holder !== null
      && isReleaseableThreadWriterHolder(recheck.holder);
    if (
      recheck.holder === null
      || recheck.holder.pid !== holder.pid
      || recheck.holder.startedAt !== holder.startedAt
      || !recheckedReleasable
    ) {
      return {
        status: "held",
        threadId,
        holder: recheck.holder ?? holder,
        releasable: recheckedReleasable,
        stuck,
      };
    }
    const exited = await terminateThreadWriterHolder(holder.pid, {
      ...(holder.startedAt === undefined ? {} : { startedAt: holder.startedAt }),
    });
    if (!exited) {
      return {
        status: "held",
        threadId,
        holder,
        releasable,
        stuck,
      };
    }
    this.retryPendingBindingRestore(threadId);
    return { status: "released", threadId, holder };
  }

  private retryPendingBindingRestore(threadId: string): void {
    this.bindingRestoreCoordinator().retry(threadId);
  }

  private scheduleBindingRestore(): void {
    this.bindingRestoreCoordinator().schedule();
  }
}

function isHighFrequencyNotification(method: string): boolean {
  return /\/(?:delta|outputDelta|progress)$/u.test(method);
}

function isReleaseableThreadWriterHolder(holder: ThreadLockHolder): boolean {
  if (holder.executable !== undefined) {
    return /^(?:.*[/\\])?codex(?:\.exe)?$/iu.test(holder.executable);
  }
  return /^(?:codex|[^\s]*[/\\]codex)(?:\s|$)/u.test(holder.command);
}


function surfaceLabel(surface: string): string {
  switch (surface) {
    case "telegram":
      return " Telegram";
    case "feishu":
      return "飞书";
    case "weixin":
      return "微信";
    default:
      return "其他渠道";
  }
}

function findAddedWorkspaces(
  current: ReadonlyArray<GatewayConfig["workspaces"][number]>,
  next: ReadonlyArray<GatewayConfig["workspaces"][number]>,
): GatewayConfig["workspaces"] {
  const currentIds = new Set(current.map((workspace) => workspace.id));
  return next.filter((workspace) => !currentIds.has(workspace.id));
}

export function immediateAddedWorkspaceNotifications(
  current: ReadonlyArray<GatewayConfig["workspaces"][number]>,
  next: ReadonlyArray<GatewayConfig["workspaces"][number]>,
  changes: readonly ConfigChange[],
  pending: ReadonlyArray<GatewayConfig["workspaces"][number]>,
): GatewayConfig["workspaces"] {
  const pendingIds = new Set(pending.map((workspace) => workspace.id));
  return (
    includesConfigChange(changes, "workspace.registry") ? findAddedWorkspaces(current, next) : []
  ).filter(
    (workspace) => !pendingIds.has(workspace.id),
  );
}

export async function waitAtMost(task: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
  });
}

function verifyCodexVersion(config: GatewayConfig): void {
  const invocation = executableInvocation(
    resolveExecutable(effectiveCodexBinary(config.codexBinary)),
    ["--version"],
  );
  const result = spawnSync(invocation.file, invocation.args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error("无法读取 Codex 版本");
  }
  const actual = result.stdout.trim();
  if (actual !== supportedCodexCliVersion) {
    throw new Error(
      `Codex 版本不受支持：当前 ${actual}，协议基线 ${supportedCodexCliVersion}`,
    );
  }
}

export function currentGitBranch(projectRoot: string): string | undefined {
  try {
    const branch = execFileSync(
      "git",
      ["-C", projectRoot, "branch", "--show-current"],
      {
        encoding: "utf8",
        maxBuffer: 4_096,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
      },
    ).trim();
    return branch && Buffer.byteLength(branch, "utf8") <= 512
      ? branch
      : undefined;
  } catch {
    return undefined;
  }
}

export { effectiveCodexBinary };

function isCriticalNotification(method: string): boolean {
  return !method.endsWith("/delta") && !method.endsWith("/outputDelta");
}
