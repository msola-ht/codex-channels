import { runGatewayProcess } from "./bootstrap/index.js";
import { ConfigurationError } from "./config/index.js";

runGatewayProcess().catch((error) => {
  if (error instanceof ConfigurationError) {
    console.error(`配置错误：${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
