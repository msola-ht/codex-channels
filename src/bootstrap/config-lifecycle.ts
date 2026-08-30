import { unwatchFile, watchFile } from "node:fs";
import { dirname } from "node:path";

import type { Logger } from "pino";

import {
  acknowledgeConfigEvents,
  configEventQueuePath,
  matchingWorkspaceConfigEvents,
  readConfigEvents,
  type WorkspaceAddedConfigEvent,
} from "../../runtime/config-event-queue.mjs";
import { GatewayOwner } from "../../runtime/gateway-owner.mjs";
import { loadRuntimeConfig } from "../config/index.js";
import { createLogger } from "../observability/index.js";
import { GatewayApplication } from "./app.js";
import {
  ProviderSettingsWatcher,
  type ProviderSettingsStateKind,
} from "./provider-settings-watcher.js";
import { restartAppServerService } from "./service-restart-runner.js";

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

export async function runGatewayProcess(): Promise<void> {
  const runtime = loadRuntimeConfig();
  const config = runtime.config;
  const gatewayOwner = new GatewayOwner(runtime.configPath);
  await gatewayOwner.start();
  const eventQueuePath = configEventQueuePath(dirname(runtime.configPath));
  const watchedPaths = [runtime.configPath, eventQueuePath];
  const logger = createLogger(config);
  let application: GatewayApplication;
  try {
    application = new GatewayApplication(
      config,
      logger,
      runtime.configPath,
    );
  } catch (error) {
    await gatewayOwner.close();
    throw error;
  }
  let stopping = false;
  let started = false;
  let reloading = false;
  let reloadPending = false;
  let reloadTimer: NodeJS.Timeout | undefined;

  const providerSettingsWatcher = new ProviderSettingsWatcher({
    logger,
    hasActiveTurns: () => application.hasActiveTurns(),
    restartAppServer: () => restartAppServerService({ environment: process.env }),
    onStateChange: (change) =>
      application.notifyProviderSettingsChange(
        providerSettingsAction[change.kind],
        change.providers,
      ),
    environment: process.env,
  });

  const stopWatching = (): void => {
    providerSettingsWatcher.stop();
    if (reloadTimer) {
      clearTimeout(reloadTimer);
      reloadTimer = undefined;
    }
    for (const path of watchedPaths) {
      unwatchFile(path);
    }
    process.removeListener("SIGHUP", scheduleReload);
    process.removeListener("message", controlFromParent);
  };
  const stop = (exitCode = 0): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    gatewayOwner.markNotReady();
    stopWatching();
    void application
      .stop()
      .catch((error) => logger.error({ err: error }, "Gateway 停止失败"))
      .finally(async () => {
        try {
          await gatewayOwner.close();
        } catch (error) {
          logger.error({ err: error }, "Gateway 所有权 Socket 关闭失败");
        }
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
      const result = application.reloadConfig(
        next.config,
        applicableEvents.map((event) => event.workspace),
      );
      if (result.action === "reinstall") {
        logger.error(
          { changes: result.changes.map((change) => change.code) },
          "配置涉及 App Server 服务定义，继续使用现有配置；请执行 codexc service install",
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

  const controlFromParent = (message: unknown): void => {
    if (
      typeof message === "object"
      && message !== null
      && "type" in message
    ) {
      if (message.type === "codexc-stop") stop();
      if (message.type === "codexc-reload") scheduleReload();
    }
  };
  process.once("SIGINT", () => stop());
  process.once("SIGTERM", () => stop());
  process.on("message", controlFromParent);
  process.on("SIGHUP", scheduleReload);

  try {
    await application.start();
  } catch (error) {
    stopWatching();
    await gatewayOwner.close();
    throw error;
  }
  if (stopping) {
    return;
  }
  gatewayOwner.markReady();
  started = true;
  providerSettingsWatcher.start();
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
