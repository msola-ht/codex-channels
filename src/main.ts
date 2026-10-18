import {
  GatewayOwnershipError,
  runGatewayProcess,
} from "./bootstrap/index.js";
import { ConfigurationError } from "./config/index.js";
import {
  ModelRequestMetricsSchemaError,
  safeErrorMetadata,
} from "./observability/index.js";

runGatewayProcess().catch((error) => {
  if (error instanceof ConfigurationError) {
    console.error(`[失败] 配置错误：${error.message}`);
  } else if (error instanceof GatewayOwnershipError) {
    console.error(`[失败] ${error.message}`);
  } else if (error instanceof ModelRequestMetricsSchemaError) {
    console.error(`[失败] ${error.message}`);
  } else {
    const metadata = safeErrorMetadata(error);
    const code = metadata.code === undefined ? "" : ` (${String(metadata.code)})`;
    console.error(`[失败] Gateway 启动失败：${String(metadata.type)}${code}`);
  }
  process.exitCode = 1;
});
