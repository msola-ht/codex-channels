import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

import type { Logger } from "pino";

import { ApprovalCoordinator, InteractionRouter } from "../approval/index.js";
import {
  CodexAppServerClient,
  JsonRpcClient,
  UnixWebSocketTransport,
  type RpcNotification,
} from "../codex-client/index.js";
import { protocolVersion } from "../codex-protocol/index.js";
import type { GatewayConfig } from "../config/index.js";
import { ConversationService, ModelSelectionService } from "../application/index.js";
import {
  ConversationCore,
  surfaceAccountKey,
  type OutputEvent,
} from "../conversation-core/index.js";
import { EventBus } from "../event-bus/index.js";
import { TelegramAccessPolicy, WorkspaceRegistry } from "../policy/index.js";
import { SessionRouter } from "../session-routing/index.js";
import { SqliteBindingStore, type BindingStore } from "../storage/index.js";
import {
  TelegramSurface,
  telegramDefaultAccountId,
  type SurfaceAdapter,
} from "../surfaces/index.js";
import { SurfaceManager } from "./surface-manager.js";

export class GatewayApplication {
  private readonly transport: UnixWebSocketTransport;
  private readonly rpc: JsonRpcClient;
  private readonly codex: CodexAppServerClient;
  private readonly inbound: EventBus<RpcNotification>;
  private readonly output: EventBus<OutputEvent>;
  private readonly telegram: TelegramSurface;
  private readonly surfaces: SurfaceAdapter[];
  private readonly surfaceManager: SurfaceManager;
  private readonly interactions: InteractionRouter;
  private readonly approval: ApprovalCoordinator;
  private readonly router: SessionRouter;
  private readonly core: ConversationCore;
  private readonly bindings: SqliteBindingStore;
  private readonly workspaces: WorkspaceRegistry;
  private readonly access: TelegramAccessPolicy;
  private removeRpcNotification: (() => void) | undefined;
  private removeRpcDisconnect: (() => void) | undefined;
  private startTask: Promise<void> | undefined;
  private stopTask: Promise<void> | undefined;
  private startupSettled = false;
  private reconnecting: Promise<void> | undefined;
  private reconnectAbort: AbortController | undefined;
  private codexUpstreamUserAgent: string | undefined;
  private stopping = false;

  constructor(
    private config: GatewayConfig,
    private readonly logger: Logger,
  ) {
    verifyCodexVersion(config);
    this.transport = new UnixWebSocketTransport(config.codexSocketPath);
    this.rpc = new JsonRpcClient(this.transport, 60_000, logger);
    this.codex = new CodexAppServerClient(this.rpc, {
      sandbox: config.codexSandbox,
      ...(config.codexModel ? { model: config.codexModel } : {}),
    });
    this.inbound = new EventBus<RpcNotification>(logger, 2_000);
    this.output = new EventBus<OutputEvent>(logger, 1_000);
    this.bindings = new SqliteBindingStore(config.stateDatabasePath);
    const removedBindings = removeUnauthorizedTelegramBindings(this.bindings, config.telegramAllowedUserIds);
    if (removedBindings > 0) {
      logger.warn({ removedBindings }, "已清理不再授权的 Telegram 会话绑定");
    }
    this.workspaces = new WorkspaceRegistry(config.workspaces, config.defaultWorkspaceId);
    this.access = new TelegramAccessPolicy(
      config.telegramAllowedUserIds,
      telegramDefaultAccountId,
    );
    this.router = new SessionRouter(
      this.codex,
      this.bindings,
      this.workspaces,
    );
    this.core = new ConversationCore(this.router, this.output);
    const models = new ModelSelectionService(this.codex, this.router, config.codexModel);
    const service = new ConversationService(this.codex, this.router, this.core, models);
    this.telegram = new TelegramSurface(
      config.telegramBotToken,
      config.telegramProxyUrl,
      service,
      this.output,
      this.access,
      config.telegramAllowedUserIds,
      config.workspaces,
      join(dirname(config.stateDatabasePath), "uploads"),
      logger,
      {
        actorRegistry: this.bindings,
        onFatal: (error) => this.handleTelegramFatal(error),
        finalMessageFormat: config.telegramMessageFormat,
        codexUpstreamUserAgent: () => this.codexUpstreamUserAgent,
      },
    );
    this.surfaces = [this.telegram];
    this.surfaceManager = new SurfaceManager(this.surfaces, logger);
    this.interactions = new InteractionRouter();
    for (const surface of this.surfaces) {
      this.interactions.register(surface.surface, surface.accountId, surface.interactions);
    }
    this.approval = new ApprovalCoordinator(this.router, this.interactions, config.approvalTimeoutMs);
    this.inbound.subscribe("conversation-core", (notification) => {
      this.core.handle(notification);
      if (notification.method === "thread/settings/updated") {
        const params = asRecord(notification.params);
        const settings = asRecord(params?.threadSettings);
        const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
        const model = typeof settings?.model === "string" ? settings.model : undefined;
        const effort = typeof settings?.effort === "string" || settings?.effort === null
          ? settings.effort
          : undefined;
        const serviceTier = typeof settings?.serviceTier === "string" || settings?.serviceTier === null
          ? settings.serviceTier
          : undefined;
        if (threadId && model && effort !== undefined && serviceTier !== undefined) {
          this.router.updateModelSettings(threadId, { model, effort, serviceTier });
        }
      }
      if (isThreadUnavailable(notification.method)) {
        const params = asRecord(notification.params);
        const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
        if (threadId) {
          this.router.forgetThread(threadId);
        }
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
    this.codex.setServerRequestHandler((request) => this.approval.handle(request));
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
      this.removeRpcNotification = this.codex.onNotification((notification) => {
        this.inbound.publish(notification, isCriticalNotification(notification.method));
      });
      this.removeRpcDisconnect = this.codex.onDisconnect((error) => {
        if (this.stopping || this.reconnecting) {
          return;
        }
        this.logger.warn({ err: error }, "Codex App Server 连接已断开");
        this.interactions.cancelAll("Codex App Server 连接已断开");
        this.core.connectionLost("Codex App Server 连接已断开，正在恢复连接");
        this.beginReconnect();
      });
      const initialized = await this.codex.connect();
      this.requireRunning();
      this.codexUpstreamUserAgent = initialized.userAgent;
      await this.refreshRateLimits();
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

  private async shutdownComponents(): Promise<void> {
    this.removeRpcNotification?.();
    this.removeRpcNotification = undefined;
    this.removeRpcDisconnect?.();
    this.removeRpcDisconnect = undefined;
    const failures: unknown[] = [];
    for (const [component, close] of [
      ["Surface", () => this.surfaceManager.stop()],
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
      const currentRecipients = this.config.telegramAllowedUserIds;
      this.telegram.replaceNotificationRecipients(
        intersectNumberSets(
          currentRecipients,
          next.telegramAllowedUserIds,
        ),
      );
      this.surfaceManager.configurationChanged({
        action: "restarting",
        changes: result.changes,
        addedWorkspaces: [],
      });
      this.telegram.replaceNotificationRecipients(currentRecipients);
      return result;
    }

    const addedWorkspaces = immediateAddedWorkspaceNotifications(
      this.config.workspaces,
      next.workspaces,
      result.changes,
      pendingAddedWorkspaces,
    );
    if (result.changes.includes("Workspace")) {
      this.workspaces.replace(next.workspaces, next.defaultWorkspaceId);
    }
    if (result.changes.includes("Telegram 允许用户")) {
      this.access.replace(next.telegramAllowedUserIds);
      this.telegram.replaceNotificationRecipients(next.telegramAllowedUserIds);
    }
    this.config = next;
    const nonWorkspaceChanges = result.changes.filter((change) => change !== "Workspace");
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
      changes: ["Workspace"],
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
      });
    this.reconnecting = task;
  }

  private async reconnect(signal: AbortSignal): Promise<void> {
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
        const initialized = await this.codex.reconnect();
        if (this.stopping || signal.aborted) {
          await this.codex.close();
          return;
        }
        this.codexUpstreamUserAgent = initialized.userAgent;
        await this.refreshRateLimits();
        if (this.stopping || signal.aborted) {
          await this.codex.close();
          return;
        }
        if (!(await this.restoreBindings())) {
          await this.codex.close();
          throw new Error("仍有 Codex Thread 订阅暂时无法恢复");
        }
        if (this.stopping || signal.aborted) {
          await this.codex.close();
          return;
        }
        this.logger.info(
          { attempt, platformFamily: initialized.platformFamily, platformOs: initialized.platformOs },
          "Codex App Server 已重新连接",
        );
        return;
      } catch (error) {
        if (this.stopping || signal.aborted) {
          return;
        }
        this.logger.warn({ err: error, attempt, maximumAttempts }, "Codex App Server 重连失败");
      }
    }
    if (!this.stopping && !signal.aborted) {
      throw new Error(`Codex App Server 重连 ${maximumAttempts} 次后仍然失败`);
    }
  }

  private requireRunning(): void {
    if (this.stopping) {
      throw new Error("Gateway 正在停止");
    }
  }

  private handleTelegramFatal(error: Error): void {
    if (this.stopping) {
      return;
    }
    this.logger.fatal({ err: error }, "Telegram 连接重试耗尽，Gateway 将停止以交由进程管理器重启");
    process.exitCode = 1;
    void this.stop().catch((stopError) => {
      this.logger.error({ err: stopError }, "Telegram 故障后停止 Gateway 失败");
      process.exitCode = 1;
    });
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
      const configured = Object.values(result.rateLimitsByLimitId ?? {}).filter(
        (snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== undefined,
      );
      this.core.rememberRateLimits([result.rateLimits, ...configured]);
    } catch (error) {
      this.logger.warn({ err: error }, "读取 Codex 周限失败，启动通知暂不显示周限");
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async restoreBindings(): Promise<boolean> {
    const enabledSurfaces = new Set(
      this.surfaces.map((surface) => surfaceAccountKey(surface.surface, surface.accountId)),
    );
    const failures = await this.router.restoreSubscriptions(
      (target) => !this.stopping
        && enabledSurfaces.has(surfaceAccountKey(target.surface, target.accountId)),
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

export type ConfigReloadResult =
  | { action: "reload"; changes: string[] }
  | { action: "restart"; changes: string[] }
  | { action: "reinstall"; changes: string[] };

export function classifyConfigReload(current: GatewayConfig, next: GatewayConfig): ConfigReloadResult {
  const reinstallReasons = serviceReinstallReasons(current, next);
  const restartReasons = restartRequiredReasons(current, next);
  const reloadReasons = hotReloadReasons(current, next);
  if (reinstallReasons.length > 0) {
    return {
      action: "reinstall",
      changes: [...reinstallReasons, ...restartReasons, ...reloadReasons],
    };
  }
  if (restartReasons.length > 0) {
    return {
      action: "restart",
      changes: [...restartReasons, ...reloadReasons],
    };
  }
  return { action: "reload", changes: reloadReasons };
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
  changes: readonly string[],
  pending: ReadonlyArray<GatewayConfig["workspaces"][number]>,
): GatewayConfig["workspaces"] {
  const pendingIds = new Set(pending.map((workspace) => workspace.id));
  return (
    changes.includes("Workspace") ? findAddedWorkspaces(current, next) : []
  ).filter(
    (workspace) => !pendingIds.has(workspace.id),
  );
}

function intersectNumberSets(
  left: ReadonlySet<number>,
  right: ReadonlySet<number>,
): ReadonlySet<number> {
  return new Set([...left].filter((value) => right.has(value)));
}

function serviceReinstallReasons(current: GatewayConfig, next: GatewayConfig): string[] {
  const reasons: string[] = [];
  if (current.codexBinary !== next.codexBinary) {
    reasons.push("Codex Binary");
  }
  if (current.codexSocketPath !== next.codexSocketPath) {
    reasons.push("Codex Socket");
  }
  return reasons;
}

function restartRequiredReasons(current: GatewayConfig, next: GatewayConfig): string[] {
  const reasons: string[] = [];
  const fields: Array<[string, unknown, unknown]> = [
    ["Telegram Bot Token", current.telegramBotToken, next.telegramBotToken],
    ["Telegram 代理", current.telegramProxyUrl, next.telegramProxyUrl],
    ["Telegram 消息格式", current.telegramMessageFormat, next.telegramMessageFormat],
    ["默认模型", current.codexModel, next.codexModel],
    ["Sandbox", current.codexSandbox, next.codexSandbox],
    ["State Database", current.stateDatabasePath, next.stateDatabasePath],
    ["审批超时", current.approvalTimeoutMs, next.approvalTimeoutMs],
    ["日志级别", current.logLevel, next.logLevel],
    ["默认 Workspace", current.defaultWorkspaceId, next.defaultWorkspaceId],
  ];
  for (const [label, before, after] of fields) {
    if (before !== after) {
      reasons.push(label);
    }
  }
  if (!preservesExistingWorkspaces(current.workspaces, next.workspaces)) {
    reasons.push("已有 Workspace");
  }
  if (![...current.telegramAllowedUserIds].every((userId) => next.telegramAllowedUserIds.has(userId))) {
    reasons.push("Telegram 用户撤权");
  }
  return reasons;
}

function hotReloadReasons(current: GatewayConfig, next: GatewayConfig): string[] {
  const reasons: string[] = [];
  if (
    preservesExistingWorkspaces(current.workspaces, next.workspaces)
    && !sameWorkspaces(current.workspaces, next.workspaces)
  ) {
    reasons.push("Workspace");
  }
  if (
    [...current.telegramAllowedUserIds].every((userId) => next.telegramAllowedUserIds.has(userId))
    && !sameNumberSet(current.telegramAllowedUserIds, next.telegramAllowedUserIds)
  ) {
    reasons.push("Telegram 允许用户");
  }
  return reasons;
}

export function removeUnauthorizedTelegramBindings(
  bindings: BindingStore,
  allowedUserIds: ReadonlySet<number>,
  accountId = telegramDefaultAccountId,
): number {
  let removed = 0;
  for (const binding of bindings.list()) {
    if (binding.target.surface !== "telegram" || binding.target.accountId !== accountId) {
      continue;
    }
    let knownActors = bindings.actors(binding.target);
    if (knownActors.length === 0) {
      const legacyActorId = legacyTelegramPrivateActorId(binding.target.conversationId);
      if (legacyActorId !== undefined && allowedUserIds.has(legacyActorId)) {
        bindings.rememberActor(binding.target, String(legacyActorId));
        knownActors = [String(legacyActorId)];
      }
    }
    const allowedActors = new Set(knownActors.filter((actorId) => {
      const userId = Number(actorId);
      return Number.isSafeInteger(userId) && allowedUserIds.has(userId);
    }));
    if (bindings.retainActors(binding.target, allowedActors)) {
      removed += 1;
    }
  }
  return removed;
}

function legacyTelegramPrivateActorId(conversationId: string): number | undefined {
  const userId = Number(conversationId);
  return Number.isSafeInteger(userId) && userId > 0 && String(userId) === conversationId
    ? userId
    : undefined;
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

function preservesExistingWorkspaces(
  current: GatewayConfig["workspaces"],
  next: GatewayConfig["workspaces"],
): boolean {
  const byId = new Map(next.map((workspace) => [workspace.id, workspace]));
  return current.every((workspace) => {
    const candidate = byId.get(workspace.id);
    return candidate?.name === workspace.name && candidate.cwd === workspace.cwd;
  });
}

function sameWorkspaces(current: GatewayConfig["workspaces"], next: GatewayConfig["workspaces"]): boolean {
  return current.length === next.length && current.every((workspace, index) => {
    const candidate = next[index];
    return candidate?.id === workspace.id
      && candidate.name === workspace.name
      && candidate.cwd === workspace.cwd;
  });
}

function sameNumberSet(current: ReadonlySet<number>, next: ReadonlySet<number>): boolean {
  return current.size === next.size && [...current].every((value) => next.has(value));
}

function verifyCodexVersion(config: GatewayConfig): void {
  const actual = execFileSync(effectiveCodexBinary(config.codexBinary), ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (actual !== protocolVersion.codexCli) {
    throw new Error(`Codex 版本不受支持：当前 ${actual}，协议基线 ${protocolVersion.codexCli}`);
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

function isThreadUnavailable(method: string): boolean {
  return method === "thread/closed" || method === "thread/archived" || method === "thread/deleted";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}
