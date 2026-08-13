import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import { resolvePrimaryAppServerSocketPath } from "../runtime/app-server-runtime.mjs";
import { resolveExecutable } from "../runtime/executable.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { packageDir, runtimeConfig } from "./runtime-config.mjs";
import { readWorkspaceConfig } from "./workspace-config.mjs";

export function prepareServiceInstallContext(additionalPathEntries) {
  const runtime = runtimeConfig();
  const document = readGatewayConfig(runtime.configPath);
  const codex = table(document.codex);
  const { defaultWorkspace } = readWorkspaceConfig(document);
  const socketPath = resolvePrimaryAppServerSocketPath(document, runtime.dataDir);
  if (!isAbsolute(socketPath)) {
    throw new Error("CODEX_SOCKET_PATH 必须是绝对路径");
  }

  const runtimeDir = dirname(socketPath);
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  chmodSync(runtimeDir, 0o700);

  const codexBinary = resolveExecutable(stringValue(codex.binary) || "codex");
  const nodeBinary = realpathSync(process.execPath);
  const executablePath = uniquePaths([
    dirname(nodeBinary),
    dirname(codexBinary),
    ...additionalPathEntries,
  ]).join(delimiter);

  return {
    cliEntry: join(packageDir, "bin", "codexc.mjs"),
    codexBinary,
    executablePath,
    nodeBinary,
    packageDir,
    runtime,
    runtimeDir,
    socketPath,
    workdir: defaultWorkspace.cwd,
  };
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
