import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { serviceDefinitions } from "../runtime/service-targets.mjs";
import { prepareServiceInstallContext } from "./service-install-context.mjs";

if (process.platform !== "linux") {
  throw new Error("systemd 安装仅支持 Linux");
}

const {
  cliEntry,
  codexBinary,
  executablePath: systemdPath,
  nodeBinary,
  packageDir,
  runtime,
  socketPath,
  workdir,
} = prepareServiceInstallContext([
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/local/sbin",
  "/usr/sbin",
  "/sbin",
]);
const argumentValues = {
  SOCKET_URI: `unix://${socketPath}`,
  NODE_BINARY: nodeBinary,
  CODEX_BINARY: codexBinary,
  CLI_ENTRY: cliEntry,
};
const directiveValues = {
  WORKDIR: workdir,
  CONFIG_DIR: runtime.dataDir,
};
const environmentValues = {
  CONFIG_DIR_ENV: runtime.dataDir,
  CONFIG_PATH_ENV: runtime.configPath,
  CODEX_BINARY_ENV: codexBinary,
  SYSTEMD_PATH: systemdPath,
};

const configHome = process.env.XDG_CONFIG_HOME?.trim()
  ? resolve(process.env.XDG_CONFIG_HOME)
  : join(homedir(), ".config");
const unitsDir = join(configHome, "systemd", "user");
mkdirSync(unitsDir, { recursive: true, mode: 0o700 });

for (const definition of serviceDefinitions) {
  const name = definition.systemd.replace(/\.service$/u, "");
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
  console.log(`生成：${destination}`);
}
writeCliMessage("success", "systemd 用户服务配置已生成。");

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
