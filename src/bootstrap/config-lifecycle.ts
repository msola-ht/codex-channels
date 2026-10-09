import { unwatchFile, watchFile } from "node:fs";
import { dirname, join } from "node:path";

import type { Logger } from "pino";

import {
  acknowledgeConfigEvents,
  configEventQueuePath,
  matchingWorkspaceConfigEvents,
  readConfigEvents,
  type WorkspaceAddedConfigEvent,
} from "../../runtime/config-event-queue.mjs";
import {
  GatewayAccountRefreshError,
  GatewayAccountRefreshServer,
} from "../../runtime/gateway-account-refresh.mjs";
import { readCodexProxySettings } from "../../runtime/codex-proxy-env.mjs";
import { GatewayOwner } from "../../runtime/gateway-owner.mjs";
import { installProcessSignalHandlers, installServiceControlHandler } from "../../runtime/process-lifecycle.mjs";
import { loadRuntimeConfig } from "../config/index.js";
import { accountQueryFailureMetadata } from "./account-query.js";
import { ResetCreditError } from "../application/index.js";
import { createLogger } from "../observability/index.js";
import { createWeixinCredentialChangeCheck, createWeixinCredentialStore } from "../surfaces/index.js";
import { GatewayApplication } from "./app.js";
import { loadBuiltInSurfacePlugins } from "./surface-composition.js";
import { NetworkProxyWatcher } from "./network-proxy-watcher.js";
import {
  ProviderSettingsWatcher,
  type ProviderSettingsStateKind,
} from "./provider-settings-watcher.js";

const providerSettingsAction: Record<
  ProviderSettingsStateKind,
  | "provider-settings-scheduled"
  | "provider-settings-restarting"
  | "provider-settings-applied"
  | "provider-settings-failed"
> = {
  scheduled: "provider-settings-scheduled",
  restarting: "provider-settings-restarting",
  applied: "provider-settings-applied",
  failed: "provider-settings-failed",
};

const shutdownTimeoutMs = 30_000;

export async function runGatewayProcess(): Promise<void> {
  const runtime = loadRuntimeConfig();
  const config = runtime.config;
  if (config.gatewayTimezone !== undefined) {
    process.env.TZ = config.gatewayTimezone;
  }
  const gatewayOwner = new GatewayOwner(runtime.configPath);
  const eventQueuePath = configEventQueuePath(dirname(runtime.configPath));
  const watchedPaths = [runtime.configPath, eventQueuePath];
  const logger = createLogger(config, { service: "gateway", module: "lifecycle" });
  let earlyStop = false;
  const controls: { stop?: () => void; reload?: () => void } = {};
  let reloadPending = false;
  const requestStop = (): void => {
    earlyStop = true;
    controls.stop?.();
  };
  const requestReload = (): void => {
    if (controls.reload) controls.reload();
    else reloadPending = true;
  };
  const cleanupControl = installServiceControlHandler(message => {
    if (message.type === "codexc-stop") requestStop();
    else requestReload();
  });
  const cleanupSignals = installProcessSignalHandlers({
    SIGINT: requestStop, SIGTERM: requestStop, SIGHUP: requestReload,
  });
  const cleanupHandlers = (): void => { cleanupControl(); cleanupSignals(); };
  let application: GatewayApplication;
  let weixinCredentialChange: (() => Promise<"changed" | "unchanged" | "unavailable">) | undefined;
  try {
    await gatewayOwner.start();
    if (earlyStop) { await gatewayOwner.close(); cleanupHandlers(); return; }
    const surfacePlugins = await loadBuiltInSurfacePlugins(config);
    if (earlyStop) { await gatewayOwner.close(); cleanupHandlers(); return; }
    if (config.weixin) {
      weixinCredentialChange = await createWeixinCredentialChangeCheck(
        createWeixinCredentialStore(join(config.credentialsDirectory, "weixin")),
        config.weixin.accountId,
        () => logger.warn({ surface: "weixin" }, "微信凭据检查失败；其他渠道继续运行，下次配置重载重新检查"),
      );
    }
    if (earlyStop) { await gatewayOwner.close(); cleanupHandlers(); return; }
    application = new GatewayApplication(
      config,
      logger,
      surfacePlugins,
      runtime.configPath,
      () => stop(1),
    );
  } catch (error) {
    cleanupHandlers();
    await gatewayOwner.close();
    throw error;
  }
  const accountRefresh = new GatewayAccountRefreshServer(
    runtime.configPath,
    async (provider, signal) => {
      const startedAt = performance.now();
      try {
        return await application.refreshAccountSnapshot(provider, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        const diagnostic = accountQueryFailureMetadata(error, performance.now() - startedAt);
        logger.warn({ provider, ...diagnostic }, "账户刷新失败");
        throw new GatewayAccountRefreshError("refresh_failed", "账户刷新失败", {
          cause: error, reason: diagnostic.reason,
        });
      }
    },
    async (request, signal) => {
      try { return await application.resetCreditOperation(request, signal); }
      catch (error) {
        throw new GatewayAccountRefreshError(error instanceof ResetCreditError ? error.code : "reset_unavailable", "重置券操作未完成");
      }
    },
  );
  let stopping = false;
  let started = false;
  let reloading = false;
  let reloadTimer: NodeJS.Timeout | undefined;
  let accountRefreshStartup: Promise<void> | undefined;

  let providerSettingsWatcher: ProviderSettingsWatcher;
  let networkProxyWatcher: NetworkProxyWatcher;
  try {
    providerSettingsWatcher = new ProviderSettingsWatcher({
      logger,
      configuredProviders: application.managedSettingsProviders,
      aggregateMembers: application.aggregateSettingsMembers,
      applyProviderSettings: (provider, signal) => application.applyProviderSettings(provider, signal),
      refreshProviderModels: (provider, signal) => application.refreshProviderModels(provider, signal),
      onStateChange: (change) =>
        application.notifyProviderSettingsChange(
          providerSettingsAction[change.kind],
          change.providers,
        ),
      environment: process.env,
    });
    const configuredNetwork = readCodexProxySettings(process.env);
    networkProxyWatcher = new NetworkProxyWatcher({
      logger,
      configured: configuredNetwork,
      initialProxy: config.networkProxy,
    });
  } catch (error) {
    cleanupHandlers();
    await application.stop().catch(() => undefined);
    await gatewayOwner.close();
    throw error;
  }

  const stopWatching = (): Promise<void> => {
    const providersStopped = providerSettingsWatcher.stop();
    const networkStopped = networkProxyWatcher.stop();
    if (reloadTimer) {
      clearTimeout(reloadTimer);
      reloadTimer = undefined;
    }
    for (const path of watchedPaths) {
      unwatchFile(path);
    }
    cleanupHandlers();
    return Promise.all([providersStopped, networkStopped]).then(() => undefined);
  };
  const closeAccountRefresh = async (): Promise<void> => {
    // IPC startup can still publish its endpoint after an early close.
    await accountRefreshStartup?.catch(() => undefined);
    await accountRefresh.close();
  };
  const stop = (exitCode = 0): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    gatewayOwner.markNotReady();
    // A stuck startup or component close must not leave a stopped Gateway
    // advertised as a live service. Only this Gateway process is terminated.
    const deadline = setTimeout(() => {
      logger.error({ timeoutMs: shutdownTimeoutMs }, "Gateway 停止等待超时，进程将以故障状态退出");
      process.exit(1);
    }, shutdownTimeoutMs);
    const watchersStopped = stopWatching();
    void Promise.all([
      watchersStopped.catch((error) => logger.error({ err: error }, "Gateway 配置监听关闭失败")),
      closeAccountRefresh().catch((error) => logger.error({ err: error }, "Gateway 账户刷新 IPC 关闭失败")),
      application.stop().catch((error) => logger.error({ err: error }, "Gateway 停止失败")),
    ])
      .finally(async () => {
        try {
          await gatewayOwner.close();
        } catch (error) {
          logger.error({ err: error }, "Gateway 所有权 Socket 关闭失败");
        }
        clearTimeout(deadline);
        process.exit(exitCode);
      });
  };
  const reload = async (): Promise<void> => {
    if (stopping || reloading) {
      reloadPending = true;
      return;
    }
    reloading = true;
    try {
      const next = loadRuntimeConfig();
      const pendingEvents = readPendingConfigEvents(eventQueuePath, logger);
      const applicableEvents = matchingWorkspaceConfigEvents(
        pendingEvents,
        next.config.workspaces,
      );
      const credentialsChanged = next.config.weixin?.accountId === config.weixin?.accountId
        && weixinCredentialChange !== undefined
        && await weixinCredentialChange() === "changed";
      if (stopping) return;
      const result = application.reloadConfig(
        next.config,
        applicableEvents.map((event) => event.workspace),
        credentialsChanged,
      );
      if (result.action === "reinstall") {
        logger.error(
          { changes: result.changes.map((change) => change.code) },
          "配置涉及 App Server 服务定义，继续使用现有配置；请执行 codexc install",
        );
        return;
      }
      if (result.action === "restart") {
        const supervised = process.env.CODEX_CONNECT_GATEWAY_SUPERVISED === "1"
          || process.env.CODEX_CONNECT_SERVICE_ROLE === "gateway";
        logger.info(
          { changes: result.changes.map((change) => change.code), supervised },
          supervised
            ? "配置需要重建连接，Gateway 将由监管入口自动重启"
            : "配置需要重建连接，Gateway 将退出，请手动重新启动",
        );
        stop(supervised ? 75 : 0);
        return;
      }
      logger.info(
        { changes: result.changes.map((change) => change.code) },
        result.changes.length > 0 ? "Gateway 配置已热加载" : "Gateway 配置没有变化",
      );
      if (eventQueuePath && applicableEvents.length > 0) {
        try {
          await application.deliverAddedWorkspaceNotifications(
            applicableEvents.map((event) => event.workspace),
          );
          acknowledgeConfigEvents(
            eventQueuePath,
            applicableEvents.map((event) => event.id),
          );
        } catch (error) {
          logger.warn(
            { err: error, events: applicableEvents.length },
            "配置事件投递或确认失败；事件已保留，等待下次配置加载",
          );
        }
      }
    } catch (error) {
      if (stopping) return;
      application.notifyConfigReloadFailure();
      logger.error({ err: error }, "Gateway 配置热加载失败，继续使用现有配置");
    } finally {
      reloading = false;
      if (reloadPending && !stopping) {
        reloadPending = false;
        void reload();
      }
    }
  };
  function scheduleReload(): void {
    if (stopping) {
      return;
    }
    if (!started) {
      reloadPending = true;
      return;
    }
    if (reloadTimer) {
      clearTimeout(reloadTimer);
    }
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined;
      void reload();
    }, 150);
    reloadTimer.unref();
  }

  controls.stop = () => stop();
  controls.reload = scheduleReload;
  if (earlyStop) { stop(); return; }

  try {
    await application.start();
    if (stopping) return;
    accountRefreshStartup = accountRefresh.start();
    await accountRefreshStartup;
  } catch (error) {
    if (stopping) return;
    await stopWatching();
    await closeAccountRefresh().catch(() => undefined);
    await application.stop().catch(() => undefined);
    await gatewayOwner.close();
    throw error;
  }
  if (stopping) {
    return;
  }
  gatewayOwner.markReady();
  started = true;
  providerSettingsWatcher.start();
  networkProxyWatcher.start();
  if (watchedPaths.length > 0) {
    for (const path of watchedPaths) {
      watchFile(path, { interval: 500, persistent: false }, (current, previous) => {
        if (
          current.mtimeMs !== previous.mtimeMs
          || current.size !== previous.size
          || current.ino !== previous.ino
        ) {
          scheduleReload();
        }
      });
    }
    reloadPending = false;
    await reload();
  }
}

function readPendingConfigEvents(
  queuePath: string | undefined,
  logger: Logger,
): WorkspaceAddedConfigEvent[] {
  if (!queuePath) {
    return [];
  }
  try {
    return readConfigEvents(queuePath);
  } catch (error) {
    logger.error({ err: error }, "读取配置事件队列失败；事件将保留以便后续重试");
    return [];
  }
}
