import { runGatewayProcess } from "./bootstrap/index.js";
import { ConfigurationError } from "./config/index.js";
import { safeErrorMetadata } from "./observability/index.js";

runGatewayProcess().catch((error) => {
  if (error instanceof ConfigurationError) {
    console.error(`配置错误：${error.message}`);
  } else {
    const metadata = safeErrorMetadata(error);
    const code = metadata.code === undefined ? "" : ` (${String(metadata.code)})`;
    console.error(`Gateway 启动失败：${String(metadata.type)}${code}`);
  }
  process.exitCode = 1;
});
