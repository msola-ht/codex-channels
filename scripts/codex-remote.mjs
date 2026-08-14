import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { resolvePrimaryAppServerSocketPath } from "../runtime/app-server-runtime.mjs";
import {
  loadManagedModelProvider,
  providerAppServerSocketPath,
} from "../runtime/model-provider-runtime.mjs";
import { deepseekProviderDefinition } from "../runtime/model-provider-definitions.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { runtimeConfig } from "./runtime-config.mjs";
import { readWorkspaceConfig } from "./workspace-config.mjs";

try {
  runRemoteCli();
} catch (error) {
  writeCliMessage("failure", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function runRemoteCli() {
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
  const primarySocketPath = resolvePrimaryAppServerSocketPath(document, runtime.dataDir);
  let socketPath = primarySocketPath;
  if (selectedProfile === deepseekProviderDefinition.profileName) {
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
    [
      "--remote",
      `unix://${socketPath}`,
      "-C",
      workdir,
      ...(selectedProfile === deepseekProviderDefinition.profileName
        ? ["--profile", deepseekProviderDefinition.profileName]
        : []),
      ...passthrough,
    ],
    { stdio: "inherit" },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  const exitCode = result.status ?? 1;
  if (exitCode !== 0) {
    writeCliMessage("failure", `Codex TUI 已退出：exit=${exitCode}`);
  }
  process.exitCode = exitCode;
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function removeDeepseekProfile(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (
      (argument === "--profile" || argument === "-p")
      && args[index + 1] === deepseekProviderDefinition.profileName
    ) {
      args.splice(index, 2);
      return deepseekProviderDefinition.profileName;
    }
    if ([
      `--profile=${deepseekProviderDefinition.profileName}`,
      `-p=${deepseekProviderDefinition.profileName}`,
      `-p${deepseekProviderDefinition.profileName}`,
    ].includes(argument)) {
      args.splice(index, 1);
      return deepseekProviderDefinition.profileName;
    }
  }
  return undefined;
}
