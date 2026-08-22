import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

import type { Logger } from "pino";

import { ensureAppServerProvider } from "../../runtime/app-server-supervisor.mjs";
import { effectiveCodexBinary } from "../../runtime/executable.mjs";
import {
  checkProjectRulesAtRoot,
  initializeProjectRulesAtRoot,
} from "../../runtime/project-rules.mjs";
import {
  loadManagedModelProviderDefinitions,
} from "../../runtime/model-provider-definitions.mjs";
import {
  loadConfiguredCustomPrimaryModelProvider,
  loadManagedModelProviders,
  loadOpenAiBaseUrl,
  loadManagedModelProviderRole,
  loadPrimaryModelProvider,
  managedProviderDirectory,
  providerAppServerSocketPath,
  providerMetricsSocketPath,
} from "../../runtime/model-provider-runtime.mjs";
import {
  inspectThreadWriterLock,
  terminateThreadWriterHolder,
} from "../../runtime/thread-writer-lock.mjs";
import {
  inspectAppServerSupervisor,
  releaseAppServerProvider,
} from "../../runtime/app-server-supervisor.mjs";
import { opencodeGoAccountIdFromProvider } from "../../runtime/opencode-go-accounts.mjs";
import { listConfiguredAgentRoles } from "../../runtime/agent-roles.mjs";
import { ApprovalCoordinator, InteractionRouter } from "../approval/index.js";
import {
  CodexAppServerClient,
  ProviderRoutingClient,
  gatewayVersion,
  handleApprovalServerRequest,
  loadManagedModelOptions,
  JsonRpcClient,
  supportedCodexCliVersion,
  toConversationInputEvent,
  toThreadQueueChangedEvent,
  toThreadStateEvent,
  UnixWebSocketTransport,
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
  createOpenAiAccountAdapter,
  priceDisplayNeedsExchangeRate,
  type ThreadLockHolder,
  type ThreadOccupancyReleaseResult,
  type RequestMetricsTimeRange,
} from "../application/index.js";
import {
  ConversationCore,
  isCriticalOutputEvent,
  surfaceAccountKey,
  type ConversationTarget,
  type OutputEvent,
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
import { ProviderIdleReleaser } from "./provider-idle-releaser.js";
import { enqueueTurnErrorMetric } from "./turn-error-metrics.js";
import { RemoteModelPricingCatalog } from "./model-pricing-catalog.js";
import { RemoteExchangeRate } from "./exchange-rate.js";
import {
  ProviderModelPricingResolver,
} from "./deepseek-model-pricing.js";
import { mergeSessionReferenceCost } from "./reference-cost-summary.js";
import { TomlWorkspacePermissionWriter } from "./workspace-permission-writer.js";
import { SubagentCompletionTracker } from "./subagent-completion-tracker.js";
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
  private readonly transport: UnixWebSocketTransport;
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
  private readonly workspaces: WorkspaceRegistry;
  private readonly workspacePermissions: TomlWorkspacePermissionWriter | undefined;
  private readonly subagentCompletion: SubagentCompletionTracker;
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
    this.transport = new UnixWebSocketTransport(config.codexSocketPath);
    this.primaryProvider = primaryProvider;
    this.customPrimaryProviderId = customPrimaryProvider?.id;
    setConfiguredCustomPrimaryProviderId(customPrimaryProvider?.id);
    const clients = new Map<string, CodexAppServerClient>();
    clients.set(primaryProvider, new CodexAppServerClient(
      new JsonRpcClient(this.transport, 60_000, logger),
      {
      sandbox: config.codexSandbox,
      ...(config.codexModel ? { model: config.codexModel } : {}),
      },
    ));
    for (const managedProvider of managedProviders) {
      const providerTransport = new UnixWebSocketTransport(
        providerAppServerSocketPath(config.codexSocketPath, managedProvider.provider),
      );
      clients.set(managedProvider.provider, new CodexAppServerClient(
        new JsonRpcClient(providerTransport, 60_000, logger),
        {
          sandbox: config.codexSandbox,
        },
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
    );
    this.inbound = new EventBus<RpcNotification>(logger, 2_000);
    this.output = new EventBus<OutputEvent>(logger, 1_000);
    this.bindings = new SqliteBindingStore(config.stateDatabasePath);
    this.workspaces = new WorkspaceRegistry(config.workspaces, config.defaultWorkspaceId);
    this.router = new SessionRouter(
      this.codex,
      this.bindings,
      this.workspaces,
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
    });
    const recordTurnErrorMetric = (
      provider: string,
      model: string | null,
      threadId: string | null,
      turnId: string | null,
      phase: "start" | "steer" | "notification",
      error: unknown,
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
            this.subagentCompletion?.metricsAvailable(sample.threadId);
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
      readSummary: (agentThreadId) => metricsStore.threadSummary(agentThreadId),
      waitForMetrics: (agentThreadId) =>
        metricsWriter.waitForCurrentWrites(agentThreadId),
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
      {
        forThread: (threadId) => {
          const summary = metricsStore.threadSummary(threadId);
          const direct = summary.latestDirectApi;
          const providerName = direct === null
            ? undefined
            : config.apiProviders.find(
                (candidate) => candidate.id === direct.provider,
              )?.name;
          return {
            threadId: summary.threadId,
            modelProvider: this.router.modelSettingsForThread(threadId)
              ?.modelProvider ?? "openai",
            latestTurn: summary.latestTurn,
            threadAggregate: summary.threadAggregate,
            latestDirectApi: direct === null
              ? null
              : {
                  provider: direct.provider,
                  ...(providerName === undefined ? {} : { providerName }),
                  model: direct.model,
                  status: direct.status,
                  httpStatus: direct.httpStatus,
                  requestDurationMs: direct.requestDurationMs,
                  inputTokens: direct.inputTokens,
                  cachedInputTokens: direct.cachedInputTokens,
                  outputTokens: direct.outputTokens,
                  reasoningOutputTokens: direct.reasoningOutputTokens,
                  totalTokens: direct.totalTokens,
                  pricingCurrency: direct.pricing?.currency ?? null,
                  totalCostNanos: direct.totalCostNanos,
                  inputCostNanos: direct.uncachedInputCostNanos,
                  cachedInputCostNanos: direct.cachedInputCostNanos,
                  outputCostNanos: direct.outputCostNanos,
                  uncachedInputPricePerMillionNanos:
                    direct.pricing?.uncachedInputPricePerMillionNanos ?? null,
                  cachedInputPricePerMillionNanos:
                    direct.pricing?.cachedInputPricePerMillionNanos ?? null,
                  outputPricePerMillionNanos:
                    direct.pricing?.outputPricePerMillionNanos ?? null,
                  ...(direct.pricing?.bucket === undefined
                    || direct.pricing.bucket === null
                    ? {}
                    : { pricingBucket: direct.pricing.bucket }),
                },
          };
        },
        aggregate: (view, range) => {
          const resolvedRange = resolveRequestMetricsRange(range);
          const report = metricsStore.aggregate({
            dimension: view === "providers"
              ? "provider"
              : view === "models"
                ? "model"
                : "global",
            startAtMs: resolvedRange.startAtMs,
            endAtMs: resolvedRange.endAtMs,
          });
          return {
            view,
            range,
            startAtMs: report.startAtMs,
            endAtMs: report.endAtMs,
            aggregate: report.aggregate,
            groups: report.groups.map((group) => {
              const providerName = group.provider === null
                ? undefined
                : config.apiProviders.find(
                    (candidate) => candidate.id === group.provider,
                  )?.name;
              return {
                provider: group.provider,
                ...(providerName === undefined ? {} : { providerName }),
                model: group.model,
                aggregate: group.aggregate,
              };
            }),
            totalGroupCount: report.totalGroupCount,
          };
        },
        weeklyQuotaEstimate: (provider, limitId, resetsAt, nowMs) =>
          metricsStore.weeklyQuotaEstimate({ provider, limitId, resetsAt, nowMs }),
        errors: (range) => {
          const resolvedRange = resolveRequestMetricsRange(range);
          const report = metricsStore.errors({
            startAtMs: resolvedRange.startAtMs,
            endAtMs: resolvedRange.endAtMs,
          });
          return {
            view: "errors",
            range,
            startAtMs: report.startAtMs,
            endAtMs: report.endAtMs,
            requestCount: report.requestCount,
            unsuccessfulRequestCount: report.unsuccessfulRequestCount,
            groups: report.groups.map((group) => {
              const providerName = config.apiProviders.find(
                (candidate) => candidate.id === group.provider,
              )?.name;
              return {
                provider: group.provider,
                ...(providerName === undefined ? {} : { providerName }),
                model: group.model,
                status: group.status,
                httpStatus: group.httpStatus,
                errorType: group.errorType,
                lastErrorMessage: group.lastErrorMessage,
                requestCount: group.requestCount,
                lastOccurredAtMs: group.lastOccurredAtMs,
              };
            }),
            totalGroupCount: report.totalGroupCount,
          };
        },
      },
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
    );
    this.output.subscribe("conversation-background-release", async (event) => {
      if (event.type !== "turn.completed" || !this.router.isBackgroundThread(event.threadId)) {
        return;
      }
      try {
        await this.trackQueueLifecycleTask(() =>
          service.releaseBackgroundIfComplete(event.threadId, {
            // 0.148 deliberately keeps Queue entries after an interrupted turn;
            // only normal/failed completion participates in native idle dispatch.
            dispatchQueued: event.status !== "interrupted",
          })
        );
      } catch (error) {
        this.logger.warn(
          { err: error, threadId: event.threadId },
          "后台 Thread 完成后的订阅清理失败，已保留绑定供重启重试",
        );
        this.output.publish({
          type: "warning",
          target: event.target,
          threadId: event.threadId,
          background: true,
          message: "后台任务已完成，但订阅清理暂时失败；Gateway 重启后会重试。",
        }, true);
      }
    });
    this.providerIdleReleaser = new ProviderIdleReleaser({
      logger,
      isAccountProvider: (provider) =>
        opencodeGoAccountIdFromProvider(provider) !== undefined,
      listRunningProviders: async () =>
        (await inspectAppServerSupervisor(config.codexSocketPath))?.runningProviders ?? [],
      releaseProvider: (provider) =>
        releaseAppServerProvider(config.codexSocketPath, provider)
          .then((result) => result.released),
      providerForThread: (threadId) =>
        this.router.modelSettingsForThread(threadId)?.modelProvider,
      listBindings: () => this.bindings.list(),
      defaultRoleProvider: () => loadManagedModelProviderRole()?.provider,
      notify: (provider, targets) => {
        const accountId = opencodeGoAccountIdFromProvider(provider);
        const label = accountId === undefined
          ? provider
          : `OpenCode Go 账户 ${accountId}`;
        const message = `${label} 已空闲停止；再次选择该账户、恢复 Thread 或使用对应 Remote TUI 时将自动启动。`;
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
    this.surfaceModules = createSurfaceModules({
      config,
      service,
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
      }
      const coreEvent = toConversationInputEvent(notification);
      if (coreEvent) {
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
    this.codex.setServerRequestHandler((request) =>
      handleApprovalServerRequest(request, this.approval));
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
    const candidateThreadIds = new Set(
      this.router.allBindings()
        .filter((binding) => {
          const bindingProvider = this.codex.knownProvider(binding.threadId);
          return !this.stopping
            && enabledSurfaces.has(surfaceAccountKey(
              binding.target.surface,
              binding.target.accountId,
            ))
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
            if (this.router.isBackgroundThread(binding.threadId)) {
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
    const exited = await terminateThreadWriterHolder(holder.pid);
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

function isHighFrequencyNotification(method: string): boolean {
  return /\/(?:delta|outputDelta|progress)$/u.test(method);
}

function isReleaseableThreadWriterHolder(holder: ThreadLockHolder): boolean {
  return /^(?:codex|[^\s]*[/\\]codex)(?:\s|$)/u.test(holder.command);
}

function resolveRequestMetricsRange(
  range: RequestMetricsTimeRange,
  nowMs = Date.now(),
): { startAtMs: number; endAtMs: number } {
  const durations: Partial<Record<RequestMetricsTimeRange, number>> = {
    "24h": 24 * 60 * 60 * 1_000,
    "7d": 7 * 24 * 60 * 60 * 1_000,
    "30d": 30 * 24 * 60 * 60 * 1_000,
    "90d": 90 * 24 * 60 * 60 * 1_000,
    "365d": 365 * 24 * 60 * 60 * 1_000,
  };
  const duration = durations[range];
  if (duration !== undefined) {
    return { startAtMs: Math.max(0, nowMs - duration), endAtMs: nowMs };
  }
  if (range === "all") return { startAtMs: 0, endAtMs: nowMs };
  const day = new Date(nowMs);
  day.setHours(0, 0, 0, 0);
  const today = day.getTime();
  if (range === "today") return { startAtMs: today, endAtMs: nowMs };
  if (range === "yesterday") {
    day.setDate(day.getDate() - 1);
    return { startAtMs: day.getTime(), endAtMs: today };
  }
  const month = new Date(day.getFullYear(), day.getMonth(), 1);
  if (range === "this-month") return { startAtMs: month.getTime(), endAtMs: nowMs };
  if (range === "last-month") {
    return {
      startAtMs: new Date(day.getFullYear(), day.getMonth() - 1, 1).getTime(),
      endAtMs: month.getTime(),
    };
  }
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  const week = day.getTime();
  if (range === "this-week") return { startAtMs: week, endAtMs: nowMs };
  day.setDate(day.getDate() - 7);
  return { startAtMs: day.getTime(), endAtMs: week };
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
  const actual = execFileSync(effectiveCodexBinary(config.codexBinary), ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
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
