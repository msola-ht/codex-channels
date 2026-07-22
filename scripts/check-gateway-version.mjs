import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageMetadata = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const gatewayMetadata = JSON.parse(
  readFileSync(resolve(root, "src/version.json"), "utf8"),
);

if (packageMetadata.version !== gatewayMetadata.version) {
  throw new Error(
    `Gateway 版本不一致：package.json=${packageMetadata.version}，src/version.json=${gatewayMetadata.version}`,
  );
}

console.log(`Gateway 版本匹配：${gatewayMetadata.version}`);
