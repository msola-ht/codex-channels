import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { resolvePrimaryAppServerSocketPath } from "../runtime/app-server-runtime.mjs";
import { ensureAppServerProvider } from "../runtime/app-server-supervisor.mjs";
import {
  loadManagedModelProviders,
  providerAppServerSocketPath,
} from "../runtime/model-provider-runtime.mjs";
import { managedModelProviderDefinitions } from "../runtime/model-provider-definitions.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import {
  assertSynchronousChildSuccess,
  ForwardedChildSignalError,
  ReportedChildExitError,
} from "../runtime/process-lifecycle.mjs";
import { parseCodexRemoteOptions } from "./codex-remote-options.mjs";
import { runtimeConfig } from "./runtime-config.mjs";
import { readWorkspaceConfig } from "./workspace-config.mjs";

try {
  await runRemoteCli();
} catch (error) {
  if (error instanceof ReportedChildExitError) {
    writeCliMessage("failure", error.message);
    process.exitCode = error.exitCode;
  } else if (!(error instanceof ForwardedChildSignalError)) {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function runRemoteCli() {
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
  const selectedDefinition = managedModelProviderDefinitions.find(
    ({ profileName }) => profileName === selectedProfile,
  );
  if (selectedDefinition) {
    const managedProvider = loadManagedModelProviders().find(
      ({ provider }) => provider === selectedDefinition.id,
    );
    if (!managedProvider) {
      throw new Error(`${selectedDefinition.displayName} 尚未配置，请先运行 codexc setup`);
    }
    socketPath = providerAppServerSocketPath(primarySocketPath, managedProvider.provider);
    await ensureAppServerProvider(primarySocketPath, managedProvider.provider);
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
      ...(selectedDefinition
        ? ["--profile", selectedDefinition.codexProfileName]
        : []),
      ...passthrough,
    ],
    { stdio: "inherit" },
  );
  assertSynchronousChildSuccess(result, {
    failureReportedByChild: true,
    failureMessage: (exitCode) => `Codex TUI 已退出：exit=${exitCode}`,
  });
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
