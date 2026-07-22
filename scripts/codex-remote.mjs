import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { parse } from "dotenv";
import { resolveConfiguredPath, runtimeConfig } from "./runtime-config.mjs";
import { readWorkspaceConfig } from "./workspace-config.mjs";

const runtime = runtimeConfig();
const env = parse(readFileSync(runtime.envPath));
const { workspaces, defaultWorkspace } = readWorkspaceConfig(env);
const passthrough = process.argv.slice(2);
const workspaceFlag = passthrough.indexOf("--workspace");
let workspace = defaultWorkspace;
if (workspaceFlag !== -1) {
  const workspaceId = passthrough[workspaceFlag + 1];
  workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    throw new Error(`找不到 Workspace：${workspaceId || "<empty>"}`);
  }
  passthrough.splice(workspaceFlag, 2);
}
const workdir = workspace.cwd;
const socketPath = resolveConfiguredPath(
  env.CODEX_SOCKET_PATH,
  runtime.dataDir,
  join(runtime.dataDir, "runtime", "codex-app-server.sock"),
);
const configuredBinary = env.CODEX_BINARY || "codex";
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
