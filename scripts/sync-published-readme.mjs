import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { packageDir } from "./package-path.mjs";

const releaseVersionPattern = /^\d+\.\d+\.\d+(?:-fix[1-9]\d*|-rc\.[1-9]\d*)?$/u;

export function renderPublishedReadme(readme, targetVersion) {
  if (!releaseVersionPattern.test(targetVersion)) {
    throw new Error(`README 只接受正式版本、rc 预发行版或 fix 修复版：${targetVersion}`);
  }
  const development = /`main` 开发基线：`(\d+\.\d+\.\d+(?:-fix[1-9]\d*|-rc\.[1-9]\d*)?)`(?:（尚未发布）)?/u
    .exec(readme);
  if (!development) {
    throw new Error("README 缺少受控的 main 开发基线标记");
  }
  if (compareBaseVersions(targetVersion, development[1]) > 0) {
    throw new Error(
      `README 发布版本不能高于 main 开发基线：${targetVersion} > ${development[1]}`,
    );
  }
  const published = /当前正式版：`(\d+\.\d+\.\d+)`/u.exec(readme);
  if (!published) {
    throw new Error("README 缺少受控的当前正式版标记");
  }
  const currentVersion = published[1];
  if (targetVersion.includes("-fix")) {
    return renderFixReadme(readme, targetVersion, development[1], currentVersion);
  }
  if (targetVersion.includes("-rc.")) {
    return renderRcReadme(readme, targetVersion, development[1], currentVersion);
  }
  if (compareBaseVersions(targetVersion, currentVersion) < 0) {
    throw new Error(
      `拒绝把 README 正式版本降级：${currentVersion} -> ${targetVersion}`,
    );
  }
  const readmeWithoutRc = removeRcPreview(readme);
  const currentCodexVersion = baseVersion(currentVersion);
  const targetCodexVersion = baseVersion(targetVersion);
  for (const expected of [
    `codex-cli ${currentCodexVersion}`,
    `@openai/codex@${currentCodexVersion}`,
    `@hegenai/codexc@${currentVersion}`,
  ]) {
    if (!readmeWithoutRc.includes(expected)) {
      throw new Error(`README 正式安装说明缺少受控版本：${expected}`);
    }
  }
  const rendered = readmeWithoutRc
    .replaceAll(`codex-cli ${currentCodexVersion}`, `codex-cli ${targetCodexVersion}`)
    .replaceAll(`@openai/codex@${currentCodexVersion}`, `@openai/codex@${targetCodexVersion}`)
    .replaceAll(`@hegenai/codexc@${currentVersion}`, `@hegenai/codexc@${targetVersion}`)
    .replace(
      `当前正式版：\`${currentVersion}\``,
      `当前正式版：\`${targetVersion}\``,
    );
  return development[1] === targetVersion
    ? rendered.replace(
      `\`main\` 开发基线：\`${targetVersion}\`（尚未发布）`,
      `\`main\` 开发基线：\`${targetVersion}\``,
    )
    : rendered;
}

function renderRcReadme(readme, targetVersion, developmentVersion, publishedVersion) {
  if (compareBaseVersions(targetVersion, publishedVersion) <= 0) {
    throw new Error(
      `README rc 预发行版必须高于当前正式版：${targetVersion} 与 ${publishedVersion}`,
    );
  }
  const preview = /当前预发行版：`(\d+\.\d+\.\d+-rc\.[1-9]\d*)`/u.exec(readme);
  const currentVersion = preview?.[1];
  if (currentVersion && compareRcVersions(targetVersion, currentVersion) < 0) {
    throw new Error(
      `拒绝把 README rc 预发行版本降级：${currentVersion} -> ${targetVersion}`,
    );
  }
  for (const expected of [
    `codex-cli ${publishedVersion}`,
    `@openai/codex@${publishedVersion}`,
    `@hegenai/codexc@${publishedVersion}`,
  ]) {
    if (!readme.includes(expected)) {
      throw new Error(`README 正式安装说明缺少受控版本：${expected}`);
    }
  }

  const targetCodexVersion = baseVersion(targetVersion);
  let rendered = currentVersion
    ? readme
      .replaceAll(currentVersion, targetVersion)
      .replaceAll(
        `预发行版要求：macOS 或 Linux、Node.js 22.13+、已登录的 \`codex-cli ${baseVersion(currentVersion)}\``,
        `预发行版要求：macOS 或 Linux、Node.js 22.13+、已登录的 \`codex-cli ${targetCodexVersion}\``,
      )
      .replaceAll(`@openai/codex@${baseVersion(currentVersion)}`, `@openai/codex@${targetCodexVersion}`)
    : readme
      .replace(
        `当前正式版：\`${publishedVersion}\``,
        `当前正式版：\`${publishedVersion}\`\n当前预发行版：\`${targetVersion}\``,
      )
      .replace(
        new RegExp(
          `^要求：[^\\n]*\`codex-cli ${escapeRegExp(publishedVersion)}\`[^\\n]*$`,
          "mu",
        ),
        `$&\n预发行版要求：macOS 或 Linux、Node.js 22.13+、已登录的 \`codex-cli ${targetCodexVersion}\``,
      )
      .replace(
        `npm install -g @hegenai/codexc@${publishedVersion}`,
        `npm install -g @hegenai/codexc@${publishedVersion}\n\`\`\`\n\n测试下一正式版预发行包：\n\n\`\`\`bash\nnpm install -g @openai/codex@${targetCodexVersion}\nnpm install -g @hegenai/codexc@${targetVersion}`,
      );
  if (!rendered.includes(`@hegenai/codexc@${targetVersion}`)) {
    throw new Error(`README 预发行安装说明缺少受控版本：@hegenai/codexc@${targetVersion}`);
  }
  if (developmentVersion === targetCodexVersion) {
    rendered = rendered
      .replace(
        `\`main\` 开发基线：\`${developmentVersion}\`（尚未发布）`,
        `\`main\` 开发基线：\`${targetVersion}\``,
      )
      .replace(
        `\`main\` 开发基线：\`${developmentVersion}\``,
        `\`main\` 开发基线：\`${targetVersion}\``,
      );
  }
  if (developmentVersion === targetVersion) {
    rendered = rendered.replace(
      `\`main\` 开发基线：\`${targetVersion}\`（尚未发布）`,
      `\`main\` 开发基线：\`${targetVersion}\``,
    );
  }
  return rendered;
}

function renderFixReadme(readme, targetVersion, developmentVersion, publishedVersion) {
  if (baseVersion(targetVersion) !== publishedVersion) {
    throw new Error(
      `README 修复版基础版本必须等于当前正式版：${targetVersion} 与 ${publishedVersion}`,
    );
  }
  const preview = /当前修复预览版：`(\d+\.\d+\.\d+-fix[1-9]\d*)`/u.exec(readme);
  const currentVersion = preview?.[1] ?? publishedVersion;
  if (compareStableVersions(targetVersion, currentVersion) < 0) {
    throw new Error(
      `拒绝把 README 修复预览版本降级：${currentVersion} -> ${targetVersion}`,
    );
  }
  for (const expected of [
    `codex-cli ${publishedVersion}`,
    `@openai/codex@${publishedVersion}`,
    `@hegenai/codexc@${publishedVersion}`,
  ]) {
    if (!readme.includes(expected)) {
      throw new Error(`README 正式安装说明缺少受控版本：${expected}`);
    }
  }

  let rendered = preview
    ? readme.replaceAll(currentVersion, targetVersion)
    : readme
      .replace(
        `当前正式版：\`${publishedVersion}\``,
        `当前正式版：\`${publishedVersion}\`\n当前修复预览版：\`${targetVersion}\``,
      )
      .replace(
        `npm install -g @hegenai/codexc@${publishedVersion}`,
        `npm install -g @hegenai/codexc@${publishedVersion}\n\`\`\`\n\n测试修复预览版：\n\n\`\`\`bash\nnpm install -g @hegenai/codexc@${targetVersion}`,
      );
  if (!rendered.includes(`@hegenai/codexc@${targetVersion}`)) {
    throw new Error(`README 修复预览安装说明缺少受控版本：@hegenai/codexc@${targetVersion}`);
  }
  if (developmentVersion === targetVersion) {
    rendered = rendered.replace(
      `\`main\` 开发基线：\`${targetVersion}\`（尚未发布）`,
      `\`main\` 开发基线：\`${targetVersion}\``,
    );
  }
  return rendered;
}

function removeRcPreview(readme) {
  return readme
    .replace(/\n当前预发行版：`\d+\.\d+\.\d+-rc\.[1-9]\d*`/u, "")
    .replace(
      /\n预发行版要求：macOS 或 Linux、Node\.js 22\.13\+、已登录的 `codex-cli \d+\.\d+\.\d+`/u,
      "",
    )
    .replace(
      /\n\n测试下一正式版预发行包：\n\n```bash\nnpm install -g @openai\/codex@\d+\.\d+\.\d+\nnpm install -g @hegenai\/codexc@\d+\.\d+\.\d+-rc\.[1-9]\d*\n```/u,
      "",
    );
}

function compareStableVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return leftParts[3] - rightParts[3];
}

function compareBaseVersions(left, right) {
  const leftParts = baseVersion(left).split(".").map(Number);
  const rightParts = baseVersion(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function compareRcVersions(left, right) {
  const baseDifference = compareBaseVersions(left, right);
  if (baseDifference !== 0) return baseDifference;
  return rcNumber(left) - rcNumber(right);
}

function rcNumber(value) {
  return Number(value.split("-rc.", 2)[1]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function baseVersion(value) {
  return value.split("-", 1)[0];
}

function versionParts(value) {
  const [stable, suffix] = value.split("-", 2);
  return [...stable.split(".").map(Number), suffix ? Number(suffix.slice(3)) : 0];
}

function normalizeReleaseVersion(value) {
  return value.startsWith("v") ? value.slice(1) : value;
}

function main() {
  const rawVersion = process.argv[2]?.trim() || process.env.GITHUB_REF_NAME?.trim();
  if (!rawVersion) {
    throw new Error("缺少发布版本");
  }
  const targetVersion = normalizeReleaseVersion(rawVersion);
  const readmePath = resolve(packageDir, "README.md");
  const current = readFileSync(readmePath, "utf8");
  const rendered = renderPublishedReadme(current, targetVersion);
  if (rendered === current) {
    console.log(`README 已是发布版本 ${targetVersion}`);
    return;
  }
  writeFileSync(readmePath, rendered);
  console.log(`README 发布版本已同步至 ${targetVersion}`);
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main();
}
