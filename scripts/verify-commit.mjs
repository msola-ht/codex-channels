import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { resolveExecutableInvocation } from "../runtime/executable.mjs";

const checks = [
  {
    name: "Git 差异格式",
    command: "git",
    args: gitDiffArgs(),
  },
  { name: "类型与版本", command: "npm", args: ["run", "check"] },
  { name: "Lint", command: "npm", args: ["run", "lint"] },
  {
    name: "WebUI 构建",
    command: "npm",
    args: ["run", "build"],
    cwd: "webui",
  },
  {
    name: "WebUI Lint",
    command: "npm",
    args: ["run", "lint"],
    cwd: "webui",
  },
  { name: "文档与索引", command: "npm", args: ["run", "docs:check"] },
  { name: "完整测试", command: "npm", args: ["test"] },
  { name: "Shell 语法", command: "bash", args: [
    "-n",
    "install.sh",
    "scripts/launchd-control.sh",
    "scripts/systemd-control.sh",
  ] },
  { name: "npm tarball 安装冒烟", command: "npm", args: ["run", "test:package:tarball-prepared"] },
];

if (process.platform === "darwin") {
  checks.push({
    name: "launchd 模板",
    command: "plutil",
    args: [
      "-lint",
      "launchd/com.hegenai.codex-app-server.plist.template",
      "launchd/com.hegenai.codex-gateway.plist.template",
      "launchd/com.hegenai.codex-webui.plist.template",
      "launchd/com.hegenai.codex-center.plist.template",
    ],
  });
}

const verificationStartedAt = performance.now();

for (const check of checks) {
  console.log(`\n[提交检查] ${check.name}`);
  const checkStartedAt = performance.now();
  const invocation = resolveExecutableInvocation(check.command, check.args);
  const result = spawnSync(invocation.file, invocation.args, {
    cwd: check.cwd === undefined ? process.cwd() : join(process.cwd(), check.cwd),
    env: process.env,
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
  `\n提交前检查全部通过。总耗时 ${formatDuration(performance.now() - verificationStartedAt)}`,
);

function gitDiffArgs() {
  if (process.env.CI === "true") {
    return ["diff", "--check", "HEAD^", "HEAD"];
  }
  const invocation = resolveExecutableInvocation("git", ["diff", "--cached", "--quiet"]);
  const staged = spawnSync(invocation.file, invocation.args, {
    cwd: process.cwd(),
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (staged.error) {
    throw staged.error;
  }
  return staged.status === 0
    ? ["diff", "--check"]
    : ["diff", "--cached", "--check"];
}

function formatDuration(milliseconds) {
  const seconds = milliseconds / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 2 : 1)} 秒`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${(seconds % 60).toFixed(1)} 秒`;
}
