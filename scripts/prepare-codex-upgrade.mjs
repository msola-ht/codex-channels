import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareStableVersions,
  resolveOfficialRelease,
} from "./resolve-codex-release.mjs";

const root = resolve(import.meta.dirname, "..");
const versionPattern = /^\d+\.\d+\.\d+$/u;

export function parseUpgradeArguments(args) {
  if (args.includes("-h") || args.includes("--help")) {
    return { help: true, dryRun: false };
  }

  const dryRun = args.includes("--dry-run");
  const positional = args.filter((argument) => argument !== "--dry-run");
  if (positional.length !== 1 || !versionPattern.test(positional[0])) {
    throw new Error("用法：npm run codex:upgrade -- <正式发行版本> [--dry-run]");
  }
  return { help: false, dryRun, targetVersion: positional[0] };
}

export function parseCodexCliVersion(output) {
  const match = /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(output.trim());
  if (!match) {
    throw new Error(`无法解析 Codex CLI 版本：${output.trim() || "(空输出)"}`);
  }
  return match[1];
}

export function assertCleanWorktree(status) {
  if (status.trim()) {
    throw new Error(
      "升级前工作区必须干净；请先让 Codex 审查并处理现有改动，避免协议生成混入其他工作。",
    );
  }
}

export function assertVersionTransition(currentVersion, targetVersion) {
  const comparison = compareStableVersions(targetVersion, currentVersion);
  if (comparison === 0) {
    throw new Error(`项目已经锁定 Codex CLI ${targetVersion}，无需再次准备升级。`);
  }
  if (comparison < 0) {
    throw new Error(`拒绝降级 Codex CLI：项目是 ${currentVersion}，目标是 ${targetVersion}`);
  }
}

export function upgradeReviewChecklist(targetVersion) {
  return [
    `已生成 Codex CLI ${targetVersion} 的版本专属协议类型并同步 Gateway 版本。`,
    "下一步请让 Codex 按 docs/codex-cli-upgrade.md 审查当前差异、修复业务适配并更新文档。",
    "在 Codex 完成审查前，不要提交、发布或重建正式服务。",
  ];
}

async function main() {
  let options;
  try {
    options = parseUpgradeArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    console.log([
      "准备 Codex CLI 协议升级，不自动安装 CLI，也不自动修改业务实现。",
      "",
      "用法：",
      "  npm run codex:upgrade -- <正式发行版本> [--dry-run]",
    ].join("\n"));
    return;
  }

  const codex = process.env.CODEX_BINARY || "codex";
  if (resolve(process.cwd()) !== root) {
    throw new Error(`请在源码仓库根目录运行升级命令：${root}`);
  }
  const gitRoot = run("git", ["rev-parse", "--show-toplevel"]).trim();
  if (resolve(gitRoot) !== root) {
    throw new Error(`脚本必须从当前源码仓库运行：${root}`);
  }
  assertCleanWorktree(run("git", ["status", "--porcelain=v1", "--untracked-files=all"]));

  const protocolMetadata = JSON.parse(
    readFileSync(resolve(root, "src/codex-protocol/version.json"), "utf8"),
  );
  const currentVersion = parseCodexCliVersion(protocolMetadata.codexCli);
  assertVersionTransition(currentVersion, options.targetVersion);
  await resolveOfficialRelease(options.targetVersion);

  const installedVersion = parseCodexCliVersion(run(codex, ["--version"]));
  if (installedVersion !== options.targetVersion) {
    throw new Error(
      `本机 Codex CLI 是 ${installedVersion}，目标是 ${options.targetVersion}；请先安装精确目标版本。`,
    );
  }

  console.log(`当前协议版本：${currentVersion}`);
  console.log(`目标 CLI 版本：${options.targetVersion}`);
  if (options.dryRun) {
    console.log("预检通过；--dry-run 未修改文件。");
    return;
  }

  run(process.execPath, [resolve(root, "scripts/generate-protocol.mjs")], {
    CODEX_BINARY: codex,
  });
  run(process.execPath, [resolve(root, "scripts/check-protocol.mjs")], {
    CODEX_BINARY: codex,
  });
  run(process.execPath, [resolve(root, "scripts/check-gateway-version.mjs")]);

  const changed = run("git", ["status", "--short"]).trim();
  if (!changed) {
    throw new Error("升级命令没有产生文件差异，请检查目标 CLI 和生成器输出。");
  }

  console.log("\n升级准备产生的文件：");
  console.log(changed);
  console.log(`\n${upgradeReviewChecklist(options.targetVersion).join("\n")}`);
}

function run(command, args, extraEnv = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "inherit"],
  });
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  await main();
}
