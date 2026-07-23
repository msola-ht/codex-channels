#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "dotenv";

import {
  initializeUserData,
  packageDir,
  requireUserConfig,
  runtimeConfig,
  userDataDir,
} from "../scripts/runtime-config.mjs";
import { addWorkspaceToEnv, readWorkspaceConfig } from "../scripts/workspace-config.mjs";

const [command = "help", ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    case "--version":
    case "-v":
    case "version":
      printVersion(args);
      break;
    case "init":
      initialize(args);
      break;
    case "start":
      requireNoArguments(args, "用法：codexc start");
      runScript("scripts/dev-all.mjs", args, { CODEX_CONNECT_GATEWAY_ENTRY: "dist" });
      break;
    case "gateway":
      runGateway(args);
      break;
    case "remote":
      runScript("scripts/codex-remote.mjs", args, {}, process.cwd());
      break;
    case "ws":
    case "workspace":
      workspace(args);
      break;
    case "service":
      service(args);
      break;
    case "config":
      showConfig(args);
      break;
    case "doctor":
      runDoctor(args);
      break;
    default:
      throw new Error(`未知命令：${command}\n运行 codexc --help 查看用法`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function initialize(args) {
  if (args.length > 0) {
    throw new Error("用法：codexc init");
  }
  const result = initializeUserData({ cwd: process.cwd() });
  console.log(result.created ? "Codex Connect 已初始化。" : "Codex Connect 已经初始化。");
  console.log(`配置目录：${result.dataDir}`);
  console.log(`配置文件：${result.envPath}`);
  if (result.created) {
    console.log(`默认 Workspace：${result.workspace}`);
    console.log("请填写 TELEGRAM_BOT_TOKEN 和 TELEGRAM_ALLOWED_USER_IDS，然后运行 codexc service install。");
  }
}

function runGateway(args) {
  if (args.length > 0) {
    throw new Error("用法：codexc gateway");
  }
  const runtime = configuredEnvironment();
  run(process.execPath, [join(packageDir, "dist/main.js")], runtime.environment, runtime.dataDir);
}

function workspace(args) {
  const runtime = requireUserConfig();
  if (args[0] === "add") {
    const options = parseWorkspaceAddOptions(args.slice(1));
    const result = addWorkspaceToEnv({
      envPath: runtime.envPath,
      cwd: process.cwd(),
      ...(options.id ? { id: options.id } : {}),
      ...(options.name ? { name: options.name } : {}),
    });
    console.log(result.added ? "Workspace 已添加。" : "Workspace 已存在。");
    console.log(`${result.workspace.name} (${result.workspace.id})`);
    console.log(result.workspace.cwd);
    if (result.added) {
      console.log("如果 Gateway 正在运行，请重启后再从 Telegram 切换。");
    }
    return;
  }
  if (args.length > 0) {
    throw new Error("用法：codexc ws [add [--id ID] [--name 名称]]");
  }
  const env = parse(readFileSync(runtime.envPath, "utf8"));
  const { workspaces, defaultWorkspace } = readWorkspaceConfig(env);
  console.log(`Workspace（${workspaces.length}）：`);
  workspaces.forEach((item, index) => {
    console.log(`${index + 1}. ${item.name} · ${item.id}${item.id === defaultWorkspace.id ? " ← 默认" : ""}`);
    console.log(`   ${item.cwd}`);
  });
}

function service(args) {
  const [action, ...rest] = args;
  if (rest.length > 0 || !["install", "uninstall", "start", "stop", "restart", "status"].includes(action)) {
    throw new Error("用法：codexc service <install|uninstall|start|stop|restart|status>");
  }
  if (process.platform === "darwin") {
    if (action === "install") {
      runScript("scripts/install-launchd.mjs", []);
    }
    run("/bin/zsh", [join(packageDir, "scripts/launchd-control.sh"), action], configuredEnvironment().environment);
    return;
  }
  if (process.platform === "linux") {
    if (action === "install") {
      runScript("scripts/install-systemd.mjs", []);
    }
    run("/bin/sh", [join(packageDir, "scripts/systemd-control.sh"), action], configuredEnvironment().environment);
    return;
  }
  throw new Error("codexc service 当前支持 macOS launchd 与 Linux systemd；Windows Transport 尚未支持");
}

function showConfig(args) {
  requireNoArguments(args, "用法：codexc config");
  const explicitEnvFile = process.env.CODEX_CONNECT_ENV_FILE?.trim();
  const runtime = explicitEnvFile
    ? runtimeConfig()
    : { dataDir: userDataDir(), envPath: join(userDataDir(), ".env") };
  console.log(`用户目录：${runtime.dataDir}`);
  console.log(`配置文件：${runtime.envPath}`);
}

function runDoctor(args) {
  requireNoArguments(args, "用法：codexc doctor");
  const result = spawnSync(process.execPath, [join(packageDir, "scripts/doctor.mjs")], {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
  });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.status ?? 1;
}

function runScript(relativePath, args, additionalEnvironment = {}, workingDirectory) {
  const runtime = configuredEnvironment();
  run(
    process.execPath,
    [join(packageDir, relativePath), ...args],
    { ...runtime.environment, ...additionalEnvironment },
    workingDirectory ?? runtime.dataDir,
  );
}

function configuredEnvironment() {
  const { dataDir, envPath } = requireUserConfig();
  const values = parse(readFileSync(envPath, "utf8"));
  return {
    dataDir,
    environment: {
      ...values,
      ...process.env,
      CODEX_CONNECT_HOME: dataDir,
      CODEX_CONNECT_ENV_FILE: envPath,
      DOTENV_CONFIG_PATH: envPath,
    },
  };
}

function run(executable, args, environment, cwd) {
  const result = spawnSync(executable, args, {
    stdio: "inherit",
    env: environment,
    ...(cwd ? { cwd } : {}),
  });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  if (result.status !== 0) {
    throw new Error(`子命令执行失败：exit=${result.status ?? 1}`);
  }
}

function parseWorkspaceAddOptions(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!new Set(["--id", "--name"]).has(option)) {
      throw new Error(`未知参数：${option}`);
    }
    const value = args[index + 1];
    if (!value) {
      throw new Error(`${option} 缺少值`);
    }
    result[option.slice(2)] = value;
    index += 1;
  }
  return result;
}

function printVersion(args) {
  requireNoArguments(args, "用法：codexc version");
  const metadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  console.log(metadata.version);
}

function requireNoArguments(args, usage) {
  if (args.length > 0) {
    throw new Error(usage);
  }
}

function printHelp() {
  console.log(`Codex Connect CLI

用法：codexc <命令>

  init                         初始化 ~/.codex-connect
  start                        前台启动 App Server 与 Gateway
  remote [--workspace ID]      在当前目录启动共享 App Server 的 Codex TUI
  ws                           列出 Workspace
  ws add [--id ID] [--name 名称]
                               将当前目录注册为 Workspace
  service install              安装并启动系统用户服务
  service uninstall            卸载系统服务并保留用户数据
  service start                启动系统服务
  service stop                 停止系统服务
  service restart              重启 Gateway，保持 App Server 运行
  service status               查看系统服务状态
  config                       显示用户配置路径
  doctor                       检查安装、配置、Codex 与服务连通性
  version                      显示版本
`);
}
