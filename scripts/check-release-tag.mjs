import { readFileSync } from "node:fs";
import { join } from "node:path";

import { packageDir } from "./runtime-config.mjs";

const tag = process.env.GITHUB_REF_NAME?.trim() || process.argv[2]?.trim();
if (!tag) {
  throw new Error("缺少发布 Tag；请设置 GITHUB_REF_NAME 或传入 Tag 参数");
}
const metadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const expected = `v${metadata.version}`;
if (tag !== expected) {
  throw new Error(`发布 Tag 与包版本不一致：tag=${tag}，期望 ${expected}`);
}
console.log(`发布版本匹配：${tag}`);
