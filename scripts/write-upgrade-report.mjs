import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeProtocolDiff } from "./analyze-upgrade-protocol.mjs";

const root = resolve(import.meta.dirname, "..");

export function renderUpgradeSummary(
  version,
  baseCommit,
  nameStatus,
  diffStat,
  channel = "stable",
  result = "success",
  validation = undefined,
) {
  const entries = nameStatus.trim().split(/\r?\n/u).filter(Boolean);
  const protocolEntries = entries.filter((entry) =>
    entry.includes("src/codex-protocol/"));
  const isAlpha = channel === "alpha";
  const title = isAlpha ? "Alpha Canary" : "正式升级提案";
  const source = isAlpha
    ? "openai/codex 官方 GitHub Pre-release"
    : "openai/codex 正式 GitHub Release";
  const validationLines = validation?.stages?.length
    ? [
        "",
        "### 分阶段验证",
        "",
        "| 阶段 | 结果 | 日志或说明 |",
        "| --- | --- | --- |",
        ...validation.stages.map((stage) =>
          `| ${stage.name} | ${renderStageResult(stage)} | `
          + `${stage.log ? `\`${stage.log}\`` : stage.reason || "-"} |`),
      ]
    : [];
  return [
    `## Codex CLI ${version === "unresolved" ? "目标版本尚未解析" : version} ${title}`,
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
    ...validationLines,
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
    !(
      /^\d+\.\d+\.\d+(?:-alpha(?:\.\d+)+)?$/u.test(version || "")
      || (version === "unresolved" && result === "failure")
    )
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
  const validation = readValidationResults(output);
  const resolutionStatus = normalizeStageStatus(process.env.RESOLUTION_OUTCOME);
  const installStatus = normalizeStageStatus(process.env.INSTALL_OUTCOME);
  const generationStatus = normalizeStageStatus(process.env.GENERATION_OUTCOME);
  const stages = [
    ...(resolutionStatus
      ? [{
          id: "resolution",
          name: "解析官方 Codex Release",
          status: resolutionStatus,
          log: "logs/resolve.log",
        }]
      : []),
    ...(installStatus
      ? [{
          id: "install",
          name: "安装目标 Codex CLI",
          status: installStatus,
          log: installStatus === "skipped" ? null : "logs/install.log",
          ...(installStatus === "skipped"
            ? { reason: "前置条件未满足" }
            : {}),
        }]
      : []),
    ...(generationStatus
      ? [{
          id: "generation",
          name: "生成目标协议",
          status: generationStatus,
          log: generationStatus === "skipped" ? null : "logs/generation.log",
          ...(generationStatus === "skipped"
            ? { reason: "目标 CLI 安装未成功" }
            : {}),
        }]
      : []),
    ...(validation?.stages || []),
  ];
  const completeValidation = stages.length
    ? { schemaVersion: 1, result, stages }
    : undefined;
  const summary = renderUpgradeSummary(
    version,
    diff.baseCommit,
    diff.nameStatus,
    diff.diffStat,
    channel,
    result,
    completeValidation,
  );
  const protocolImpact = analyzeProtocolDiff(root, diff.nameStatus);
  const baseVersion = readProtocolVersionAtHead(root);

  writeFileSync(resolve(output, "base-commit.txt"), `${diff.baseCommit}\n`);
  writeFileSync(resolve(output, "base-version.txt"), `${baseVersion}\n`);
  writeFileSync(resolve(output, "target-version.txt"), `${version}\n`);
  writeFileSync(resolve(output, "result.txt"), `${result}\n`);
  writeFileSync(resolve(output, "changed-files.txt"), diff.nameStatus);
  writeFileSync(resolve(output, "diff-stat.txt"), diff.diffStat);
  writeFileSync(resolve(output, "upgrade.patch"), diff.patch);
  writeFileSync(resolve(output, "protocol-impact.md"), protocolImpact);
  writeFileSync(resolve(output, "summary.md"), summary);
  if (completeValidation) {
    writeFileSync(
      resolve(output, "results.json"),
      `${JSON.stringify(completeValidation, null, 2)}\n`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  console.log(`升级差异报告已写入：${output}`);
}

function readValidationResults(output) {
  const path = resolve(output, "validation-results.json");
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function normalizeStageStatus(value) {
  if (!value) {
    return undefined;
  }
  return {
    success: "passed",
    failure: "failed",
    skipped: "skipped",
    cancelled: "skipped",
  }[value] || "error";
}

function renderStageResult(stage) {
  const label = {
    passed: "通过",
    failed: "失败",
    error: "无法执行",
    skipped: "跳过",
  }[stage.status] || stage.status;
  return stage.exitCode === null || stage.exitCode === undefined
    ? label
    : `${label}（exit ${stage.exitCode}）`;
}

function readProtocolVersionAtHead(repositoryRoot) {
  const metadata = JSON.parse(git(repositoryRoot, [
    "show",
    "HEAD:src/codex-protocol/version.json",
  ]));
  return metadata.codexCli.replace(/^codex-cli /u, "");
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
