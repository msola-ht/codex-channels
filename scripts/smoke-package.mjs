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
  const workspaceHelp = run(command, ["work", "-h"], temporaryDirectory, environment, true).stdout;
  const metricsHelp = run(command, ["metrics", "-h"], temporaryDirectory, environment, true).stdout;
  const rulesHelp = run(command, ["rules", "init", "-h"], temporaryDirectory, environment, true).stdout;
  const serviceHelp = run(
    command,
    ["service", "restart", "-h"],
    temporaryDirectory,
    environment,
    true,
  ).stdout;
  const centerHelp = run(
    command,
    ["center", "-h"],
    temporaryDirectory,
    environment,
    true,
  ).stdout;
  if (version !== packageReport.version) {
    throw new Error(`CLI 版本不匹配：实际 ${version}，期望 ${packageReport.version}`);
  }
  if (
    !help.includes("setup ")
    || !help.includes("config ")
    || !help.includes("doctor ")
    || !help.includes("service install")
    || !help.includes("service reload")
    || !help.includes("service logs")
    || !help.includes("rules <init|check>")
  ) {
    throw new Error("CLI 帮助缺少公开命令");
  }
  if (
    !workspaceHelp.includes("用法：codexc work")
    || !metricsHelp.includes("用法：codexc metrics")
    || !rulesHelp.includes("用法：codexc rules init")
    || !serviceHelp.includes("gateway|app-server|webui|center|all")
    || !centerHelp.includes("用法：codexc center")
  ) {
    throw new Error("CLI 分级帮助不完整");
  }
  const installedPackage = join(temporaryDirectory, "node_modules", "@hegenai", "codexc");
  for (const requiredFile of [
    "runtime/app-server-runtime.mjs",
    "runtime/app-server-supervisor.mjs",
    "runtime/cli-presentation.mjs",
    "runtime/gateway-owner.mjs",
    "runtime/network-proxy.mjs",
    "runtime/process-lifecycle.mjs",
    "runtime/service-targets.mjs",
    "scripts/feishu-application.mjs",
    "scripts/feishu-setup.mjs",
    "scripts/setup.mjs",
    "scripts/cli-status.mjs",
    "scripts/service-target-query.mjs",
    "scripts/codex-rules.mjs",
    "scripts/telegram-setup.mjs",
    "scripts/terminal-prompter.mjs",
    "scripts/validate-config.mjs",
    "systemd/codex-connect-app-server.service.template",
    "systemd/codex-connect-gateway.service.template",
    "systemd/codex-connect-webui.service.template",
    "systemd/codex-connect-center.service.template",
    "launchd/com.hegenai.codex-webui.plist.template",
    "launchd/com.hegenai.codex-center.plist.template",
    "scripts/install-systemd.mjs",
    "scripts/metrics-database-access.mjs",
    "scripts/metrics-database.mjs",
    "scripts/metrics-menu.d.mts",
    "scripts/metrics-menu.mjs",
    "scripts/metrics-center-payload.mjs",
    "scripts/metrics-center-schema.sql",
    "scripts/systemd-control.sh",
    ".codex/skills/channel-image/SKILL.md",
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
  const metricsStatus = run(
    command,
    ["metrics", "status"],
    temporaryDirectory,
    configEnvironment,
    true,
  ).stdout;
  if (!metricsStatus.includes("状态：尚未创建")) {
    throw new Error("tarball 安装后的 metrics status 不可用");
  }
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
