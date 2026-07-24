#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { configEventQueuePath } from "../runtime/config-event-queue.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { resolveProxyEnvironment } from "../runtime/network-proxy.mjs";
import {
  initializeUserData,
  packageDir,
  requireUserConfig,
  resolveConfiguredPath,
  runtimeConfig,
  userDataDir,
} from "../scripts/runtime-config.mjs";
import {
  addWorkspaceToConfig,
  inspectWorkspaceConfig,
  readWorkspaceConfig,
  removeWorkspaceFromConfig,
} from "../scripts/workspace-config.mjs";

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
    case "setup":
      requireNoArguments(args, "用法：codexc setup");
      runSetup();
      break;
    case "start":
      requireNoArguments(args, "用法：codexc start");
      runScript("scripts/dev-all.mjs", args, { CODEX_CONNECT_GATEWAY_ENTRY: "dist" });
      break;
    case "gateway":
      runGateway(args);
      break;
    case "service-app-server":
      runServiceAppServer(args);
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
  console.log(`配置文件：${result.configPath}`);
  if (result.created) {
    console.log(`默认 Workspace：${result.workspace}`);
    console.log("请运行 codexc setup 配置通讯渠道，然后运行 codexc service install。");
  }
}

function runGateway(args) {
  if (args.length > 0) {
    throw new Error("用法：codexc gateway");
  }
  const runtime = configuredEnvironment();
  const child = spawn(process.execPath, [join(packageDir, "dist/main.js")], {
    stdio: "inherit",
    env: runtime.environment,
    cwd: runtime.dataDir,
  });
  const forwardSignal = (signal) => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  };
  const forwardReload = () => forwardSignal("SIGHUP");
  const forwardTerminate = () => forwardSignal("SIGTERM");
  const forwardInterrupt = () => forwardSignal("SIGINT");
  const cleanup = () => {
    process.off("SIGHUP", forwardReload);
    process.off("SIGTERM", forwardTerminate);
    process.off("SIGINT", forwardInterrupt);
  };

  process.on("SIGHUP", forwardReload);
  process.on("SIGTERM", forwardTerminate);
  process.on("SIGINT", forwardInterrupt);
  child.once("error", (error) => {
    cleanup();
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    cleanup();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

function runServiceAppServer(args) {
  if (args.length > 0) {
    throw new Error("内部服务入口不接受参数");
  }
  const runtime = configuredEnvironment();
  const codex = table(runtime.document.codex);
  const { defaultWorkspace } = readWorkspaceConfig(runtime.document);
  const socketPath = resolveConfiguredPath(
    stringValue(codex.socket_path),
    runtime.dataDir,
    join(runtime.dataDir, "runtime", "codex-app-server.sock"),
  );
  const child = spawn(runtime.environment.CODEX_BINARY, [
    "app-server",
    "--listen",
    `unix://${socketPath}`,
  ], {
    stdio: "inherit",
    env: runtime.environment,
    cwd: defaultWorkspace.cwd,
  });
  forwardChildLifecycle(child);
}

function workspace(args) {
  const runtime = requireUserConfig();
  const eventQueuePath = configEventQueuePath(runtime.dataDir);
  const fallbackDefaultWorkspace = {
    cwd: join(runtime.dataDir, "workspace"),
    id: "codex-connect",
    name: ".codex-connect/workspace",
  };
  if (args[0] === "add") {
    const options = parseWorkspaceAddOptions(args.slice(1));
    const result = addWorkspaceToConfig({
      configPath: runtime.configPath,
      cwd: process.cwd(),
      ...(options.id ? { id: options.id } : {}),
      ...(options.name ? { name: options.name } : {}),
      ...(options.pruneMissing ? { pruneMissing: true } : {}),
      fallbackDefaultWorkspace,
      eventQueuePath,
    });
    console.log(result.added ? "Workspace 已添加。" : "Workspace 已存在。");
    console.log(`${result.workspace.name} (${result.workspace.id})`);
    console.log(result.workspace.cwd);
    for (const removed of result.removedWorkspaces) {
      console.log(`已清理失效 Workspace：${removed.name} (${removed.id})`);
      console.log(removed.cwd);
    }
    if (result.defaultChanged) {
      console.log(`默认 Workspace 已切换为：${result.defaultWorkspace.name} (${result.defaultWorkspace.id})`);
    }
    if (result.added || result.removedWorkspaces.length > 0 || result.defaultChanged) {
      console.log("运行中的 Gateway 会自动热加载配置，必要时重启。");
    }
    return;
  }
  if (args[0] === "remove") {
    if (args.length !== 2) {
      throw new Error("用法：codexc ws remove <序号|ID|名称>");
    }
    const result = removeWorkspaceFromConfig({
      configPath: runtime.configPath,
      selector: args[1],
      fallbackDefaultWorkspace,
      eventQueuePath,
    });
    console.log(`Workspace 注册已删除：${result.removedWorkspace.name} (${result.removedWorkspace.id})`);
    console.log(result.removedWorkspace.cwd);
    console.log("磁盘目录未删除。");
    if (result.defaultChanged) {
      console.log(`默认 Workspace 已切换为：${result.defaultWorkspace.name} (${result.defaultWorkspace.id})`);
    }
    console.log("运行中的 Gateway 会自动重新加载配置，必要时重启。");
    return;
  }
  if (args.length > 0) {
    throw new Error([
      "用法：",
      "  codexc ws",
      "  codexc ws add [--id ID] [--name 名称] [--prune-missing]",
      "  codexc ws remove <序号|ID|名称>",
    ].join("\n"));
  }
  const document = readGatewayConfig(runtime.configPath);
  const { workspaces, defaultWorkspaceId } = inspectWorkspaceConfig(document);
  console.log(`Workspace（${workspaces.length}）：`);
  workspaces.forEach((item, index) => {
    const status = item.status === "missing"
      ? " · 目录不存在"
      : item.status === "inaccessible"
        ? " · 目录无法访问"
        : "";
    console.log(`${index + 1}. ${item.name} · ${item.id}${item.id === defaultWorkspaceId ? " ← 默认" : ""}${status}`);
    console.log(`   ${item.cwd}`);
  });
}

function service(args) {
  const [action, ...rest] = args;
  const actions = ["install", "uninstall", "start", "stop", "reload", "restart", "status", "logs"];
  if (!actions.includes(action) || (action !== "logs" && rest.length > 0)) {
    throw new Error("用法：codexc service <install|uninstall|start|stop|reload|restart|status|logs>");
  }
  const serviceArgs = action === "logs" ? parseServiceLogOptions(rest) : [];
  if (action === "install") {
    runScript("scripts/validate-config.mjs", []);
  }
  if (process.platform === "darwin") {
    if (action === "install") {
      run(
        "/bin/zsh",
        [join(packageDir, "scripts/launchd-control.sh"), "check-install"],
        configuredEnvironment().environment,
      );
      runScript("scripts/install-launchd.mjs", []);
    }
    run(
      "/bin/zsh",
      [join(packageDir, "scripts/launchd-control.sh"), action, ...serviceArgs],
      configuredEnvironment().environment,
    );
    return;
  }
  if (process.platform === "linux") {
    if (action === "install") {
      runScript("scripts/install-systemd.mjs", []);
    }
    run(
      "/bin/sh",
      [join(packageDir, "scripts/systemd-control.sh"), action, ...serviceArgs],
      configuredEnvironment().environment,
    );
    return;
  }
  throw new Error("codexc service 当前支持 macOS launchd 与 Linux systemd；Windows Transport 尚未支持");
}

function showConfig(args) {
  requireNoArguments(args, "用法：codexc config");
  const explicitConfigFile = process.env.CODEX_CONNECT_CONFIG_FILE?.trim();
  const runtime = explicitConfigFile
    ? runtimeConfig()
    : { dataDir: userDataDir(), configPath: join(userDataDir(), "config.toml") };
  console.log(`用户目录：${runtime.dataDir}`);
  console.log(`配置文件：${runtime.configPath}`);
}

function runDoctor(args) {
  if (args.length > 0) {
    throw new Error("用法：codexc doctor");
  }
  const result = spawnSync(process.execPath, [join(packageDir, "scripts/doctor.mjs"), ...args], {
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

function runSetup() {
  initializeUserData({ cwd: process.cwd() });
  runScript("scripts/setup.mjs", []);
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
  const { configPath, dataDir } = requireUserConfig();
  const document = readGatewayConfig(configPath);
  const network = table(document.network);
  const codex = table(document.codex);
  const proxyEnvironment = resolveProxyEnvironment(network, process.env);
  return {
    configPath,
    dataDir,
    document,
    environment: {
      ...process.env,
      CODEX_CONNECT_HOME: dataDir,
      CODEX_CONNECT_CONFIG_FILE: configPath,
      CODEX_BINARY: stringValue(codex.binary) || "codex",
      ...proxyEnvironment,
    },
  };
}

function forwardChildLifecycle(child) {
  const forward = (signal) => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  };
  const terminate = () => forward("SIGTERM");
  const interrupt = () => forward("SIGINT");
  const cleanup = () => {
    process.off("SIGTERM", terminate);
    process.off("SIGINT", interrupt);
  };
  process.on("SIGTERM", terminate);
  process.on("SIGINT", interrupt);
  child.once("error", (error) => {
    cleanup();
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    cleanup();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
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
    if (option === "--prune-missing") {
      result.pruneMissing = true;
      continue;
    }
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

function parseServiceLogOptions(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--follow" || option === "-f") {
      result.push("--follow");
      continue;
    }
    if (option === "--lines" || option === "-n") {
      const value = args[index + 1];
      const lines = Number(value);
      if (!Number.isSafeInteger(lines) || lines <= 0 || lines > 10_000) {
        throw new Error("日志行数必须是 1 到 10000 之间的整数");
      }
      result.push("--lines", String(lines));
      index += 1;
      continue;
    }
    if (option === "--service") {
      const value = args[index + 1];
      if (!["gateway", "app-server", "all"].includes(value)) {
        throw new Error("日志服务必须是 gateway、app-server 或 all");
      }
      result.push("--service", value);
      index += 1;
      continue;
    }
    throw new Error(
      `未知日志参数：${option}\n`
      + "用法：codexc service logs [-f|--follow] [-n|--lines 行数] [--service gateway|app-server|all]",
    );
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
  setup                        选择并配置 Gateway 模块
  start                        前台启动 App Server 与 Gateway
  remote [--workspace ID]      在当前目录启动共享 App Server 的 Codex TUI
  ws                           列出 Workspace
  ws add [--id ID] [--name 名称] [--prune-missing]
                               注册当前目录；可清理失效项
  ws remove <序号|ID|名称>      删除 Workspace 注册，不删除磁盘目录
  service install              安装并启动系统用户服务
  service uninstall            卸载系统服务并保留用户数据
  service start                启动系统服务
  service stop                 停止系统服务
  service reload               立即重新读取配置，必要时自动重启 Gateway
  service restart              重启 Gateway，保持 App Server 运行
  service status               查看系统服务状态
  service logs [-f] [-n 行数] [--service 名称]
                               查看或持续跟踪后台服务日志
  config                       显示用户配置路径
  doctor                       检查安装、配置、Codex 与服务连通性
  version                      显示版本
`);
}
