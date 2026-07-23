import { loadRuntimeConfig } from "../dist/config/index.js";

try {
  loadRuntimeConfig(process.env);
  console.log("Gateway 配置校验通过。");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
