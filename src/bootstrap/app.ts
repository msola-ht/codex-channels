import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

import type { Logger } from "pino";

import { ApprovalCoordinator } from "../approval/index.js";
import {
  CodexAppServerClient,
  JsonRpcClient,
  UnixWebSocketTransport,
  type RpcNotification,
} from "../codex-client/index.js";
import { protocolVersion } from "../codex-protocol/index.js";
import type { GatewayConfig } from "../config/index.js";
import { ConversationService, ModelSelectionService } from "../application/index.js";
import { ConversationCore, type OutputEvent } from "../conversation-core/index.js";
import { EventBus } from "../event-bus/index.js";
import { TelegramAccessPolicy, WorkspaceRegistry } from "../policy/index.js";
import { SessionRouter } from "../session-routing/index.js";
import { SqliteBindingStore, type BindingStore } from "../storage/index.js";
import { TelegramSurface } from "../surfaces/index.js";

export class GatewayApplication {
  private readonly transport: UnixWebSocketTransport;
  private readonly rpc: JsonRpcClient;
  private readonly codex: CodexAppServerClient;
  private readonly inbound: EventBus<RpcNotification>;
  private readonly output: EventBus<OutputEvent>;
  private readonly telegram: TelegramSurface;
  private readonly approval: ApprovalCoordinator;
  private readonly router: SessionRouter;
  private readonly core: ConversationCore;
  private readonly bindings: SqliteBindingStore;
  private readonly workspaces: WorkspaceRegistry;
  private readonly access: TelegramAccessPolicy;
  private removeRpcNotification: (() => void) | undefined;
  private removeRpcDisconnect: (() => void) | undefined;
  private reconnecting: Promise<void> | undefined;
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
    this.access = new TelegramAccessPolicy(config.telegramAllowedUserIds);
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
        onFatal: (error) => this.handleTelegramFatal(error),
        finalMessageFormat: config.telegramMessageFormat,
      },
    );
    this.approval = new ApprovalCoordinator(this.router, this.telegram.interactions, config.approvalTimeoutMs);
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
        if (threadId && model && effort !== undefined) {
          this.router.updateModelSettings(threadId, { model, effort });
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

  async start(): Promise<void> {
    this.removeRpcNotification = this.codex.onNotification((notification) => {
      this.inbound.publish(notification, isCriticalNotification(notification.method));
    });
    this.removeRpcDisconnect = this.codex.onDisconnect((error) => {
      if (this.stopping || this.reconnecting) {
        return;
      }
      this.logger.warn({ err: error }, "Codex App Server 连接已断开");
      this.telegram.interactions.cancelAll("Codex App Server 连接已断开");
      this.core.connectionLost("Codex App Server 连接已断开，正在恢复连接");
      this.reconnecting = this.reconnect().finally(() => {
        this.reconnecting = undefined;
      });
    });
    const initialized = await this.codex.connect();
    if (!(await this.restoreBindings())) {
      await this.codex.close();
      throw new Error("恢复 Codex Thread 订阅暂时失败，请由进程管理器重试启动");
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
    await this.telegram.start();
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.removeRpcNotification?.();
    this.removeRpcNotification = undefined;
    this.removeRpcDisconnect?.();
    this.removeRpcDisconnect = undefined;
    this.reconnecting = undefined;
    await this.telegram.stop();
    await this.inbound.close();
    await this.output.close();
    await this.codex.close();
    this.bindings.close();
  }

  reloadConfig(next: GatewayConfig): ConfigReloadResult {
    const result = classifyConfigReload(this.config, next);
    if (result.action !== "reload") {
      return result;
    }

    if (result.changes.includes("Workspace")) {
      this.workspaces.replace(next.workspaces, next.defaultWorkspaceId);
    }
    if (result.changes.includes("Telegram 允许用户")) {
      this.access.replace(next.telegramAllowedUserIds);
    }
    this.config = next;
    return result;
  }

  private async reconnect(): Promise<void> {
    const maximumAttempts = 12;
    for (let attempt = 1; attempt <= maximumAttempts && !this.stopping; attempt += 1) {
      if (attempt > 1) {
        const ceiling = Math.min(30_000, 500 * 2 ** (attempt - 2));
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.floor(ceiling / 2 + Math.random() * ceiling / 2));
          timer.unref();
        });
      }
      if (this.stopping) {
        return;
      }
      try {
        const initialized = await this.codex.reconnect();
        if (!(await this.restoreBindings())) {
          await this.codex.close();
          throw new Error("仍有 Codex Thread 订阅暂时无法恢复");
        }
        this.logger.info(
          { attempt, platformFamily: initialized.platformFamily, platformOs: initialized.platformOs },
          "Codex App Server 已重新连接",
        );
        return;
      } catch (error) {
        this.logger.warn({ err: error, attempt, maximumAttempts }, "Codex App Server 重连失败");
      }
    }
    if (!this.stopping) {
      this.logger.fatal("Codex App Server 重连次数耗尽，Gateway 将停止以交由进程管理器重启");
      this.reconnecting = undefined;
      await this.stop();
      process.exitCode = 1;
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

  private async restoreBindings(): Promise<boolean> {
    const failures = await this.router.restoreSubscriptions();
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
        "已恢复 Telegram 与 Codex Thread 绑定",
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
  if (reinstallReasons.length > 0) {
    return { action: "reinstall", changes: reinstallReasons };
  }
  const restartReasons = restartRequiredReasons(current, next);
  if (restartReasons.length > 0) {
    return { action: "restart", changes: restartReasons };
  }
  const changes: string[] = [];
  if (!sameWorkspaces(current.workspaces, next.workspaces)) {
    changes.push("Workspace");
  }
  if (!sameNumberSet(current.telegramAllowedUserIds, next.telegramAllowedUserIds)) {
    changes.push("Telegram 允许用户");
  }
  return { action: "reload", changes };
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

export function removeUnauthorizedTelegramBindings(
  bindings: BindingStore,
  allowedUserIds: ReadonlySet<number>,
): number {
  let removed = 0;
  for (const binding of bindings.list()) {
    const userId = Number(binding.target.conversationId);
    if (!Number.isSafeInteger(userId) || !allowedUserIds.has(userId)) {
      bindings.unbind(binding.target);
      removed += 1;
    }
  }
  return removed;
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
