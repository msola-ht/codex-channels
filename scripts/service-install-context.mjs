import { mkdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import { resolvePrimaryAppServerSocketPath } from "../runtime/app-server-runtime.mjs";
import { resolveExecutable } from "../runtime/executable.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { securePrivateDirectorySync } from "../runtime/private-file.mjs";
import { packageDir, runtimeConfig } from "./runtime-config.mjs";
import { readWorkspaceConfig } from "./workspace-config.mjs";

export function prepareServiceInstallContext(additionalPathEntries) {
  const context = resolveServiceInstallContext(additionalPathEntries);
  ensureServiceInstallRuntimeDirectory(context);
  return context;
}

export function resolveServiceInstallContext(
  additionalPathEntries,
  {
    environment = process.env,
    projectDir = packageDir,
    nodeExecutable = process.execPath,
  } = {},
) {
  const runtime = runtimeConfig(environment);
  const document = readGatewayConfig(runtime.configPath);
  const codex = table(document.codex);
  const { defaultWorkspace } = readWorkspaceConfig(document);
  const socketPath = resolvePrimaryAppServerSocketPath(document, runtime.dataDir);
  if (!isAbsolute(socketPath)) {
    throw new Error("CODEX_SOCKET_PATH 必须是绝对路径");
  }

  const runtimeDir = dirname(socketPath);
  const codexBinary = resolveExecutable(
    stringValue(codex.binary) || "codex",
    environment,
  );
  const nodeBinary = realpathSync(nodeExecutable);
  const executablePath = uniquePaths([
    dirname(nodeBinary),
    dirname(codexBinary),
    ...additionalPathEntries,
  ]).join(delimiter);

  return {
    cliEntry: join(projectDir, "bin", "codexc.mjs"),
    codexBinary,
    executablePath,
    nodeBinary,
    packageDir: projectDir,
    runtime,
    runtimeDir,
    socketPath,
    workdir: defaultWorkspace.cwd,
  };
}

export function ensureServiceInstallRuntimeDirectory(context) {
  mkdirSync(context.runtimeDir, { recursive: true, mode: 0o700 });
  securePrivateDirectorySync(context.runtimeDir);
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
