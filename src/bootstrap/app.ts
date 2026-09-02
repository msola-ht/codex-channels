import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

import type { Logger } from "pino";

import { assertAppServerSocketPathSupported } from "../../runtime/app-server-runtime.mjs";
import { ensureAppServerProvider } from "../../runtime/app-server-supervisor.mjs";
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
  releaseAppServerProvider,
} from "../../runtime/app-server-supervisor.mjs";
import {
  loadOpencodeGoProviderIdentities,
  opencodeGoAccountIdFromProvider,
  opencodeGoProviderDisplayName,
} from "../../runtime/opencode-go-accounts.mjs";
import { listConfiguredAgentRoles } from "../../runtime/agent-roles.mjs";
import { ApprovalCoordinator, InteractionRouter } from "../approval/index.js";
import {
  CodexAppServerClient,
  createAppServerTransport,
  ProviderRoutingClient,
  gatewayVersion,
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
  classifyConfigReload,
  configChange,
  includesConfigChange,
  type ConfigChange,
  type ConfigReloadResult,
  type GatewayConfig,
} from "../config/index.js";
import {
  CollaborationModeSelectionService,
  ConversationService,
  ModelSelectionService,
  ProviderAccountService,
  scheduledTaskToolSpec,
  createOpenAiAccountAdapter,
  priceDisplayNeedsExchangeRate,
  type ThreadLockHolder,
  type ThreadOccupancyReleaseResult,
} from "../application/index.js";
import {
  ConversationCore,
  UserFacingError,
  isCriticalOutputEvent,
  surfaceAccountKey,
  type ConversationTarget,
  type OutputEvent,
  type TurnErrorCode,
  type TurnTaskMetricsSummary,
} from "../conversation-core/index.js";
import { EventBus } from "../event-bus/index.js";
import {
  BufferedModelRequestMetricsWriter,
  MetricsSync,
  modelRequestMetricsDatabasePath,
  SqliteModelRequestMetricsStore,
  type ModelPricingResolver,
} from "../observability/index.js";
import { WorkspaceRegistry } from "../policy/index.js";
import {
  SessionRouter,
  ThreadStateSynchronizer,
  type SubscriptionRestoreFailure,
} from "../session-routing/index.js";
import {
  SqliteBindingStore,
  SqliteSessionDisplayCache,
  type ConversationBinding,
} from "../storage/index.js";
import {
  setConfiguredCustomPrimaryProviderId,
  type SurfaceAdapter,
} from "../surfaces/index.js";
import { ChannelImageSpool } from "./channel-image-spool.js";
import {
  createSurfaceModules,
} from "./surface-composition.js";
import type { SurfaceRuntimeModule } from "./surface-plugin.js";
import { SurfaceManager } from "./surface-manager.js";
import { createOpencodeGoRemainingUsageReader } from "./opencode-go-account-adapter.js";
import { createProxyFetch } from "./proxy-fetch.js";
import {
  checkOpenAiConnectivity,
  type OpenAiConnectivityStatus,
} from "./openai-connectivity.js";
import { ProviderMetricsComposition } from "./provider-metrics-composition.js";
import {
  ProviderIdleReleaser,
  providerIdleReleaseMessage,
} from "./provider-idle-releaser.js";
import { enqueueTurnErrorMetric } from "./turn-error-metrics.js";
import { RemoteModelPricingCatalog } from "./model-pricing-catalog.js";
import { RemoteExchangeRate } from "./exchange-rate.js";
import {
  ProviderModelPricingResolver,
} from "./deepseek-model-pricing.js";
import {
  mergeCompletionTiming,
  mergeSessionReferenceCost,
} from "./reference-cost-summary.js";
import { TomlWorkspacePermissionWriter } from "./workspace-permission-writer.js";
import { SubagentCompletionTracker } from "./subagent-completion-tracker.js";
import { createScheduledTaskServerRequestHandler } from "./scheduled-task-server-request.js";
import { ScheduledTaskComposition } from "./scheduled-task-composition.js";
import { RequestMetricsQueryAdapter } from "./request-metrics-query-adapter.js";
import {
  createManagedProviderAccountAdapters,
  createManagedProviderPricingResolvers,
  managedProviderNeedsExchangeRate,
} from "./managed-provider-capabilities.js";

const bindingRestoreRetryDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const bindingRestoreEscalationAttempts = 3;

interface PendingBindingRestore {
  binding: ConversationBinding;
  occupiedNotified: boolean;
  failureCount: number;
}

export class GatewayApplication {
  private readonly transport: CodexTransport;
  private readonly codex: ProviderRoutingClient;
  private readonly primaryProvider: string;
  private readonly customPrimaryProviderId: string | undefined;
  private readonly inbound: EventBus<RpcNotification>;
  private readonly output: EventBus<OutputEvent>;
  private readonly surfaceModules: SurfaceRuntimeModule[];
  private readonly surfaces: SurfaceAdapter[];
  private readonly surfaceManager: SurfaceManager;
  private readonly channelImageSpool: ChannelImageSpool;
  private readonly interactions: InteractionRouter;
  private readonly approval: ApprovalCoordinator;
  private readonly router: SessionRouter;
  private readonly threadState: ThreadStateSynchronizer;
  private readonly core: ConversationCore;
  private readonly providerMetrics: ProviderMetricsComposition;
  private readonly modelPricing: RemoteModelPricingCatalog;
  private readonly pricingResolver: ModelPricingResolver;
  private readonly modelPricingNeedsExchangeRate: boolean;
  private readonly exchangeRate: RemoteExchangeRate;
  private readonly metricsSync: MetricsSync;
  private readonly providerIdleReleaser: ProviderIdleReleaser;
  private readonly bindings: SqliteBindingStore;
  private readonly sessionDisplayCache?: SqliteSessionDisplayCache;
  private readonly workspaces: WorkspaceRegistry;
  private readonly workspacePermissions: TomlWorkspacePermissionWriter | undefined;
  private readonly subagentCompletion: SubagentCompletionTracker;
  private readonly scheduledTasks: ScheduledTaskComposition | undefined;
  private removeRpcNotification: (() => void) | undefined;
  private removeRpcDisconnect: (() => void) | undefined;
  private startTask: Promise<void> | undefined;
  private stopTask: Promise<void> | undefined;
  private shutdownTask: Promise<void> | undefined;
  private startupSettled = false;
  private reconnecting: Promise<void> | undefined;
  private reconnectAbort: AbortController | undefined;
  private readonly disconnectedProviders = new Set<string>();
  private readonly disconnectedBindingsByProvider = new Map<string, Set<string>>();
  private readonly pendingBindingRestores = new Map<string, PendingBindingRestore>();
  private readonly restoringThreadIds = new Set<string>();
  private readonly queueLifecycleTasks = new Set<Promise<void>>();
  private bindingRestoreTimer: NodeJS.Timeout | undefined;
  private bindingRestoreTask: Promise<void> | undefined;
  private bindingRestoreAttempt = 0;
  private codexUpstreamUserAgent: string | undefined;
  private openAiConnectivity: OpenAiConnectivityStatus = "not-applicable";
  private stopping = false;

  constructor(
    private config: GatewayConfig,
    private readonly logger: Logger,
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
      new JsonRpcClient(this.transport, 60_000, logger),
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
        new JsonRpcClient(providerTransport, 60_000, logger),
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
        new JsonRpcClient(providerTransport, 60_000, logger),
        { sandbox: config.codexSandbox },
      ));
    }
    this.codex = new ProviderRoutingClient(
      primaryProvider,
      clients,
      async (provider) => {
        this.providerIdleReleaser?.markLaunching(provider);
        try {
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
    this.metricsSync = new MetricsSync({
      config: config.metricsSync ?? {
        enabled: false,
        batchSize: 200,
        intervalSeconds: 60,
      },
      store: metricsStore,
      statePath: join(dirname(config.stateDatabasePath), "metrics-sync-state.json"),
      fetchImpl: createProxyFetch(config.networkProxy),
      logger,
      providerIdentities: () => loadOpencodeGoProviderIdentities(),
    });
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
    this.modelPricing = new RemoteModelPricingCatalog({
      cachePath: join(dirname(config.stateDatabasePath), "model-pricing.json"),
      fetchImpl: createProxyFetch(config.networkProxy),
      logger,
    });
    this.exchangeRate = new RemoteExchangeRate({
      cachePath: join(dirname(config.stateDatabasePath), "exchange-rate.json"),
      fetchImpl: createProxyFetch(config.networkProxy),
      logger,
    });
    const pricingResolvers = createManagedProviderPricingResolvers(
      providerDefinitions,
      { exchangeRate: () => this.exchangeRate.resolve() },
    );
    this.pricingResolver = new ProviderModelPricingResolver(
      this.modelPricing,
      pricingResolvers,
    );
    this.modelPricingNeedsExchangeRate = managedProviderNeedsExchangeRate(
      providerDefinitions,
      new Set([
        primaryProvider,
        ...managedProviders.map(({ provider }) => provider),
      ]),
    );
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
      pricingResolver: this.pricingResolver,
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
    const providerAccounts = new ProviderAccountService(accountAdapters);
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
      providerAccounts,
      new RequestMetricsQueryAdapter(metricsStore, this.router, config.apiProviders),
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
      (provider, resetsAt) => readRemoteQuotaSummary(
        this.config.metricsView,
        provider,
        resetsAt,
        this.logger,
      ),
      (parentThreadId) =>
        this.subagentCompletion.hasPendingForParentThread(parentThreadId),
      this.sessionDisplayCache,
    );
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
      isAccountProvider: (provider) =>
        opencodeGoAccountIdFromProvider(provider) !== undefined,
      listRunningProviders: async () =>
        (await inspectAppServerSupervisor(config.codexSocketPath))?.runningProviders ?? [],
      releaseProvider: async (provider) => {
        const result = await releaseAppServerProvider(config.codexSocketPath, provider);
        if (!result.released) return false;
        await this.codex.closeProvider(provider).catch((error) => {
          logger.warn(
            { err: error, provider },
            "空闲 Provider 路由 Client 关闭失败，已保留按需重连状态",
          );
        });
        return true;
      },
      providerForThread: (threadId) =>
        this.router.modelSettingsForThread(threadId)?.modelProvider,
      listBindings: () => this.bindings.list(),
      notify: (provider, targets) => {
        const accountId = opencodeGoAccountIdFromProvider(provider);
        const label = accountId === undefined
          ? provider
          : opencodeGoProviderDisplayName(provider);
        const message = providerIdleReleaseMessage(label);
        if (targets.length === 0) {
          this.logger.info({ provider }, "OpenCode Go 账户已释放，无渠道会话需要通知");
          return;
        }
        for (const target of targets) {
          this.output.publish({ type: "warning", target, message }, true);
        }
      },
    });
    this.output.subscribe("provider-idle-activity", (event) => {
      if (event.type !== "turn.started" && event.type !== "turn.completed") return;
      const provider = this.router.modelSettingsForThread(event.threadId)?.modelProvider;
      this.providerIdleReleaser.touch(provider, event.target);
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
    this.surfaceModules = createSurfaceModules({
      config,
      service,
      ...(scheduledTaskUseCases === undefined ? {} : { scheduledTasks: scheduledTaskUseCases }),
      bindings: this.bindings,
      logger,
      gatewayVersion,
      codexUpstreamUserAgent: () => this.codexUpstreamUserAgent,
      openAiConnectivity: () => this.openAiConnectivity,
      onFatal: (surface, accountId, error) => this.handleSurfaceFatal(
        surface,
        accountId,
        error,
      ),
      exchangeRate: () => this.exchangeRate.resolve(),
      priceCurrency: () => this.config.priceCurrency,
      remainingUsage: createOpencodeGoRemainingUsageReader({
        fetchImpl: createProxyFetch(config.networkProxy),
        metricsDatabasePath: modelRequestMetricsDatabasePath(
          config.stateDatabasePath,
        ),
      }),
      remoteQuota: (provider, resetsAt) => readRemoteQuotaSummary(config.metricsView, provider, resetsAt, logger),
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
        sessionReferenceCost: (threadId, turnId, current) =>
          mergeSessionReferenceCost(
            metricsStore.threadSummary(threadId),
            turnId,
            current,
          ),
          remoteQuota: (provider, resetsAt) => readRemoteQuotaSummary(
            this.config.metricsView,
            provider,
            resetsAt,
            this.logger,
          ),
        completionTiming: async (threadId, turnId, current) => {
          await metricsWriter.waitForCurrentWrites(threadId);
          const summary = metricsStore.threadSummary(threadId);
          return mergeCompletionTiming(summary.latestTurn, turnId, current);
        },
        taskAggregate: async (threadId, turnId): Promise<TurnTaskMetricsSummary | undefined> => {
          let summary = metricsStore.threadTurnTaskSummary(threadId, turnId);
          if (summary === null) return undefined;
          // The completion event can outrun the buffered request writer. Once
          // a child is known, wait for the current queue watermark so the
          // parent task total includes the root Turn's just-finished samples.
          await metricsWriter.waitForCurrentWrites(threadId);
          summary = metricsStore.threadTurnTaskSummary(threadId, turnId);
          if (summary === null) return undefined;
          return {
            requestCount: summary.requestCount,
            unsuccessfulRequestCount: summary.unsuccessfulRequestCount,
            inputTokens: summary.inputTokens,
            cachedInputTokens: summary.cachedInputTokens,
            outputTokens: summary.outputTokens,
            reasoningOutputTokens: summary.reasoningOutputTokens,
            pricedRequestCount: summary.pricedRequestCount,
            pricedInputTokens: summary.pricedInputTokens,
            pricedOutputTokens: summary.pricedOutputTokens,
            totalCostNanos: summary.totalCostNanos,
            inputCostNanos: summary.inputCostNanos,
            cachedInputCostNanos: summary.cachedInputCostNanos,
            outputCostNanos: summary.outputCostNanos,
            pricingCurrency: summary.pricingCurrency,
            uncachedInputPricePerMillionNanos:
              summary.uncachedInputPricePerMillionNanos,
            cachedInputPricePerMillionNanos:
              summary.cachedInputPricePerMillionNanos,
            outputPricePerMillionNanos: summary.outputPricePerMillionNanos,
            hasMixedPrices: summary.hasMixedPrices,
            pricingBuckets: summary.pricingBuckets,
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
  }

  hasActiveTurns(): boolean {
    return this.core.hasActiveTurns();
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

  start(): Promise<void> {
    this.startTask ??= this.startInternal().finally(() => {
      this.startupSettled = true;
    });
    return this.startTask;
  }

  stop(): Promise<void> {
    if (this.stopTask) {
      return this.stopTask;
    }
    this.stopping = true;
    this.reconnectAbort?.abort();
    if (this.bindingRestoreTimer) {
      clearTimeout(this.bindingRestoreTimer);
      this.bindingRestoreTimer = undefined;
    }
    const startup = this.startTask;
    const reconnecting = this.reconnecting;
    const restoringBindings = this.bindingRestoreTask;
    this.stopTask = (async () => {
      const failures: unknown[] = [];
      if (startup && !this.startupSettled) {
        this.removeRpcNotification?.();
        this.removeRpcNotification = undefined;
        this.removeRpcDisconnect?.();
        this.removeRpcDisconnect = undefined;
        try {
          await this.codex.close();
        } catch (error) {
          failures.push(error);
          this.logger.error({ err: error, component: "Codex Client" }, "Gateway 启动中断失败");
        }
      }
      await startup?.catch(() => undefined);
      if (restoringBindings && !(await waitAtMost(restoringBindings, 5_000))) {
        const error = new Error("等待 Codex Thread 订阅恢复任务停止超时");
        failures.push(error);
        this.logger.error({ err: error }, "Gateway 后台任务关闭失败");
      }
      try {
        await this.shutdownComponents();
      } catch (error) {
        failures.push(error);
      }
      if (reconnecting && !(await waitAtMost(reconnecting, 5_000))) {
        const error = new Error("等待 Codex App Server 重连任务停止超时");
        failures.push(error);
        this.logger.error({ err: error }, "Gateway 后台任务关闭失败");
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Gateway 资源未完全关闭");
      }
    })();
    return this.stopTask;
  }

  private async startInternal(): Promise<void> {
    try {
      this.requireRunning();
      this.modelPricing.start();
      if (this.modelPricingNeedsExchangeRate || priceDisplayNeedsExchangeRate(this.config)) {
        this.exchangeRate.start();
      }
      if (this.config.metricsSync?.enabled) {
        this.metricsSync.start();
      }
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
        const [connectivity] = await Promise.all([
          this.primaryProvider === undefined
            ? Promise.resolve<OpenAiConnectivityStatus>("not-applicable")
            : this.probeOpenAiConnectivity(),
          this.refreshRateLimits(),
        ]);
        this.openAiConnectivity = connectivity;
        if (connectivity === "unreachable") {
          this.logger.warn(
            { connectivity },
            "OpenAI 启动连通探测失败，渠道启动通知将显示提醒",
          );
        } else if (connectivity === "partial") {
          this.logger.info(
            { connectivity },
            "OpenAI 启动连通探测部分通过，不影响渠道启动通知",
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
      await this.channelImageSpool.start();
      this.scheduledTasks?.start();
      this.providerIdleReleaser?.start();
      this.scheduleBindingRestore();
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

  private shutdownComponents(): Promise<void> {
    this.shutdownTask ??= this.shutdownComponentsOnce();
    return this.shutdownTask;
  }

  private async shutdownComponentsOnce(): Promise<void> {
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
      ["Surface", () => this.surfaceManager.stop()],
      ["Metrics Sync", () => this.metricsSync.close()],
      ["Provider Proxy Metrics", () => this.providerMetrics.close()],
      ["Model Pricing", () => this.modelPricing.close()],
      ["Exchange Rate", () => this.exchangeRate.close()],
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

  reloadConfig(
    next: GatewayConfig,
    pendingAddedWorkspaces: readonly GatewayConfig["workspaces"][number][] = [],
  ): ConfigReloadResult {
    const result = classifyConfigReload(this.config, next);
    if (result.action === "reinstall") {
      this.surfaceManager.configurationChanged({
        action: "reinstall-required",
        changes: result.changes,
        addedWorkspaces: [],
      });
      return result;
    }
    if (result.action === "restart") {
      const restoreRecipients: Array<() => void> = [];
      try {
        for (const module of this.surfaceModules) {
          restoreRecipients.push(module.prepareRestartNotification(next));
        }
        this.surfaceManager.configurationChanged({
          action: "restarting",
          changes: result.changes,
          addedWorkspaces: [],
        });
      } finally {
        for (const restore of restoreRecipients.reverse()) {
          restore();
        }
      }
      return result;
    }

    const addedWorkspaces = immediateAddedWorkspaceNotifications(
      this.config.workspaces,
      next.workspaces,
      result.changes,
      pendingAddedWorkspaces,
    );
    if (includesConfigChange(result.changes, "workspace.registry")) {
      this.workspaces.replace(next.workspaces, next.defaultWorkspaceId);
    }
    for (const module of this.surfaceModules) {
      module.applyHotReload(next, result.changes);
    }
    this.config = next;
    const nonWorkspaceChanges = result.changes.filter(
      (change) => change.code !== "workspace.registry",
    );
    if (nonWorkspaceChanges.length > 0 || addedWorkspaces.length > 0) {
      this.surfaceManager.configurationChanged({
        action: "reloaded",
        changes: result.changes,
        addedWorkspaces,
      });
    }
    return result;
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
        void this.stop().catch((stopError) => {
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
        if (!this.stopping && this.disconnectedProviders.size > 0) {
          queueMicrotask(() => this.beginReconnect());
        }
      });
    this.reconnecting = task;
  }

  private async reconnect(signal: AbortSignal): Promise<void> {
    while (this.disconnectedProviders.size > 0 && !this.stopping && !signal.aborted) {
      const provider = this.disconnectedProviders.values().next().value as string;
      await this.reconnectProvider(provider, signal);
      this.disconnectedProviders.delete(provider);
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
    this.disconnectedProviders.add(provider);
    this.logger.warn({ err: error, provider }, "Codex App Server 连接已断开");
    if (affectedThreadIds.size > 0) {
      const existing = this.disconnectedBindingsByProvider.get(provider);
      if (existing) {
        for (const threadId of affectedThreadIds) existing.add(threadId);
      } else {
        this.disconnectedBindingsByProvider.set(provider, affectedThreadIds);
      }
    }
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
        const restoredThreadIds = this.disconnectedBindingsByProvider.get(provider);
        if (restoredThreadIds !== undefined && restoredThreadIds.size > 0) {
          this.core.connectionRestored(
            `${provider} App Server 已重新连接`,
            restoredThreadIds,
          );
        }
        this.disconnectedBindingsByProvider.delete(provider);
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

  private async refreshRateLimits(): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.codex.accountRateLimits(),
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

  private async probeOpenAiConnectivity(): Promise<OpenAiConnectivityStatus> {
    const openAiBaseUrl = loadOpenAiBaseUrl();
    return await checkOpenAiConnectivity({
      proxy: this.config.networkProxy,
      ...(openAiBaseUrl === undefined ? {} : { baseUrl: openAiBaseUrl }),
    });
  }

  private async restoreBindings(
    provider?: string,
    requestedThreadIds?: ReadonlySet<string>,
  ): Promise<void> {
    const enabledSurfaces = new Set(
      this.surfaces.map((surface) => surfaceAccountKey(surface.surface, surface.accountId)),
    );
    const scheduledThreadIds = this.scheduledTasks?.coordinator.runningThreadIds()
      ?? new Set<string>();
    const candidateThreadIds = new Set(
      this.router.allBindings()
        .filter((binding) => {
          const bindingProvider = this.codex.knownProvider(binding.threadId);
          return !this.stopping
            && (
              enabledSurfaces.has(surfaceAccountKey(
                binding.target.surface,
                binding.target.accountId,
              ))
              || scheduledThreadIds.has(binding.threadId)
            )
            && !this.restoringThreadIds.has(binding.threadId)
            && (requestedThreadIds === undefined
              || requestedThreadIds.has(binding.threadId))
            && (provider === undefined || bindingProvider === provider)
            && (provider !== undefined
              || bindingProvider === undefined
              || !this.disconnectedProviders.has(bindingProvider));
        })
        .map((binding) => binding.threadId),
    );
    if (candidateThreadIds.size === 0) {
      if (provider === undefined && requestedThreadIds === undefined) {
        await this.scheduledTasks?.coordinator.recoverRunning(scheduledThreadIds);
      }
      return;
    }
    for (const threadId of candidateThreadIds) {
      this.restoringThreadIds.add(threadId);
    }
    const restoredThreadIds = new Set<string>();
    let failures: SubscriptionRestoreFailure[];
    try {
      failures = await this.router.restoreSubscriptions(
        (_target, binding) => candidateThreadIds.has(binding.threadId),
        (binding, thread) => {
          restoredThreadIds.add(binding.threadId);
          if (thread.status.type !== "active") {
            if (
              this.router.isBackgroundThread(binding.threadId)
              && !scheduledThreadIds.has(binding.threadId)
            ) {
              this.output.publish({
                type: "warning",
                target: binding.target,
                threadId: binding.threadId,
                background: true,
                message: "后台任务已在 Gateway 离线期间结束，可通过 /resume 查看完整会话。",
              }, true);
            }
            return;
          }
          if (thread.activeTurnId) {
            this.core.markTurnStarted(
              binding.target,
              binding.threadId,
              thread.activeTurnId,
            );
            this.logger.info(
              {
                surface: binding.target.surface,
                accountId: binding.target.accountId,
                conversationId: binding.target.conversationId,
                threadId: binding.threadId,
                turnId: thread.activeTurnId,
              },
              "已恢复正在运行的 Codex Turn",
            );
          }
        },
        (binding) => {
          const task = this.scheduledTasks?.coordinator.taskForThread(binding.threadId);
          return task?.modelProvider == null
            ? {}
            : { modelProvider: task.modelProvider };
        },
        (binding) => scheduledThreadIds.has(binding.threadId),
      );
    } finally {
      for (const threadId of candidateThreadIds) {
        this.restoringThreadIds.delete(threadId);
      }
    }
    for (const threadId of restoredThreadIds) {
      const pending = this.pendingBindingRestores.get(threadId);
      if (!pending) {
        continue;
      }
      this.pendingBindingRestores.delete(threadId);
      if (pending.occupiedNotified) {
        this.publishThreadAvailability(pending.binding, "available");
      }
    }
    await this.scheduledTasks?.coordinator.recoverRunning(restoredThreadIds);
    for (const failure of failures) {
      this.logger.warn(
        {
          err: failure.error,
          threadId: failure.binding.threadId,
          bindingRemoved: failure.bindingRemoved,
        },
        failure.bindingRemoved
          ? "恢复 Codex Thread 订阅永久失败，已移除持久化绑定"
          : "恢复 Codex Thread 订阅暂时失败，已保留持久化绑定",
      );
      if (failure.bindingRemoved) {
        this.pendingBindingRestores.delete(failure.binding.threadId);
        continue;
      }
      const previous = this.pendingBindingRestores.get(failure.binding.threadId);
      const failureCount = (previous?.failureCount ?? 0) + 1;
      const shouldNotifyOccupied = failure.reason === "active-writer"
        || (
          failure.reason === "other"
          && failureCount >= bindingRestoreEscalationAttempts
        );
      const occupiedNotified = previous?.occupiedNotified === true
        || shouldNotifyOccupied;
      this.pendingBindingRestores.set(failure.binding.threadId, {
        binding: failure.binding,
        occupiedNotified,
        failureCount,
      });
      if (shouldNotifyOccupied && !previous?.occupiedNotified) {
        this.publishThreadAvailability(failure.binding, "occupied");
      }
    }
    if (this.router.allBindings().length > 0) {
      this.logger.info(
        { bindings: this.router.allBindings().length },
        "已恢复外部会话与 Codex Thread 绑定",
      );
    }
    if (this.pendingBindingRestores.size === 0) {
      this.bindingRestoreAttempt = 0;
    }
  }

  private publishThreadAvailability(
    binding: ConversationBinding,
    availability: "occupied" | "available",
  ): void {
    this.output.publish({
      type: "thread.availability",
      target: binding.target,
      threadId: binding.threadId,
      availability,
      background: this.router.isBackgroundThread(binding.threadId),
    }, true);
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
    const stuck = this.pendingBindingRestores.has(threadId);
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
    if (!this.pendingBindingRestores.has(threadId)) {
      return;
    }
    void this.restoreBindings(undefined, new Set([threadId]));
  }

  private scheduleBindingRestore(): void {
    if (
      this.stopping
      || this.pendingBindingRestores.size === 0
      || this.bindingRestoreTimer
      || this.bindingRestoreTask
    ) {
      return;
    }
    const delayIndex = Math.min(
      this.bindingRestoreAttempt,
      bindingRestoreRetryDelaysMs.length - 1,
    );
    const delayMs = bindingRestoreRetryDelaysMs[delayIndex]!;
    this.bindingRestoreAttempt += 1;
    this.bindingRestoreTimer = setTimeout(() => {
      this.bindingRestoreTimer = undefined;
      if (this.stopping) {
        return;
      }
      const requestedThreadIds = new Set(this.pendingBindingRestores.keys());
      const task = this.restoreBindings(undefined, requestedThreadIds)
        .catch((error) => {
          if (!this.stopping) {
            this.logger.warn({ err: error }, "Codex Thread 订阅后台恢复失败");
          }
        })
        .finally(() => {
          if (this.bindingRestoreTask === task) {
            this.bindingRestoreTask = undefined;
          }
          this.scheduleBindingRestore();
        });
      this.bindingRestoreTask = task;
    }, delayMs);
    this.bindingRestoreTimer.unref();
  }
}

async function readRemoteQuotaSummary(
  settings: GatewayConfig["metricsView"] | undefined,
  provider: string | undefined,
  resetsAt: number | null | undefined,
  logger?: Pick<Logger, "warn">,
): Promise<import("../conversation-core/index.js").RemoteQuotaSummary | undefined> {
  if (!settings?.enabled || !settings.endpoint || !settings.token || !provider) {
    return undefined;
  }
  const controller = new AbortController();
  // The center may aggregate a year's worth of periods from SQLite. Keep the
  // request bounded, but do not treat a normal local response (~1s) as a
  // failure and silently fall back to the single-device estimate.
  const timeout = setTimeout(() => controller.abort(), 2_500);
  try {
    const endpoint = new URL("/api/quota?days=365", settings.endpoint);
    const response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${settings.token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      logger?.warn({ provider, resetsAt, status: response.status }, "指标中心额度查询失败");
      return undefined;
    }
    const body = await response.json() as {
      periods?: Array<{
        provider?: string;
        windowId?: string;
        resetsAt?: number;
        deviceCount?: number;
        requestCount?: number;
        totalTokens?: number;
        totalCostNanos?: number;
        latestUsedPercentMillionths?: number | null;
        estimatedTotalTokens?: number | null;
        estimatedTotalCostNanos?: number | null;
        tokensPerPercent?: number | null;
        costPerPercentNanos?: number | null;
        lastObservedAtMs?: number;
      }>;
    };
    const candidates = body.periods?.filter((candidate) => candidate.provider === provider) ?? [];
    const exactPeriod = resetsAt === null || resetsAt === undefined
      ? undefined
      : candidates.find((candidate) =>
          candidate.windowId === "codex"
          && typeof candidate.resetsAt === "number"
          && Math.abs(candidate.resetsAt - resetsAt) <= 5 * 60,
        );
    // A provider may refresh its reset timestamp between two snapshots. If an
    // exact match is absent, only use the most recently observed future codex
    // period; never fall back to an older completed period.
    const period = exactPeriod ?? candidates
      .filter((candidate) => candidate.windowId === "codex"
        && typeof candidate.resetsAt === "number"
        && candidate.resetsAt >= Math.floor(Date.now() / 1_000)
        && typeof candidate.lastObservedAtMs === "number")
      .sort((a, b) => (b.lastObservedAtMs ?? 0) - (a.lastObservedAtMs ?? 0))[0];
    if (!period || typeof period.deviceCount !== "number" || typeof period.requestCount !== "number"
      || typeof period.totalTokens !== "number" || typeof period.resetsAt !== "number"
      || typeof period.lastObservedAtMs !== "number") {
      logger?.warn({
        provider,
        resetsAt,
        candidateResetsAt: candidates
          .filter((candidate) => candidate.windowId === "codex")
          .map((candidate) => candidate.resetsAt)
          .filter((value): value is number => typeof value === "number")
          .slice(0, 8),
      }, "指标中心额度周期未命中");
      return undefined;
    }
    return {
      provider,
      windowId: period.windowId ?? "codex",
      deviceCount: period.deviceCount,
      requestCount: period.requestCount,
      totalTokens: period.totalTokens,
      totalCostNanos: typeof period.totalCostNanos === "number" ? period.totalCostNanos : null,
      latestUsedPercentMillionths: period.latestUsedPercentMillionths ?? null,
      estimatedTotalTokens: period.estimatedTotalTokens ?? null,
      estimatedTotalCostNanos: period.estimatedTotalCostNanos ?? null,
      resetsAt: period.resetsAt,
      tokensPerPercent: period.tokensPerPercent ?? null,
      costPerPercentNanos: period.costPerPercentNanos ?? null,
      observedAtMs: period.lastObservedAtMs,
    };
  } catch (error) {
    logger?.warn({
      err: error,
      provider,
      resetsAt,
    }, "指标中心额度读取异常，回退本机估算");
    return undefined;
  } finally {
    clearTimeout(timeout);
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

function immediateAddedWorkspaceNotifications(
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

async function waitAtMost(task: Promise<void>, timeoutMs: number): Promise<boolean> {
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
