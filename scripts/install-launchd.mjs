import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { writeServiceDefinitions } from "./service-install-management.mjs";

try {
  installLaunchdAgents();
} catch (error) {
  writeCliMessage("failure", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function installLaunchdAgents() {
  if (process.platform !== "darwin") {
    throw new Error("launchd 安装仅支持 macOS");
  }
  const result = writeServiceDefinitions(process.env, {
    operatingSystem: "darwin",
  });
  for (const service of result.services) console.log(`生成：${service.destination}`);
  writeCliMessage("success", "launchd 配置已生成。");
}
