import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  assertProtocolTreesEqual,
  generateProtocolTree,
} from "./protocol-schema.mjs";
import {
  executableInvocation,
  resolveExecutable,
} from "../runtime/executable.mjs";

const root = resolve(import.meta.dirname, "..");
const generated = resolve(root, "src/codex-protocol/generated");
const expected = JSON.parse(
  readFileSync(resolve(root, "src/codex-protocol/version.json"), "utf8"),
);
const codex = resolveExecutable(process.env.CODEX_BINARY || "codex");
const versionInvocation = executableInvocation(codex, ["--version"]);
const actual = execFileSync(versionInvocation.file, versionInvocation.args, {
  cwd: root,
  encoding: "utf8",
  windowsVerbatimArguments: versionInvocation.windowsVerbatimArguments,
}).trim();

if (actual !== expected.codexCli) {
  console.error(`Codex 版本不受支持：当前 ${actual}，协议基线 ${expected.codexCli}`);
  process.exit(1);
}

const regenerated = generateProtocolTree(codex, root, dirname(generated), {
  experimental: expected.experimental === true,
  stdio: "ignore",
});
try {
  assertProtocolTreesEqual(generated, regenerated);
} finally {
  if (existsSync(regenerated)) {
    rmSync(regenerated, { recursive: true, force: true });
  }
}

console.log(`Codex 协议版本与生成类型匹配：${actual}`);
