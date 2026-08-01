#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HttpsProxyAgent } from "https-proxy-agent";

import { configEventQueuePath } from "../runtime/config-event-queue.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  resolveProxyEnvironment,
  selectHttpProxyUrl,
} from "../runtime/network-proxy.mjs";
import {
  loadManagedProviderAppServer,
  providerAppServerSocketPath,
  providerMetricsSocketPath,
  withProviderBaseUrl,
} from "../runtime/model-provider-runtime.mjs";
import {
  initializeUserData,
  packageDir,
  requireUserConfig,
  resolveConfiguredPath,
  runtimeConfig,
  userDataDir,
} from "../scripts/runtime-config.mjs";
import { checkProjectRules, initializeProjectRules } from "../scripts/codex-rules.mjs";
import {
  addWorkspaceToConfig,
  inspectWorkspaceConfig,
  readWorkspaceConfig,
  removeWorkspaceFromConfig,
} from "../scripts/workspace-config.mjs";

const helpText = {
  main: `Codex Connect CLI

用法：codexc <命令>

初始化与诊断：
  init                         初始化用户目录和配置
  setup                        选择并配置 Gateway 模块
  doctor                       检查安装、配置、Codex 与服务

项目与会话：
  remote [参数]                启动共享 App Server 的 Codex TUI
  ws                           列出 Workspace
  ws add                       注册当前目录
  ws remove <目标>             删除 Workspace 注册
  rules init                   生成项目 Codex 命令预设
  rules check                  检查项目 Codex 命令预设

后台服务：
  start                        前台启动 App Server 与 Gateway
  service install              安装并启动整套后台服务
  service uninstall            卸载整套后台服务并保留用户数据
  service start [目标]         启动后台服务
  service stop [目标]          停止后台服务
  service reload               重新读取 Gateway 配置
  service restart [目标]       重启后台服务
  service status [目标]        查看后台服务状态
  service logs [目标]          查看后台服务日志

信息：
  config                       显示用户配置路径
  version                      显示版本

运行 codexc <命令> -h 查看命令用法。`,
  init: `用法：codexc init

初始化用户数据目录和 config.toml；已有配置不会被覆盖。`,
  setup: `用法：codexc setup

打开统一设置菜单。`,
  start: `用法：codexc start

在前台启动 Codex App Server 与 Gateway。`,
  remote: `用法：codexc remote [--workspace ID] [Codex 参数...]

连接共享 App Server，并把其余参数传给原生 Codex CLI。
切换模式下使用 --profile deepseek 连接隔离的 DeepSeek App Server。`,
  ws: `用法：codexc ws

其他用法：
  codexc ws add [--id ID] [--name 名称] [--prune-missing]
  codexc ws remove <序号|ID|名称>`,
  "ws.add": `用法：codexc ws add [--id ID] [--name 名称] [--prune-missing]

把当前目录注册为 Workspace。`,
  "ws.remove": `用法：codexc ws remove <序号|ID|名称>

删除 Workspace 注册，不删除磁盘目录。`,
  service: `用法：codexc service <命令>

  install                      安装并启动整套后台服务
  uninstall                    卸载整套后台服务并保留用户数据
  start [目标]                 启动 gateway、app-server 或 all
  stop [目标]                  停止 gateway、app-server 或 all
  reload                       通知 Gateway 重新读取配置
  restart [目标]               重启 gateway、app-server 或 all
  status [目标]                查看 gateway、app-server 或 all
  logs [目标] [-f] [-n 行数]   查看后台日志

目标默认值：start/stop/status 为 all，restart/logs 为 gateway。`,
  "service.install": "用法：codexc service install",
  "service.uninstall": "用法：codexc service uninstall",
  "service.start": "用法：codexc service start [gateway|app-server|all]",
  "service.stop": "用法：codexc service stop [gateway|app-server|all]",
  "service.reload": "用法：codexc service reload",
  "service.restart": "用法：codexc service restart [gateway|app-server|all]",
  "service.status": "用法：codexc service status [gateway|app-server|all]",
  "service.logs": `用法：codexc service logs [gateway|app-server|all] [-f|--follow] [-n|--lines 行数]`,
  config: `用法：codexc config

显示当前用户数据目录和配置文件路径。`,
  doctor: `用法：codexc doctor

只诊断当前安装、配置和服务状态，不修改配置。`,
  rules: `用法：codexc rules <init|check>

具体用法：
  codexc rules init [--force]
  codexc rules check`,
  "rules.init": `用法：codexc rules init [--force]

为当前项目生成安全命令预设；已有文件默认不覆盖。`,
  "rules.check": `用法：codexc rules check

使用当前 Codex CLI 检查项目规则。`,
  version: "用法：codexc version",
  gateway: `用法：codexc gateway

内部 Gateway 服务入口。`,
  "service-app-server": `用法：codexc service-app-server

内部 Codex App Server 服务入口。`,
};

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
      if (showRequestedHelp(args, "version")) {
        break;
      }
      printVersion(args);
      break;
    case "init":
      if (showRequestedHelp(args, "init")) {
        break;
      }
      initialize(args);
      break;
    case "setup":
      if (showRequestedHelp(args, "setup")) {
        break;
      }
      requireNoArguments(args, "用法：codexc setup");
      runSetup();
      break;
    case "start":
      if (showRequestedHelp(args, "start")) {
        break;
      }
      requireNoArguments(args, "用法：codexc start");
      runScript("scripts/dev-all.mjs", args, { CODEX_CONNECT_GATEWAY_ENTRY: "dist" });
      break;
    case "gateway":
      if (showRequestedHelp(args, "gateway")) {
        break;
      }
      runGateway(args);
      break;
    case "service-app-server":
      if (showRequestedHelp(args, "service-app-server")) {
        break;
      }
      await runServiceAppServer(args);
      break;
    case "remote":
      if (showRequestedHelp(args, "remote")) {
        break;
      }
      runScript("scripts/codex-remote.mjs", args, {}, process.cwd());
      break;
    case "ws":
      workspace(args);
      break;
    case "service":
      service(args);
      break;
    case "config":
      if (showRequestedHelp(args, "config")) {
        break;
      }
      showConfig(args);
      break;
    case "doctor":
      if (showRequestedHelp(args, "doctor")) {
        break;
      }
      runDoctor(args);
      break;
    case "rules":
      projectRules(args);
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

async function runServiceAppServer(args) {
  if (args.length > 0) {
    throw new Error("内部服务入口不接受参数");
  }
  const runtime = configuredEnvironment();
  runtime.environment.CODEX_CONNECT_SERVICE_ROLE = "app-server";
  const codex = table(runtime.document.codex);
  const { defaultWorkspace } = readWorkspaceConfig(runtime.document);
  const socketPath = resolveConfiguredPath(
    stringValue(codex.socket_path),
    runtime.dataDir,
    join(runtime.dataDir, "runtime", "codex-app-server.sock"),
  );
  const managedProvider = loadManagedProviderAppServer(runtime.environment);
  const dsProxyListen = stringValue(table(runtime.document.ds_proxy)?.listen);
  if (dsProxyListen && managedProvider?.provider !== "deepseek") {
    throw new Error("ds_proxy 仅支持 DeepSeek 切换模式");
  }
  let providerProxy;
  let upstreamAgent;
  if (managedProvider?.provider === "deepseek" && dsProxyListen) {
    const {
      ProviderProxy,
      sendProviderProxyMetrics,
    } = await import("../dist/provider-proxy/index.js");
    const upstreamUrl = new URL("https://api.deepseek.com/");
    const proxyUrl = selectHttpProxyUrl({
      http: runtime.environment.HTTP_PROXY,
      https: runtime.environment.HTTPS_PROXY,
      all: runtime.environment.ALL_PROXY,
      no: runtime.environment.NO_PROXY,
    }, upstreamUrl);
    upstreamAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
    const metricsSocketPath = providerMetricsSocketPath(
      socketPath,
      managedProvider.provider,
    );
    providerProxy = new ProviderProxy(dsProxyListen, {
      ...(upstreamAgent ? { upstreamAgent } : {}),
      upstreamHost: upstreamUrl.hostname,
      onMetrics: (metrics) => sendProviderProxyMetrics(metricsSocketPath, metrics),
      onError: (error) => console.error(
        `DeepSeek 模型代理转发失败：${error instanceof Error ? error.message : String(error)}`,
      ),
    });
    await providerProxy.start();
    console.log(`DeepSeek 模型代理已启动：${providerProxy.address()}`);
  }
  const children = [spawn(runtime.environment.CODEX_BINARY, [
    "app-server",
    "--listen",
    `unix://${socketPath}`,
  ], {
    stdio: "inherit",
    env: runtime.environment,
    cwd: defaultWorkspace.cwd,
  })];
  if (managedProvider) {
    const managedArguments = dsProxyListen
      ? withProviderBaseUrl(
          managedProvider.arguments,
          managedProvider.provider,
          `http://${dsProxyListen}/`,
        )
      : managedProvider.arguments;
    children.push(spawn(runtime.environment.CODEX_BINARY, [
      ...managedArguments,
      "app-server",
      "--listen",
      `unix://${providerAppServerSocketPath(socketPath, managedProvider.provider)}`,
    ], {
      stdio: "inherit",
      env: {
        ...runtime.environment,
        ...managedProvider.childEnvironment,
      },
      cwd: defaultWorkspace.cwd,
    }));
  }
  forwardChildrenLifecycle(children, async () => {
    await providerProxy?.close();
    upstreamAgent?.destroy();
  });
}

function workspace(args) {
  if (showRequestedHelp(args, "ws")) {
    return;
  }
  if (showSubcommandHelp(args, "add", "ws.add") || showSubcommandHelp(args, "remove", "ws.remove")) {
    return;
  }
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
  if (showRequestedHelp(args, "service")) {
    return;
  }
  const [action, ...rest] = args;
  const actions = ["install", "uninstall", "start", "stop", "reload", "restart", "status", "logs"];
  if (actions.includes(action) && showRequestedHelp(rest, `service.${action}`)) {
    return;
  }
  if (!actions.includes(action)) {
    throw new Error("用法：codexc service <install|uninstall|start|stop|reload|restart|status|logs>");
  }
  const serviceArgs = parseServiceArguments(action, rest);
  rejectAppServerSelfRestart(action, serviceArgs, process.env);
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

function rejectAppServerSelfRestart(action, serviceArgs, environment) {
  const target = serviceArgs[0];
  if (
    environment.CODEX_CONNECT_SERVICE_ROLE === "app-server"
    && action === "restart"
    && (target === "app-server" || target === "all")
  ) {
    throw new Error(
      "不能在 Codex App Server 内重启 App Server；请在本机终端运行 "
      + `codexc service restart ${target}。渠道内只能运行 codexc service restart gateway。`,
    );
  }
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

function projectRules(args) {
  if (showRequestedHelp(args, "rules")) {
    return;
  }
  if (showSubcommandHelp(args, "init", "rules.init") ||
    showSubcommandHelp(args, "check", "rules.check")) {
    return;
  }
  if (args[0] === "check" && args.length === 1) {
    const result = checkProjectRules({ cwd: process.cwd() });
    console.log("项目 Codex 规则检查通过。");
    console.log(`项目目录：${result.projectRoot}`);
    console.log(`规则文件：${result.rulesPath}`);
    return;
  }
  if (args[0] !== "init" || args.some((argument, index) =>
    index > 0 && argument !== "--force"
  )) {
    throw new Error("用法：codexc rules <init [--force]|check>");
  }
  const force = args.includes("--force");
  const result = initializeProjectRules({ cwd: process.cwd(), force });
  console.log(force ? "项目 Codex 规则已重新生成。" : "项目 Codex 规则已生成。");
  console.log(`项目目录：${result.projectRoot}`);
  console.log(`规则文件：${result.rulesPath}`);
  checkProjectRules({ cwd: result.projectRoot });
  console.log("项目 Codex 规则检查通过。");
  console.log("重启 Codex 后生效；项目必须处于受信任状态。");
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

function forwardChildrenLifecycle(children, closeResources = async () => undefined) {
  let settled = false;
  const forward = (signal) => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    }
  };
  const terminate = () => forward("SIGTERM");
  const interrupt = () => forward("SIGINT");
  const cleanup = () => {
    process.off("SIGTERM", terminate);
    process.off("SIGINT", interrupt);
  };
  const finish = (code, signal, error) => {
    if (settled) return;
    settled = true;
    cleanup();
    forward("SIGTERM");
    void Promise.resolve(closeResources()).then(() => {
      if (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        return;
      }
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = code ?? 1;
    }).catch((closeError) => {
      console.error(closeError instanceof Error ? closeError.message : String(closeError));
      process.exitCode = 1;
    });
  };
  process.on("SIGTERM", terminate);
  process.on("SIGINT", interrupt);
  for (const child of children) {
    child.once("error", (error) => finish(1, null, error));
    child.once("exit", (code, signal) => finish(code, signal));
  }
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
  const remaining = [...args];
  const result = [];
  if (remaining[0] && !remaining[0].startsWith("-")) {
    result.push(parseServiceTarget(remaining.shift()));
  } else {
    result.push("gateway");
  }
  for (let index = 0; index < remaining.length; index += 1) {
    const option = remaining[index];
    if (option === "--follow" || option === "-f") {
      result.push("--follow");
      continue;
    }
    if (option === "--lines" || option === "-n") {
      const value = remaining[index + 1];
      const lines = Number(value);
      if (!Number.isSafeInteger(lines) || lines <= 0 || lines > 10_000) {
        throw new Error("日志行数必须是 1 到 10000 之间的整数");
      }
      result.push("--lines", String(lines));
      index += 1;
      continue;
    }
    throw new Error(
      `未知日志参数：${option}\n`
      + helpText["service.logs"],
    );
  }
  return result;
}

function parseServiceArguments(action, args) {
  if (action === "logs") {
    return parseServiceLogOptions(args);
  }
  if (action === "install" || action === "uninstall" || action === "reload") {
    if (args.length > 0) {
      throw new Error(helpText[`service.${action}`]);
    }
    return [];
  }
  if (args.length > 1) {
    throw new Error(helpText[`service.${action}`]);
  }
  const defaultTarget = action === "restart" ? "gateway" : "all";
  return [parseServiceTarget(args[0] ?? defaultTarget)];
}

function parseServiceTarget(value) {
  if (!["gateway", "app-server", "all"].includes(value)) {
    throw new Error(`服务目标必须是 gateway、app-server 或 all：${value}`);
  }
  return value;
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

function isHelpArgument(value) {
  return value === "-h" || value === "--help";
}

function showRequestedHelp(args, key) {
  if (args.length !== 1 || !isHelpArgument(args[0])) {
    return false;
  }
  console.log(helpText[key]);
  return true;
}

function showSubcommandHelp(args, subcommand, key) {
  if (args.length !== 2 || args[0] !== subcommand || !isHelpArgument(args[1])) {
    return false;
  }
  console.log(helpText[key]);
  return true;
}

function printHelp() {
  console.log(helpText.main);
}
