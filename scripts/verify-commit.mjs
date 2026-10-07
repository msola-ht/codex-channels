import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { resolveExecutableInvocation } from "../runtime/executable.mjs";
import { changedFiles, parseChangedFiles, verificationScope } from "./verification-scope.mjs";

const checkTypes = { name: "类型与版本", command: "npm", args: ["run", "check"] };
const rootLint = { name: "Lint", command: "npm", args: ["run", "lint"] };
const webuiBuild = { name: "WebUI 构建", command: "npm", args: ["run", "build"], cwd: "webui" };
const webuiLint = { name: "WebUI Lint", command: "npm", args: ["run", "lint"], cwd: "webui" };
const dictionary = { name: "WebUI 翻译字典", command: "npm", args: ["run", "i18n:check"] };
const docs = { name: "文档与索引", command: "npm", args: ["run", "docs:check"] };
// Emission follows the full incremental source/test type check. Ordinary npm test
// and npm run build retain their independent type checking.
const gatewayBuild = { name: "Gateway 构建", command: "npm", args: ["run", "build", "--", "--noCheck"] };
const shell = { name: "Shell 语法", command: "bash", args: [
    "-n",
    "install.sh",
    "scripts/launchd-control.sh",
    "scripts/systemd-control.sh",
  ] };
const templates = { name: "launchd 模板", command: "plutil", args: [
  "-lint", "launchd/com.hegenai.codex-app-server.plist.template",
  "launchd/com.hegenai.codex-gateway.plist.template", "launchd/com.hegenai.codex-webui.plist.template",
] };

function allTests() {
  return { name: "完整测试", command: process.execPath,
    args: ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.config.ts"] };
}

export function createVerificationPlan(changes, { ci = false, root = process.cwd(), platform = process.platform } = {}) {
  if (ci) return { reason: "PR 完整回归；安装和真实合同由专项任务按变更范围执行", checks: [
    checkTypes, rootLint, webuiBuild, webuiLint, dictionary, docs, gatewayBuild, allTests(),
    ...(platform === "win32" ? [] : [shell]), ...(platform === "darwin" ? [templates] : []),
  ] };

  const scope = verificationScope(changes);
  const paths = changes.map(change => change.path);
  const code = paths.filter(path => !path.endsWith(".md"));
  const lintFiles = code.filter(path => /^(?:src|tests|bin|runtime|scripts)\/.*\.(?:ts|mjs)$/u.test(path)
    && !path.startsWith("src/codex-protocol/generated/") && existsSync(join(root, path)));
  const checks = code.length ? [checkTypes] : [];
  const fullLint = code.some(path => /^(?:package(?:-lock)?\.json|eslint\.config\.mjs)$/u.test(path));
  if (fullLint) checks.push(rootLint);
  else if (lintFiles.length) checks.push({ name: "变更文件 Lint", command: process.execPath,
    args: ["node_modules/eslint/bin/eslint.js", ...lintFiles] });
  if (paths.some(path => path.endsWith(".md")) || code.some(path => /^(?:src|scripts|bin|runtime|tests|\.github)\//u.test(path))) checks.push(docs);
  const webui = code.some(path => path.startsWith("webui/"));
  if (webui || scope.package) checks.push(webuiBuild, webuiLint, dictionary);
  if (code.some(path => /\.(?:sh|ps1)$/u.test(path) || /^(?:launchd|systemd)\//u.test(path))) {
    if (platform !== "win32") checks.push(shell);
    if (platform === "darwin") checks.push(templates);
  }

  let reason = "仅文档变更，无需执行测试";
  if (code.length) {
    checks.push(gatewayBuild);
    const requiresCi = changes.some(change => change.status === "D" && !change.path.endsWith(".md"))
      || code.length > 100 || code.some(path => !/^(?:src|tests|bin|runtime|scripts|webui)\/.*\.(?:ts|tsx|js|jsx|mjs)$/u.test(path));
    reason = requiresCi
      ? "删除、共享配置或无法可靠界定影响：本地静态检查及直接相关测试；PR CI 执行完整回归"
      : "本地静态检查及依赖图直接相关测试（含 dist 消费者）；动态文件读取、CLI/子进程集成由 PR CI 完整回归覆盖";
    const inputs = relatedInputs(code, root);
    if (inputs.length) {
      checks.push({ name: "受影响测试", command: process.execPath, args: [
        "node_modules/vitest/vitest.mjs", "related", "--run", "--passWithNoTests", "--config", "vitest.config.ts",
        ...inputs,
      ] });
    } else reason += "；无可用于依赖图选择的现存代码输入，本地测试未执行";
  }
  return { reason, checks };
}

function relatedInputs(paths, root) {
  const existingCode = paths.filter(path => /^(?:src|tests|bin|runtime|scripts|webui)\/.*\.(?:ts|tsx|js|jsx|mjs)$/u.test(path)
    && existsSync(join(root, path)));
  const inputs = new Set(existingCode.map(path => resolve(root, path)));
  for (const path of existingCode.filter(path => path.startsWith("src/") && path.endsWith(".ts"))) {
    inputs.add(resolve(root, "dist", path.slice(4).replace(/\.ts$/u, ".js")));
  }
  return [...inputs];
}

function runChecks(checks) {
  const verificationStartedAt = performance.now();
  for (const check of checks) {
    console.log(`\n[提交检查] ${check.name}`);
    const checkStartedAt = performance.now();
    const invocation = resolveExecutableInvocation(check.command, check.args);
    const result = spawnSync(invocation.file, invocation.args, {
      cwd: check.cwd === undefined ? process.cwd() : join(process.cwd(), check.cwd),
      env: { ...process.env, ...check.environment },
      stdio: "inherit",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    const checkDuration = formatDuration(performance.now() - checkStartedAt);
    const cumulativeDuration = formatDuration(performance.now() - verificationStartedAt);
    if (result.error) {
      console.error(
        `[提交检查] ${check.name} 失败（本阶段 ${checkDuration}，累计耗时 ${cumulativeDuration}）`,
      );
      throw result.error;
    }
    if (result.status !== 0) {
      console.error(
        `[提交检查] ${check.name} 失败（本阶段 ${checkDuration}，累计耗时 ${cumulativeDuration}）`,
      );
      process.exit(result.status ?? 1);
    }
    console.log(
      `[提交检查] ${check.name} 通过（本阶段 ${checkDuration}，累计耗时 ${cumulativeDuration}）`,
    );
  }
  console.log(
    `\n验证全部通过。总耗时 ${formatDuration(performance.now() - verificationStartedAt)}`,
  );
}

function main() {
  const args = process.argv.slice(2);
  const ci = args.length === 1 && args[0] === "--ci";
  const changesFile = args.length === 2 && args[0] === "--changes-file" ? args[1] : undefined;
  if (args.length && !ci && !changesFile) throw new Error("用法：verify-commit.mjs [--ci|--changes-file <path>]");
  let changes = [];
  let diffArgs = ["diff", "--check", "HEAD^", "HEAD"];
  if (!ci && changesFile) changes = parseChangedFiles(readFileSync(changesFile, "utf8"));
  else if (!ci) {
    changes = changedFiles(["--cached"]);
    diffArgs = ["diff", "--cached", "--check"];
    if (!changes.length) {
      changes = changedFiles([]);
      diffArgs = ["diff", "--check"];
      for (const path of execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean)) {
        changes.push({ status: "A", path });
      }
    }
  }
  const plan = createVerificationPlan(changes, { ci });
  console.log(`[验证范围] ${plan.reason}`);
  runChecks([
    // The hook already checked the actual commit index before clearing Git env.
    ...(!changesFile ? [{ name: "Git 差异格式", command: "git", args: diffArgs }] : []),
    ...plan.checks,
  ]);
}

function formatDuration(milliseconds) {
  const seconds = milliseconds / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 2 : 1)} 秒`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${(seconds % 60).toFixed(1)} 秒`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
