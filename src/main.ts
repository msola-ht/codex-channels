import { GatewayApplication } from "./bootstrap/index.js";
import { ConfigurationError, loadConfig } from "./config/index.js";
import { createLogger } from "./observability/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const application = new GatewayApplication(config, logger);
  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    void application
      .stop()
      .catch((error) => logger.error({ err: error }, "Gateway 停止失败"))
      .finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await application.start();
}

main().catch((error) => {
  if (error instanceof ConfigurationError) {
    console.error(`配置错误：${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
