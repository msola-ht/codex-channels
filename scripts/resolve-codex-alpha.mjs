import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchCodexReleaseJson } from "./codex-release-api.mjs";

const alphaVersionPattern = /^\d+\.\d+\.\d+-alpha(?:\.\d+)+$/u;
const repository = "openai/codex";

export function validateOfficialAlphaRelease(release) {
  if (!release || typeof release !== "object") {
    throw new Error("GitHub API 没有返回有效的 Codex Pre-release。");
  }
  const tag = release.tag_name;
  const version = typeof tag === "string" && tag.startsWith("rust-v")
    ? tag.slice("rust-v".length)
    : "";
  if (
    !alphaVersionPattern.test(version)
    || release.draft !== false
    || release.prerelease !== true
  ) {
    throw new Error(`不是有效的 openai/codex Alpha Release：${tag || "(无 Tag)"}`);
  }
  return {
    version,
    tag,
    url: release.html_url,
  };
}

export function selectLatestOfficialAlpha(releases) {
  if (!Array.isArray(releases)) {
    throw new Error("GitHub API 没有返回 Codex Release 列表。");
  }
  const candidates = releases.flatMap((release) => {
    try {
      return [validateOfficialAlphaRelease(release)];
    } catch {
      return [];
    }
  });
  candidates.sort((left, right) => compareAlphaVersions(right.version, left.version));
  if (candidates.length === 0) {
    throw new Error("没有找到 openai/codex 官方 Alpha Release。");
  }
  return candidates[0];
}

export function compareAlphaVersions(left, right) {
  const leftParts = alphaVersionParts(left);
  const rightParts = alphaVersionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

async function main() {
  const releases = await fetchCodexReleaseJson(
    `https://api.github.com/repos/${repository}/releases?per_page=100`,
  );
  const resolved = selectLatestOfficialAlpha(releases);
  console.log(`官方 Codex 最新 Alpha：${resolved.tag}`);
  console.log(resolved.url);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${resolved.version}\ntag=${resolved.tag}\nurl=${resolved.url}\n`,
    );
  }
}

function alphaVersionParts(version) {
  if (!alphaVersionPattern.test(version)) {
    throw new Error(`无法解析 Codex Alpha 版本：${version}`);
  }
  return version
    .replace("-alpha", "")
    .split(".")
    .map(Number);
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  await main();
}
