import type { Logger } from "pino";

import type { ProviderRoutingClient } from "../codex-client/index.js";
import type { ConversationCore } from "../conversation-core/index.js";
import type { InteractionRouter } from "../approval/index.js";
import type { SessionRouter } from "../session-routing/index.js";
import type { BindingRestoreCoordinator } from "./binding-restore-coordinator.js";

type Initialization = Awaited<ReturnType<ProviderRoutingClient["reconnectProvider"]>>;

export interface GatewayReconnectOptions {
  codex: Pick<ProviderRoutingClient, "knownProvider" | "reconnectProvider" | "closeProvider">;
  router: Pick<SessionRouter, "allBindings">;
  core: Pick<ConversationCore, "connectionLost" | "connectionRestored">;
  interactions: Pick<InteractionRouter, "cancelThreads">;
  bindings: Pick<BindingRestoreCoordinator, "hasDisconnectedProviders" | "nextDisconnectedProvider"
    | "markProviderDisconnected" | "completeProviderReconnect" | "affectedThreadsForProvider" | "restore" | "schedule">;
  logger: Logger;
  isStopping(): boolean;
  cancelQuestions(threadId: string): void;
  intentionallyReleased(provider: string): Promise<boolean>;
  connected(provider: string, initialized: Initialization, signal: AbortSignal): Promise<void>;
  requestStop(): Promise<void>;
}

/** Owns disconnect inspection, serial Provider recovery and cancellation, not Thread state. */
export class GatewayReconnectCoordinator {
  private reconnecting: Promise<void> | undefined;
  private reconnectAbort: AbortController | undefined;
  private readonly disconnectChecks = new Map<string, Promise<void>>();
  private readonly attempts = new Map<string, number>();
  private readonly generations = new Map<string, number>();
  private stopped = false;
  private failed = false;
  private stopTask: Promise<void> | undefined;

  constructor(private readonly options: GatewayReconnectOptions) {}

  private get stopping(): boolean {
    return this.stopped || this.failed || this.options.isStopping();
  }

  disconnected(error: Error, provider: string): void {
    if (this.stopping || this.disconnectChecks.has(provider)) return;
    this.generations.set(provider, (this.generations.get(provider) ?? 0) + 1);
    const task = this.handleCodexDisconnect(error, provider).catch((failure) => {
      if (!this.stopping) {
        this.options.logger.error({ err: failure, provider }, "处理 Codex 断线失败");
        this.failed = true;
        void this.options.requestStop().catch((stopError) => {
          this.options.logger.error({ err: stopError }, "Codex 断线失败后停止 Gateway 失败");
        });
      }
    }).finally(() => {
      if (this.disconnectChecks.get(provider) === task) this.disconnectChecks.delete(provider);
    });
    this.disconnectChecks.set(provider, task);
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopped = true;
    this.reconnectAbort?.abort();
    this.stopTask = Promise.allSettled([
      ...this.disconnectChecks.values(),
      ...(this.reconnecting ? [this.reconnecting] : []),
    ]).then(() => undefined);
    return this.stopTask;
  }

  private beginReconnect(): void {
    if (this.stopping || this.reconnecting) {
      return;
    }
    const controller = new AbortController();
    this.reconnectAbort = controller;
    const task = this.reconnect(controller.signal)
      .catch((error) => {
        if (this.stopping || controller.signal.aborted) {
          return;
        }
        this.options.logger.fatal({ err: error }, "Codex App Server 重连次数耗尽，Gateway 将停止");
        this.failed = true;
        void this.options.requestStop().catch((stopError) => {
          this.options.logger.error({ err: stopError }, "Codex 重连失败后停止 Gateway 失败");
        });
      })
      .finally(() => {
        if (this.reconnecting === task) {
          this.reconnecting = undefined;
        }
        if (this.reconnectAbort === controller) {
          this.reconnectAbort = undefined;
        }
        if (!this.stopping && this.options.bindings.hasDisconnectedProviders()) {
          queueMicrotask(() => this.beginReconnect());
        }
      });
    this.reconnecting = task;
  }

  private async reconnect(signal: AbortSignal): Promise<void> {
    while (
      this.options.bindings.hasDisconnectedProviders()
      && !this.stopping
      && !signal.aborted
    ) {
      const provider = this.options.bindings.nextDisconnectedProvider();
      if (provider === undefined) return;
      await this.disconnectChecks.get(provider);
      if (this.options.bindings.nextDisconnectedProvider() !== provider) continue;
      await this.reconnectProvider(provider, signal);
    }
  }

  private async handleCodexDisconnect(error: Error, provider: string): Promise<void> {
    if (this.stopping) return;
    const affectedThreadIds = new Set(
      this.options.router.allBindings()
        .map((binding) => binding.threadId)
        .filter((threadId) => this.options.codex.knownProvider(threadId) === provider),
    );
    for (const threadId of affectedThreadIds) this.options.cancelQuestions(threadId);
    let intentionallyReleased = false;
    try {
      intentionallyReleased = await this.options.intentionallyReleased(provider);
    } catch (inspectError) {
      this.options.logger.warn(
        { err: inspectError, provider },
        "无法确认模型 Provider 是否主动停止，将按意外断线恢复",
      );
    }
    if (this.stopping) return;
    if (intentionallyReleased) {
      try {
        await this.options.codex.closeProvider(provider);
      } catch (closeError) {
        this.options.logger.warn({ err: closeError, provider }, "主动停止的 Provider Client 清理失败");
      }
      if (this.stopping) return;
      this.options.bindings.completeProviderReconnect(provider);
      this.attempts.delete(provider);
      this.options.interactions.cancelThreads(affectedThreadIds);
      this.options.core.connectionLost(
        `${provider} App Server 已主动停止；再次使用时将自动启动`,
        affectedThreadIds,
      );
      this.options.logger.info({ provider }, "模型 Provider App Server 已主动停止");
      return;
    }
    this.options.bindings.markProviderDisconnected(provider, affectedThreadIds);
    this.options.logger.warn({ err: error, provider }, "Codex App Server 连接已断开");
    this.options.interactions.cancelThreads(affectedThreadIds);
    this.options.core.connectionLost(
      `${provider} App Server 连接已断开，正在恢复连接`,
      affectedThreadIds,
    );
    this.beginReconnect();
  }

  private async reconnectProvider(provider: string, signal: AbortSignal): Promise<void> {
    const generation = this.generations.get(provider);
    const superseded = () => this.stopping || signal.aborted
      || this.generations.get(provider) !== generation;
    const maximumAttempts = 12;
    let initialized: Initialization | undefined;
    let connectionPrepared = false;
    for (
      let attempt = (this.attempts.get(provider) ?? 0) + 1;
      attempt <= maximumAttempts && !superseded();
      attempt += 1
    ) {
      if (attempt > 1) {
        const ceiling = Math.min(30_000, 500 * 2 ** (attempt - 2));
        await abortableDelay(
          Math.floor(ceiling / 2 + Math.random() * ceiling / 2),
          signal,
        );
      }
      if (superseded()) {
        return;
      }
      this.attempts.set(provider, attempt);
      try {
        initialized ??= await this.options.codex.reconnectProvider(provider);
        if (superseded()) {
          return;
        }
        if (!connectionPrepared) {
          await this.options.connected(provider, initialized, signal);
          connectionPrepared = true;
        }
        if (superseded()) {
          return;
        }
        await this.options.bindings.restore(provider);
        if (superseded()) {
          return;
        }
        this.options.bindings.schedule();
        const restoredThreadIds = this.options.bindings
          .affectedThreadsForProvider(provider);
        if (restoredThreadIds !== undefined && restoredThreadIds.size > 0) {
          this.options.core.connectionRestored(
            `${provider} App Server 已重新连接`,
            restoredThreadIds,
          );
        }
        this.options.bindings.completeProviderReconnect(provider);
        this.attempts.delete(provider);
        this.options.logger.info(
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
        if (superseded()) {
          return;
        }
        this.options.logger.warn(
          { err: error, provider, attempt, maximumAttempts },
          "模型 Provider App Server 重连失败",
        );
      }
    }
    if (!superseded()) {
      throw new Error(`${provider} App Server 重连 ${maximumAttempts} 次后仍然失败`);
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
