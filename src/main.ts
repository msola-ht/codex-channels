import { watchFile, unwatchFile } from "node:fs";

import { GatewayApplication } from "./bootstrap/index.js";
import { ConfigurationError, loadRuntimeConfig } from "./config/index.js";
import { createLogger } from "./observability/index.js";

async function main(): Promise<void> {
  const runtime = loadRuntimeConfig();
  const config = runtime.config;
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
    if (runtime.envPath) {
      unwatchFile(runtime.envPath);
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
      const result = application.reloadConfig(next.config);
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
  if (runtime.envPath) {
    watchFile(runtime.envPath, { interval: 500, persistent: false }, (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size || current.ino !== previous.ino) {
        scheduleReload();
      }
    });
    reloadPending = false;
    await reload();
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
