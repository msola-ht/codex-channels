import { spawn, spawnSync } from "node:child_process";
import { constants, accessSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveExecutable } from "./executable.mjs";

const openAiTeamIdentifier = "2DC432GLL2";
const desktopAppName = "ChatGPT.app";
export const macDesktopAppPluginEnabledConfigKey =
  "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled";
const hostSource = `
  const { spawn } = require("node:child_process");
  const [command, ...args] = process.argv.slice(1);
  const child = spawn(command, args, { env: process.env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => { console.error(error.message); process.exit(1); });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
`;
const protocolVersionPath = fileURLToPath(
  new URL("../src/codex-protocol/version.json", import.meta.url),
);
const expectedCodexVersion = JSON.parse(
  readFileSync(protocolVersionPath, "utf8"),
).codexCli;

export function validateMacDesktopAppAttachment({
  appPath,
  pipePath,
  toolsEnabled,
  codexBinary,
  environment = process.env,
}) {
  if (process.platform !== "darwin") {
    throw new Error("Codex Desktop App 可信 Host 只支持 macOS");
  }
  if (typeof toolsEnabled !== "boolean") {
    throw new Error("Codex Desktop App 未提供有效的内置工具配置");
  }
  const normalizedAppPath = resolveRequiredPath(appPath, "ChatGPT Desktop App 路径无效");
  const appStatus = lstatSync(normalizedAppPath, { throwIfNoEntry: false });
  if (
    basename(normalizedAppPath) !== desktopAppName
    || !appStatus?.isDirectory()
    || appStatus.isSymbolicLink()
  ) {
    throw new Error("ChatGPT Desktop App 路径无效");
  }

  const normalizedPipePath = resolveRequiredPath(pipePath, "Desktop 工具 Pipe 路径无效");
  const pipeStatus = lstatSync(normalizedPipePath, { throwIfNoEntry: false });
  if (
    !pipeStatus?.isSocket()
    || pipeStatus.isSymbolicLink()
    || pipeStatus.uid !== process.getuid?.()
    || (pipeStatus.mode & 0o077) !== 0
  ) {
    throw new Error("Desktop 工具 Pipe 不是当前用户私有 Socket");
  }

  const resourcesPath = join(normalizedAppPath, "Contents", "Resources");
  const nodePath = join(resourcesPath, "cua_node", "bin", "node");
  assertSignedExecutable(nodePath, "node");
  const nativeCodexPath = resolveNativeCodexExecutable(codexBinary, environment);
  assertSignedExecutable(nativeCodexPath, "codex");
  assertCodexVersion(nativeCodexPath, environment);

  return Object.freeze({
    key: `${normalizedAppPath}\0${normalizedPipePath}\0${toolsEnabled}`,
    appPath: normalizedAppPath,
    pipePath: normalizedPipePath,
    toolsEnabled,
    resourcesPath,
    nodePath,
    nativeCodexPath,
  });
}

export function parseMacDesktopAppToolsEnabled(args) {
  let toolsEnabled;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-c") continue;
    const override = args[index + 1];
    if (typeof override !== "string") {
      throw new Error("Codex Desktop App 提供了不完整的配置覆盖");
    }
    index += 1;
    const prefix = `${macDesktopAppPluginEnabledConfigKey}=`;
    if (!override.startsWith(prefix)) continue;
    const value = override.slice(prefix.length);
    const parsed = value === "true" ? true : value === "false" ? false : undefined;
    if (parsed === undefined || toolsEnabled !== undefined) {
      throw new Error("Codex Desktop App 提供了无效的内置工具配置");
    }
    toolsEnabled = parsed;
  }
  if (toolsEnabled === undefined) {
    throw new Error("Codex Desktop App 未提供内置工具插件配置");
  }
  return toolsEnabled;
}

export function spawnMacDesktopHostedCodex(
  attachment,
  args,
  options,
  spawnProcess = spawn,
) {
  return spawnProcess(attachment.nodePath, [
    "-e",
    hostSource,
    attachment.nativeCodexPath,
    ...args,
  ], {
    ...options,
    env: {
      ...options.env,
      CODEX_APP_TOOLS_PIPE_PATH: attachment.pipePath,
      CODEX_MCP_NODE_PATH: attachment.nodePath,
      CODEX_BROWSER_USE_NODE_PATH: attachment.nodePath,
      CODEX_ELECTRON_RESOURCES_PATH: attachment.resourcesPath,
      CODEX_CLI_PATH: attachment.nativeCodexPath,
    },
  });
}

function resolveNativeCodexExecutable(codexBinary, environment) {
  const entrypoint = realpathSync(resolveExecutable(codexBinary, environment));
  if (basename(entrypoint) !== "codex.js") return entrypoint;
  const target = process.arch === "arm64"
    ? { packageName: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" }
    : process.arch === "x64"
      ? { packageName: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin" }
      : undefined;
  if (!target) throw new Error(`macOS Desktop 不支持当前架构：${process.arch}`);
  const require = createRequire(entrypoint);
  let packageMetadataPath;
  try {
    packageMetadataPath = require.resolve(`${target.packageName}/package.json`);
  } catch {
    throw new Error("无法从项目 Codex CLI 解析 macOS 原生可执行文件");
  }
  return realpathSync(join(
    dirname(packageMetadataPath),
    "vendor",
    target.triple,
    "bin",
    "codex",
  ));
}

function assertSignedExecutable(path, identifier) {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error(`Desktop 可信可执行文件不可用：${identifier}`);
  }
  const status = lstatSync(path, { throwIfNoEntry: false });
  if (!status?.isFile() || status.isSymbolicLink()) {
    throw new Error(`Desktop 可信可执行文件无效：${identifier}`);
  }
  const result = spawnSync(
    "/usr/bin/codesign",
    ["-dv", "--verbose=4", path],
    { encoding: "utf8", maxBuffer: 1_048_576, timeout: 5_000 },
  );
  const details = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (
    result.error
    || result.status !== 0
    || !details.split(/\r?\n/u).includes(`Identifier=${identifier}`)
    || !details.split(/\r?\n/u).includes(`TeamIdentifier=${openAiTeamIdentifier}`)
  ) {
    throw new Error(`Desktop 可信可执行文件签名不匹配：${identifier}`);
  }
}

function assertCodexVersion(nativeCodexPath, environment) {
  const result = spawnSync(nativeCodexPath, ["--version"], {
    encoding: "utf8",
    env: environment,
    maxBuffer: 1_048_576,
    timeout: 5_000,
  });
  if (result.error || result.status !== 0 || result.stdout.trim() !== expectedCodexVersion) {
    throw new Error(`Desktop 可信 Host 需要 ${expectedCodexVersion}`);
  }
}

function resolveRequiredPath(value, message) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(message);
  }
  return resolve(value);
}
