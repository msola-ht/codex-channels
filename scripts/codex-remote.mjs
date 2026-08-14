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
import {
  assertSynchronousChildSuccess,
  ForwardedChildSignalError,
} from "../runtime/process-lifecycle.mjs";
import { parseCodexRemoteOptions } from "./codex-remote-options.mjs";
import { runtimeConfig } from "./runtime-config.mjs";
import { readWorkspaceConfig } from "./workspace-config.mjs";

try {
  runRemoteCli();
} catch (error) {
  if (!(error instanceof ForwardedChildSignalError)) {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function runRemoteCli() {
  const runtime = runtimeConfig();
  const document = readGatewayConfig(runtime.configPath);
  const codex = table(document.codex);
  const { workspaces } = readWorkspaceConfig(document);
  const { passthrough, selectedProfile, workspaceId } = parseCodexRemoteOptions(
    process.argv.slice(2),
  );
  let workdir = realpathSync(process.cwd());
  if (workspaceId !== undefined) {
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) {
      throw new Error(`找不到 Workspace：${workspaceId}`);
    }
    workdir = workspace.cwd;
  }
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
  assertSynchronousChildSuccess(result, {
    failureMessage: (exitCode) => `Codex TUI 已退出：exit=${exitCode}`,
  });
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
