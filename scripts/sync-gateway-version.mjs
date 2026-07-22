import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { packageDir } from "./runtime-config.mjs";

const packageMetadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const lockMetadata = JSON.parse(readFileSync(join(packageDir, "package-lock.json"), "utf8"));
const protocolMetadata = JSON.parse(
  readFileSync(join(packageDir, "src", "codex-protocol", "version.json"), "utf8"),
);
const match = /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(protocolMetadata.codexCli);
if (!match) {
  throw new Error(`无法从协议版本解析 npm 版本：${protocolMetadata.codexCli}`);
}
const version = match[1];
packageMetadata.version = version;
lockMetadata.version = version;
lockMetadata.packages[""].version = version;

writeJson(join(packageDir, "package.json"), packageMetadata);
writeJson(join(packageDir, "package-lock.json"), lockMetadata);
writeJson(join(packageDir, "src", "version.json"), { version });
console.log(`包版本已同步至 Codex CLI：${version}`);

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
