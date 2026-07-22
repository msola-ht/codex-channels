import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { addWorkspaceToEnv } from "./workspace-config.mjs";

const projectDir = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const options = parseOptions(process.argv.slice(2));
const envPath = resolve(options.envFile ?? join(projectDir, ".env"));
const cwd = resolve(options.cwd ?? process.env.INIT_CWD ?? process.cwd());

const result = addWorkspaceToEnv({
  envPath,
  cwd,
  ...(options.id ? { id: options.id } : {}),
  ...(options.name ? { name: options.name } : {}),
});

if (result.added) {
  console.log(`已添加 Workspace：${result.workspace.name} (${result.workspace.id})`);
  console.log(`工作目录：${result.workspace.cwd}`);
  console.log("重启 Gateway 后可在 Telegram 使用 /workspace 切换。");
} else {
  console.log(`Workspace 已存在：${result.workspace.name} (${result.workspace.id})`);
  console.log(`工作目录：${result.workspace.cwd}`);
}

function parseOptions(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!["--id", "--name", "--cwd", "--env-file"].includes(argument)) {
      throw new Error(`未知参数：${argument}`);
    }
    const value = args[index + 1];
    if (!value) {
      throw new Error(`${argument} 缺少值`);
    }
    const key = argument === "--env-file" ? "envFile" : argument.slice(2);
    result[key] = value;
    index += 1;
  }
  return result;
}
