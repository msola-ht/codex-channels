import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const upgradeTitlePattern = /^升级 Codex CLI 至 \d+\.\d+\.\d+$/u;
const requiredSections = [
  "对本项目的收益",
  "本次采用",
  "本次不采用",
  "风险与验证",
];
const placeholderPattern = /(?:待 Codex|待填写|TODO|TBD)/iu;
const minimumSectionLength = 12;

export function checkUpgradePullRequestDescription(event) {
  const pullRequest = event?.pull_request;
  if (
    !pullRequest
    || pullRequest.draft === true
    || !upgradeTitlePattern.test(pullRequest.title || "")
  ) {
    return { checked: false };
  }

  const body = pullRequest.body || "";
  const missing = [];
  for (const section of requiredSections) {
    const heading = `## ${section}`;
    const start = body.indexOf(heading);
    if (start < 0) {
      missing.push(section);
      continue;
    }
    const contentStart = start + heading.length;
    const nextHeadingOffset = body.slice(contentStart).search(/\n## /u);
    const nextHeading = nextHeadingOffset < 0
      ? body.length
      : contentStart + nextHeadingOffset;
    const content = body.slice(
      contentStart,
      nextHeading,
    ).trim();
    if (
      content.length < minimumSectionLength
      || placeholderPattern.test(content)
    ) {
      missing.push(section);
    }
  }

  if (missing.length) {
    throw new Error(
      `升级 PR 转为 Ready 前必须写清以下章节：${missing.join("、")}。`
      + "不能保留待填写占位内容。",
    );
  }
  return { checked: true };
}

function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    console.log("非 GitHub Actions Pull Request 环境，跳过升级 PR 描述检查。");
    return;
  }
  const event = JSON.parse(readFileSync(resolve(eventPath), "utf8"));
  const result = checkUpgradePullRequestDescription(event);
  console.log(result.checked
    ? "Codex CLI 升级 PR 的项目收益与取舍说明完整。"
    : "不是已就绪的 Codex CLI 升级 PR，跳过描述检查。");
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main();
}
