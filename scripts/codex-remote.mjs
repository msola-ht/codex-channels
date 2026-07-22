import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "dotenv";

const projectDir = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const env = parse(readFileSync(join(projectDir, ".env")));
const workdir = realpathSync(env.CODEX_WORKDIR || projectDir);
const socketPath = resolve(env.CODEX_SOCKET_PATH || join(workdir, ".runtime/codex-app-server.sock"));
const configuredBinary = env.CODEX_BINARY || "codex";
const codexBinary = isAbsolute(configuredBinary)
  ? realpathSync(configuredBinary)
  : execFileSync("/usr/bin/which", [configuredBinary], { encoding: "utf8" }).trim();
const result = spawnSync(
  codexBinary,
  ["--remote", `unix://${socketPath}`, "-C", workdir, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
