import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { packageDir } from "./runtime-config.mjs";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "codexc-package-smoke-"));
const environment = {
  ...process.env,
  npm_config_cache: join(temporaryDirectory, "npm-cache"),
};
let tarballPath;

try {
  const packed = run("npm", ["pack", "--ignore-scripts", "--json"], packageDir, environment, true);
  const report = JSON.parse(packed.stdout);
  const packageReport = Array.isArray(report) ? report[0] : Object.values(report)[0];
  if (!packageReport?.filename) {
    throw new Error("npm pack 未返回 tarball 文件名");
  }
  tarballPath = resolve(packageDir, packageReport.filename);
  run(
    "npm",
    ["install", "--prefix", temporaryDirectory, "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
    packageDir,
    environment,
  );

  const binDirectory = join(temporaryDirectory, "node_modules", ".bin");
  const shortCommand = join(binDirectory, "codexc");
  const longCommand = join(binDirectory, "codex-connect");
  if (!existsSync(shortCommand) || !existsSync(longCommand)) {
    throw new Error("tarball 安装后缺少 codexc 或 codex-connect 命令");
  }
  const version = run(shortCommand, ["--version"], temporaryDirectory, environment, true).stdout.trim();
  const help = run(longCommand, ["--help"], temporaryDirectory, environment, true).stdout;
  if (version !== packageReport.version) {
    throw new Error(`CLI 版本不匹配：实际 ${version}，期望 ${packageReport.version}`);
  }
  if (!help.includes("doctor ") || !help.includes("service install")) {
    throw new Error("CLI 帮助缺少公开命令");
  }
  console.log(`tarball 安装冒烟通过：${packageReport.name}@${packageReport.version}`);
} finally {
  if (tarballPath) {
    rmSync(tarballPath, { force: true });
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function run(command, args, cwd, env, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(`${command} 执行失败：exit=${result.status ?? 1}${detail}`);
  }
  return result;
}
