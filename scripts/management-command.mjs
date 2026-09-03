import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  provisionManagementCredential,
} from "./management-security.mjs";
import { userDataDir } from "./runtime-config.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";

export function enableManagement(environment = process.env, output = process.stdout) {
  const explicitConfig = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  const dataDir = explicitConfig ? dirname(resolve(explicitConfig)) : userDataDir(environment);
  const path = join(dataDir, "management-credential");
  const result = provisionManagementCredential(path);
  if (!result.created && !result.rotated) {
    output.write(`管理凭据已存在：${path}\n如需轮换，请先在终端安全删除旧凭据后重新运行。\n`);
    return { ...result, credential: null };
  }
  output.write("管理凭据只显示这一次，请立即保存到密码管理器：\n");
  output.write(`${result.credential}\n`);
  output.write(`凭据文件：${path}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "enable") {
      throw new Error("用法：codexc management enable");
    }
    enableManagement();
  } catch (error) {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
