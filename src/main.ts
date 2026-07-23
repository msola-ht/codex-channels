import { watchFile, unwatchFile } from "node:fs";
import { dirname } from "node:path";

import {
  acknowledgeConfigEvents,
  configEventQueuePath,
  matchingWorkspaceConfigEvents,
  readConfigEvents,
  type WorkspaceAddedConfigEvent,
} from "../scripts/config-event-queue.mjs";
import { GatewayApplication } from "./bootstrap/index.js";
import { ConfigurationError, loadRuntimeConfig } from "./config/index.js";
import { createLogger } from "./observability/index.js";

async function main(): Promise<void> {
  const runtime = loadRuntimeConfig();
  const config = runtime.config;
  const eventQueuePath = runtime.envPath
    ? configEventQueuePath(dirname(runtime.envPath))
    : undefined;
  const watchedPaths = [runtime.envPath, eventQueuePath].filter(
    (path): path is string => path !== undefined,
  );
  const logger = createLogger(config);
  const application = new GatewayApplication(config, logger);
  let stopping = false;
  let started = false;
  let reloading = false;
  let reloadPending = false;
  let reloadTimer: NodeJS.Timeout | undefined;
  const stopWatching = (): void => {
    if (reloadTimer) {
      clearTimeout(reloadTimer);
      reloadTimer = undefined;
    }
    for (const path of watchedPaths) {
      unwatchFile(path);
    }
    process.removeListener("SIGHUP", scheduleReload);
  };
  const stop = (exitCode = 0): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    stopWatching();
    void application
      .stop()
      .catch((error) => logger.error({ err: error }, "Gateway 停止失败"))
      .finally(() => process.exit(exitCode));
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
      const applicableEvents = matchingWorkspaceConfigEvents(pendingEvents, next.config.workspaces);
      const result = application.reloadConfig(
        next.config,
        applicableEvents.map((event) => event.workspace),
      );
      if (result.action === "reinstall") {
        logger.error(
          { changes: result.changes },
          "配置涉及 App Server 服务定义，继续使用现有配置；请执行 codexc service install",
        );
        return;
      }
      if (result.action === "restart") {
        const supervised = process.env.CODEX_CONNECT_GATEWAY_SUPERVISED === "1";
        logger.info(
          { changes: result.changes, supervised },
          supervised
            ? "配置需要重建连接，Gateway 将由系统服务自动重启"
            : "配置需要重建连接，Gateway 将退出，请手动重新启动",
        );
        stop(supervised ? 75 : 0);
        return;
      }
      logger.info(
        { changes: result.changes },
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
  process.once("SIGINT", () => stop());
  process.once("SIGTERM", () => stop());
  process.on("SIGHUP", scheduleReload);

  await application.start();
  started = true;
  if (watchedPaths.length > 0) {
    for (const path of watchedPaths) {
      watchFile(path, { interval: 500, persistent: false }, (current, previous) => {
        if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size || current.ino !== previous.ino) {
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
  logger: ReturnType<typeof createLogger>,
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

main().catch((error) => {
  if (error instanceof ConfigurationError) {
    console.error(`配置错误：${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
