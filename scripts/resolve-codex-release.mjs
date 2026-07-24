import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchCodexReleaseJson } from "./codex-release-api.mjs";

const stableVersionPattern = /^\d+\.\d+\.\d+$/u;
const repository = "openai/codex";

export function validateOfficialRelease(release, requestedVersion) {
  if (!release || typeof release !== "object") {
    throw new Error("GitHub API 没有返回有效的 Codex Release。");
  }
  const tag = release.tag_name;
  const version = typeof tag === "string" && tag.startsWith("rust-v")
    ? tag.slice("rust-v".length)
    : "";
  if (
    !stableVersionPattern.test(version)
    || release.draft !== false
    || release.prerelease !== false
  ) {
    throw new Error(`只允许 openai/codex 的正式发行版，收到：${tag || "(无 Tag)"}`);
  }
  if (requestedVersion && version !== requestedVersion) {
    throw new Error(`官方 Release 版本不匹配：请求 ${requestedVersion}，返回 ${version}`);
  }
  return {
    version,
    tag,
    url: release.html_url,
  };
}

export function compareStableVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

export async function resolveOfficialRelease(requestedVersion) {
  const endpoint = requestedVersion
    ? `https://api.github.com/repos/${repository}/releases/tags/rust-v${requestedVersion}`
    : `https://api.github.com/repos/${repository}/releases/latest`;
  return validateOfficialRelease(
    await fetchCodexReleaseJson(endpoint),
    requestedVersion,
  );
}

async function main() {
  const requestedVersion = process.argv[2]?.trim() || undefined;
  if (requestedVersion && !stableVersionPattern.test(requestedVersion)) {
    throw new Error("目标版本必须是正式发行版本，例如 0.146.0；不接受 alpha、beta 或 rc。");
  }

  const resolved = await resolveOfficialRelease(requestedVersion);
  const packageMetadata = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
  );
  const comparison = compareStableVersions(resolved.version, packageMetadata.version);
  if (comparison < 0) {
    throw new Error(
      `拒绝降级 Codex CLI：项目是 ${packageMetadata.version}，目标是 ${resolved.version}`,
    );
  }
  const upgradeAvailable = comparison > 0;
  console.log(`官方 Codex 正式发行版：${resolved.tag}`);
  console.log(upgradeAvailable
    ? `发现可用升级：${packageMetadata.version} → ${resolved.version}`
    : `项目已经使用该正式版本：${packageMetadata.version}`);
  console.log(resolved.url);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `version=${resolved.version}`,
        `tag=${resolved.tag}`,
        `url=${resolved.url}`,
        `upgrade_available=${upgradeAvailable}`,
        "",
      ].join("\n"),
    );
  }
  if (!upgradeAvailable && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Codex CLI 升级检查\n\n当前项目已是最新正式版：${resolved.version}\n`,
    );
  }
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  await main();
}
