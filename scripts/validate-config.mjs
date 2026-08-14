import { loadRuntimeConfig } from "../dist/config/index.js";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";

try {
  loadRuntimeConfig(process.env);
  console.log("Gateway 配置校验通过。");
} catch (error) {
  writeCliMessage("failure", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
