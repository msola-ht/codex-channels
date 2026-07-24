import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { writeGatewayConfig } from "../runtime/gateway-config.mjs";
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
  const command = join(binDirectory, "codexc");
  if (!existsSync(command)) {
    throw new Error("tarball 安装后缺少 codexc 命令");
  }
  const version = run(command, ["--version"], temporaryDirectory, environment, true).stdout.trim();
  const help = run(command, ["--help"], temporaryDirectory, environment, true).stdout;
  if (version !== packageReport.version) {
    throw new Error(`CLI 版本不匹配：实际 ${version}，期望 ${packageReport.version}`);
  }
  if (
    !help.includes("setup ")
    || !help.includes("doctor ")
    || !help.includes("service install")
    || !help.includes("service reload")
    || !help.includes("service logs")
  ) {
    throw new Error("CLI 帮助缺少公开命令");
  }
  const installedPackage = join(temporaryDirectory, "node_modules", "@hegenai", "codexc");
  for (const requiredFile of [
    "runtime/network-proxy.mjs",
    "scripts/setup.mjs",
    "scripts/telegram-setup.mjs",
    "scripts/validate-config.mjs",
    "systemd/codex-connect-app-server.service.template",
    "systemd/codex-connect-gateway.service.template",
    "scripts/install-systemd.mjs",
    "scripts/systemd-control.sh",
  ]) {
    if (!existsSync(join(installedPackage, requiredFile))) {
      throw new Error(`tarball 安装后缺少发布文件：${requiredFile}`);
    }
  }
  const configPath = join(temporaryDirectory, "config.toml");
  writeGatewayConfig(configPath, {
    version: 1,
    default_workspace: "smoke",
    telegram: {
      bot_token: "smoke-token",
      allowed_user_ids: [123],
      message_format: "html",
    },
    network: {},
    codex: {
      binary: "codex",
      socket_path: "runtime/codex-app-server.sock",
      sandbox: "workspace-write",
    },
    approval: { timeout_seconds: 300 },
    storage: { database_path: "data/gateway.sqlite3" },
    logging: { level: "info" },
    workspaces: [{ id: "smoke", name: "Smoke", cwd: temporaryDirectory }],
  });
  const configEnvironment = {
    ...environment,
    CODEX_CONNECT_CONFIG_FILE: configPath,
  };
  const validator = join(installedPackage, "scripts", "validate-config.mjs");
  run(process.execPath, [validator], temporaryDirectory, configEnvironment, true);
  writeFileSync(
    configPath,
    `legacy_setting = true\n${readFileSync(configPath, "utf8")}`,
    { mode: 0o600 },
  );
  const rejected = spawnSync(process.execPath, [validator], {
    cwd: temporaryDirectory,
    env: configEnvironment,
    encoding: "utf8",
  });
  if (
    rejected.status === 0
    || !rejected.stderr.includes("Unrecognized key")
  ) {
    throw new Error("配置预检未拒绝已经移除的配置项");
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
