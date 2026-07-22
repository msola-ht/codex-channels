import { execFileSync } from "node:child_process";

import type { Logger } from "pino";

import { ApprovalCoordinator } from "../approval/coordinator.js";
import { JsonRpcClient, type RpcNotification } from "../codex-client/json-rpc.js";
import { CodexAppServerClient } from "../codex-client/client.js";
import { UnixWebSocketTransport } from "../codex-client/unix-websocket-transport.js";
import { protocolVersion } from "../codex-protocol/index.js";
import type { GatewayConfig } from "../config/index.js";
import { ConversationCore } from "../conversation-core/core.js";
import type { OutputEvent } from "../conversation-core/events.js";
import { ConversationService } from "../application/conversation-service.js";
import { ModelSelectionService } from "../application/model-selection-service.js";
import { EventBus } from "../event-bus/event-bus.js";
import { TelegramAccessPolicy } from "../policy/telegram-access.js";
import { WorkspaceRegistry } from "../policy/workspace-registry.js";
import { SessionRouter } from "../session-routing/router.js";
import { SqliteBindingStore } from "../storage/sqlite-binding-store.js";
import { TelegramSurface } from "../surfaces/telegram/bot.js";

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
  private removeRpcNotification: (() => void) | undefined;
  private removeRpcDisconnect: (() => void) | undefined;
  private reconnecting: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly config: GatewayConfig,
    private readonly logger: Logger,
  ) {
    verifyCodexVersion(config);
    this.transport = new UnixWebSocketTransport(config.codexSocketPath);
    this.rpc = new JsonRpcClient(this.transport);
    this.codex = new CodexAppServerClient(this.rpc, {
      sandbox: config.codexSandbox,
      ...(config.codexModel ? { model: config.codexModel } : {}),
    });
    this.inbound = new EventBus<RpcNotification>(logger, 2_000);
    this.output = new EventBus<OutputEvent>(logger, 1_000);
    this.bindings = new SqliteBindingStore(config.stateDatabasePath);
    this.router = new SessionRouter(
      this.codex,
      this.bindings,
      new WorkspaceRegistry(config.workspaces, config.defaultWorkspaceId),
    );
    this.core = new ConversationCore(this.router, this.output);
    const models = new ModelSelectionService(this.codex, this.router, config.codexModel);
    const service = new ConversationService(this.codex, this.router, this.core, models);
    this.telegram = new TelegramSurface(
      config.telegramBotToken,
      config.telegramProxyUrl,
      service,
      this.output,
      new TelegramAccessPolicy(config.telegramAllowedUserIds),
      config.telegramAllowedUserIds,
      config.workspaces,
      logger,
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
    await this.restoreBindings();
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
        await this.restoreBindings();
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

  private async restoreBindings(): Promise<void> {
    const failures = await this.router.restoreSubscriptions();
    for (const failure of failures) {
      this.logger.warn(
        { err: failure.error, threadId: failure.binding.threadId },
        "恢复 Codex Thread 订阅失败，已移除持久化绑定",
      );
    }
    if (this.router.allBindings().length > 0) {
      this.logger.info(
        { bindings: this.router.allBindings().length },
        "已恢复 Telegram 与 Codex Thread 绑定",
      );
    }
  }
}

function verifyCodexVersion(config: GatewayConfig): void {
  const actual = execFileSync(config.codexBinary, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (actual !== protocolVersion.codexCli) {
    throw new Error(`Codex 版本不受支持：当前 ${actual}，协议基线 ${protocolVersion.codexCli}`);
  }
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
