import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { writeServiceDefinitions } from "./service-install-management.mjs";

try {
  installSystemdUnits();
} catch (error) {
  writeCliMessage("failure", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function installSystemdUnits() {
  if (process.platform !== "linux") {
    throw new Error("systemd 安装仅支持 Linux");
  }
  const result = writeServiceDefinitions(process.env, {
    operatingSystem: "linux",
  });
  for (const service of result.services) console.log(`生成：${service.destination}`);
  writeCliMessage("success", "systemd 用户服务配置已生成。");
}
