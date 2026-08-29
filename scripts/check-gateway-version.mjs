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

if (packageMetadata.version !== gatewayMetadata.version) {
  throw new Error(
    `npm 包与 Gateway 运行时版本不一致：package.json=${packageMetadata.version}，src/version.json=${gatewayMetadata.version}`,
  );
}
if (!isGatewayVersionCompatible(packageMetadata.version, expectedVersion)) {
  throw new Error(
    `Gateway 版本必须匹配 Codex CLI 基础版本：codex=${expectedVersion}，gateway=${packageMetadata.version}`,
  );
}

console.log(`Gateway ${packageMetadata.version} 与 Codex CLI ${expectedVersion} 兼容`);

function codexPackageVersion(value) {
  const match = /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(String(value));
  if (!match) {
    throw new Error(`无法从协议版本解析 npm 版本：${value}`);
  }
  return match[1];
}

function isGatewayVersionCompatible(gatewayVersion, codexVersion) {
  return gatewayVersion === codexVersion
    || new RegExp(
      `^${escapeRegExp(codexVersion)}-(?:fix[1-9]\\d*|rc\\.[1-9]\\d*)$`,
      "u",
    ).test(gatewayVersion);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
