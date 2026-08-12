import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { packageDir } from "./package-path.mjs";

const stableVersionPattern = /^\d+\.\d+\.\d+$/u;

export function renderPublishedReadme(readme, targetVersion) {
  if (!stableVersionPattern.test(targetVersion)) {
    throw new Error(`README 只接受正式版本：${targetVersion}`);
  }
  const development = /`main` 开发基线：`(\d+\.\d+\.\d+)`(?:（尚未发布）)?/u
    .exec(readme);
  if (!development) {
    throw new Error("README 缺少受控的 main 开发基线标记");
  }
  if (compareStableVersions(targetVersion, development[1]) > 0) {
    throw new Error(
      `README 正式版本不能高于 main 开发基线：${targetVersion} > ${development[1]}`,
    );
  }
  const published = /当前正式版：`(\d+\.\d+\.\d+)`/u.exec(readme);
  if (!published) {
    throw new Error("README 缺少受控的当前正式版标记");
  }
  const currentVersion = published[1];
  if (compareStableVersions(targetVersion, currentVersion) < 0) {
    throw new Error(
      `拒绝把 README 正式版本降级：${currentVersion} -> ${targetVersion}`,
    );
  }
  for (const expected of [
    `codex-cli ${currentVersion}`,
    `@openai/codex@${currentVersion}`,
    `@hegenai/codexc@${currentVersion}`,
  ]) {
    if (!readme.includes(expected)) {
      throw new Error(`README 正式安装说明缺少受控版本：${expected}`);
    }
  }
  const rendered = readme.replaceAll(currentVersion, targetVersion);
  return development[1] === targetVersion
    ? rendered.replace(
      `\`main\` 开发基线：\`${targetVersion}\`（尚未发布）`,
      `\`main\` 开发基线：\`${targetVersion}\``,
    )
    : rendered;
}

function compareStableVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function normalizeReleaseVersion(value) {
  return value.startsWith("v") ? value.slice(1) : value;
}

function main() {
  const rawVersion = process.argv[2]?.trim() || process.env.GITHUB_REF_NAME?.trim();
  if (!rawVersion) {
    throw new Error("缺少正式发布版本");
  }
  const targetVersion = normalizeReleaseVersion(rawVersion);
  const readmePath = resolve(packageDir, "README.md");
  const current = readFileSync(readmePath, "utf8");
  const rendered = renderPublishedReadme(current, targetVersion);
  if (rendered === current) {
    console.log(`README 已是正式版本 ${targetVersion}`);
    return;
  }
  writeFileSync(readmePath, rendered);
  console.log(`README 正式版本已同步至 ${targetVersion}`);
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main();
}
