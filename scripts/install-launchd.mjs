import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import { resolvePrimaryAppServerSocketPath } from "../runtime/app-server-runtime.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { resolveExecutable } from "../runtime/executable.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { serviceDefinitions } from "../runtime/service-targets.mjs";
import { packageDir, runtimeConfig } from "./runtime-config.mjs";
import { readWorkspaceConfig } from "./workspace-config.mjs";

if (process.platform !== "darwin") {
  throw new Error("launchd 安装仅支持 macOS");
}
const projectDir = packageDir;
const runtime = runtimeConfig();
const document = readGatewayConfig(runtime.configPath);
const codex = table(document.codex);
const { defaultWorkspace } = readWorkspaceConfig(document);
const workdir = defaultWorkspace.cwd;
const socketPath = resolvePrimaryAppServerSocketPath(document, runtime.dataDir);
if (!isAbsolute(socketPath)) {
  throw new Error("CODEX_SOCKET_PATH 必须是绝对路径");
}
const runtimeDir = dirname(socketPath);
mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
chmodSync(runtimeDir, 0o700);

const codexBinary = resolveExecutable(stringValue(codex.binary) || "codex");
const nodeBinary = realpathSync(process.execPath);
const launchdPath = uniquePaths([
  dirname(nodeBinary),
  dirname(codexBinary),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
]).join(delimiter);
const values = {
  PROJECT_DIR: projectDir,
  CONFIG_DIR: runtime.dataDir,
  CONFIG_PATH: runtime.configPath,
  CLI_ENTRY: join(projectDir, "bin", "codexc.mjs"),
  WORKDIR: workdir,
  RUNTIME_DIR: runtimeDir,
  SOCKET_PATH: socketPath,
  NODE_BINARY: nodeBinary,
  CODEX_BINARY: codexBinary,
  LAUNCHD_PATH: launchdPath,
};
const agentsDir = join(homedir(), "Library", "LaunchAgents");
mkdirSync(agentsDir, { recursive: true });
for (const definition of serviceDefinitions) {
  const name = definition.launchd;
  const template = readFileSync(join(projectDir, "launchd", `${name}.plist.template`), "utf8");
  const rendered = Object.entries(values).reduce(
    (content, [key, value]) => content.replaceAll(`__${key}__`, xmlEscape(value)),
    template,
  );
  const destination = join(agentsDir, `${name}.plist`);
  writeFileSync(destination, rendered, { mode: 0o600 });
  console.log(`生成：${destination}`);
}
writeCliMessage("success", "launchd 配置已生成。");

function uniquePaths(paths) {
  return [...new Set(paths)];
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
