import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");

export function renderUpgradeSummary(
  version,
  baseCommit,
  nameStatus,
  diffStat,
  channel = "stable",
  result = "success",
) {
  const entries = nameStatus.trim().split(/\r?\n/u).filter(Boolean);
  const protocolEntries = entries.filter((entry) =>
    entry.includes("src/codex-protocol/"));
  const isAlpha = channel === "alpha";
  const title = isAlpha ? "Alpha Canary" : "正式升级预览";
  const source = isAlpha
    ? "openai/codex 官方 GitHub Pre-release"
    : "openai/codex 正式 GitHub Release";
  return [
    `## Codex CLI ${version} ${title}`,
    "",
    `- 变更文件：${entries.length}`,
    `- 协议目录文件：${protocolEntries.length}`,
    `- 基线提交：${baseCommit}`,
    `- 来源：${source}`,
    `- 自动验证：${result === "success" ? "通过" : "失败，详见 Artifact 日志"}`,
    "- 状态：仅生成预览，未提交、未推送、未部署",
    ...(isAlpha
      ? ["- 限制：仅用于前向兼容预警，不可作为 main 的协议或版本基线"]
      : []),
    "",
    "### 差异统计",
    "",
    "```text",
    diffStat.trim() || "(没有文件差异)",
    "```",
    "",
    "### 文件清单",
    "",
    "```text",
    nameStatus.trim() || "(没有文件差异)",
    "```",
    "",
  ].join("\n");
}

export function collectGitDiff(repositoryRoot) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codexc-upgrade-index-"));
  const temporaryIndex = resolve(temporaryDirectory, "index");
  const gitEnvironment = { GIT_INDEX_FILE: temporaryIndex };
  try {
    git(repositoryRoot, ["read-tree", "HEAD"], gitEnvironment);
    git(repositoryRoot, ["add", "--all"], gitEnvironment);
    return {
      baseCommit: git(repositoryRoot, ["rev-parse", "HEAD"]).trim(),
      nameStatus: git(
        repositoryRoot,
        ["diff", "--cached", "--name-status", "--find-renames", "HEAD"],
        gitEnvironment,
      ),
      diffStat: git(
        repositoryRoot,
        ["diff", "--cached", "--stat", "HEAD"],
        gitEnvironment,
      ),
      patch: git(
        repositoryRoot,
        ["diff", "--cached", "--binary", "HEAD"],
        gitEnvironment,
      ),
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function main() {
  const [
    version,
    outputDirectory,
    channel = "stable",
    result = "success",
  ] = process.argv.slice(2);
  if (
    !/^\d+\.\d+\.\d+(?:-alpha(?:\.\d+)+)?$/u.test(version || "")
    || !outputDirectory
    || !["stable", "alpha"].includes(channel)
    || !["success", "failure"].includes(result)
  ) {
    throw new Error(
      "用法：node scripts/write-upgrade-report.mjs <版本> <输出目录> "
      + "[stable|alpha] [success|failure]",
    );
  }

  const output = resolve(outputDirectory);
  mkdirSync(output, { recursive: true });
  const diff = collectGitDiff(root);
  const summary = renderUpgradeSummary(
    version,
    diff.baseCommit,
    diff.nameStatus,
    diff.diffStat,
    channel,
    result,
  );

  writeFileSync(resolve(output, "base-commit.txt"), `${diff.baseCommit}\n`);
  writeFileSync(resolve(output, "result.txt"), `${result}\n`);
  writeFileSync(resolve(output, "changed-files.txt"), diff.nameStatus);
  writeFileSync(resolve(output, "diff-stat.txt"), diff.diffStat);
  writeFileSync(resolve(output, "upgrade.patch"), diff.patch);
  writeFileSync(resolve(output, "summary.md"), summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  console.log(`升级差异报告已写入：${output}`);
}

function git(repositoryRoot, args, extraEnvironment = {}) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...extraEnvironment },
  });
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main();
}
