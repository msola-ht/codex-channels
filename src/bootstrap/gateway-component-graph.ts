import { execFileSync, spawnSync } from "node:child_process";
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

import { assertAppServerSocketPathSupported } from "../../runtime/app-server-runtime.mjs";
import {
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
import {
  loadManagedModelProviderDefinitions,
} from "../../runtime/model-provider-definitions.mjs";
import {
  loadConfiguredCustomPrimaryModelProvider,
  loadConfiguredCustomSwitchingModelProviders,
  loadManagedModelProviders,
  loadManagedModelProviderSettings,
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
import { resolveDefaultManagedProvider } from "../../runtime/managed-provider-account-routing.mjs";
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
  ConversationService,
  ModelSelectionService,
  ProviderAccountService,
  scheduledTaskToolSpec,
  createOpenAiAccountAdapter,
  OpenAiResetCreditService,
  ConversationResetCreditService,
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
import { WorkspaceRegistry, TelegramAccessPolicy, FeishuAccessPolicy, WeixinAccessPolicy } from "../policy/index.js";
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
  SurfaceOutputCoalescer,
} from "../surfaces/index.js";
import { ChannelImageSpool } from "./channel-image-spool.js";
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
import { enqueueTurnErrorMetric } from "./turn-error-metrics.js";
import { completionAccountStatus } from "./completion-account-status.js";
import { mergeCompletionTiming } from "./completion-timing.js";
import { TurnExecutionTracker } from "./turn-execution-tracker.js";
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
} from "./binding-restore-coordinator.js";

export abstract class GatewayComponentGraph {
  private readonly transport: CodexTransport;
  private readonly codex: ProviderRoutingClient;
  private readonly turnExecution: TurnExecutionTracker;
  private readonly primaryProvider: string;
  private readonly customPrimaryProviderId: string | undefined;
  private readonly inbound: EventBus<RpcNotification>;
  private readonly output: EventBus<OutputEvent>;
  private readonly surfaceModules: SurfaceRuntimeModule[];
  private readonly surfaces: SurfaceAdapter[];
  private readonly surfaceManager: SurfaceManager;
  private readonly channelImageSpool: ChannelImageSpool;
  private readonly interactions: InteractionRouter;
  private readonly asyncQuestions: AsyncQuestionCoordinator;
  private readonly approval: ApprovalCoordinator;
  private readonly router: SessionRouter;
  private readonly threadState: ThreadStateSynchronizer;
  private readonly core: ConversationCore;
  private readonly conversations: ConversationService;
  readonly refreshProviderModels: () => void;
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
  private readonly workspacePermissions: TomlWorkspacePermissionWriter | undefined;
  private readonly subagentCompletion: SubagentCompletionTracker;
  private readonly scheduledTasks: ScheduledTaskComposition | undefined;
  private bindingRestore: BindingRestoreCoordinator | undefined;
  private removeRpcNotification: (() => void) | undefined;
  private removeRpcDisconnect: (() => void) | undefined;
  private shutdownTask: Promise<void> | undefined;
  private resetCredits: OpenAiResetCreditService | undefined;
  private accountWarmupTask: Promise<void> | undefined;
  private reconnectCoordinator: GatewayReconnectCoordinator | undefined;
  private readonly queueLifecycleTasks = new Set<Promise<void>>();
  private codexUpstreamUserAgent: string | undefined;
  private openAiConnectivity: OpenAiConnectivityStatus | "recovering" = "not-applicable";
  private startupNetworkRecovery: StartupNetworkRecovery | undefined;
  private openAiConnectivityAbort: AbortController | undefined;
  private startupAbort: AbortController | undefined;
  private stopping = false;

  protected abstract requestStop(): Promise<void>;

  constructor(
    private config: GatewayConfig,
    private readonly logger: Logger,
    surfacePlugins: readonly BuiltInSurfacePlugin[],
    configPath?: string,
  ) {
    logger = logger.child({ module: "gateway" });
    this.logger = logger;
    verifyCodexVersion(config);
    this.workspacePermissions = configPath === undefined
      ? undefined
      : new TomlWorkspacePermissionWriter(configPath);
    const primaryProvider = loadPrimaryModelProvider();
    const customPrimaryProvider = loadConfiguredCustomPrimaryModelProvider();
    const customSwitchingProviders = loadConfiguredCustomSwitchingModelProviders();
    const managedProviders = loadManagedModelProviders();
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
    const readSupplementaryModels = () => {
      const managedDefaults = loadManagedModelProviderSettings();
      return providerDefinitions.flatMap((definition) =>
        loadManagedModelOptions(
          managedProviderDirectory(process.env, definition),
          configuredProviders.has(definition.id),
          definition,
        ).map((model) => ({
          ...model,
          isDefault: model.model === managedDefaults.find((entry) => entry.provider === definition.id)?.model,
        })));
    };
    const supplementaryModels = readSupplementaryModels();
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
      primaryProvider === "openai" ? { upload: createProxyFetch(config.networkProxy) } : undefined,
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
    this.inbound = new EventBus<RpcNotification>(logger.child({ module: "inbound" }), 2_000, undefined, {
      entries: 4_096,
      bytes: 32 * 1024 * 1024,
      size: (event) => Buffer.byteLength(JSON.stringify(event)),
      overflow: () => {
        logger.error("协议通知消费预算耗尽，停止 Gateway 消费；尚未持久接收的通知存在缺口");
        void this.requestStop().catch(() => logger.error("协议通知超载后的 Gateway 清理失败"));
      },
    });
    this.output = new EventBus<OutputEvent>(logger.child({ module: "output" }), 1_000, new SurfaceOutputCoalescer().key, {
      entries: 2_048,
      bytes: 32 * 1024 * 1024,
      size: (event) => Buffer.byteLength(JSON.stringify(event)),
      overflow: () => {
        logger.error("共享输出预算耗尽，停止 Gateway 消费；已持久接收记录保留，未接收区间存在缺口");
        void this.requestStop().catch(() => logger.error("共享输出超载后的 Gateway 清理失败"));
      },
    });
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
        this.asyncQuestions?.cancelStale();
        this.approval?.cancelStale();
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
    this.metricsEvents = configPath === undefined ? undefined : new QueueEventsServer(metricsEventsPath(configPath));
    this.accountSnapshotEvents = configPath === undefined ? undefined : new QueueEventsServer(accountSnapshotEventsPath(configPath));
    this.turnExecution = new TurnExecutionTracker(this.codex, metricsStore,
      () => this.metricsEvents?.changed(),
      (error, threadId) => logger.warn({ module: "metrics", event: "turn_timing.sync_failed", err: error, threadId }, "轮次耗时记录或同步失败"));
    const metricsWriter = new BufferedModelRequestMetricsWriter(
      metricsStore,
      (error) => logger.error({ module: "metrics", event: "request_metrics.write_failed", err: error }, "模型请求指标后台写入失败"),
      () => this.metricsEvents?.changed(),
    );
    this.relayMetrics = configPath === undefined ? undefined : new RelayMetricsComposition({
      path: modelRelayPaths(configPath).metrics,
      writer: metricsWriter,
      authorize: createRelayMetricAuthorization(configPath),
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
      this.subagentCompletion.handle(event);
    });
    this.interactions = new InteractionRouter(logger);
    const models = new ModelSelectionService(
      this.codex,
      this.router,
      config.codexModel,
      supplementaryModels,
      customPrimaryProvider?.id ?? primaryProvider,
      customSwitchingProviders.filter((provider) => provider.catalogSource.kind === "official").map((provider) => ({
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
      defaultThirdPartyProvider,
      customSwitchingProviders.filter((provider) => provider.catalogSource.kind === "custom").map((provider) => ({
        provider: provider.provider,
        displayName: provider.name,
        defaultModel: provider.model,
      })),
    );
    this.refreshProviderModels = () => models.updateSupplementaryModels(readSupplementaryModels());
    const collaborationModes = new CollaborationModeSelectionService(
      this.codex,
      this.router,
      models,
    );
    this.resetCredits = new OpenAiResetCreditService(this.codex, signal => this.providerAccounts!.accountLimits("openai", signal, { refreshLogin: false }));
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
        metricsStore.upsertAccountSnapshot({
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
      execution,
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
          turns: execution,
          acceptsExecution: (target) => this.surfaceManager.acceptsExecution(target),
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
    const channelResetCredits = new ConversationResetCreditService(this.resetCredits, (target, actorId) => {
      this.requireRunning();
      if (!this.accessPolicy(target)?.isAllowed({ target, actorId }) || !this.bindings.actors(target).includes(actorId)) {
        throw new UserFacingError("reset-credit.failed", "当前用户未获授权", { reason: "forbidden" });
      }
      const status = service.status(target);
      const workspace = this.workspaces.require(status.workspaceId);
      return JSON.stringify([workspace.id, workspace.cwd, status.threadId]);
    });
    const commands = new ConversationCommandService(service, scheduledTaskUseCases, channelResetCredits);
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
    }, surfacePlugins);
    this.surfaces = this.surfaceModules.map((module) => module.adapter);
    this.surfaceManager = new SurfaceManager(
      this.surfaces,
      this.output,
      logger.child({ module: "delivery" }),
      (target) => service.status(target, { includeGitBranch: true }).gitBranch,
      {
        persistence: {
          directory: join(dirname(config.stateDatabasePath), "delivery-outbox"),
          workerUrl: new URL(import.meta.url.endsWith(".ts") ? "../../dist/delivery/worker.js" : "../delivery/worker.js", import.meta.url),
          owner: (event) => this.outputOwner(event),
          authorized: (event, owner) => this.outputAuthorized(event, owner),
          fault: (code, account, persistentDeliveryId) => {
            logger.error({ code, account, persistentDeliveryId }, "可靠输出未确认或无法持久接收；已接收结果保留，请检查投递箱");
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
        completionTiming: async (threadId, turnId, current) => {
          const persisted = await metricsWriter.waitForCurrentWrites(threadId, turnId);
          if (!persisted) return current;
          const summary = metricsStore.threadTurnSummary(threadId, turnId);
          return mergeCompletionTiming(summary, turnId, current);
        },
        executionTiming: (threadId, turnId) => {
          const sessionTiming = metricsStore.sessionExecutionTiming(threadId, turnId);
          return {
            durationMs: metricsStore.turnExecutionDuration(threadId, turnId),
            sessionDurationMs: sessionTiming.historyComplete && sessionTiming.missingTurnCount === 0
              ? sessionTiming.knownDurationMs : null,
            sessionTiming,
          };
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
            responseUsage: summary.responseUsage ?? null,
            requestOutcomes: summary.requestOutcomes,
            interruptionSummary: summary.interruptionSummary,
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
            responseUsage: aggregate.responseUsage ?? null,
            requestOutcomes: aggregate.requestOutcomes,
            interruptionSummary: aggregate.interruptionSummary,
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
      this.interactions.register(surface.surface, surface.accountId, new PersistentInteractionPort(surface.interactions,
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
      submit: (target, threadId, text, isCurrent) => service.submitAsyncAnswer(target, threadId, text, isCurrent),
      warn: (event, message) => this.output.publish({
        type: "warning", target: event.target, threadId: event.threadId, message,
      }, true),
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
      reduce: (event) => this.core.handle(event),
      isBackgroundThread: (threadId) => this.router.isBackgroundThread(threadId),
      retryBackgroundRelease: (threadId, trigger) => {
        void this.trackQueueLifecycleTask(() => service.retryPendingBackgroundRelease(threadId))
          .catch((error) => {
            this.logger.warn({ err: error, threadId }, trigger === "thread-idle"
              ? "后台 Thread 空闲状态后的订阅清理失败，已保留绑定供后续重试"
              : "子代理终态后的后台 Thread 订阅清理失败，已保留绑定供后续重试");
          });
      },
    });
    this.inbound.subscribe("conversation-core", (notification) => {
      const queueChanged = toThreadQueueChangedEvent(notification);
      if (queueChanged) {
        conversationEvents.queueChanged(queueChanged.threadId);
      }
      const coreEvent = toConversationInputEvent(notification);
      if (coreEvent) {
        if (coreEvent.type === "turn.completed" || coreEvent.type === "thread.reverted") {
          const timingProvider = this.codex.knownProvider(coreEvent.threadId);
          if (timingProvider) this.turnExecution.handle(coreEvent, timingProvider);
        }
        this.asyncQuestions.handleInput(coreEvent);
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
      handleApprovalServerRequest(request, this.approval, approval => this.codex.fileApprovalChanges(approval));
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

  private bindingRestoreCoordinator(): BindingRestoreCoordinator {
    this.bindingRestore ??= new BindingRestoreCoordinator({
      restored: (threadId) => {
        const provider = this.codex.knownProvider(threadId);
        if (provider) this.turnExecution.synchronize(threadId, provider);
      },
      codex: this.codex,
      router: this.router,
      output: this.output,
      enabledSurfaces: () => this.surfaces,
      scheduledRecovery: () => this.scheduledTasks?.coordinator,
      markTurnStarted: (target, threadId, turnId) => {
        this.core.markTurnStarted(target, threadId, turnId);
      },
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
        addedWorkspaces,
      });
    }
    return result;
  }

  hasActiveTurns(): boolean {
    return this.core.hasActiveTurns();
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
      await this.surfaceManager.preparePersistence();
      this.requireRunning();
      await this.providerMetrics.start();
      await this.metricsEvents?.start();
      await this.accountSnapshotEvents?.start();
      // IPC lifetime follows the writer, not the HTTP admission switch. It must
      // already exist for first enablement and drain terminal metrics on disable.
      await this.relayMetrics?.apply(true);
      this.requireRunning();
      this.removeRpcNotification = this.codex.onNotification((notification) => {
        this.inbound.publish(notification, isCriticalNotification(notification.method));
      });
      this.removeRpcDisconnect = this.codex.onDisconnect((error, provider) => {
        this.turnExecution.reset(provider);
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
    this.surfaceManager.beginShutdown?.();
    this.startupAbort?.abort();
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
    return JSON.stringify(this.outputIdentity(event));
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
      : undefined;
  }

  private shutdownComponents(): Promise<void> {
    this.shutdownTask ??= this.shutdownComponentsOnce();
    return this.shutdownTask;
  }

  private async shutdownComponentsOnce(): Promise<void> {
    this.stopping = true;
    this.surfaceManager.beginShutdown?.();
    this.startupAbort?.abort();
    const restoringBindings = this.bindingRestoreCoordinator().close();
    this.openAiConnectivityAbort?.abort();
    this.openAiConnectivityAbort = undefined;
    this.removeRpcNotification?.();
    this.removeRpcNotification = undefined;
    this.removeRpcDisconnect?.();
    this.removeRpcDisconnect = undefined;
    const failures: unknown[] = [];
    for (const [component, close] of [
      ["Startup Network Recovery", () => this.startupNetworkRecovery?.stop()],
      ["Scheduled Task Scheduler", () => this.scheduledTasks?.stop()],
      ["Queue Lifecycle", () => this.closeQueueLifecycleTasks()],
      ["Channel Image Spool", () => this.channelImageSpool.stop()],
      ["Provider Idle Releaser", () => this.providerIdleReleaser?.stop()],
      ["Conversation Idle Releaser", () => this.conversationIdleReleaser?.stop()],
      ["Luna Reserve", () => this.conversations?.closeLunaReserve()],
      ["Async Questions", () => this.asyncQuestions.close()],
      // Keep synchronous durable admission alive until every accepted inbound
      // notification has been reduced. Closing Surface first loses this tail.
      ["Inbound Event Bus", () => this.inbound.close({ requireDrained: true })],
      ["Derived Output Inputs", () => this.output.drain()],
      ["Turn Execution Metrics", () => this.turnExecution.stop()],
      ["Subagent Terminals", () => this.subagentCompletion?.drain()],
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
