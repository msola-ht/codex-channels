import { dirname, resolve } from "node:path";

import { configEventQueuePath } from "./config-event-queue.mjs";
import { runtimeConfig } from "./runtime-config.mjs";
import { addWorkspaceToEnv } from "./workspace-config.mjs";

const options = parseOptions(process.argv.slice(2));
const envPath = resolve(options.envFile ?? runtimeConfig().envPath);
const cwd = resolve(options.cwd ?? process.env.INIT_CWD ?? process.cwd());

const result = addWorkspaceToEnv({
  envPath,
  cwd,
  ...(options.id ? { id: options.id } : {}),
  ...(options.name ? { name: options.name } : {}),
  ...(options.pruneMissing ? { pruneMissing: true } : {}),
  ...(options.restoreDefault ? { restoreDefault: true } : {}),
  fallbackDefaultWorkspace: {
    cwd: resolve(dirname(envPath), "workspace"),
    id: "codex-connect",
    name: ".codex-connect/workspace",
  },
  eventQueuePath: configEventQueuePath(dirname(envPath)),
});

for (const removed of result.removedWorkspaces) {
  console.log(`已清理失效 Workspace：${removed.name} (${removed.id})`);
  console.log(`原工作目录：${removed.cwd}`);
}
if (result.added) {
  console.log(`已添加 Workspace：${result.workspace.name} (${result.workspace.id})`);
  console.log(`工作目录：${result.workspace.cwd}`);
} else {
  console.log(`Workspace 已存在：${result.workspace.name} (${result.workspace.id})`);
  console.log(`工作目录：${result.workspace.cwd}`);
}
if (result.defaultChanged) {
  console.log(`默认 Workspace 已切换为：${result.defaultWorkspace.name} (${result.defaultWorkspace.id})`);
}
if (result.added || result.removedWorkspaces.length > 0 || result.defaultChanged) {
  console.log("运行中的 Gateway 会自动热加载配置，必要时重启。");
}

function parseOptions(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--prune-missing") {
      result.pruneMissing = true;
      continue;
    }
    if (argument === "--restore-default") {
      result.restoreDefault = true;
      continue;
    }
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
