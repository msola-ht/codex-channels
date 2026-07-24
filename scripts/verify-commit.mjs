import { spawnSync } from "node:child_process";

const checks = [
  {
    name: "Git 差异格式",
    command: "git",
    args: gitDiffArgs(),
  },
  { name: "类型与版本", command: "npm", args: ["run", "check"] },
  { name: "Lint", command: "npm", args: ["run", "lint"] },
  { name: "文档与索引", command: "npm", args: ["run", "docs:check"] },
  { name: "完整测试", command: "npm", args: ["test"] },
  { name: "Shell 语法", command: "bash", args: [
    "-n",
    "scripts/launchd-control.sh",
    "scripts/systemd-control.sh",
  ] },
  { name: "npm tarball 冒烟", command: "npm", args: ["run", "test:package"] },
];

if (process.platform === "darwin") {
  checks.push({
    name: "launchd 模板",
    command: "plutil",
    args: [
      "-lint",
      "launchd/com.hegenai.codex-app-server.plist.template",
      "launchd/com.hegenai.codex-gateway.plist.template",
    ],
  });
}

for (const check of checks) {
  console.log(`\n[提交检查] ${check.name}`);
  const result = spawnSync(check.command, check.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("\n提交前检查全部通过。");

function gitDiffArgs() {
  if (process.env.CI === "true") {
    return ["diff", "--check", "HEAD^", "HEAD"];
  }
  const staged = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: process.cwd(),
  });
  if (staged.error) {
    throw staged.error;
  }
  return staged.status === 0
    ? ["diff", "--check"]
    : ["diff", "--cached", "--check"];
}
