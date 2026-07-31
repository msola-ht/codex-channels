import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  loadManagedModelProvider,
  providerAppServerSocketPath,
} from "../runtime/model-provider-runtime.mjs";
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
const selectedProfile = removeDeepseekProfile(passthrough);
const primarySocketPath = resolveConfiguredPath(
  stringValue(codex.socket_path),
  runtime.dataDir,
  join(runtime.dataDir, "runtime", "codex-app-server.sock"),
);
let socketPath = primarySocketPath;
if (selectedProfile === "deepseek") {
  const managedProvider = loadManagedModelProvider();
  if (!managedProvider) {
    throw new Error("DeepSeek 切换模式尚未配置，请先运行 codexc setup");
  }
  socketPath = providerAppServerSocketPath(primarySocketPath, managedProvider.provider);
}
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

function removeDeepseekProfile(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if ((argument === "--profile" || argument === "-p") && args[index + 1] === "deepseek") {
      args.splice(index, 2);
      return "deepseek";
    }
    if (["--profile=deepseek", "-p=deepseek", "-pdeepseek"].includes(argument)) {
      args.splice(index, 1);
      return "deepseek";
    }
  }
  return undefined;
}
