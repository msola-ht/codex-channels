import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const expected = JSON.parse(
  readFileSync(resolve(root, "src/codex-protocol/version.json"), "utf8"),
);
const codex = process.env.CODEX_BINARY || "codex";
const actual = execFileSync(codex, ["--version"], {
  cwd: root,
  encoding: "utf8",
}).trim();

if (actual !== expected.codexCli) {
  console.error(`Codex 版本不受支持：当前 ${actual}，协议基线 ${expected.codexCli}`);
  process.exit(1);
}

console.log(`Codex 协议版本匹配：${actual}`);
