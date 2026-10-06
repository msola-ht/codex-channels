import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveExecutableInvocation, resolveOptionalExecutable } from "../runtime/executable.mjs";
import { packageDir } from "./package-path.mjs";
import { ensureSandboxDependencies } from "./sandbox-dependencies.mjs";

const sourceConfig = join(packageDir, "tsconfig.build.json");
const webuiDir = join(packageDir, "webui");
if (!existsSync(sourceConfig)) {
  throw new Error("install:global 只能在 codexc 源码仓库中运行");
}

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--prepared")) {
  throw new Error("用法：install-global-source.mjs [--prepared]");
}
const alreadyPrepared = args.includes("--prepared");
const prepared = alreadyPrepared
  ? assertPreparedBuild()
  : run(process.execPath, [join(packageDir, "scripts", "prepare-package.mjs")]);
const webuiBuilt = prepared === 0 && !alreadyPrepared ? buildWebui() : prepared;
if (prepared === 0 && webuiBuilt === 0) {
  ensureCodexCli();
  ensureSandboxDependencies();
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codexc-source-install-"));
  try {
    const tarballPath = packSource(temporaryDirectory);
    process.exitCode = runQuiet("npm", [
      "install",
      "--global",
      "--ignore-scripts",
      "--loglevel=error",
      "--no-audit",
      "--no-fund",
      tarballPath,
    ]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
} else {
  process.exitCode = prepared === 0 ? webuiBuilt : prepared;
}

function assertPreparedBuild() {
  if (
    !existsSync(join(packageDir, "dist", "main.js"))
    || !existsSync(join(webuiDir, "dist", "index.html"))
  ) {
    throw new Error("预构建源码缺少 Gateway 或 WebUI 构建结果");
  }
  return 0;
}

function packSource(destination) {
  const invocation = resolveExecutableInvocation("npm", [
    "pack",
    "--ignore-scripts",
    "--loglevel=error",
    "--json",
    "--pack-destination",
    destination,
  ]);
  const result = spawnSync(
    invocation.file,
    invocation.args,
    {
      cwd: packageDir,
      encoding: "utf8",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `源码打包失败：exit=${result.status ?? 1}\n${result.stderr || result.stdout}`,
    );
  }
  const report = JSON.parse(result.stdout);
  const packageReport = Array.isArray(report) ? report[0] : Object.values(report)[0];
  if (!packageReport?.filename) {
    throw new Error("npm pack 未返回 tarball 文件名");
  }
  return resolve(destination, packageReport.filename);
}

function buildWebui() {
  const installed = run(
    "npm",
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    webuiDir,
  );
  if (installed !== 0) return installed;
  return run("npm", ["run", "build"], webuiDir);
}

function run(command, args, cwd = packageDir) {
  const invocation = resolveExecutableInvocation(command, args);
  const result = spawnSync(invocation.file, invocation.args, {
    cwd,
    stdio: "inherit",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

function runQuiet(command, args, cwd = packageDir) {
  const invocation = resolveExecutableInvocation(command, args);
  const result = spawnSync(invocation.file, invocation.args, {
    cwd,
    encoding: "utf8",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return result.status ?? 1;
}

// Source installation must work before init/setup; do not depend on channel configuration.
function ensureCodexCli() {
  const metadata = JSON.parse(readFileSync(join(packageDir, "src", "codex-protocol", "version.json"), "utf8"));
  const expected = /^codex-cli (\d+\.\d+\.\d+)$/u.exec(metadata.codexCli)?.[1];
  if (!expected) throw new Error("源码协议元数据缺少正式 Codex CLI 版本");
  const selected = process.env.CODEX_BINARY?.trim();
  const configured = selected === "codex" ? undefined : selected;
  const command = configured || "codex";
  let executable = resolveOptionalExecutable(command);
  let installed = false;
  if (!executable) {
    if (configured) throw new Error("CODEX_BINARY 指定的可执行文件不存在，请修正后重新安装");
    console.log(`未检测到 Codex CLI，正在安装 @openai/codex@${expected}`);
    if (run("npm", ["install", "--global", "--no-audit", "--no-fund", `@openai/codex@${expected}`]) !== 0) {
      throw new Error(`Codex CLI 安装失败；请检查 npm 全局目录权限后重试 npm run install:global`);
    }
    installed = true;
    executable = resolveOptionalExecutable(command);
    if (!executable) throw new Error("Codex CLI 安装后仍不在 PATH，请将当前 npm 全局命令目录加入 PATH 后重新运行 npm run install:global");
  }
  const invocation = resolveExecutableInvocation(executable, ["--version"]);
  const result = spawnSync(invocation.file, invocation.args, {
    encoding: "utf8", windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error || result.status !== 0) throw new Error("Codex CLI 版本检查失败，请修复可执行文件后重试安装");
  const actual = result.stdout.trim().split(/\s+/u).at(-1)?.replace(/^v/u, "");
  if (actual !== expected) {
    if (installed) throw new Error(`Codex CLI 安装版本不匹配：需要 ${expected}，当前 ${actual || "未知"}`);
    if (configured) throw new Error(`CODEX_BINARY 版本不匹配：需要 ${expected}，当前 ${actual || "未知"}；请更新指定文件后重试`);
    console.log(`Codex CLI 当前 ${actual || "未知"}，正在同步为项目锁定版本 ${expected}`);
    if (run("npm", ["install", "--global", "--no-audit", "--no-fund", `@openai/codex@${expected}`]) !== 0) {
      throw new Error("Codex CLI 版本同步失败；请检查 npm 全局目录权限后重试 npm run install:global");
    }
    const refreshed = resolveOptionalExecutable("codex");
    if (!refreshed) throw new Error("Codex CLI 安装后仍不在 PATH，请修正 PATH 后重试");
    const check = resolveExecutableInvocation(refreshed, ["--version"]);
    const verified = spawnSync(check.file, check.args, { encoding: "utf8", windowsVerbatimArguments: check.windowsVerbatimArguments });
    if (verified.error || verified.status !== 0 || verified.stdout.trim().split(/\s+/u).at(-1)?.replace(/^v/u, "") !== expected) {
      throw new Error(`Codex CLI 同步后版本仍不匹配：需要 ${expected}；请检查 PATH 中的同名命令`);
    }
  } else {
    console.log(`Codex CLI ${expected} 检测通过；首次使用继续运行 codexc init、codexc setup、codexc install。`);
  }
}
