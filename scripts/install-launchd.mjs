import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { packageDir, resolveConfiguredPath, runtimeConfig } from "./runtime-config.mjs";
import { readWorkspaceConfig } from "./workspace-config.mjs";

if (process.platform !== "darwin") {
  throw new Error("launchd 安装仅支持 macOS");
}
const projectDir = packageDir;
const runtime = runtimeConfig();
const document = readGatewayConfig(runtime.configPath);
const codex = table(document.codex);
const network = table(document.network);
const { defaultWorkspace } = readWorkspaceConfig(document);
const workdir = defaultWorkspace.cwd;
const socketPath = resolveConfiguredPath(
  stringValue(codex.socket_path),
  runtime.dataDir,
  join(runtime.dataDir, "runtime", "codex-app-server.sock"),
);
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
  ...proxyEnvironment(network),
};
const agentsDir = join(homedir(), "Library", "LaunchAgents");
mkdirSync(agentsDir, { recursive: true });
for (const name of ["com.hegenai.codex-app-server", "com.hegenai.codex-gateway"]) {
  const template = readFileSync(join(projectDir, "launchd", `${name}.plist.template`), "utf8");
  const rendered = Object.entries(values).reduce(
    (content, [key, value]) => content.replaceAll(`__${key}__`, xmlEscape(value)),
    template,
  );
  const destination = join(agentsDir, `${name}.plist`);
  writeFileSync(destination, rendered, { mode: 0o600 });
  console.log(`已生成 ${destination}`);
}
console.log("launchd 配置已生成。");

function resolveExecutable(command) {
  if (isAbsolute(command)) {
    return realpathSync(command);
  }
  return realpathSync(execFileSync("/usr/bin/which", [command], { encoding: "utf8" }).trim());
}

function uniquePaths(paths) {
  return [...new Set(paths)];
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function proxyEnvironment(network) {
  const values = {
    HTTP_PROXY: stringValue(network.http_proxy),
    HTTPS_PROXY: stringValue(network.https_proxy),
    ALL_PROXY: stringValue(network.all_proxy),
    NO_PROXY: stringValue(network.no_proxy),
  };
  return {
    ...values,
    http_proxy: values.HTTP_PROXY,
    https_proxy: values.HTTPS_PROXY,
    all_proxy: values.ALL_PROXY,
    no_proxy: values.NO_PROXY,
  };
}

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
