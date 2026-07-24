import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { packageDir } from "./runtime-config.mjs";

const hooksPath = ".githooks";

export function installGitHooks(root = packageDir) {
  const repositoryRoot = resolve(root);
  if (!existsSync(join(repositoryRoot, ".git"))) {
    return { changed: false, installed: false };
  }
  const preCommitPath = join(repositoryRoot, hooksPath, "pre-commit");
  if (!existsSync(preCommitPath)) {
    throw new Error("仓库缺少 .githooks/pre-commit");
  }
  if ((statSync(preCommitPath).mode & 0o111) === 0) {
    throw new Error(".githooks/pre-commit 缺少可执行权限");
  }

  const current = runGit(
    ["config", "--local", "--get", "core.hooksPath"],
    repositoryRoot,
    true,
  ).stdout.trim();
  if (current === hooksPath) {
    return { changed: false, installed: true };
  }

  runGit(["config", "--local", "core.hooksPath", hooksPath], repositoryRoot);
  return { changed: true, installed: true };
}

function runGit(args, cwd, allowUnset = false) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !(allowUnset && result.status === 1)) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} 执行失败`);
  }
  return result;
}

function isDirectExecution() {
  return process.argv[1]
    ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
    : false;
}

if (isDirectExecution()) {
  const result = installGitHooks();
  if (!result.installed) {
    console.log("当前目录不是源码 Git 仓库，跳过 hooks 安装。");
  } else if (result.changed) {
    console.log("已启用仓库 .githooks/pre-commit。");
  } else {
    console.log("仓库 pre-commit hook 已启用。");
  }
}
