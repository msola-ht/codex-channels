import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

import type { Logger } from "pino";

import {
  checkProjectRulesAtRoot,
  initializeProjectRulesAtRoot,
} from "../../runtime/project-rules.mjs";
import {
  deepseekProviderDefinition,
} from "../../runtime/model-provider-definitions.mjs";
import {
  loadManagedModelProvider,
  loadPrimaryModelProvider,
  providerAppServerSocketPath,
  providerMetricsSocketPath,
} from "../../runtime/model-provider-runtime.mjs";
import { readApiProviderKey } from "../../runtime/api-provider-credential.mjs";
import { ApprovalCoordinator, InteractionRouter } from "../approval/index.js";
import {
  CodexAppServerClient,
  ProviderRoutingClient,
  gatewayVersion,
  handleApprovalServerRequest,
  loadDeepseekModelOptions,
  JsonRpcClient,
  supportedCodexCliVersion,
  toConversationInputEvent,
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
} from "../application/index.js";
import {
  ConversationCore,
  surfaceAccountKey,
  type OutputEvent,
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
import { SqliteBindingStore } from "../storage/index.js";
import type { SurfaceAdapter } from "../surfaces/index.js";
import {
  createSurfaceModules,
} from "./surface-composition.js";
import type { SurfaceRuntimeModule } from "./surface-plugin.js";
import { SurfaceManager } from "./surface-manager.js";
import { createDeepseekAccountAdapter } from "./deepseek-account-adapter.js";
import { createProxyFetch } from "./proxy-fetch.js";
import { createResponsesVisionAdapter } from "./responses-vision-adapter.js";
import { ProviderMetricsComposition } from "./provider-metrics-composition.js";
import { RemoteModelPricingCatalog } from "./model-pricing-catalog.js";
import { mergeSessionReferenceCost } from "./reference-cost-summary.js";

export class GatewayApplication {
  private readonly transport: UnixWebSocketTransport;
  private readonly codex: ProviderRoutingClient;
  private readonly primaryProvider: string;
  private readonly inbound: EventBus<RpcNotification>;
  private readonly output: EventBus<OutputEvent>;
  private readonly surfaceModules: SurfaceRuntimeModule[];
  private readonly surfaces: SurfaceAdapter[];
  private readonly surfaceManager: SurfaceManager;
  private readonly interactions: InteractionRouter;
  private readonly approval: ApprovalCoordinator;
  private readonly router: SessionRouter;
  private readonly threadState: ThreadStateSynchronizer;
  private readonly core: ConversationCore;
  private readonly providerMetrics: ProviderMetricsComposition;
  private readonly modelPricing: RemoteModelPricingCatalog;
  private readonly bindings: SqliteBindingStore;
  private readonly workspaces: WorkspaceRegistry;
  private removeRpcNotification: (() => void) | undefined;
  private removeRpcDisconnect: (() => void) | undefined;
  private startTask: Promise<void> | undefined;
  private stopTask: Promise<void> | undefined;
  private shutdownTask: Promise<void> | undefined;
  private startupSettled = false;
  private reconnecting: Promise<void> | undefined;
  private reconnectAbort: AbortController | undefined;
  private readonly disconnectedProviders = new Set<string>();
  private codexUpstreamUserAgent: string | undefined;
  private stopping = false;

  constructor(
    private config: GatewayConfig,
    private readonly logger: Logger,
  ) {
    verifyCodexVersion(config);
    const primaryProvider = loadPrimaryModelProvider();
    const managedProvider = loadManagedModelProvider();
    const supplementaryModels = loadDeepseekModelOptions(
      process.env,
      primaryProvider === deepseekProviderDefinition.id
        || managedProvider?.provider === deepseekProviderDefinition.id,
      deepseekProviderDefinition,
    );
    this.transport = new UnixWebSocketTransport(config.codexSocketPath);
    this.primaryProvider = primaryProvider;
    const clients = new Map<string, CodexAppServerClient>();
    clients.set(primaryProvider, new CodexAppServerClient(
      new JsonRpcClient(this.transport, 60_000, logger),
      {
      sandbox: config.codexSandbox,
      ...(config.codexModel ? { model: config.codexModel } : {}),
      },
    ));
    if (managedProvider) {
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
    this.codex = new ProviderRoutingClient(primaryProvider, clients);
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
    );
    const metricsWriter = new BufferedModelRequestMetricsWriter(
      metricsStore,
      (error) => logger.warn({ err: error }, "模型请求指标后台写入失败"),
    );
    this.modelPricing = new RemoteModelPricingCatalog({
      cachePath: join(dirname(config.stateDatabasePath), "model-pricing.json"),
      fetchImpl: createProxyFetch(config.networkProxy),
      logger,
    });
    this.providerMetrics = new ProviderMetricsComposition({
      providers: [
        primaryProvider,
        ...(managedProvider ? [managedProvider.provider] : []),
      ],
      socketPath: (provider) =>
        providerMetricsSocketPath(config.codexSocketPath, provider),
      writer: metricsWriter,
      pricingResolver: this.modelPricing,
      onModelTiming: (event) => this.core.handle(event),
      logger,
    });
    this.interactions = new InteractionRouter(logger);
    const models = new ModelSelectionService(
      this.codex,
      this.router,
      config.codexModel,
      supplementaryModels,
    );
    const collaborationModes = new CollaborationModeSelectionService(
      this.codex,
      this.router,
      models,
    );
    const providerAccounts = new ProviderAccountService([
      createOpenAiAccountAdapter(this.codex),
      createDeepseekAccountAdapter({
        fetchImpl: createProxyFetch(config.networkProxy),
      }),
    ]);
    const visionConfig = config.vision;
    const visionProviderName = visionConfig.mode === "disabled"
      ? undefined
      : config.apiProviders.find(
          (candidate) => candidate.id === visionConfig.provider,
        )?.name;
    const vision = visionConfig.mode === "disabled"
      ? undefined
      : createResponsesVisionAdapter({
          provider: visionConfig.provider,
          ...(visionProviderName === undefined
            ? {}
            : { providerName: visionProviderName }),
          endpoint: visionConfig.endpoint,
          model: visionConfig.model,
          loadApiKey: () => readApiProviderKey(
            config.credentialsDirectory,
            visionConfig.provider,
          ),
          fetchImpl: createProxyFetch(config.networkProxy),
          onMetric: (metric) => {
            try {
              const pricing = this.modelPricing.resolve({
                provider: metric.provider,
                model: metric.model,
                serviceTier: metric.serviceTier,
                inputTokens: metric.inputTokens,
                atMs: metric.responseCompletedAtMs,
              });
              metricsWriter.enqueue({ ...metric, pricing });
            } catch (error) {
              logger.warn({ err: error }, "视觉 API 指标持久化失败");
            }
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
      providerAccounts,
      vision,
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
                  uncachedInputPricePerMillionNanos:
                    direct.pricing?.uncachedInputPricePerMillionNanos ?? null,
                  cachedInputPricePerMillionNanos:
                    direct.pricing?.cachedInputPricePerMillionNanos ?? null,
                  outputPricePerMillionNanos:
                    direct.pricing?.outputPricePerMillionNanos ?? null,
                },
          };
        },
        aggregate: (view, range) => {
          const endAtMs = Date.now();
          const rangeMs = {
            "24h": 24 * 60 * 60 * 1_000,
            "7d": 7 * 24 * 60 * 60 * 1_000,
            "30d": 30 * 24 * 60 * 60 * 1_000,
          }[range];
          const report = metricsStore.aggregate({
            dimension: view === "providers"
              ? "provider"
              : view === "models"
                ? "model"
                : "global",
            startAtMs: endAtMs - rangeMs,
            endAtMs,
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
        errors: (range) => {
          const endAtMs = Date.now();
          const rangeMs = {
            "24h": 24 * 60 * 60 * 1_000,
            "7d": 7 * 24 * 60 * 60 * 1_000,
            "30d": 30 * 24 * 60 * 60 * 1_000,
          }[range];
          const report = metricsStore.errors({
            startAtMs: endAtMs - rangeMs,
            endAtMs,
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
                requestCount: group.requestCount,
                lastOccurredAtMs: group.lastOccurredAtMs,
              };
            }),
            totalGroupCount: report.totalGroupCount,
          };
        },
      },
    );
    this.output.subscribe("conversation-follow-up", async (event) => {
      if (event.type !== "turn.completed") {
        return;
      }
      if (this.router.isBackgroundThread(event.threadId)) {
        try {
          await this.router.releaseBackground(event.threadId);
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
        return;
      }
      try {
        await service.handleTurnCompleted(
          event.target,
          event.threadId,
        );
      } catch (error) {
        this.logger.warn(
          {
            err: error,
            surface: event.target.surface,
            accountId: event.target.accountId,
            conversationId: event.target.conversationId,
            threadId: event.threadId,
          },
          "下一 Turn 排队消息启动失败，队列已清空",
        );
        this.output.publish({
          type: "warning",
          target: event.target,
          threadId: event.threadId,
          message: "下一 Turn 排队消息未能启动，队列已清空。",
        }, true);
      }
    });
    this.surfaceModules = createSurfaceModules({
      config,
      service,
      bindings: this.bindings,
      logger,
      gatewayVersion,
      codexUpstreamUserAgent: () => this.codexUpstreamUserAgent,
      onFatal: (surface, accountId, error) => this.handleSurfaceFatal(
        surface,
        accountId,
        error,
      ),
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
      },
    );
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
      const coreEvent = toConversationInputEvent(notification);
      if (coreEvent) {
        this.core.handle(coreEvent);
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
    const startup = this.startTask;
    const reconnecting = this.reconnecting;
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
      await this.providerMetrics.start();
      this.removeRpcNotification = this.codex.onNotification((notification) => {
        this.inbound.publish(notification, isCriticalNotification(notification.method));
      });
      this.removeRpcDisconnect = this.codex.onDisconnect((error, provider) => {
        if (this.stopping) {
          return;
        }
        this.disconnectedProviders.add(provider);
        this.logger.warn({ err: error, provider }, "Codex App Server 连接已断开");
        const affectedThreadIds = new Set(
          this.router.allBindings()
            .map((binding) => binding.threadId)
            .filter((threadId) => this.codex.knownProvider(threadId) === provider),
        );
        this.interactions.cancelThreads(affectedThreadIds);
        this.core.connectionLost(
          `${provider} App Server 连接已断开，正在恢复连接`,
          affectedThreadIds,
        );
        this.beginReconnect();
      });
      const initialized = await this.codex.connect();
      this.requireRunning();
      this.codexUpstreamUserAgent = initialized.userAgent;
      if (this.primaryProvider !== deepseekProviderDefinition.id) {
        await this.refreshRateLimits();
      }
      this.requireRunning();
      if (!(await this.restoreBindings())) {
        throw new Error("恢复 Codex Thread 订阅暂时失败，请由进程管理器重试启动");
      }
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
    const failures: unknown[] = [];
    for (const [component, close] of [
      ["Surface", () => this.surfaceManager.stop()],
      ["Provider Proxy Metrics", () => this.providerMetrics.close()],
      ["Model Pricing", () => this.modelPricing.close()],
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
        if (provider === "openai") {
          await this.refreshRateLimits();
        }
        if (this.stopping || signal.aborted) {
          return;
        }
        if (!(await this.restoreBindings(provider))) {
          await this.codex.closeProvider(provider);
          throw new Error("仍有 Codex Thread 订阅暂时无法恢复");
        }
        if (this.stopping || signal.aborted) {
          return;
        }
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

  private async restoreBindings(provider?: string): Promise<boolean> {
    const enabledSurfaces = new Set(
      this.surfaces.map((surface) => surfaceAccountKey(surface.surface, surface.accountId)),
    );
    const failures = await this.router.restoreSubscriptions(
      (target, binding) => !this.stopping
        && enabledSurfaces.has(surfaceAccountKey(target.surface, target.accountId))
        && (provider === undefined
          || this.codex.knownProvider(binding.threadId) === provider),
      (binding, thread) => {
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
    }
    if (this.router.allBindings().length > 0) {
      this.logger.info(
        { bindings: this.router.allBindings().length },
        "已恢复外部会话与 Codex Thread 绑定",
      );
    }
    return failures.every((failure) => failure.bindingRemoved);
  }
}

function isHighFrequencyNotification(method: string): boolean {
  return /\/(?:delta|outputDelta|progress)$/u.test(method);
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

export function effectiveCodexBinary(
  configuredBinary: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const installedBinary = environment.CODEX_BINARY?.trim();
  return configuredBinary === "codex" && installedBinary ? installedBinary : configuredBinary;
}

function isCriticalNotification(method: string): boolean {
  return !method.endsWith("/delta") && !method.endsWith("/outputDelta");
}
