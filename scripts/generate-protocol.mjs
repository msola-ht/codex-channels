import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  generateProtocolTree,
  replaceProtocolTree,
} from "./protocol-schema.mjs";
import {
  executableInvocation,
  resolveExecutable,
} from "../runtime/executable.mjs";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "src/codex-protocol/generated");
const codex = resolveExecutable(process.env.CODEX_BINARY || "codex");
const generated = generateProtocolTree(codex, root, dirname(output), {
  experimental: true,
});
try {
  const versionInvocation = executableInvocation(codex, ["--version"]);
  const version = execFileSync(versionInvocation.file, versionInvocation.args, {
    cwd: root,
    encoding: "utf8",
    windowsVerbatimArguments: versionInvocation.windowsVerbatimArguments,
  }).trim();
  replaceProtocolTree(generated, output);
  writeFileSync(
    resolve(root, "src/codex-protocol/version.json"),
    `${JSON.stringify({ codexCli: version, experimental: true }, null, 2)}\n`,
  );
  await import("./sync-gateway-version.mjs");
} finally {
  if (existsSync(generated)) {
    rmSync(generated, { recursive: true, force: true });
  }
}
