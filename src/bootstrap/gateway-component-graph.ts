import { currentGitBranch } from "./git-workspace-status.js";
import { dirname, join } from "node:path";

import type { Logger } from "pino";
import startupNetworkPolicy from "../../startup-network-policy.json" with { type: "json" };
import { GatewayReconnectCoordinator } from "./gateway-reconnect-coordinator.js";
import { accountQueryFailureMetadata } from "./account-query.js";
import { StartupNetworkRecovery } from "./startup-network-recovery.js";
import { withOutputExecutionAdmission } from "./output-execution-admission.js";
import { PersistentInteractionPort } from "./persistent-interaction-port.js";
import { RelayMetricsComposition, createRelayMetricAuthorization } from "./relay-metrics-composition.js";
import { modelRelayPaths } from "../../runtime/model-relay-paths.mjs";
import { accountSnapshotEventsPath, metricsEventsPath } from "../../runtime/metrics-events.mjs";
import { QueueEventsServer } from "../../runtime/queue-events.mjs";
import { threadStateReadTimeoutMs, type GatewayThreadState } from "../../runtime/gateway-thread-state.mjs";

import { assertAppServerSocketPathSupported } from "../../runtime/app-server-runtime.mjs";
import {
  applyAppServerProviderSettings,
  readAppServerProviderSettingsFingerprint,
  readAppServerImageUploadRoute,
  ensureAppServerProvider,
  releaseAppServerProvider,
} from "../../runtime/app-server-supervisor.mjs";
import { hasCodexAuthFile } from "../../runtime/codex-home.mjs";
import { readOpenAiCredentialRefreshTime } from "../../runtime/openai-credentials.mjs";
import {
  effectiveCodexBinary,
  executableInvocation,
  resolveExecutable,
} from "../../runtime/executable.mjs";
import { codexProcessInvocation } from "../../runtime/owned-process.mjs";
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
import { OwnedCommandRunner } from "../../runtime/owned-command-runner.mjs";
import {
  inspectAppServerSupervisor,
  inspectAppServerSupervisorState,
} from "../../runtime/app-server-supervisor.mjs";
import {
  opencodeGoAccountIdFromProvider,
} from "../../runtime/opencode-go-accounts.mjs";
import { resolveDefaultManagedProvider } from "../../runtime/managed-provider-account-routing.mjs";
import {
  aggregateProviderId,
  aggregateProviderMembers,
  loadAggregateModelMaterial,
} from "../../runtime/aggregate-model-provider.mjs";
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
  parseAggregateModelOptions,
  JsonRpcClient,
  supportedCodexCliVersion,
  toAutoApprovalReviewEvent,
  toConversationInputEvent,
  toReasoningGuardInput,
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
  ConversationCommandService,
  ConversationEventCoordinator,
  ReasoningRepeatGuard,
  ConversationService,
  ModelSelectionService,
  ProviderAccountService,
  scheduledTaskToolSpec,
  createOpenAiAccountAdapter,
  OpenAiResetCreditService,
  ConversationResetCreditService,
  type ThreadLockHolder,
  type ThreadOccupancyReleaseResult,
  type ModelOption,
} from "../application/index.js";
import {
  ConversationCore,
  UserFacingError,
  isCriticalOutputEvent,
  usesOpenAiAccount,
  type ConversationTarget,
  type OutputEvent,
  type TurnErrorCode,
  type TurnTaskMetricsSummary,
} from "../conversation-core/index.js";
import { EventBus } from "../event-bus/index.js";
import {
  BufferedModelRequestMetricsWriter,
  AsyncMetricsStore,
  metricsWorkerFailureMetadata,
  modelRequestMetricsDatabasePath,
} from "../observability/index.js";
import { WorkspaceRegistry, TelegramAccessPolicy, FeishuAccessPolicy, WeixinAccessPolicy, QqAccessPolicy } from "../policy/index.js";
import {
  SessionRouter,
  ThreadStateSynchronizer,
} from "../session-routing/index.js";
import {
  SqliteBindingStore,
  SqliteSessionDisplayCache,
} from "../storage/index.js";
import {
  canReviewConversationHook,
  canPreserveWeixinHookReviewText,
  canPreserveQqHookReviewText,
  formatProviderIdleReleaseNotice,
  type SurfaceAdapter,
  type SurfaceDeliverySource,
  SurfaceOutputCoalescer,
} from "../surfaces/index.js";
import { ChannelImageSpool } from "./channel-image-spool.js";
import { ChannelFileSpool } from "./channel-file-spool.js";
import { AsyncQuestionCoordinator } from "./async-question-coordinator.js";
import { ConversationIdleReleaser } from "./conversation-idle-releaser.js";
import {
  createSurfaceModules,
} from "./surface-composition.js";
import type { BuiltInSurfacePlugin, SurfaceRuntimeModule } from "./surface-plugin.js";
import { SurfaceManager } from "./surface-manager.js";
import { createProxyFetch } from "./proxy-fetch.js";
import {
  checkOpenAiConnectivity,
  type OpenAiConnectivityStatus,
} from "./openai-connectivity.js";
import { ProviderMetricsComposition } from "./provider-metrics-composition.js";
import { ProviderIdleReleaser } from "./provider-idle-releaser.js";
import { turnErrorDiagnostics } from "./turn-error-diagnostics.js";
import { completionAccountStatus } from "./completion-account-status.js";
import { mergeCompletionTiming } from "./completion-timing.js";
import { TurnExecutionTracker } from "./turn-execution-tracker.js";
import { AutoApprovalReviewTracker } from "./auto-approval-review-tracker.js";
import { AutoApprovalReviewNotifications } from "./auto-approval-review-notifications.js";
import { SubagentCompletionTracker } from "./subagent-completion-tracker.js";
import { createScheduledTaskServerRequestHandler } from "./scheduled-task-server-request.js";
import { ScheduledTaskComposition } from "./scheduled-task-composition.js";
import { RequestMetricsQueryAdapter } from "./request-metrics-query-adapter.js";
import {
  createManagedProviderAccountAdapters,
} from "./managed-provider-capabilities.js";
import {
  BindingRestoreCoordinator,
} from "./binding-restore-coordinator.js";

export abstract class GatewayComponentGraph {
  private readonly transport: CodexTransport;
  private readonly codex: ProviderRoutingClient;
  private readonly turnExecution: TurnExecutionTracker;
  private readonly metricsDatabase: AsyncMetricsStore;
  private readonly metricsReady: Promise<void>;
  private readonly autoApprovalReview: AutoApprovalReviewTracker;
  private readonly autoApprovalReviewNotifications: AutoApprovalReviewNotifications;
  private readonly reasoningRepeatGuard: ReasoningRepeatGuard;
  private readonly primaryProvider: string;
  private readonly customPrimaryProviderId: string | undefined;
  private readonly inbound: EventBus<RpcNotification>;
  private readonly notificationGenerations = new WeakMap<RpcNotification, { provider: string; generation: number }>();
  private readonly notificationCurrent = new WeakMap<RpcNotification, () => boolean>();
  private readonly providerNotificationGenerations = new Map<string, number>();
  private readonly output: EventBus<OutputEvent>;
  private readonly surfaceModules: SurfaceRuntimeModule[];
  private readonly surfaces: SurfaceAdapter[];
  private readonly surfaceManager: SurfaceManager;
  private readonly channelImageSpool: ChannelImageSpool;
  private readonly channelFileSpool: ChannelFileSpool;
  private readonly interactions: InteractionRouter;
  private readonly asyncQuestions: AsyncQuestionCoordinator;
  private readonly approval: ApprovalCoordinator;
  private readonly router: SessionRouter;
  private readonly threadState: ThreadStateSynchronizer;
  private readonly core: ConversationCore;
  private readonly conversations: ConversationService;
  private readonly modelSelection: ModelSelectionService;
  private readonly providerModelSnapshots = new Map<string, ModelOption[]>();
  private readonly captureProviderModels: (provider: string) => { fingerprint: string; models: ModelOption[] };
  readonly managedSettingsProviders: readonly string[];
  readonly aggregateSettingsMembers: readonly string[];
  private readonly providerSettingsAbort = new AbortController();
  private readonly providersApplyingSettings = new Set<string>();
  private readonly pendingProviderSettings = new Set<string>();
  private readonly settingsDisconnects = new Map<string, Error>();
  private readonly providerMetrics: ProviderMetricsComposition;
  private readonly relayMetrics: RelayMetricsComposition | undefined;
  private readonly metricsEvents: QueueEventsServer | undefined;
  private readonly accountSnapshotEvents: QueueEventsServer | undefined;
  private readonly providerIdleReleaser: ProviderIdleReleaser;
  private readonly conversationIdleReleaser?: ConversationIdleReleaser;
  private readonly providerAccounts?: ProviderAccountService;
  private readonly bindings: SqliteBindingStore;
  private readonly sessionDisplayCache?: SqliteSessionDisplayCache;
  private readonly workspaces: WorkspaceRegistry;
  private readonly subagentCompletion: SubagentCompletionTracker;
  private readonly subagentMetricsAbort = new AbortController();
  private readonly scheduledTasks: ScheduledTaskComposition | undefined;
  private bindingRestore: BindingRestoreCoordinator | undefined;
  private removeRpcNotification: (() => void) | undefined;
  private removeRpcDisconnect: (() => void) | undefined;
  private shutdownTask: Promise<void> | undefined;
  private resetCredits: OpenAiResetCreditService | undefined;
  private accountWarmupTask: Promise<void> | undefined;
  private reconnectCoordinator: GatewayReconnectCoordinator | undefined;
  private readonly queueLifecycleTasks = new Set<Promise<unknown>>();
  private codexUpstreamUserAgent: string | undefined;
  private openAiConnectivity: OpenAiConnectivityStatus | "recovering" = "not-applicable";
  private startupNetworkRecovery: StartupNetworkRecovery | undefined;
  private openAiConnectivityAbort: AbortController | undefined;
  private startupAbort: AbortController | undefined;
  private readonly auxiliaryCommands: OwnedCommandRunner;
  private stopping = false;

  protected abstract requestStop(): Promise<void>;

  protected constructor(
    private config: GatewayConfig,
    private readonly logger: Logger,
    surfacePlugins: readonly BuiltInSurfacePlugin[],
    registerConstructionCleanup: (component: string, close: () => void | Promise<void>) => void,
    configPath?: string,
  ) {
    logger = logger.child({ module: "gateway" });
    this.logger = logger;
    this.auxiliaryCommands = new OwnedCommandRunner();
    registerConstructionCleanup("Auxiliary Commands", () => this.auxiliaryCommands.close());
    const primaryProvider = loadPrimaryModelProvider();
    const customPrimaryProvider = loadConfiguredCustomPrimaryModelProvider();
    const customSwitchingProviders = loadConfiguredCustomSwitchingModelProviders();
    const managedProviders = loadManagedModelProviders();
    this.aggregateSettingsMembers = aggregateProviderMembers(primaryProvider, [
      ...managedProviders,
      ...customSwitchingProviders,
    ]);
    const aggregateEnabled = this.aggregateSettingsMembers.length > 0;
    const switchingProviderIds = [
      ...managedProviders.map(({ provider }) => provider),
      ...customSwitchingProviders.map(({ provider }) => provider),
    ];
    const defaultThirdPartyProvider = resolveDefaultManagedProvider(switchingProviderIds);
    const providerDefinitions = loadManagedModelProviderDefinitions();
    const configuredProviders = new Set<string>([
      primaryProvider,
      ...managedProviders.map(({ provider }) => provider),
    ]);
    this.managedSettingsProviders = [
      ...providerDefinitions.map((definition) => definition.id)
        .filter((provider) => configuredProviders.has(provider)),
      ...(aggregateEnabled ? [aggregateProviderId] : []),
    ];
    this.captureProviderModels = (provider) => {
      if (provider === aggregateProviderId) {
        const material = loadAggregateModelMaterial(process.env, [...this.aggregateSettingsMembers]);
        return { fingerprint: material.fingerprint, models: parseAggregateModelOptions(material.catalog) };
      }
      const definition = providerDefinitions.find((entry) => entry.id === provider);
      if (!definition) throw new Error("Provider 模型目录定义不存在");
      const fingerprint = readAppServerProviderSettingsFingerprint(provider);
      const models = loadManagedModelOptions(managedProviderDirectory(process.env, definition), true, definition);
      if (fingerprint !== readAppServerProviderSettingsFingerprint(provider)) throw new Error("Provider 模型目录在读取期间发生变化");
      return { fingerprint, models };
    };
    const unavailableModels: ModelOption[] = this.managedSettingsProviders.map((provider) => ({
      provider, id: provider, model: provider,
      displayName: providerDefinitions.find((definition) => definition.id === provider)?.displayName ?? provider,
      isDefault: true, available: false,
      unavailableReason: "模型目录尚未确认，请检查对应 App Server 后重试",
      supportedReasoningEfforts: [], defaultReasoningEffort: "none",
      inputModalities: [], serviceTiers: [], defaultServiceTier: null,
    }));
    const codexBinary = resolveExecutable(effectiveCodexBinary(config.codexBinary));
    const createCodexProcessInvocation = (args: readonly string[]) =>
      codexProcessInvocation(codexBinary, args);
    const createTransport = (socketPath: string): CodexTransport =>
      {
        assertAppServerSocketPathSupported(socketPath);
        return createAppServerTransport(
          { kind: "local-app-server", socketPath },
          {
            createCodexProcessInvocation,
            terminateCodexProcess: terminateChildProcess,
          },
        );
      };
    this.transport = createTransport(config.codexSocketPath);
    this.primaryProvider = primaryProvider;
    this.customPrimaryProviderId = customPrimaryProvider?.id;
    const clients = new Map<string, CodexAppServerClient>();
    const imageUploadFetch = createProxyFetch(config.networkProxy);
    const supportsImageReferenceUpload = (provider: string): boolean =>
      provider === "openai" || /^ds-[a-z0-9_-]{1,32}$/u.test(provider);
    const imageUploadOptions = (provider: string) =>
      supportsImageReferenceUpload(provider) ? { upload: imageUploadFetch,
        ...(/^ds-[a-z0-9_-]{1,32}$/u.test(provider) ? {
          readProviderUploadRoute: async (target: string, signal: AbortSignal) => {
            try { return await readAppServerImageUploadRoute(config.codexSocketPath, target, signal); }
            catch {
              signal.throwIfAborted();
              throw new UserFacingError("image.reference.failed",
                "图片上传私有路由不可用，请确认 Provider 配置已应用并重启 App Server 与 Gateway。",
                { reason: "private-route-unavailable" });
            }
          },
        } : {}) } : undefined;
    clients.set(primaryProvider, new CodexAppServerClient(
      new JsonRpcClient(this.transport, 60_000, logger, 64, config.codexClientIdentity),
      {
        ...(config.codexModel ? { model: config.codexModel } : {}),
      },
      imageUploadOptions(primaryProvider),
    ));
    for (const managedProvider of managedProviders) {
      const providerTransport = createTransport(
        providerAppServerSocketPath(config.codexSocketPath, managedProvider.provider),
      );
      clients.set(managedProvider.provider, new CodexAppServerClient(
        new JsonRpcClient(providerTransport, 60_000, logger, 64, config.codexClientIdentity),
        {},
        imageUploadOptions(managedProvider.provider),
      ));
    }
    for (const customSwitchingProvider of customSwitchingProviders) {
      const providerTransport = createTransport(
        providerAppServerSocketPath(config.codexSocketPath, customSwitchingProvider.provider),
      );
      clients.set(customSwitchingProvider.provider, new CodexAppServerClient(
        new JsonRpcClient(providerTransport, 60_000, logger, 64, config.codexClientIdentity),
        {},
      ));
    }
    if (aggregateEnabled) {
      const providerTransport = createTransport(
        providerAppServerSocketPath(config.codexSocketPath, aggregateProviderId),
      );
      clients.set(aggregateProviderId, new CodexAppServerClient(
        new JsonRpcClient(providerTransport, 60_000, logger, 64, config.codexClientIdentity),
        {},
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
                "App Server 监管协议版本不匹配；请运行 codexc restart all 后重试",
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
      (provider, mode, operation, signal) => {
        if (!this.providerIdleReleaser) return operation();
        return mode === "activity"
          ? this.providerIdleReleaser.runActivity(provider, operation, signal)
          : this.providerIdleReleaser.runOperation(provider, operation);
      },
    );
    registerConstructionCleanup("Codex Client", () => this.codex.close());
    this.inbound = new EventBus<RpcNotification>(logger.child({ module: "inbound" }), 2_000, undefined, {
      entries: 4_096,
      bytes: 32 * 1024 * 1024,
      size: (event) => Buffer.byteLength(JSON.stringify(event)),
      overflow: () => {
        logger.error("协议通知消费预算耗尽，停止 Gateway 消费；尚未持久接收的通知存在缺口");
        void this.requestStop().catch(() => logger.error("协议通知超载后的 Gateway 清理失败"));
      },
    });
    registerConstructionCleanup("Inbound Event Bus", () => this.inbound.close());
    this.output = new EventBus<OutputEvent>(logger.child({ module: "output" }), 1_000, new SurfaceOutputCoalescer().key, {
      entries: 2_048,
      bytes: 32 * 1024 * 1024,
      size: (event) => Buffer.byteLength(JSON.stringify(event)),
      overflow: () => {
        logger.error("共享输出预算耗尽，停止 Gateway 消费；已持久接收记录保留，未接收区间存在缺口");
        void this.requestStop().catch(() => logger.error("共享输出超载后的 Gateway 清理失败"));
      },
    });
    registerConstructionCleanup("Output Event Bus", () => this.output.close());
    this.bindings = new SqliteBindingStore(config.stateDatabasePath);
    registerConstructionCleanup("Binding Store", () => this.bindings.close());
    this.sessionDisplayCache = new SqliteSessionDisplayCache(
      join(dirname(config.stateDatabasePath), "session-display-cache.sqlite3"),
    );
    registerConstructionCleanup("Session Display Cache", () => this.sessionDisplayCache?.close());
    this.workspaces = new WorkspaceRegistry(config.workspaces, config.defaultWorkspaceId);
    this.router = new SessionRouter(
      this.codex,
      this.bindings,
      this.workspaces,
      config.scheduledTasksEnabled ? [scheduledTaskToolSpec] : [],
      () => {
        this.core?.pruneUnboundTurns();
        this.reasoningRepeatGuard?.prune();
        this.asyncQuestions?.cancelStale();
        this.approval?.cancelStale();
        void this.providerIdleReleaser?.closeIfIdle().catch((error) => {
          this.logger.warn(
            { err: error },
            "会话绑定变化后的全局 Client 空闲检查失败",
          );
        });
      },
      (binding) => {
        if (!this.stopping && !this.isBindingRestoring(binding.threadId)) {
          void this.restoreIdleBinding(binding.threadId);
        }
      },
    );
    this.threadState = new ThreadStateSynchronizer(this.router);
    this.core = new ConversationCore(this.router, {
      publish: (event, critical) => {
        if (event.type === "turn.completed" && event.status !== "inProgress") {
          const runningSubagentCount = this.subagentCompletion.flushCompletedForParent(event.threadId, event.turnId);
          this.output.publish({ ...event, ...(runningSubagentCount > 0 ? { runningSubagentCount } : {}) }, critical);
        } else this.output.publish(event, critical);
      },
    });
    this.metricsDatabase = new AsyncMetricsStore(
      modelRequestMetricsDatabasePath(config.stateDatabasePath),
      {
        retentionDays: config.metricsStorage.retentionDays,
        maximumRows: config.metricsStorage.maxRows,
      }, (error) => {
        logger.error({ err: error, ...metricsWorkerFailureMetadata(error) }, "指标数据库 Worker 不可用，Gateway 正在停止");
        void this.requestStop().catch(() => logger.error("指标数据库故障后的 Gateway 清理失败"));
      },
    );
    const metricsStore = this.metricsDatabase.store;
    const providersWithoutSubscription = new Set<string>();
    this.metricsReady = this.metricsDatabase.ready.then(async () => {
      const snapshots = await metricsStore.latestAccountSnapshots();
      for (const snapshot of snapshots) {
        if (snapshot.provider.startsWith("ocg-") && snapshot.usage !== null
          && typeof snapshot.usage === "object" && "kind" in snapshot.usage
          && snapshot.usage.kind === "subscription-required") providersWithoutSubscription.add(snapshot.provider);
      }
    });
    void this.metricsReady.catch(() => undefined);
    let closeConstructionMetrics: () => void | Promise<void> = () => this.metricsDatabase.close();
    registerConstructionCleanup("Request Metrics", () => closeConstructionMetrics());
    this.metricsEvents = configPath === undefined ? undefined : new QueueEventsServer(metricsEventsPath(configPath));
    if (this.metricsEvents) registerConstructionCleanup("Metrics Notifications", () => this.metricsEvents!.close());
    this.accountSnapshotEvents = configPath === undefined ? undefined : new QueueEventsServer(accountSnapshotEventsPath(configPath));
    if (this.accountSnapshotEvents) registerConstructionCleanup("Account Snapshot Notifications", () => this.accountSnapshotEvents!.close());
    this.turnExecution = new TurnExecutionTracker(this.codex, metricsStore,
      () => this.metricsEvents?.changed(),
      (error, threadId) => logger.warn({ module: "metrics", event: "turn_timing.sync_failed", err: error, threadId, ...metricsWorkerFailureMetadata(error) }, "轮次耗时记录或同步失败"),
      signal => this.metricsDatabase.withSignal(signal),
      (error) => {
        logger.error({ err: error, ...metricsWorkerFailureMetadata(error) }, "轮次耗时覆盖无法持久降级，Gateway 正在停止");
        void this.requestStop().catch(() => logger.error("指标故障后的 Gateway 清理失败"));
      });
    this.reasoningRepeatGuard = new ReasoningRepeatGuard({
      route: (threadId) => {
        if (this.stopping) return undefined;
        const provider = this.codex.knownProvider(threadId);
        const target = this.router.targetForThread(threadId);
        const official = usesOpenAiAccount(provider) && this.customPrimaryProviderId === undefined;
        return provider && !official && target
          ? { target, provider } : undefined;
      },
      active: (threadId, turnId) => this.core.activeTurnForThread(threadId)?.turnId === turnId,
      interrupt: async (threadId, turnId, beforeSubmit) => {
        await this.trackQueueLifecycleTask(() => this.codex.interruptTurn(threadId, turnId, beforeSubmit));
      },
      notify: (route, threadId, message) => this.output.publish({ type: "warning", target: route.target,
        threadId, message, ...(this.router.isBackgroundThread(threadId) ? { background: true } : {}) }, true),
    });
    registerConstructionCleanup("Reasoning Repeat Guard", () => this.reasoningRepeatGuard.close());
    this.autoApprovalReview = new AutoApprovalReviewTracker(metricsStore,
      (threadId) => this.codex.knownProvider(threadId),
      (error, threadId) => logger.warn({ module: "metrics", event: "auto_review.write_failed", err: error, threadId, ...metricsWorkerFailureMetadata(error) }, "自动审查统计记录失败，统计覆盖不完整"),
      (error) => {
        logger.error({ err: error, ...metricsWorkerFailureMetadata(error) }, "自动审查覆盖无法持久降级，Gateway 正在停止");
        void this.requestStop().catch(() => logger.error("指标故障后的 Gateway 清理失败"));
      });
    this.autoApprovalReviewNotifications = new AutoApprovalReviewNotifications({
      targetForThread: (threadId) => this.router.targetForThread(threadId),
      isBackgroundThread: (threadId) => this.router.isBackgroundThread(threadId),
      providerForThread: (threadId) => this.codex.knownProvider(threadId),
      publish: (event) => this.output.publish(event, true),
      unroutable: (threadId, turnId, reason) => logger.warn(
        { event: "auto_review.notification_unroutable", threadId, turnId, reason },
        "自动审查通知未向渠道发送"),
    });
    const metricsWriter = new BufferedModelRequestMetricsWriter(
      { recordBatch: samples => metricsStore.recordBatch(samples), close: async () => {
        try { await this.metricsDatabase.drain(); }
        finally { await this.metricsDatabase.close(); }
      } },
      (error) => logger.error({ module: "metrics", event: "request_metrics.write_failed", err: error, ...metricsWorkerFailureMetadata(error) }, "模型请求指标后台写入失败"),
      () => this.metricsEvents?.changed(),
    );
    closeConstructionMetrics = () => metricsWriter.close();
    const waitForMetricsScope = (
      threadId: string,
      scope: Parameters<typeof metricsStore.metricsWriteScopes>[1],
      requestPurpose: "autoApprovalReview" | null,
      signal?: AbortSignal,
    ): Promise<boolean> => metricsWriter.waitForCurrentWritesInScope(
      () => this.metricsDatabase.withSignal(signal).metricsWriteScopes(threadId, scope),
      requestPurpose,
      signal,
    );
    registerConstructionCleanup("Subagent Metrics Waits", () => this.subagentMetricsAbort.abort());
    this.relayMetrics = configPath === undefined ? undefined : new RelayMetricsComposition({
      path: modelRelayPaths(configPath).metrics,
      writer: metricsWriter,
      authorize: createRelayMetricAuthorization(configPath),
    });
    if (this.relayMetrics) registerConstructionCleanup("Relay Metrics", () => this.relayMetrics!.close());
    const recordTurnErrorDiagnostic = (
      provider: string,
      model: string | null,
      threadId: string | null,
      turnId: string | null,
      phase: "start" | "steer" | "notification",
      error: unknown,
      structuredErrorCode?: TurnErrorCode,
    ): void => {
      logger.warn(turnErrorDiagnostics(provider, model, threadId, turnId, phase, error, structuredErrorCode), "Turn 执行失败");
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
    closeConstructionMetrics = () => this.providerMetrics.close();
    this.subagentCompletion = new SubagentCompletionTracker({
      readSummary: async (agentThreadId, terminalTurnId, signal) => {
        const readSignal = signal
          ? AbortSignal.any([signal, this.subagentMetricsAbort.signal])
          : this.subagentMetricsAbort.signal;
        const scope = terminalTurnId === undefined ? { type: "session" as const }
          : { type: "task" as const, turnId: terminalTurnId };
        if (!await waitForMetricsScope(agentThreadId, scope, null, readSignal)) throw new Error("子代理任务指标写入未确认");
        return this.metricsDatabase.withSignal(readSignal).subagentCompletionSummary(agentThreadId, terminalTurnId);
      },
      waitForMetrics: (agentThreadId, agentTurnId) =>
        metricsWriter.waitForCurrentWritesInScopes([{ threadId: agentThreadId, ...(agentTurnId === undefined ? {} : { turnId: agentTurnId }) }], null, this.subagentMetricsAbort.signal),
      onRunStarted: (details) => {
        this.autoApprovalReviewNotifications.recordRun(details);
        void metricsStore.recordSubagentTurn(details).catch((error) => {
          this.autoApprovalReview.markIncomplete();
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
        });
      },
      onRunAttributionIncomplete: () => {
        this.autoApprovalReview.markIncomplete();
        logger.warn({ module: "metrics", event: "subagent.attribution_incomplete" }, "子代理轮次归属观测不完整，自动审查统计降级");
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
    this.output.observe((event) => this.subagentCompletion.handle(event));
    this.output.subscribe("subagent-metrics", async (event) => {
      if (event.type === "subagent.spawned") {
        try {
          await metricsStore.recordSubagentThread({
            agentThreadId: event.agentThreadId,
            parentThreadId: event.threadId,
            parentTurnId: event.turnId,
            agentPath: event.agentPath,
          });
          this.metricsEvents?.changed();
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
    });
    this.interactions = new InteractionRouter(logger);
    const models = new ModelSelectionService(
      this.codex,
      this.router,
      config.codexModel,
      unavailableModels,
      customPrimaryProvider?.id ?? primaryProvider,
      customSwitchingProviders.filter((provider) => provider.catalogSource.kind === "official").map((provider) => ({
        provider: provider.provider,
        displayName: provider.provider,
        defaultModel: provider.model,
      })),
      () => hasCodexAuthFile(process.env),
      () => providersWithoutSubscription,
      defaultThirdPartyProvider,
      [
        ...customSwitchingProviders.filter((provider) => provider.catalogSource.kind === "custom").map((provider) => ({
          provider: provider.provider,
          displayName: provider.name,
          defaultModel: provider.model,
        })),
      ],
    );
    this.modelSelection = models;
    const collaborationModes = new CollaborationModeSelectionService(
      this.codex,
      this.router,
      models,
    );
    this.resetCredits = new OpenAiResetCreditService(this.codex, signal => this.providerAccounts!.accountLimits("openai", signal));
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
          metricsQuery: signal => this.metricsDatabase.withSignal(signal),
        },
      ),
    ];
    this.providerAccounts = new ProviderAccountService(accountAdapters, {
      writeOfficialAccountSnapshot: async (snapshot, signal) => {
        signal?.throwIfAborted();
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
        await this.metricsDatabase.withSignal(signal).upsertAccountSnapshot({
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
        // The write is confirmed; cancellation must not suppress its cache invalidation.
        if (snapshot.provider.startsWith("ocg-")) {
          if (snapshot.usage.kind === "subscription-required") providersWithoutSubscription.add(snapshot.provider);
          else providersWithoutSubscription.delete(snapshot.provider);
        }
        try { this.accountSnapshotEvents?.changed(); }
        catch (error) { logger.warn({ err: error }, "账户快照已保存，但变化通知失败"); }
      },
    }, readOpenAiCredentialRefreshTime);
    const execution = withOutputExecutionAdmission(this.codex, (threadId) => {
      const target = this.bindings.getByThread(threadId)?.target;
      const reason = target ? this.surfaceManager.executionBlockReason(target) : "unavailable";
      if (reason) throw new UserFacingError("delivery.overloaded", "投递存储容量不足或不可用，已暂停新执行", { reason });
    });
    const service = new ConversationService(
      execution,
      this.router,
      this.core,
      models,
      this.codex,
      {
        currentGitBranch,
      },
      collaborationModes,
      {
        hasPendingInteraction: (threadId) =>
          this.interactions.hasPendingForThread(threadId)
          || this.asyncQuestions?.hasPendingForThread(threadId) === true,
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
      {
        recordTurnError: (record) => {
          const error = new Error(record.message ?? "Turn 错误");
          if (record.errorCode !== null) {
            (error as { code?: unknown }).code = record.errorCode;
          }
          recordTurnErrorDiagnostic(
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
        releaseThread: (target, force, assertAuthorized) => this.releaseThread(target, force, assertAuthorized),
      },
      execution,
      this.codex,
      (parentThreadId) =>
        this.subagentCompletion.hasPendingForParentThread(parentThreadId),
      this.sessionDisplayCache,
      {
        port: {
          accountRateLimits: options => this.codex.accountRateLimits(options),
          lunaReserveModel: () => this.codex.lunaReserveModel(),
          updateLunaReserveThreadSettings: async (threadId, settings, beforeSubmit) => {
            await this.codex.updateLunaReserveThreadSettings(threadId, settings, beforeSubmit);
            if (this.stopping) throw new Error("Gateway 正在停止");
            await this.inbound.drain();
            if (this.stopping) throw new Error("Gateway 正在停止");
          },
        },
        output: this.output,
        onError: (error, threadId) => {
          this.logger.warn(
            { err: error, threadId },
            "Luna Reserve 自动切换状态刷新失败",
          );
        },
      },
      {
        updateThreadApprovalsReviewer: (threadId, reviewer, beforeSubmit) =>
          this.updateThreadApprovalsReviewer(threadId, reviewer, beforeSubmit),
      },
      (target, actorId) => {
        this.requireRunning();
        if (!this.accessPolicy(target)?.isAllowed({ target, actorId }) || !this.bindings.actors(target).includes(actorId)) {
          throw new UserFacingError("hooks.forbidden", "当前用户未获授权管理 Hook");
        }
      },
      (surface, hook) => {
        if (surface === "weixin") return canReviewConversationHook(hook, canPreserveWeixinHookReviewText);
        if (surface === "qq") return canReviewConversationHook(hook, canPreserveQqHookReviewText);
        if (surface === "feishu" || surface === "telegram") return canReviewConversationHook(hook, () => true);
        return false;
      },
      {
        backgrounded: (threadId) => {
          this.scheduleBindingRestore();
          this.retrySettledBackground(threadId);
        },
        restoreRequired: (threadId) => {
          if (!this.stopping && !this.isBindingRestoring(threadId)) void this.restoreIdleBinding(threadId);
        },
      },
      (operation) => logger.warn(
        { module: "sessions", event: "display_cache.disabled", operation, reason: "cache-operation-failed" },
        "会话派生缓存操作失败，当前会话查询实例已禁用缓存",
      ),
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
        releaseIdle: (target, condition) => service.releaseIdle(target, condition),
        canRelease: (threadId) => !this.stopping && !this.isBindingRestoring(threadId),
        restoreBinding: (threadId) => {
          void this.restoreIdleBinding(threadId);
        },
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
              isCurrent: () => !this.stopping && !this.isBindingRestoring(threadId),
            })
          : service.retryPendingBackgroundRelease(threadId, () => !this.stopping && !this.isBindingRestoring(threadId)));
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
        if (!this.stopping && !this.isBindingRestoring(threadId)) {
          await this.restoreIdleBinding(threadId);
        }
        this.output.publish({
          type: "warning",
          target: event.target,
          threadId,
          background: true,
          message: "后台会话清理暂时失败，已安排订阅恢复；可通过 /resume 查看会话状态。",
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
              + "请运行 codexc restart all 后重试",
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
          registerConstructionCleanup,
          releaseRecoveredThread: (threadId, isCurrent) => service.releaseBackgroundIfComplete(threadId, {
            dispatchQueued: false, isCurrent,
          }),
          router: this.router,
          codex: this.codex,
          turns: execution,
          acceptsExecution: (target) => this.surfaceManager.acceptsExecution(target),
          bindings: this.bindings,
          workspaces: this.workspaces,
          core: this.core,
          output: this.output,
          logger,
          isSurfaceEnabled: (target) => this.surfaces.some((surface) =>
            !surface.connectionOnly && surface.capabilities?.scheduledTasks !== false
            && surface.surface === target.surface && surface.accountId === target.accountId),
          isActorAuthorized: (target, actorId) =>
            this.accessPolicy(target)?.isAllowed({ target, actorId }) === true,
          creationContext: (target) => {
            const status = service.status(target);
            if (status.serviceTierKnown !== true) {
              throw new UserFacingError("fast.selection.unknown", "当前用户选择的速度档位未知，无法固定计划任务");
            }
            const workspace = this.workspaces.require(status.workspaceId);
            return {
              workspaceId: workspace.id,
              workspaceName: workspace.name,
              cwd: workspace.cwd,
              modelProvider: status.modelProvider ?? "openai",
              model: status.model,
              reasoningEffort: status.effort,
              // New tasks fix an observed absence as Standard. Historical null
              // task rows retain their existing execution-time inheritance.
              serviceTier: status.serviceTier ?? "default",
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
    const channelResetCredits = new ConversationResetCreditService(this.resetCredits, (target, actorId) => {
      this.requireRunning();
      if (!this.accessPolicy(target)?.isAllowed({ target, actorId }) || !this.bindings.actors(target).includes(actorId)) {
        throw new UserFacingError("reset-credit.failed", "当前用户未获授权", { reason: "forbidden" });
      }
      const status = service.status(target);
      const workspace = this.workspaces.require(status.workspaceId);
      return JSON.stringify([workspace.id, workspace.cwd, status.threadId]);
    });
    const commands = new ConversationCommandService(service, scheduledTaskUseCases, channelResetCredits, (target, actorId) => {
      this.requireRunning();
      if (!actorId || !this.accessPolicy(target)?.isAllowed({ target, actorId })) {
        throw new UserFacingError("command.authorization-changed", "当前命令操作者未获授权");
      }
    });
    const constructedSurfaces = new Set<SurfaceAdapter>();
    this.surfaceModules = createSurfaceModules({
      config,
      service,
      commands,
      bindings: this.bindings,
      logger,
      gatewayVersion: codexCliVersion,
      codexUpstreamUserAgent: () => this.codexUpstreamUserAgent,
      officialOpenAiAuthenticated: () => (
        this.primaryProvider === "openai" && this.customPrimaryProviderId === undefined
          ? hasCodexAuthFile(process.env)
          : undefined
      ),
      openAiConnectivity: () => this.openAiConnectivity,
      onFatal: (surface, accountId, error) => this.handleSurfaceFatal(
        surface,
        accountId,
        error,
      ),
      autoCompactPercent: (provider, model) => this.resolveAutoCompactPercent(provider, model),
    }, surfacePlugins, module => {
      if (constructedSurfaces.has(module.adapter)) return;
      constructedSurfaces.add(module.adapter);
      registerConstructionCleanup(`Surface ${module.adapter.surface}/${module.adapter.accountId}`,
        () => module.adapter.stop());
    });
    this.surfaces = this.surfaceModules.map((module) => module.adapter);
    this.surfaceManager = new SurfaceManager(
      this.surfaces,
      this.output,
      logger.child({ module: "delivery" }),
      (target, signal) => service.workspaceGitBranch(target, signal),
      {
        persistence: {
          directory: join(dirname(config.stateDatabasePath), "delivery-outbox"),
          workerUrl: new URL(import.meta.url.endsWith(".ts") ? "../../dist/delivery/worker.js" : "../delivery/worker.js", import.meta.url),
          owner: (event) => this.outputOwner(event),
          authorized: (event, owner) => this.outputAuthorized(event, owner),
          authorizeAtDispatch: (event, owner, signal) => this.authorizeOutputAtDispatch(event, owner, signal),
          fault: (code, account, persistentDeliveryId, failure) => {
            logger.error({ code, account, persistentDeliveryId, ...(failure ? { deliveryFailure: failure } : {}) }, "可靠输出未确认或无法持久接收；已接收结果保留，请检查投递箱");
            if (code === "delivery-uncertain" || code === "authorization-changed") return;
            if (account && code !== "storage" && code !== "capacity" && code !== "mailbox-full") this.surfaceManager.suspendPersistentAccount(account);
            else void this.requestStop().catch(() => logger.error("可靠投递故障后的 Gateway 清理失败"));
          },
        },
        setInteractionAvailable: (
          surface,
          accountId,
          available,
          outcome,
        ) => {
          this.interactions.setAvailable(surface, accountId, available, outcome);
          if (!available) this.asyncQuestions?.cancelSurface(surface, accountId);
        },
        subagentMetadata: (agentThreadId, signal) => this.codex.readThread(agentThreadId, signal),
        completionAccountStatus: async (provider, signal) => {
          if (provider === "openai" || !this.providerAccounts || !accountAdapters.some((adapter) => adapter.provider === provider)) return undefined;
          return completionAccountStatus(provider, await this.providerAccounts.accountUsage(provider, undefined, signal));
        },
        completionTiming: async (threadId, turnId, current, signal) => {
          const persisted = await metricsWriter.waitForCurrentWritesInScopes([{ threadId, turnId }], null, signal);
          if (!persisted) return current;
          const summary = await this.metricsDatabase.withSignal(signal).threadTurnSummary(threadId, turnId);
          return mergeCompletionTiming(summary, turnId, current);
        },
        executionTiming: async (threadId, turnId, signal) => {
          const { durationMs, sessionTiming } = await this.metricsDatabase.withSignal(signal).completionExecutionTiming(threadId, turnId);
          if (!this.turnExecution.isReliable()) sessionTiming.historyComplete = false;
          return {
            durationMs,
            sessionDurationMs: sessionTiming.historyComplete && sessionTiming.missingTurnCount === 0
              ? sessionTiming.knownDurationMs : null,
            sessionTiming,
          };
        },
        autoApprovalReview: async (threadId, turnId, signal) => {
          const persisted = await waitForMetricsScope(threadId, { type: "task", turnId }, "autoApprovalReview", signal);
          const summary = await this.autoApprovalReview.summary(threadId, turnId, this.subagentCompletion.pendingParentTurns(), this.metricsDatabase.withSignal(signal));
          if (!persisted && summary.usage) summary.usage.coverage = "partial";
          return summary;
        },
        sessionAutoApprovalReview: async (threadId, signal) => {
          const persisted = await waitForMetricsScope(threadId, { type: "sessionReview" }, "autoApprovalReview", signal);
          const summary = await this.autoApprovalReview.sessionSummary(threadId, this.subagentCompletion.pendingParentTurns(), this.metricsDatabase.withSignal(signal));
          if (!persisted && summary.usage) summary.usage.coverage = "partial";
          return summary;
        },
        taskAggregate: async (threadId, turnId, signal): Promise<TurnTaskMetricsSummary | undefined> => {
          const persisted = await waitForMetricsScope(threadId, { type: "task", turnId }, null, signal);
          if (!persisted) return undefined;
          const summary = await this.metricsDatabase.withSignal(signal).threadTurnTaskSummary(threadId, turnId);
          if (summary === null) return undefined;
          return {
            responseUsage: summary.responseUsage ?? null,
            requestOutcomes: summary.requestOutcomes,
            interruptionSummary: summary.interruptionSummary,
            requestCount: summary.requestCount,
            usageCoverage: summary.usageCoverage,
            unsuccessfulRequestCount: summary.unsuccessfulRequestCount,
            inputTokens: summary.inputTokens,
            cachedInputTokens: summary.cachedInputTokens,
            outputTokens: summary.outputTokens,
            reasoningOutputTokens: summary.reasoningOutputTokens,
          };
        },
        sessionAggregate: async (threadId, signal): Promise<TurnTaskMetricsSummary | undefined> => {
          const persisted = await waitForMetricsScope(threadId, { type: "session" }, null, signal);
          if (!persisted) return undefined;
          const aggregate = (await this.metricsDatabase.withSignal(signal).threadSummary(threadId)).threadAggregate;
          if (aggregate === null) return undefined;
          return {
            responseUsage: aggregate.responseUsage ?? null,
            performance: aggregate.performance,
            compact: aggregate.compact,
            requestOutcomes: aggregate.requestOutcomes,
            interruptionSummary: aggregate.interruptionSummary,
            requestCount: aggregate.requestCount,
            usageCoverage: aggregate.usageCoverage,
            unsuccessfulRequestCount: aggregate.unsuccessfulRequestCount,
            inputTokens: aggregate.inputTokens,
            cachedInputTokens: aggregate.cachedInputTokens,
            outputTokens: aggregate.outputTokens,
            reasoningOutputTokens: aggregate.reasoningOutputTokens,
          };
        },
      },
    );
    // Construction never starts adapters, so manager.stop only closes routing
    // and persistence; the individually registered adapters still own stop().
    registerConstructionCleanup("Surface Routing", () => this.surfaceManager.stop());
    this.channelImageSpool = new ChannelImageSpool({
      directory: join(dirname(config.stateDatabasePath), "channel-outbox"),
      resolveTarget: (threadId) => this.router.targetForThread(threadId),
      sendImage: (target, imagePath, isCurrent) =>
        this.surfaceManager.sendChannelImage(target, imagePath, isCurrent),
      logger,
    });
    this.channelFileSpool = new ChannelFileSpool({
      directory: join(dirname(config.stateDatabasePath), "channel-file-outbox"),
      resolveTarget: (threadId) => this.router.targetForThread(threadId),
      sendFile: (target, filePath, fileName, isCurrent) => this.surfaceManager.sendChannelFile(target, filePath, fileName, isCurrent),
      logger,
    });
    for (const surface of this.surfaces) {
      this.interactions.register(surface.surface, surface.accountId, surface.capabilities?.interactions === false
        ? surface.interactions : new PersistentInteractionPort(surface.interactions,
          (target, signal) => this.surfaceManager.waitForPersistentOutput(target, signal)));
      this.interactions.setAvailable(surface.surface, surface.accountId, false);
    }
    this.approval = new ApprovalCoordinator(
      this.router,
      this.interactions,
      config.approvalTimeoutMs,
      logger,
    );
    this.asyncQuestions = new AsyncQuestionCoordinator({
      interactions: this.interactions,
      timeoutMs: config.approvalTimeoutMs,
      targetForThread: (threadId) => this.router.targetForThread(threadId),
      currentThread: (target) => this.router.current(target)?.threadId,
      captureAuthorization: (target) => {
        const actors = this.bindings.actors(target).filter(actorId => this.accessPolicy(target)?.isAllowed({ target, actorId }));
        if (this.stopping || actors.length !== 1) return undefined;
        const actorId = actors[0]!;
        let workspace: ReturnType<SessionRouter["workspace"]>;
        try { workspace = this.router.workspace(target); } catch { return undefined; }
        const workspaceId = workspace.id;
        const cwd = workspace.cwd;
        return { actorId, isCurrent: () => {
          if (this.stopping || !this.bindings.actors(target).includes(actorId)
            || !this.accessPolicy(target)?.isAllowed({ target, actorId })) return false;
          try {
            const current = this.router.workspace(target);
            return current.id === workspaceId && current.cwd === cwd;
          } catch { return false; }
        } };
      },
      submit: async (target, threadId, text, isCurrent, requestId) => {
        const surface = this.surfaces.find(candidate => candidate.surface === target.surface
          && candidate.accountId === target.accountId);
        const submission = surface?.takeAsyncAnswerSubmission?.(target, requestId);
        if (target.surface === "qq" && !submission) {
          throw new UserFacingError("input.authorization-changed", "回答来源已失效，请重新发送。");
        }
        try {
          return await service.submitAsyncAnswer(target, threadId, text,
            () => isCurrent() && (submission?.isCurrent() ?? true), submission?.observer);
        } catch (error) {
          submission?.cancel();
          try {
            await submission?.failed?.();
          } catch { /* Notification failure must preserve the submission error. */ }
          throw error;
        }
      },
      warn: (event, message) => this.output.publish({
        type: "warning", target: event.target, threadId: event.threadId, message,
      }, true),
      settled: (threadId) => this.retrySettledBackground(threadId),
    });
    if (primaryProvider === "openai" && this.customPrimaryProviderId === undefined) {
      const primaryClient = clients.get(primaryProvider)!;
      this.startupNetworkRecovery = new StartupNetworkRecovery({
        logger,
        probe: (signal) => this.probeOpenAiConnectivity(signal),
        snapshot: (threadId, signal) => primaryClient.listMcpServers(threadId, signal),
        // Use this instance only; the public /mcp reload deliberately refreshes all Providers.
        reloadMcp: (signal) => primaryClient.reloadMcpServers(signal),
        recovered: async (signal) => {
          signal.throwIfAborted();
          await this.refreshRateLimits(signal);
        },
        status: (status) => { this.openAiConnectivity = status; },
        notify: (message) => {
          logger.info(message);
          for (const binding of this.router.allBindings()) {
            if (this.codex.knownProvider(binding.threadId) !== "openai") continue;
            this.output.publish({ type: "warning", target: binding.target, threadId: binding.threadId, message }, true);
          }
        },
      });
    }
    const conversationEvents = new ConversationEventCoordinator(service, {
      trackSubagent: (event) => this.subagentCompletion.handleInput(event),
      reduce: (event) => this.core.handle(event, { threadClosureObserved: event.type === "thread.closed" }),
      isBackgroundThread: (threadId) => this.router.isBackgroundThread(threadId),
      retryBackgroundRelease: (threadId, trigger) => {
        void this.trackQueueLifecycleTask(() => service.retryPendingBackgroundRelease(threadId,
          () => !this.stopping && !this.isBindingRestoring(threadId)))
          .catch(async (error) => {
            this.logger.warn({ err: error, threadId }, trigger === "thread-idle"
              ? "后台 Thread 空闲状态后的订阅清理失败，已保留绑定供后续重试"
              : "子代理终态后的后台 Thread 订阅清理失败，已保留绑定供后续重试");
            if (!this.stopping && !this.isBindingRestoring(threadId)) {
              await this.restoreIdleBinding(threadId);
            }
          });
      },
    });
    this.inbound.subscribe("conversation-core", (notification) => {
      if (this.notificationCurrent.get(notification)?.() === false) return;
      const source = this.notificationGenerations.get(notification);
      const stale = source !== undefined
        && source.generation !== (this.providerNotificationGenerations.get(source.provider) ?? 0);
      // Connection-local state must be filtered before Application/Core side effects.
      if (stale && (notification.method === "thread/closed" || notification.method === "thread/settings/updated")) return;
      const autoReview = toAutoApprovalReviewEvent(notification);
      if (autoReview) this.autoApprovalReviewNotifications.handle(autoReview);
      const queueChanged = toThreadQueueChangedEvent(notification);
      if (queueChanged) {
        conversationEvents.queueChanged(queueChanged.threadId);
      }
      const coreEvent = toConversationInputEvent(notification);
      if (coreEvent) {
        // Preserve accepted results, but never revive live status from a disconnected stream.
        if (stale && (coreEvent.type === "turn.started" || coreEvent.type === "item.reasoning.delta"
          || (coreEvent.type === "turn.error" && coreEvent.willRetry))) return;
        if (coreEvent.type === "turn.started") {
          this.autoApprovalReviewNotifications.observeParentRun(coreEvent.threadId, coreEvent.turnId);
        }
        if (coreEvent.type === "turn.completed" || coreEvent.type === "thread.reverted") {
          const timingProvider = this.codex.knownProvider(coreEvent.threadId);
          if (timingProvider) this.turnExecution.handle(coreEvent, timingProvider);
        }
        this.asyncQuestions.handleInput(coreEvent, !stale);
        if (coreEvent.type === "mcp.status.updated"
          && (coreEvent.modelProvider === "openai"
            || (coreEvent.threadId !== null && this.codex.knownProvider(coreEvent.threadId) === "openai"))) {
          this.startupNetworkRecovery?.observeMcp(coreEvent);
        }
        if (coreEvent.type === "thread.closed" || coreEvent.type === "thread.archived" || coreEvent.type === "thread.deleted") {
          this.startupNetworkRecovery?.forgetThread(coreEvent.threadId);
        }
        conversationEvents.handle(coreEvent);
        if (coreEvent.type === "turn.error" && !coreEvent.willRetry) {
          const modelSettings = this.router.modelSettingsForThread(coreEvent.threadId);
          recordTurnErrorDiagnostic(
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
        && !autoReview
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
        const params = notification.params as { requestId?: string | number; threadId?: unknown };
        if (params.requestId !== undefined) {
          this.approval.resolved(params.requestId);
          if (typeof params.threadId === "string" && params.threadId.trim()) {
            const threadId = params.threadId;
            void this.trackQueueLifecycleTask(async () => {
              const controller = new AbortController();
              const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
              try {
                const route = await this.router.resolveApprovalTarget(threadId, () => !this.stopping, signal);
                if (route?.isCurrent() && !this.stopping) this.retrySettledBackground(route.ownerThreadId);
              } finally { controller.abort(); }
            }).catch((error) => this.logger.warn({ err: error, threadId }, "交互解决后的后台归属查询失败，已保留绑定"));
          }
        }
      }
    });
    const approvalHandler = (request: Parameters<typeof handleApprovalServerRequest>[0]) =>
      handleApprovalServerRequest(request, this.approval, approval => this.codex.fileApprovalChanges(approval));
    const guardedApprovalHandler = this.scheduledTasks === undefined
      ? approvalHandler
      : createScheduledTaskServerRequestHandler(this.scheduledTasks.coordinator, approvalHandler);
    const appServerRequestHandler: Parameters<typeof this.codex.setServerRequestHandler>[0] =
      async (request) => {
        if (request.method === "item/tool/call") {
          if (!scheduledTaskToolHandler) {
            throw new JsonRpcError(-32601, "计划任务动态工具未启用");
          }
          return scheduledTaskToolHandler(request);
        }
        return guardedApprovalHandler(request);
      };
    this.codex.setServerRequestHandler(appServerRequestHandler);
    this.bindingRestoreCoordinator();
  }

  private async updateThreadApprovalsReviewer(threadId: string, reviewer: "user" | "auto_review", beforeSubmit?: () => void): Promise<void> {
    await this.codex.updateThreadApprovalsReviewer(threadId, reviewer, beforeSubmit);
    // RPC confirmation observes notifications before the asynchronous inbound
    // consumers reduce them. Wait for the shared reducer before Application
    // reads the actual reviewer or the next command checks a same-value no-op.
    try {
      if (this.stopping) throw new Error("Gateway 正在停止");
      await this.inbound.drain();
      if (this.stopping) throw new Error("Gateway 正在停止");
    } catch {
      throw new UserFacingError("autoreview.update-unconfirmed", "会话审批方式更新结果尚未确认，请重新查询状态");
    }
  }

  private bindingRestoreCoordinator(): BindingRestoreCoordinator {
    this.bindingRestore ??= new BindingRestoreCoordinator({
      restored: (threadId) => {
        const provider = this.codex.knownProvider(threadId);
        if (provider) this.turnExecution.synchronize(threadId, provider);
      },
      codex: this.codex,
      router: this.router,
      output: this.output,
      enabledSurfaces: () => this.surfaces.filter(surface => !surface.connectionOnly && surface.capabilities?.recoverBindings !== false),
      scheduledRecovery: () => this.scheduledTasks?.coordinator,
      releaseBackground: async (threadId, isCurrent) =>
        await this.trackQueueLifecycleTask(() =>
          this.conversations.releaseBackgroundIfComplete(threadId, {
            dispatchQueued: false,
            isCurrent,
          })) === true,
      trackThreadActivity: (threadId) => this.core.trackThreadActivity(threadId),
      logger: this.logger,
    });
    return this.bindingRestore;
  }

  reloadConfig(
    next: GatewayConfig,
    pendingAddedWorkspaces: readonly GatewayConfig["workspaces"][number][] = [],
    weixinCredentialsChanged = false,
  ): ConfigReloadResult {
    const result = classifyConfigReload(this.config, next, weixinCredentialsChanged);
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
        for (const restore of restoreRecipients.reverse()) restore();
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
        addedWorkspaces: this.numberAddedWorkspaces(addedWorkspaces),
      });
    }
    return result;
  }

  async applyProviderSettings(provider: string, signal: AbortSignal): Promise<boolean> {
    this.requireRunning();
    if (!this.managedSettingsProviders.includes(provider)) {
      throw new Error("Provider 不属于当前 Gateway 的设置应用范围");
    }
    const cancellation = AbortSignal.any([signal, this.providerSettingsAbort.signal]);
    cancellation.throwIfAborted();
    if (this.pendingProviderSettings.has(provider)) throw new Error("该 Provider 设置已在应用中");
    this.pendingProviderSettings.add(provider);
    try {
      return await this.applyProviderSettingsOnce(provider, cancellation);
    } finally {
      this.pendingProviderSettings.delete(provider);
    }
  }

  refreshProviderModels(provider: string, signal: AbortSignal): void {
    this.requireRunning();
    const cancellation = AbortSignal.any([signal, this.providerSettingsAbort.signal]);
    cancellation.throwIfAborted();
    const snapshot = this.providerModelSnapshots.get(provider);
    if (!snapshot) throw new Error("Provider 模型目录尚未确认应用");
    this.modelSelection.updateSupplementaryModels(snapshot, provider);
  }

  private async stageProviderModels(
    provider: string,
    result: Awaited<ReturnType<typeof applyAppServerProviderSettings>>,
    candidate: { fingerprint: string; models: ModelOption[] } | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const snapshot = result.snapshot;
    if (!snapshot) throw new Error("Provider 已应用设置快照不可用");
    const inspection = await inspectAppServerSupervisorState(this.config.codexSocketPath);
    signal.throwIfAborted();
    let catalog: ModelOption[];
    if (inspection.status !== "ready") throw new Error("App Server 监管状态暂不可用");
    if (inspection.topology.runningProviders.includes(provider)) {
      catalog = await this.codex.listModelsForProvider(provider);
      signal.throwIfAborted();
    } else {
      if (!result.applied || candidate?.fingerprint !== snapshot.fingerprint) {
        throw new Error("Provider 模型目录尚未确认应用");
      }
      catalog = candidate.models;
    }
    const confirmed = catalog.map((model) => ({ ...model, provider,
      isDefault: model.model === snapshot.defaultModel }));
    if (snapshot.defaultModel !== null && !confirmed.some((model) => model.isDefault)) {
      throw new Error("Provider 已应用默认模型不在确认目录中");
    }
    signal.throwIfAborted();
    this.providerModelSnapshots.set(provider, confirmed);
  }

  private async initializeProviderModels(signal: AbortSignal): Promise<void> {
    for (const provider of this.managedSettingsProviders) {
      this.requireRunning();
      signal.throwIfAborted();
      try {
        await this.applyProviderSettings(provider, signal);
        this.refreshProviderModels(provider, signal);
      } catch (error) {
        signal.throwIfAborted();
        this.requireRunning();
        this.logger.warn({ err: error, provider }, "Provider 模型目录确认失败，暂不开放未确认目录");
      }
    }
  }

  private async applyProviderSettingsOnce(provider: string, cancellation: AbortSignal): Promise<boolean> {
    let candidate: { fingerprint: string; models: ModelOption[] } | undefined;
    try {
      candidate = this.captureProviderModels(provider);
    } catch (error) {
      this.logger.warn({ err: error, provider }, "Provider 待应用模型目录暂不可读，将只使用宿主确认目录");
    }
    let result: Awaited<ReturnType<typeof applyAppServerProviderSettings>> | undefined;
    let connected = false;
    let recovering: Promise<void> | undefined;
    let disconnectedDuringApply: Error | undefined;
    let applied: boolean;
    try {
      applied = await this.providerIdleReleaser.applySettings(provider, cancellation, async () => {
        this.providersApplyingSettings.add(provider);
        connected = this.codex.connectedProviderIds().includes(provider);
        cancellation.throwIfAborted();
        result = await applyAppServerProviderSettings(this.config.codexSocketPath, provider, cancellation);
        cancellation.throwIfAborted();
        if (!result.applied) return false;
        const disconnected = this.settingsDisconnects.has(provider);
        if (!result.changed && !disconnected) return true;
        // Intentional close does not emit onDisconnect; invalidate this stream here too.
        this.router.invalidateSubscriptions(threadId => this.codex.knownProvider(threadId) === provider);
        try {
          await this.codex.closeProvider(provider);
        } finally {
          this.providerNotificationGenerations.set(provider, (this.providerNotificationGenerations.get(provider) ?? 0) + 1);
        }
        cancellation.throwIfAborted();
        if (connected || disconnected) {
          recovering = this.gatewayReconnectCoordinator().recoverAppliedSettings(provider, cancellation);
          // Recovery waits on this admission barrier; own rejection until it is released.
          void recovering.catch(() => undefined);
        }
        return true;
      });
    } catch (error) {
      const disconnected = this.settingsDisconnects.get(provider);
      if (disconnected && !this.stopping) {
        this.gatewayReconnectCoordinator().disconnected(disconnected, provider);
      }
      throw error;
    } finally {
      this.providersApplyingSettings.delete(provider);
      disconnectedDuringApply = this.settingsDisconnects.get(provider);
      this.settingsDisconnects.delete(provider);
    }
    if (!applied) {
      if (disconnectedDuringApply && !this.stopping) {
        this.gatewayReconnectCoordinator().disconnected(disconnectedDuringApply, provider);
      }
      if (result) await this.stageProviderModels(provider, result, candidate, cancellation);
      return false;
    }
    cancellation.throwIfAborted();
    if (recovering) {
      await recovering;
      cancellation.throwIfAborted();
    }
    if (result) await this.stageProviderModels(provider, result, candidate, cancellation);
    return true;
  }

  async readConnectedThreadStates(
    threadIds: readonly string[],
    signal: AbortSignal,
  ): Promise<GatewayThreadState[]> {
    this.requireRunning();
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), threadStateReadTimeoutMs);
    const cancellation = AbortSignal.any([signal, deadline.signal]);
    const states: GatewayThreadState[] = threadIds.map(threadId => ({ threadId, status: "unknown", reason: "timeout" }));
    let next = 0;
    const read = async (): Promise<void> => {
      while (next < threadIds.length) {
        signal.throwIfAborted();
        if (deadline.signal.aborted) return;
        const index = next++;
        const threadId = threadIds[index]!;
        try {
          const state = await this.codex.readConnectedThreadState(threadId, cancellation);
          states[index] = { threadId, ...state };
        } catch (error) {
          signal.throwIfAborted();
          if (deadline.signal.aborted) return;
          throw error;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(4, threadIds.length) }, read));
      signal.throwIfAborted();
      return states;
    } finally {
      clearTimeout(timeout);
      deadline.abort();
    }
  }

  async resetCreditOperation(request: import("../../runtime/gateway-account-refresh.mjs").ResetCreditRequest, signal: AbortSignal): Promise<unknown> {
    this.requireRunning();
    if (!this.resetCredits) throw new Error("Account service unavailable");
    switch (request.method) {
      case "reset/list": return this.resetCredits.list(signal);
      case "reset/preview": return this.resetCredits.preview(request.creditId, signal);
      case "reset/consume": return this.resetCredits.consume(request.attemptId, signal);
      case "reset/cancel": this.resetCredits.cancel(request.attemptId); return { cancelled: true };
    }
  }

  refreshAccountSnapshot(provider: string, signal?: AbortSignal): Promise<boolean> {
    this.requireRunning();
    if (provider === "openai") return this.providerAccounts!.accountLimits("openai", signal).then(() => true);
    return this.providerAccounts?.refreshAccountSnapshot(provider, signal)
      ?? Promise.resolve(false);
  }

  notifyProviderSettingsChange(
    action:
      | "provider-settings-scheduled"
      | "provider-settings-restarting"
      | "provider-settings-applied"
      | "provider-settings-restart-required"
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
      this.startupAbort = new AbortController();
      await verifyCodexVersion(this.config, this.auxiliaryCommands, this.startupAbort.signal);
      this.requireRunning();
      await this.metricsReady;
      this.requireRunning();
      await this.scheduledTasks?.prepareStore(this.startupAbort.signal);
      this.requireRunning();
      await this.surfaceManager.preparePersistence();
      this.requireRunning();
      await this.providerMetrics.start();
      this.requireRunning();
      await this.metricsEvents?.start();
      this.requireRunning();
      await this.accountSnapshotEvents?.start();
      this.requireRunning();
      // IPC lifetime follows the writer, not the HTTP admission switch. It must
      // already exist for first enablement and drain terminal metrics on disable.
      await this.relayMetrics?.apply(true);
      this.requireRunning();
      this.removeRpcNotification = this.codex.onNotification((notification) => {
        const provider = notification.provider ?? this.primaryProvider;
        this.notificationGenerations.set(notification, {
          provider, generation: this.providerNotificationGenerations.get(provider) ?? 0,
        });
        const threadStateEvent = toThreadStateEvent(notification);
        if (threadStateEvent) {
          const isCurrent = this.threadState.observeExecutionContext(threadStateEvent);
          if (isCurrent) this.notificationCurrent.set(notification, isCurrent);
          if (threadStateEvent.type === "thread.closed") this.core.observeThreadClosed(threadStateEvent.threadId);
          if (threadStateEvent.type === "thread.settings.updated") {
            this.conversations.observeLunaReserveSettings(threadStateEvent.threadId);
          }
        }
        // Revoke live tools before bounded asynchronous notification consumers.
        const toolEvent = toConversationInputEvent(notification);
        if (toolEvent) this.scheduledTasks?.toolHandler.handleInput(toolEvent);
        // Guard input precedes the lossy presentation queue; raw text never enters that queue via Core.
        if (toolEvent && "threadId" in toolEvent && toolEvent.threadId
          && provider === this.codex.knownProvider(toolEvent.threadId)) {
          if (toolEvent.type === "turn.completed") {
            this.reasoningRepeatGuard.completed(toolEvent.threadId, toolEvent.turnId, toolEvent.status);
          } else if (toolEvent.type === "turn.started") {
            this.reasoningRepeatGuard.started(toolEvent.threadId, toolEvent.turnId);
          } else if (toolEvent.type === "turn.error") {
            this.reasoningRepeatGuard.requestFailed(toolEvent.threadId, toolEvent.turnId);
          } else if (toolEvent.type === "thread.closed" || toolEvent.type === "thread.archived"
            || toolEvent.type === "thread.deleted" || toolEvent.type === "thread.reverted") {
            this.reasoningRepeatGuard.reset(toolEvent.threadId);
          }
        }
        const reasoningInput = toReasoningGuardInput(notification);
        if (reasoningInput && provider === this.codex.knownProvider(reasoningInput.threadId)) {
          this.reasoningRepeatGuard.observe(reasoningInput);
        }
        if (notification.method === "serverRequest/resolved" && typeof notification.params === "object"
          && notification.params !== null && !Array.isArray(notification.params)) {
          const params = notification.params as { requestId?: unknown; threadId?: unknown };
          if ((typeof params.requestId === "string" || typeof params.requestId === "number") && typeof params.threadId === "string") {
            this.scheduledTasks?.toolHandler.resolved(params.requestId, params.threadId);
          }
        }
        // Persist minimal facts before bounded asynchronous presentation queues.
        this.autoApprovalReview.handleNotification(notification);
        this.inbound.publish(notification, isCriticalNotification(notification.method));
      });
      this.removeRpcDisconnect = this.codex.onDisconnect((error, provider) => {
        // A reconnect has no delta sequence numbers: never join text across connections.
        this.reasoningRepeatGuard.resetProvider(provider);
        this.providerNotificationGenerations.set(provider, (this.providerNotificationGenerations.get(provider) ?? 0) + 1);
        this.router.invalidateSubscriptions(threadId => this.codex.knownProvider(threadId) === provider);
        this.scheduledTasks?.toolHandler.cancelThreads((threadId) => this.codex.knownProvider(threadId) === provider);
        const affectedThreads = new Set(this.router.allBindings()
          .filter((binding) => this.codex.knownProvider(binding.threadId) === provider)
          .map((binding) => binding.threadId));
        this.conversationIdleReleaser?.cancelPending(affectedThreads);
        for (const threadId of affectedThreads) {
          this.conversations.clearMcpLoginThread(threadId);
        }
        this.turnExecution.reset(provider);
        this.autoApprovalReview.reset(provider);
        this.autoApprovalReviewNotifications.reset(provider);
        this.subagentCompletion.resetRunAttribution((threadId) => this.codex.knownProvider(threadId) === provider);
        if (this.providersApplyingSettings.has(provider)) {
          this.settingsDisconnects.set(provider, error);
          return;
        }
        this.gatewayReconnectCoordinator().disconnected(error, provider);
      });
      const initialized = await this.codex.connect();
      this.requireRunning();
      this.codexUpstreamUserAgent = initialized.userAgent;
      if (this.primaryProvider === "openai" && this.customPrimaryProviderId === undefined) {
        const connectivityAbort = new AbortController();
        this.openAiConnectivityAbort = connectivityAbort;
        const [connectivity] = await Promise.all([
          this.probeOpenAiConnectivity(connectivityAbort.signal),
          this.refreshRateLimits(connectivityAbort.signal),
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
      await this.initializeProviderModels(this.startupAbort.signal);
      this.requireRunning();
      await this.scheduledTasks?.prepareRecovery(this.startupAbort.signal);
      this.requireRunning();
      await this.restoreBindings();
      this.requireRunning();
      if (this.openAiConnectivity !== "recovering") {
        this.startupNetworkRecovery?.start(this.openAiConnectivity, this.router.allBindings()
          .filter((binding) => this.codex.knownProvider(binding.threadId) === "openai")
          .map((binding) => binding.threadId));
      }
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
      this.requireRunning();
      const warmupStarted = performance.now();
      const warmupSignal = this.startupAbort.signal;
      this.accountWarmupTask = this.providerAccounts?.refreshSnapshots(warmupSignal, (provider, operation, error) => {
        this.logger.warn({ provider, query: operation,
          ...accountQueryFailureMetadata(error, performance.now() - warmupStarted) }, "账户快照预热失败");
      }).catch((error) => {
        if (!warmupSignal.aborted) {
          this.logger.warn(accountQueryFailureMetadata(error, performance.now() - warmupStarted), "账户快照预热任务失败");
        }
      });
      await this.channelImageSpool.start();
      this.requireRunning();
      await this.channelFileSpool.start();
      this.requireRunning();
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
      const reconnecting = this.stopReconnect();
      await this.shutdownComponents().catch((cleanupError) => {
        this.logger.error({ err: cleanupError }, "Gateway 启动失败后的资源清理不完整");
      });
      if (!(await waitAtMost(reconnecting, 5_000))) {
        this.logger.error("Gateway 启动失败后等待重连任务停止超时");
      }
      throw error;
    }
  }

  protected async stopInternal(startup: Promise<void> | undefined, startupSettled: boolean): Promise<void> {
    this.stopping = true;
    this.scheduledTasks?.toolHandler.close();
    this.providerSettingsAbort.abort(new Error("Gateway 正在停止"));
    this.conversationIdleReleaser?.cancelPending();
    this.conversations?.setIdleReleaseEnabled(false);
    this.surfaceManager.beginShutdown?.();
    this.conversations?.closeSessionQueries();
    this.startupAbort?.abort();
    this.auxiliaryCommands.cancel();
    void this.startupNetworkRecovery?.stop();
    this.openAiConnectivityAbort?.abort(new Error("Gateway 正在停止"));
    const reconnecting = this.stopReconnect();
    void this.bindingRestoreCoordinator().close();
    const failures: unknown[] = [];
    if (startup && !startupSettled) {
      this.removeRpcNotification?.();
      this.removeRpcNotification = undefined;
      this.removeRpcDisconnect?.();
      this.removeRpcDisconnect = undefined;
      try {
        await this.codex.close();
      } catch (error) {
        failures.push(error);
        this.logger.error(
          { err: error, component: "Codex Client" },
          "Gateway 启动中断失败",
        );
      }
    }
    await startup?.catch(() => undefined);
    try {
      await this.shutdownComponents();
    } catch (error) {
      failures.push(error);
    }
    if (!(await waitAtMost(reconnecting, 5_000))) {
      const error = new Error("等待 Codex App Server 重连任务停止超时");
      failures.push(error);
      this.logger.error({ err: error }, "Gateway 后台任务关闭失败");
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Gateway 资源未完全关闭");
    }
  }

  private outputOwner(event: OutputEvent): string {
    const identity = JSON.stringify(this.outputIdentity(event));
    if (event.target.surface !== "qq") return identity;
    const source = this.outputSourcePort(event)?.capture(event) ?? null;
    return JSON.stringify({ version: 3, kind: "qq-live", identity, source });
  }

  private outputSourcePort(event: OutputEvent) {
    const surface = this.surfaces.find(candidate => candidate.surface === event.target.surface
      && candidate.accountId === event.target.accountId);
    return surface && !surface.connectionOnly ? surface.output.deliverySource : undefined;
  }

  private outputSourceOwner(event: OutputEvent, owner: string): { identity: string; source: SurfaceDeliverySource } | undefined {
    const value = JSON.parse(owner) as { version?: unknown; kind?: unknown; identity?: unknown; source?: SurfaceDeliverySource | null };
    const source = value?.source;
    if (value?.version !== 3 || value.kind !== "qq-live" || typeof value.identity !== "string" || !source
      || ![source.generation, source.sourceToken, source.accountId, source.conversationId, source.threadId]
        .every(field => typeof field === "string" && field.length > 0 && Buffer.byteLength(field) <= 512)
      || source.accountId !== event.target.accountId || source.conversationId !== event.target.conversationId
      || !("threadId" in event) || event.threadId !== source.threadId) return undefined;
    if (source.kind === "notification") {
      if (source.eventType !== "mcp.oauth.completed" || event.type !== source.eventType
        || source.serverName !== event.name) return undefined;
    } else if (source.kind !== undefined || typeof source.turnId !== "string" || !source.turnId
      || Buffer.byteLength(source.turnId) > 512 || !("turnId" in event) || event.turnId !== source.turnId) return undefined;
    return { identity: value.identity, source: Object.freeze({ ...source }) };
  }

  private async authorizeOutputAtDispatch(event: OutputEvent, owner: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    if (event.target.surface !== "qq") return this.outputAuthorized(event, owner);
    const original = this.outputSourceOwner(event, owner);
    const port = this.outputSourcePort(event);
    if (!original || !port || !this.outputIdentityAuthorized(event, original.identity)) return false;
    if (!(await port.await(original.source, signal))) return false;
    return !signal.aborted && this.outputAuthorized(event, owner);
  }

  private outputIdentity(event: OutputEvent) {
    const target = event.target;
    const threadId = "threadId" in event ? event.threadId : "parentThreadId" in event ? event.parentThreadId : undefined;
    const binding = threadId ? this.bindings.getByThread(threadId) : this.bindings.get(target);
    const workspace = this.bindings.getWorkspace(target) ?? null;
    return {
      version: 2,
      workspaceCwd: workspace ? this.workspaces.get(workspace)?.cwd ?? null : null,
      bindingWorkspaceCwd: binding ? this.workspaces.get(binding.workspaceId)?.cwd ?? null : null,
      actors: this.bindings.actors(target).sort(),
      workspace,
      binding: binding ? [binding.target.surface, binding.target.accountId, binding.target.conversationId, binding.workspaceId, binding.threadId] : null,
      provider: binding ? this.codex.knownProvider(binding.threadId) ?? null : null,
      background: typeof threadId === "string" && this.router.isBackgroundThread(threadId),
    };
  }

  private outputAuthorized(event: OutputEvent, owner: string): boolean {
    if (event.target.surface !== "qq") return this.outputIdentityAuthorized(event, owner);
    const original = this.outputSourceOwner(event, owner);
    return !!original && this.outputIdentityAuthorized(event, original.identity)
      && this.outputSourcePort(event)?.current(original.source) === true;
  }

  private outputIdentityAuthorized(event: OutputEvent, owner: string): boolean {
    const original = JSON.parse(owner) as ReturnType<typeof this.outputIdentity>;
    // Older owners cannot prove the directory that was authorized at admission.
    // Preserve their records, but never infer or upgrade their identity here.
    if (original?.version !== 2) return false;
    if (original.provider && !this.codex.isProviderConfigured(original.provider)) return false;
    // Stored selections survive unbinding and configuration changes; they do
    // not establish current Workspace authorization.
    if ([original.workspace, original.binding?.[3]].some((id) => id != null && !this.workspaces.get(id))) return false;
    if (original.workspace !== null && (!original.workspaceCwd
      || this.workspaces.get(original.workspace)?.cwd !== original.workspaceCwd)) return false;
    if (original.binding && (!original.bindingWorkspaceCwd
      || this.workspaces.get(original.binding[3]!)?.cwd !== original.bindingWorkspaceCwd)) return false;
    const current = this.outputIdentity(event);
    // Foreground/background is presentation state, not recipient authorization.
    // Normal unsubscription may precede slow delivery, including after demotion.
    // A Thread currently owned by another target must still fail the comparison.
    current.background = original.background;
    if (original.binding && current.binding === null && original.provider
      && this.codex.isProviderConfigured(original.provider)) {
      current.binding = original.binding;
      current.provider = original.provider;
      current.bindingWorkspaceCwd = original.bindingWorkspaceCwd;
    }
    if (JSON.stringify(current) !== owner) return false;
    const target = event.target;
    const actors = this.bindings.actors(target);
    const policy = this.accessPolicy(target);
    if (!policy) return false;
    if (actors.some((actorId) => policy.isAllowed({ target, actorId }))) return true;
    return actors.length === 0 && this.surfaceModules.some((module) => module.notificationTargets?.().some((candidate) =>
      candidate.surface === target.surface && candidate.accountId === target.accountId && candidate.conversationId === target.conversationId));
  }

  private accessPolicy(target: ConversationTarget) {
    return target.surface === "telegram" && this.config.telegramEnabled
      ? new TelegramAccessPolicy(this.config.telegramAllowedUserIds, "default")
      : target.surface === "feishu" && this.config.feishu
      ? new FeishuAccessPolicy(this.config.feishu.allowedOpenIds, this.config.feishu.appId)
      : target.surface === "weixin" && this.config.weixin
      ? new WeixinAccessPolicy(this.config.weixin.allowedUserIds, this.config.weixin.accountId)
      : target.surface === "qq" && this.config.qq
      ? new QqAccessPolicy(this.config.qq.allowedUserOpenIds, this.config.qq.appId)
      : undefined;
  }

  private shutdownComponents(): Promise<void> {
    this.shutdownTask ??= this.shutdownComponentsOnce();
    return this.shutdownTask;
  }

  private async shutdownComponentsOnce(): Promise<void> {
    this.stopping = true;
    this.scheduledTasks?.toolHandler.close();
    this.providerSettingsAbort.abort(new Error("Gateway 正在停止"));
    this.conversationIdleReleaser?.cancelPending();
    this.conversations?.setIdleReleaseEnabled(false);
    this.surfaceManager.beginShutdown?.();
    this.conversations?.closeSessionQueries();
    this.startupAbort?.abort();
    this.auxiliaryCommands.cancel();
    const restoringBindings = this.bindingRestoreCoordinator().close();
    this.openAiConnectivityAbort?.abort();
    this.openAiConnectivityAbort = undefined;
    this.removeRpcNotification?.();
    this.removeRpcNotification = undefined;
    this.removeRpcDisconnect?.();
    this.removeRpcDisconnect = undefined;
    const failures: unknown[] = [];
    for (const [component, close] of [
      ["Auxiliary Commands", () => this.auxiliaryCommands.close()],
      ["Startup Network Recovery", () => this.startupNetworkRecovery?.stop()],
      ["Scheduled Task Scheduler", () => this.scheduledTasks?.stop()],
      ["Reasoning Repeat Guard", () => this.reasoningRepeatGuard.close()],
      ["Queue Lifecycle", () => this.closeQueueLifecycleTasks()],
      ["Channel Image Spool", () => this.channelImageSpool.stop()],
      ["Channel File Spool", () => this.channelFileSpool.stop()],
      ["Provider Idle Releaser", () => this.providerIdleReleaser?.stop()],
      ["Conversation Idle Releaser", () => this.conversationIdleReleaser?.stop()],
      ["Luna Reserve", () => this.conversations?.closeLunaReserve()],
      ["Async Questions", () => this.asyncQuestions.close()],
      // Keep synchronous durable admission alive until every accepted inbound
      // notification has been reduced. Closing Surface first loses this tail.
      ["Inbound Event Bus", () => this.inbound.close({ requireDrained: true })],
      ["Derived Output Inputs", () => this.output.drain()],
      ["Turn Execution Metrics", () => this.turnExecution.stop()],
      ["Auto-review Metrics", () => this.autoApprovalReview.stop()],
      ["Subagent Terminals", async () => {
        try { await this.subagentCompletion?.drain(); }
        finally { this.subagentMetricsAbort.abort(); }
      }],
      ["Auto-review Notifications", () => this.autoApprovalReviewNotifications.reset()],
      ["Surface", () => this.surfaceManager.stop()],
      ["Account Snapshot Warmup", async () => {
        if (this.accountWarmupTask && !(await waitAtMost(this.accountWarmupTask, 5_000))) {
          this.logger.warn("账户快照预热取消等待超时，迟到结果不会写入快照");
        }
      }],
      ["Relay Metrics", () => this.relayMetrics?.close()],
      ["Provider Proxy Metrics", () => this.providerMetrics.close()],
      ["Metrics Notifications", () => this.metricsEvents?.close()],
      ["Account Snapshot Notifications", () => this.accountSnapshotEvents?.close()],
      ["Output Event Bus", () => this.output.close()],
      ["Codex Client", () => this.codex.close()],
      ["Binding Recovery", async () => {
        if (restoringBindings && !(await waitAtMost(restoringBindings, 5_000))) {
          throw new Error("等待 Codex Thread 订阅恢复任务停止超时");
        }
      }],
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

  private retrySettledBackground(threadId: string): void {
    void this.trackQueueLifecycleTask(() => this.conversations.retryPendingBackgroundRelease(threadId,
      () => !this.stopping && !this.isBindingRestoring(threadId)))
      .catch(async (error) => {
        this.logger.warn({ err: error, threadId }, "后台空闲复核失败，安排订阅恢复");
        if (!this.stopping && !this.isBindingRestoring(threadId)) await this.restoreIdleBinding(threadId);
      });
  }

  private trackQueueLifecycleTask<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (this.stopping) {
      return Promise.resolve(undefined);
    }
    const task = operation();
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

  private numberAddedWorkspaces(
    workspaces: readonly GatewayConfig["workspaces"][number][],
  ) {
    const registered = this.workspaces.list();
    return workspaces.map((workspace) => {
      const index = registered.findIndex((entry) => entry.id === workspace.id);
      if (index < 0) {
        throw new Error("新增 Workspace 通知的目标不在当前注册列表中");
      }
      return { ...workspace, listNumber: index + 1 };
    });
  }

  deliverAddedWorkspaceNotifications(
    workspaces: readonly GatewayConfig["workspaces"][number][],
  ): Promise<void> {
    return this.surfaceManager.deliverConfigurationChange({
      action: "reloaded",
      changes: [configChange("workspace.registry")],
      addedWorkspaces: this.numberAddedWorkspaces(workspaces),
    });
  }

  notifyConfigReloadFailure(): void {
    this.surfaceManager.configurationChanged({
      action: "reload-failed",
      changes: [],
      addedWorkspaces: [],
    });
  }

  private stopReconnect(): Promise<void> {
    return this.reconnectCoordinator?.stop() ?? Promise.resolve();
  }

  private gatewayReconnectCoordinator(): GatewayReconnectCoordinator {
    this.reconnectCoordinator ??= new GatewayReconnectCoordinator({
      codex: this.codex,
      router: this.router,
      core: this.core,
      interactions: this.interactions,
      bindings: this.bindingRestoreCoordinator(),
      logger: this.logger,
      isStopping: () => this.stopping,
      cancelQuestions: (threadId) => this.asyncQuestions.cancelThread(threadId),
      intentionallyReleased: async (provider) => {
        const topology = await inspectAppServerSupervisor(this.config.codexSocketPath);
        return topology?.releasedProviders.includes(provider) === true;
      },
      connected: async (provider, initialized, signal) => {
        this.codexUpstreamUserAgent = initialized.userAgent;
        if (provider === "openai" && this.customPrimaryProviderId === undefined) {
          await this.refreshRateLimits(signal);
        }
      },
      requestStop: () => {
        process.exitCode = 1;
        return this.requestStop();
      },
    });
    return this.reconnectCoordinator;
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
    provider: string | null | undefined,
    model: string | null | undefined,
  ): number | null {
    if (!model) return null;
    // 受管第三方 Provider 只配置模型窗口，压缩阈值由上游按窗口推导。
    const managed = loadManagedModelWindow(process.env).some(
      (candidate: { provider: string; model: string }) => candidate.provider === provider && candidate.model === model,
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

  private async refreshRateLimits(signal?: AbortSignal): Promise<void> {
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new Error("读取 Codex 周限超时")), startupNetworkPolicy.probeTimeoutMs);
    timeout.unref();
    const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      const result = await this.codex.accountRateLimits({ background: true, signal: requestSignal });
      requestSignal.throwIfAborted();
      this.core.rememberRateLimits(result.limits);
    } catch (error) {
      if (signal?.aborted) return;
      this.logger.warn({ err: error }, "读取 Codex 周限失败，启动通知暂不显示周限");
    } finally {
      clearTimeout(timeout);
    }
  }

  private async probeOpenAiConnectivity(
    signal?: AbortSignal,
  ): Promise<OpenAiConnectivityStatus> {
    if (!hasCodexAuthFile(process.env)) {
      return "not-applicable";
    }
    const openAiBaseUrl = loadOpenAiBaseUrl();
    const deadlineMs = startupNetworkPolicy.probeDeadlineMs;
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

  private async restoreIdleBinding(threadId: string): Promise<void> {
    try {
      await this.restoreBindings(undefined, new Set([threadId]));
    } catch (error) {
      this.logger.warn({ err: error, threadId }, "空闲释放取消后的绑定恢复失败");
    } finally {
      this.scheduleBindingRestore();
    }
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
    assertAuthorized?: () => void,
  ): Promise<ThreadOccupancyReleaseResult> {
    this.requireRunning();
    assertAuthorized?.();
    const current = this.router.current(target);
    if (!current) {
      return { status: "unbound" };
    }
    const workspace = this.router.workspace(target);
    const assertCurrent = () => {
      this.requireRunning();
      assertAuthorized?.();
      if (this.router.current(target) !== current || this.router.workspace(target) !== workspace) {
        throw new UserFacingError("thread.takeover.changed", "等待期间会话或 Workspace 已变化，请重新查询占用");
      }
    };
    const threadId = current.threadId;
    const options = {
      runner: this.auxiliaryCommands,
      ...(this.startupAbort ? { signal: this.startupAbort.signal } : {}),
    };
    const inspection = await inspectThreadWriterLock(threadId, process.env, "/proc", options);
    assertCurrent();
    if (!inspection.held) {
      this.retryPendingBindingRestore(threadId);
      return { status: "free", threadId };
    }
    if (inspection.holder === null) {
      return { status: "unidentifiable", threadId, reason: inspection.reason };
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
    const recheck = await inspectThreadWriterLock(threadId, process.env, "/proc", options);
    assertCurrent();
    if (!recheck.held) {
      this.retryPendingBindingRestore(threadId);
      return { status: "released", threadId, holder };
    }
    if (recheck.holder === null) {
      return { status: "unidentifiable", threadId, reason: recheck.reason };
    }
    const recheckedReleasable = isReleaseableThreadWriterHolder(recheck.holder);
    if (
      recheck.holder.pid !== holder.pid
      || recheck.holder.startedAt !== holder.startedAt
      || !recheckedReleasable
    ) {
      return {
        status: "held",
        threadId,
        holder: recheck.holder,
        releasable: recheckedReleasable,
        stuck,
      };
    }
    assertCurrent();
    const exited = await terminateThreadWriterHolder(holder.pid, {
      ...(holder.startedAt === undefined ? {} : { startedAt: holder.startedAt }),
      ...options,
    });
    // Termination may already have happened. A stale result never restores a
    // replacement binding, and cancellation does not imply rollback of force.
    assertCurrent();
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

async function verifyCodexVersion(config: GatewayConfig, runner: OwnedCommandRunner, signal: AbortSignal): Promise<void> {
  const invocation = executableInvocation(
    resolveExecutable(effectiveCodexBinary(config.codexBinary)),
    ["--version"],
  );
  const result = await runner.run(invocation, { timeoutMs: 5_000, maxOutputBytes: 4_096, signal });
  if (result.status !== 0) {
    throw new Error("无法读取 Codex 版本");
  }
  const actual = result.stdout.trim();
  if (actual !== supportedCodexCliVersion) {
    throw new Error(
      `Codex 版本不受支持：需要协议基线 ${supportedCodexCliVersion}`,
    );
  }
}

export { effectiveCodexBinary };

function isCriticalNotification(method: string): boolean {
  return !method.endsWith("/delta") && !method.endsWith("/outputDelta");
}
