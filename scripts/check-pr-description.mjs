import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const upgradeTitlePattern = /^升级 Codex CLI 至 \d+\.\d+\.\d+$/u;
const commonSections = ["新增", "修复", "改动"];
const upgradeSections = [
  "对本项目的收益",
  "本次采用",
  "本次不采用",
  "风险与验证",
];
const placeholderPattern = /(?:待 Codex|待填写|TODO|TBD)/iu;
const markdownCommentPattern = /<!--[\s\S]*?-->/gu;
const explicitNonePattern = /^(?:[-*]\s*)?无[。.]?$/u;
const minimumSectionLength = 4;

function sectionContent(body, section) {
  const heading = `## ${section}`;
  const lines = body.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start < 0) {
    return undefined;
  }
  const nextHeading = lines.findIndex((line, index) => (
    index > start && line.startsWith("## ")
  ));
  const end = nextHeading < 0 ? lines.length : nextHeading;
  return lines.slice(start + 1, end).join("\n")
    .replace(markdownCommentPattern, "")
    .trim();
}

function hasMeaningfulContent(content, allowExplicitNone) {
  if (!content || placeholderPattern.test(content)) {
    return false;
  }
  if (explicitNonePattern.test(content)) {
    return allowExplicitNone;
  }
  return content.length >= minimumSectionLength;
}

export function checkPullRequestDescription(event) {
  const pullRequest = event?.pull_request;
  if (!pullRequest || pullRequest.draft === true) {
    return { checked: false };
  }

  const body = pullRequest.body || "";
  const missing = commonSections.filter((section) => (
    !hasMeaningfulContent(sectionContent(body, section), true)
  ));

  if (upgradeTitlePattern.test(pullRequest.title || "")) {
    missing.push(...upgradeSections.filter((section) => (
      !hasMeaningfulContent(sectionContent(body, section), false)
    )));
  }

  if (missing.length) {
    throw new Error(
      `PR 转为 Ready 前必须写清以下章节：${missing.join("、")}。`
      + "没有对应的新增、修复或改动时必须明确写“无”，不能保留占位内容。",
    );
  }
  return { checked: true };
}

function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    console.log("非 GitHub Actions Pull Request 环境，跳过 PR 描述检查。");
    return;
  }
  const event = JSON.parse(readFileSync(resolve(eventPath), "utf8"));
  const result = checkPullRequestDescription(event);
  console.log(result.checked
    ? "PR 的新增、修复和改动分类完整。"
    : "Draft PR 暂不检查描述，转为 Ready 后执行门禁。");
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main();
}
