import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveExecutableInvocation, resolveOptionalExecutable } from "../runtime/executable.mjs";
import { packageDir } from "./package-path.mjs";
import { currentNpmGlobalPrefix, recordInstalledSourceMetadata } from "./source-install-metadata.mjs";
import { runInstallationCommand } from "./installation-command.mjs";
import { writeCliSection } from "./cli-operation-progress.mjs";

const sourceConfig = join(packageDir, "tsconfig.build.json");
const webuiDir = join(packageDir, "webui");
if (!existsSync(sourceConfig)) {
  throw new Error("install:global 只能在 codexc 源码仓库中运行");
}

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--prepared")) {
  throw new Error("用法：install-global-source.mjs [--prepared]");
}
async function install() {
  const alreadyPrepared = args.includes("--prepared");
  writeCliSection(alreadyPrepared ? "检查安装产物" : "构建准备");
  console.log(alreadyPrepared
    ? "[安装] 使用已有 Gateway/WebUI 构建产物安装全局 codexc 命令。"
    : "[构建] 准备 Gateway/WebUI 构建产物，随后安装全局 codexc 命令。");
  if (!alreadyPrepared) {
    await run(process.execPath, [join(packageDir, "scripts", "prepare-package.mjs")], packageDir, "准备并构建 Gateway");
    await buildWebui();
  }
  await assertPreparedBuild();
  await ensureCodexCli();
  await run(process.execPath, [join(packageDir, "scripts", "sandbox-dependencies.mjs")], packageDir, "检查沙盒运行依赖");
  const prefix = currentNpmGlobalPrefix();
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codexc-source-install-"));
  try {
    writeCliSection("安装程序");
    const tarballPath = await packSource(temporaryDirectory);
    console.log(`[安装] npm 全局目录：${prefix}`);
    await run("npm", [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--loglevel=error",
      "--no-audit",
      "--no-fund",
      tarballPath,
    ], packageDir, "安装全局 codexc 命令");
    recordInstalledSourceMetadata(packageDir, prefix);
    writeCliSection("安装结果与下一步");
    console.log(`[完成] 当前源码构建结果已安装为全局 codexc 命令：${prefix}`);
    console.log("[提示] 本步骤只安装程序；后台服务的安装与启动由初始化向导或外层更新流程处理。");
    try {
      // Configuration helpers depend on packages prepared by this installation.
      const { printSourceInstallNextSteps } = await import("./source-install-summary.mjs");
      printSourceInstallNextSteps();
    } catch {
      console.log("[提示] 无法生成后续指引；请运行 codexc doctor 检查配置与运行环境。");
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

try { await install(); }
catch (error) {
  console.error(error instanceof Error ? error.message : "源码安装失败");
  process.exitCode = error?.exitCode ?? 1;
}

async function assertPreparedBuild() {
  if (
    !lstatSync(join(packageDir, "dist", "main.js"), { throwIfNoEntry: false })?.isFile()
    || !lstatSync(join(webuiDir, "dist", "index.html"), { throwIfNoEntry: false })?.isFile()
  ) {
    throw new Error("预构建源码缺少 Gateway 或 WebUI 构建结果");
  }
  if (process.platform === "win32") await run("pwsh.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", join(packageDir, "runtime", "windows-native-load.ps1"),
  ], packageDir, "验证 Windows 原生产物");
}

async function packSource(destination) {
  const result = await runInstallationCommand("生成源码安装包", "npm", [
    "pack",
    "--ignore-scripts",
    "--loglevel=error",
    "--json",
    "--pack-destination",
    destination,
  ], { cwd: packageDir, captureStdout: true });
  const report = JSON.parse(result.stdout);
  const packageReport = Array.isArray(report) ? report[0] : Object.values(report)[0];
  if (!packageReport?.filename) {
    throw new Error("npm pack 未返回 tarball 文件名");
  }
  return resolve(destination, packageReport.filename);
}

async function buildWebui() {
  await run(
    "npm",
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    webuiDir, "安装 WebUI 依赖",
  );
  await run("npm", ["run", "build"], webuiDir, "构建 WebUI");
}

async function run(command, args, cwd, label) {
  await runInstallationCommand(label, command, args, { cwd });
}

// Source installation must work before init/setup; do not depend on channel configuration.
async function ensureCodexCli() {
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
    await run("npm", ["install", "--global", "--include=optional", "--no-audit", "--no-fund", `@openai/codex@${expected}`], packageDir, "安装 Codex CLI");
    installed = true;
    executable = resolveOptionalExecutable(command);
    if (!executable) throw new Error("Codex CLI 安装后仍不在 PATH，请将当前 npm 全局命令目录加入 PATH 后重新运行 npm run install:global");
  }
  const actual = readCodexVersion(executable, expected, configured);
  if (actual !== expected) {
    if (installed) throw new Error(`Codex CLI 安装版本不匹配：需要 ${expected}，当前 ${actual || "未知"}`);
    if (configured) throw new Error(`CODEX_BINARY 版本不匹配：需要 ${expected}，当前 ${actual || "未知"}；请更新指定文件后重试`);
    console.log(`Codex CLI 当前 ${actual || "未知"}，正在同步为项目锁定版本 ${expected}`);
    await run("npm", ["install", "--global", "--include=optional", "--no-audit", "--no-fund", `@openai/codex@${expected}`], packageDir, "同步 Codex CLI 版本");
    const refreshed = resolveOptionalExecutable("codex");
    if (!refreshed) throw new Error("Codex CLI 安装后仍不在 PATH，请修正 PATH 后重试");
    const verified = readCodexVersion(refreshed, expected, configured);
    if (verified !== expected) {
      throw new Error(`Codex CLI 同步后版本仍不匹配：需要 ${expected}，当前 ${verified || "未知"}；请检查 PATH 中的同名命令`);
    }
  }
  console.log(`[通过] Codex CLI 版本符合要求：${expected}`);
}

function readCodexVersion(executable, expected, configured) {
  const invocation = resolveExecutableInvocation(executable, ["--version"]);
  const result = spawnSync(invocation.file, invocation.args, {
    encoding: "utf8", windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) {
    throw new Error("Codex CLI 版本检查无法启动，请修复可执行文件或执行权限后重试安装");
  }
  if (result.status !== 0) {
    const missing = /Missing optional dependency (@openai\/codex-(?:linux|darwin|win32)-(?:x64|arm64))\. Reinstall Codex:/u.exec(result.stderr)?.[1];
    if (missing) {
      const repair = configured
        ? `请修复 CODEX_BINARY 指定的安装，确保包含原生依赖且版本为 ${expected} 后重试；安装器不会替换指定文件`
        : `请执行 npm install --global --include=optional @openai/codex@${expected} 后重试 npm run install:global`;
      throw new Error(`Codex CLI 无法启动：缺少原生依赖 ${missing}；${repair}`);
    }
    throw new Error(`Codex CLI 版本检查命令失败（exit=${result.status ?? "未知"}），请修复可执行文件后重试安装`);
  }
  const version = result.stdout.trim().split(/\s+/u).at(-1)?.replace(/^v/u, "");
  return /^\d+\.\d+\.\d+$/u.test(version ?? "") ? version : undefined;
}
