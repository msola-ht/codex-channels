import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { parse } from "dotenv";
import { packageDir, resolveConfiguredPath, runtimeConfig } from "./runtime-config.mjs";
import { readWorkspaceConfig } from "./workspace-config.mjs";

if (process.platform !== "darwin") {
  throw new Error("launchd 安装仅支持 macOS");
}
const projectDir = packageDir;
const runtime = runtimeConfig();
const envPath = runtime.envPath;
const env = parse(readFileSync(envPath));
const { defaultWorkspace } = readWorkspaceConfig(env);
const workdir = defaultWorkspace.cwd;
const socketPath = resolveConfiguredPath(
  env.CODEX_SOCKET_PATH,
  runtime.dataDir,
  join(runtime.dataDir, "runtime", "codex-app-server.sock"),
);
if (!isAbsolute(socketPath)) {
  throw new Error("CODEX_SOCKET_PATH 必须是绝对路径");
}
const runtimeDir = dirname(socketPath);
mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
chmodSync(runtimeDir, 0o700);

const values = {
  PROJECT_DIR: projectDir,
  CONFIG_DIR: runtime.dataDir,
  ENV_PATH: envPath,
  CLI_ENTRY: join(projectDir, "bin", "codexc.mjs"),
  WORKDIR: workdir,
  RUNTIME_DIR: runtimeDir,
  SOCKET_PATH: socketPath,
  NODE_BINARY: process.execPath,
  CODEX_BINARY: resolveExecutable(env.CODEX_BINARY || "codex"),
};
const agentsDir = join(homedir(), "Library", "LaunchAgents");
mkdirSync(agentsDir, { recursive: true });
for (const name of ["com.msola.codex-app-server", "com.msola.codex-gateway"]) {
  const template = readFileSync(join(projectDir, "launchd", `${name}.plist.template`), "utf8");
  const rendered = Object.entries(values).reduce(
    (content, [key, value]) => content.replaceAll(`__${key}__`, xmlEscape(value)),
    template,
  );
  const destination = join(agentsDir, `${name}.plist`);
  writeFileSync(destination, rendered, { mode: 0o600 });
  console.log(`已生成 ${destination}`);
}
console.log("配置已生成。使用 scripts/launchd-control.sh start 启动服务。");

function resolveExecutable(command) {
  if (isAbsolute(command)) {
    return realpathSync(command);
  }
  return execFileSync("/usr/bin/which", [command], { encoding: "utf8" }).trim();
}

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
