import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "src/codex-protocol/generated");
const codex = process.env.CODEX_BINARY || "codex";

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
execFileSync(codex, ["app-server", "generate-ts", "--out", output], {
  cwd: root,
  stdio: "inherit",
});

const version = execFileSync(codex, ["--version"], {
  cwd: root,
  encoding: "utf8",
}).trim();

writeFileSync(
  resolve(root, "src/codex-protocol/version.json"),
  `${JSON.stringify({ codexCli: version, experimental: false }, null, 2)}\n`,
);

await import("./sync-gateway-version.mjs");
