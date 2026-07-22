import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "dotenv";
import { readWorkspaceConfig } from "./workspace-config.mjs";

const projectDir = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const env = parse(readFileSync(join(projectDir, ".env")));
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
const socketPath = resolve(env.CODEX_SOCKET_PATH || join(projectDir, ".runtime/codex-app-server.sock"));
const configuredBinary = env.CODEX_BINARY || "codex";
const codexBinary = isAbsolute(configuredBinary)
  ? realpathSync(configuredBinary)
  : execFileSync("/usr/bin/which", [configuredBinary], { encoding: "utf8" }).trim();
const result = spawnSync(
  codexBinary,
  ["--remote", `unix://${socketPath}`, "-C", workdir, ...passthrough],
  { stdio: "inherit" },
);
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
