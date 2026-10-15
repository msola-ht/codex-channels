import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { userDataDir } from "./runtime-config.mjs";

export function printSourceInstallNextSteps(environment = process.env) {
  const explicitConfig = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  const configPath = explicitConfig ? resolve(explicitConfig) : join(userDataDir(environment), "config.toml");
  try {
    const status = lstatSync(configPath);
    if (!status.isFile()) {
      console.log(`[提示] 配置路径不是普通文件：${configPath}；请运行 codexc doctor 检查，不要重复初始化。`);
      return;
    }
    console.log(`[提示] 检测到已有用户配置：${configPath}；无需因程序安装而重新初始化。`);
    console.log("[下一步] 运行 codexc doctor 检查配置与服务状态；已有配置不代表接入和后台服务已就绪。");
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.log(explicitConfig
        ? "[提示] CODEX_CONNECT_CONFIG_FILE 指定的配置路径不存在；请先核对路径，确需新建配置时再运行 codexc init。"
        : "[下一步] 未找到用户配置，请在交互终端运行 codexc init 完成初始化、接入与后台服务安装。");
    } else {
      console.log("[提示] 无法确认用户配置状态；请运行 codexc config paths --json 核对路径，再运行 codexc doctor 检查权限和配置。");
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error("source-install-summary.mjs 不接受参数");
  printSourceInstallNextSteps();
}
