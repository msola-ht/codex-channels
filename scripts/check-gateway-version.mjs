import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageMetadata = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const gatewayMetadata = JSON.parse(
  readFileSync(resolve(root, "src/version.json"), "utf8"),
);
const protocolMetadata = JSON.parse(
  readFileSync(resolve(root, "src/codex-protocol/version.json"), "utf8"),
);
const expectedVersion = codexPackageVersion(protocolMetadata.codexCli);

if (packageMetadata.version !== expectedVersion || gatewayMetadata.version !== expectedVersion) {
  throw new Error(
    `版本必须匹配 Codex CLI：codex=${expectedVersion}，package.json=${packageMetadata.version}，src/version.json=${gatewayMetadata.version}`,
  );
}

console.log(`包版本与 Codex CLI 匹配：${expectedVersion}`);

function codexPackageVersion(value) {
  const match = /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(String(value));
  if (!match) {
    throw new Error(`无法从协议版本解析 npm 版本：${value}`);
  }
  return match[1];
}
