import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import { parse } from "dotenv";

import { packageDir, resolveConfiguredPath, runtimeConfig } from "./runtime-config.mjs";
import { readWorkspaceConfig } from "./workspace-config.mjs";

if (process.platform !== "linux") {
  throw new Error("systemd 安装仅支持 Linux");
}

const runtime = runtimeConfig();
const envPath = runtime.envPath;
const env = parse(readFileSync(envPath));
const { defaultWorkspace } = readWorkspaceConfig(env);
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

const codexBinary = resolveExecutable(env.CODEX_BINARY || "codex");
const nodeBinary = realpathSync(process.execPath);
const systemdPath = uniquePaths([
  dirname(nodeBinary),
  dirname(codexBinary),
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/local/sbin",
  "/usr/sbin",
  "/sbin",
]).join(delimiter);
const proxyKeys = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];
const argumentValues = {
  SOCKET_URI: `unix://${socketPath}`,
  NODE_BINARY: nodeBinary,
  CODEX_BINARY: codexBinary,
  CLI_ENTRY: join(packageDir, "bin", "codexc.mjs"),
};
const directiveValues = {
  WORKDIR: defaultWorkspace.cwd,
  CONFIG_DIR: runtime.dataDir,
};
const environmentValues = {
  CONFIG_DIR_ENV: runtime.dataDir,
  ENV_PATH_ENV: envPath,
  CODEX_BINARY_ENV: codexBinary,
  SYSTEMD_PATH: systemdPath,
  ...Object.fromEntries(proxyKeys.map((key) => [key, env[key]?.trim() ?? ""])),
};

const configHome = process.env.XDG_CONFIG_HOME?.trim()
  ? resolve(process.env.XDG_CONFIG_HOME)
  : join(homedir(), ".config");
const unitsDir = join(configHome, "systemd", "user");
mkdirSync(unitsDir, { recursive: true, mode: 0o700 });

for (const name of ["codex-connect-app-server", "codex-connect-gateway"]) {
  const template = readFileSync(join(packageDir, "systemd", `${name}.service.template`), "utf8");
  let rendered = Object.entries(argumentValues).reduce(
    (content, [key, value]) => content.replaceAll(`__${key}__`, systemdArgument(value)),
    template,
  );
  rendered = Object.entries(directiveValues).reduce(
    (content, [key, value]) => content.replaceAll(`__${key}__`, systemdDirective(value)),
    rendered,
  );
  rendered = Object.entries(environmentValues).reduce(
    (content, [key, value]) => content.replaceAll(`__${key}__`, systemdEnvironment(value)),
    rendered,
  );
  const destination = join(unitsDir, `${name}.service`);
  writeFileSync(destination, rendered, { mode: 0o600 });
  console.log(`已生成 ${destination}`);
}
console.log("systemd 用户服务配置已生成。");

function resolveExecutable(command) {
  if (isAbsolute(command)) {
    return realpathSync(command);
  }
  return realpathSync(execFileSync("/usr/bin/which", [command], { encoding: "utf8" }).trim());
}

function uniquePaths(paths) {
  return [...new Set(paths)];
}

function systemdArgument(value) {
  return `"${systemdEscape(value)}"`;
}

function systemdEnvironment(value) {
  return systemdEscape(value);
}

function systemdDirective(value) {
  return systemdEscape(value);
}

function systemdEscape(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%");
}
