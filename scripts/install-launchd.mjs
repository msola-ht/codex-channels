import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "dotenv";
import { readWorkspaceConfig } from "./workspace-config.mjs";

const projectDir = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const envPath = join(projectDir, ".env");
const env = parse(readFileSync(envPath));
const { defaultWorkspace } = readWorkspaceConfig(env);
const workdir = defaultWorkspace.cwd;
const socketPath = resolve(env.CODEX_SOCKET_PATH || join(projectDir, ".runtime/codex-app-server.sock"));
if (!isAbsolute(socketPath)) {
  throw new Error("CODEX_SOCKET_PATH 必须是绝对路径");
}
const runtimeDir = dirname(socketPath);
mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
chmodSync(runtimeDir, 0o700);

const values = {
  PROJECT_DIR: projectDir,
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
