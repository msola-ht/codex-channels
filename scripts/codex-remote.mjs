import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { resolveConfiguredPath, runtimeConfig } from "./runtime-config.mjs";
import { readWorkspaceConfig } from "./workspace-config.mjs";

const runtime = runtimeConfig();
const document = readGatewayConfig(runtime.configPath);
const codex = table(document.codex);
const { workspaces } = readWorkspaceConfig(document);
const passthrough = process.argv.slice(2);
const workspaceFlag = passthrough.indexOf("--workspace");
let workdir = realpathSync(process.cwd());
if (workspaceFlag !== -1) {
  const workspaceId = passthrough[workspaceFlag + 1];
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    throw new Error(`找不到 Workspace：${workspaceId || "<empty>"}`);
  }
  workdir = workspace.cwd;
  passthrough.splice(workspaceFlag, 2);
}
if (usesDeepseekProfile(passthrough)) {
  throw new Error(
    "Remote TUI 不支持 DeepSeek Profile：Codex 0.146 Remote 不会把 Provider 传给共享 App Server。" +
    "请先在渠道使用 /model 切换到 DeepSeek，再运行 codexc remote resume；" +
    "独立 TUI 请运行 codex --profile deepseek。",
  );
}
const socketPath = resolveConfiguredPath(
  stringValue(codex.socket_path),
  runtime.dataDir,
  join(runtime.dataDir, "runtime", "codex-app-server.sock"),
);
const configuredBinary = stringValue(codex.binary) || "codex";
const codexBinary = isAbsolute(configuredBinary)
  ? realpathSync(configuredBinary)
  : configuredBinary;
const result = spawnSync(
  codexBinary,
  ["--remote", `unix://${socketPath}`, "-C", workdir, ...passthrough],
  { stdio: "inherit" },
);
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function usesDeepseekProfile(args) {
  return args.some((argument, index) =>
    ((argument === "--profile" || argument === "-p") && args[index + 1] === "deepseek")
    || argument === "--profile=deepseek"
    || argument === "-p=deepseek"
    || argument === "-pdeepseek");
}
