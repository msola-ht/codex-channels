#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import * as clackPrompts from "@clack/prompts";

import { HttpsProxyAgent } from "https-proxy-agent";

import { configEventQueuePath } from "../runtime/config-event-queue.mjs";
import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import {
  resolveProxyEnvironment,
  selectHttpProxyUrl,
} from "../runtime/network-proxy.mjs";
import {
  loadManagedProviderAppServer,
  loadOpenAiBaseUrl,
  loadPrimaryModelProvider,
  providerAppServerSocketPath,
  providerMetricsSocketPath,
  withOpenAiBaseUrl,
  withProviderBaseUrl,
} from "../runtime/model-provider-runtime.mjs";
import { deepseekProviderDefinition } from "../runtime/model-provider-definitions.mjs";
import {
  initializeUserData,
  packageDir,
  requireUserConfig,
  resolveConfiguredPath,
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
  config                       打开配置与设置菜单（显示、系统、工作区、消息格式）
  doctor                       检查安装、配置、Codex 与服务

项目与会话：
  remote [参数]                启动共享 App Server 的 Codex TUI
  work [list|add|remove]       管理 Workspace（别名 ws；无子命令进入交互菜单）
  rules <init|check>           生成或检查项目 Codex 命令预设
  state upgrade               显式升级 Gateway 状态数据库
  metrics <run|report|export|status|reset>   模型请求指标：本次运行、汇报、明细导出、状态、重建

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
  work: `用法：codexc work

无子命令时进入交互菜单：列出、新增、删除、权限；新增创建在
~/.codex-connect/<id>-work，不更改默认工作区。

其他用法：
  codexc work list
  codexc work add [--id ID] [--name 名称] [--cwd 目录] [--prune-missing]
  codexc work remove <序号|ID|名称>`,
  ws: `用法：codexc work（别名：codexc ws）

管理 Workspace；使用 codexc work --help 查看完整用法。`,
  "work.add": `用法：codexc work add [--id ID] [--name 名称] [--cwd 目录] [--prune-missing]

把当前目录注册为 Workspace；交互式新建请运行 codexc work。`,
  "work.list": `用法：codexc work list

列出全部 Workspace 与当前默认项。`,
  "work.remove": `用法：codexc work remove <序号|ID|名称>

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

打开交互式配置与设置菜单：显示设置（操作详情、计划更新、按提供商的价格显示方式）、系统设置
（调试模式、审批超时、Sandbox、默认工作区与模型）、工作区设置（沙箱、审批策略、权限 Profile）、
Telegram 消息格式与配置路径查看。
非交互终端（脚本或管道）直接显示用户目录与配置文件路径。`,
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
  state: `用法：codexc state upgrade

停止 Gateway 后，备份并显式升级状态数据库。`,
  "state.upgrade": `用法：codexc state upgrade

停止 Gateway 后，备份并显式升级状态数据库。`,
  metrics: `用法：codexc metrics

无参数时进入交互菜单。查看与导出模型请求指标：
  codexc metrics run <Thread ID> [--format json|markdown]   本次运行汇总（最近 Turn + 会话累计）
  codexc metrics report [--range 24h|7d|30d] [--group global|providers|models]   聚合汇报
  codexc metrics export [--range 24h|7d|30d] [--format json|csv] [--thread Thread ID]   请求明细导出
  codexc metrics status   指标数据库状态
  codexc metrics reset    备份并重建指标库（需 Gateway 停止）`,
  "metrics.status": `用法：codexc metrics status

只读显示指标数据库路径、Schema 兼容性和记录数量。`,
  "metrics.run": `用法：codexc metrics run <Thread ID> [--format json|markdown]

导出指定 Thread 的本次运行汇总：最近 Turn 的请求数、Token、缓存命中率、速度、费用与耗时，
以及当前会话累计；默认输出 Markdown。`,
  "metrics.reset": `用法：codexc metrics reset

要求 Gateway 已停止；先备份现有指标库，再让下次启动创建当前 Schema。`,
  "metrics.report": `用法：codexc metrics report [--range <24h|7d|30d>] [--group <global|providers|models>]

只读输出 Markdown 汇报；默认最近 30 天并按模型分组。`,
  "metrics.export": `用法：codexc metrics export [--range <24h|7d|30d>] [--format <json|csv>] [--thread <Thread ID>]

只读导出脱敏请求记录到标准输出；默认最近 30 天、JSON 格式。--thread 只导出指定 Thread。`,
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
    case "work":
    case "ws":
      await workspace(args);
      break;
    case "service":
      service(args);
      break;
    case "config":
      if (showRequestedHelp(args, "config")) {
        break;
      }
      requireNoArguments(args, "用法：codexc config");
      run(
        process.execPath,
        [join(packageDir, "scripts/config.mjs")],
        process.env,
        process.cwd(),
      );
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
    case "state":
      state(args);
      break;
    case "metrics":
      await metrics(args);
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
  if (Object.hasOwn(runtime.document, "ds_proxy")) {
    throw new Error("ds_proxy 已移除，模型统计代理现在由 App Server 服务自动管理");
  }
  runtime.environment.CODEX_CONNECT_SERVICE_ROLE = "app-server";
  const codex = table(runtime.document.codex);
  const { defaultWorkspace } = readWorkspaceConfig(runtime.document);
  const socketPath = resolveConfiguredPath(
    stringValue(codex.socket_path),
    runtime.dataDir,
    join(runtime.dataDir, "runtime", "codex-app-server.sock"),
  );
  const managedProvider = loadManagedProviderAppServer(runtime.environment);
  const primaryProvider = loadPrimaryModelProvider(runtime.environment);
  const {
    ProviderProxy,
    sendProviderProxyMetrics,
  } = await import("../dist/provider-proxy/index.js");
  const providerProxies = [];
  const upstreamAgents = new Set();
  const upstreamAgentFor = (upstreamUrl) => {
    const proxyUrl = selectHttpProxyUrl({
      http: runtime.environment.HTTP_PROXY,
      https: runtime.environment.HTTPS_PROXY,
      all: runtime.environment.ALL_PROXY,
      no: runtime.environment.NO_PROXY,
    }, upstreamUrl);
    if (!proxyUrl) return undefined;
    const agent = new HttpsProxyAgent(proxyUrl);
    upstreamAgents.add(agent);
    return agent;
  };
  const startProviderProxy = async (provider, options) => {
    const modelProxy = new ProviderProxy("127.0.0.1:0", {
      ...options,
      onMetrics: (metrics) => sendProviderProxyMetrics(
        providerMetricsSocketPath(socketPath, provider),
        metrics,
      ),
      onError: (error) => console.error(
        `${provider} 模型统计代理失败：${error instanceof Error ? error.message : String(error)}`,
      ),
    });
    await modelProxy.start();
    providerProxies.push(modelProxy);
    console.log(`${provider} 模型统计代理已启动：${modelProxy.address()}`);
    return `http://${modelProxy.address()}`;
  };
  const deepseekUrl = new URL(deepseekProviderDefinition.baseUrl);
  const proxyOptionsForUrl = (upstreamUrl) => {
    const upstreamAgent = upstreamAgentFor(upstreamUrl);
    return {
      ...(upstreamAgent ? { upstreamAgent } : {}),
      upstreamHost: upstreamUrl.hostname,
      ...(upstreamUrl.port ? { upstreamPort: Number(upstreamUrl.port) } : {}),
      upstreamProtocol: upstreamUrl.protocol === "http:" ? "http" : "https",
      upstreamBasePath: upstreamUrl.pathname,
    };
  };
  let primaryArguments = [];
  let managedArguments;
  try {
    if (primaryProvider === "openai") {
      const configuredOpenAiBaseUrl = loadOpenAiBaseUrl(runtime.environment);
      let openAiProxyOptions;
      if (configuredOpenAiBaseUrl) {
        openAiProxyOptions = proxyOptionsForUrl(new URL(configuredOpenAiBaseUrl));
      } else {
        const chatgptUrl = new URL("https://chatgpt.com/backend-api/codex");
        const apiUrl = new URL("https://api.openai.com/v1");
        const chatgptAgent = upstreamAgentFor(chatgptUrl);
        const apiAgent = upstreamAgentFor(apiUrl);
        openAiProxyOptions = {
          upstreamHost: apiUrl.hostname,
          upstreamProtocol: "https",
          upstreamBasePath: apiUrl.pathname,
          resolveUpstream: (headers) => {
            const target = headers["chatgpt-account-id"] === undefined ? apiUrl : chatgptUrl;
            const agent = target === chatgptUrl ? chatgptAgent : apiAgent;
            return {
              ...(agent ? { agent } : {}),
              host: target.hostname,
              protocol: "https",
              basePath: target.pathname,
            };
          },
        };
      }
      const localBaseUrl = await startProviderProxy("openai", openAiProxyOptions);
      primaryArguments = withOpenAiBaseUrl(primaryArguments, localBaseUrl);
    } else if (primaryProvider === deepseekProviderDefinition.id) {
      const localBaseUrl = await startProviderProxy(
        deepseekProviderDefinition.id,
        proxyOptionsForUrl(deepseekUrl),
      );
      primaryArguments = withProviderBaseUrl(
        primaryArguments,
        deepseekProviderDefinition.id,
        localBaseUrl,
      );
    }
    if (managedProvider) {
      const localBaseUrl = await startProviderProxy(
        managedProvider.provider,
        proxyOptionsForUrl(deepseekUrl),
      );
      managedArguments = withProviderBaseUrl(
        managedProvider.arguments,
        managedProvider.provider,
        localBaseUrl,
      );
    }
  } catch (error) {
    await Promise.all(providerProxies.map((proxy) => proxy.close()));
    for (const agent of upstreamAgents) agent.destroy();
    throw error;
  }
  const children = [spawn(runtime.environment.CODEX_BINARY, [
    ...primaryArguments,
    "app-server",
    "--listen",
    `unix://${socketPath}`,
  ], {
    stdio: "inherit",
    env: runtime.environment,
    cwd: defaultWorkspace.cwd,
  })];
  if (managedProvider && managedArguments) {
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
    await Promise.all(providerProxies.map((proxy) => proxy.close()));
    for (const agent of upstreamAgents) agent.destroy();
  });
}

async function workspace(args) {
  if (showRequestedHelp(args, "work") || showRequestedHelp(args, "ws")) {
    return;
  }
  if (
    showSubcommandHelp(args, "list", "work.list")
    || showSubcommandHelp(args, "add", "work.add")
    || showSubcommandHelp(args, "remove", "work.remove")
  ) {
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
      cwd: options.cwd ?? process.cwd(),
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
      throw new Error("用法：codexc work remove <序号|ID|名称>");
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
  if (args.length > 0 && args[0] !== "list") {
    throw new Error([
      "用法：",
      "  codexc work",
      "  codexc work list",
      "  codexc work add [--name 名称] [--cwd 目录] [--id ID] [--prune-missing]",
      "  codexc work remove <序号|ID|名称>",
    ].join("\n"));
  }
  if (process.stdout.isTTY && args[0] !== "list") {
    await runWorkspaceMenu({
      runtime,
      eventQueuePath,
      fallbackDefaultWorkspace,
    });
    return;
  }
  listWorkspaces(runtime.configPath);
}

async function runWorkspaceMenu({
  runtime,
  eventQueuePath,
  fallbackDefaultWorkspace,
}) {
  clackPrompts.intro("Codex Connect Workspace");
  const action = await clackPrompts.select({
    message: "选择操作",
    showInstructions: false,
    options: [
      {
        value: "list",
        label: "列出工作区",
        hint: "查看全部 Workspace 与默认项",
      },
      {
        value: "create",
        label: "新增工作区",
        hint: "在 ~/.codex-connect/<id>-work 下新建并注册",
      },
      {
        value: "remove",
        label: "删除工作区",
        hint: "删除注册，不删除目录",
      },
      {
        value: "permissions",
        label: "工作区权限",
        hint: "沙箱、审批策略、权限 Profile",
      },
      { value: "cancel", label: "取消" },
    ],
  });
  if (clackPrompts.isCancel(action) || action === "cancel") {
    clackPrompts.cancel("已取消");
    return;
  }
  if (action === "list") {
    listWorkspaces(runtime.configPath);
    return;
  }
  if (action === "create") {
    await createWorkspaceInteractively({
      runtime,
      eventQueuePath,
      fallbackDefaultWorkspace,
    });
    return;
  }
  if (action === "remove") {
    await removeWorkspaceInteractively({
      runtime,
      eventQueuePath,
      fallbackDefaultWorkspace,
    });
    return;
  }
  if (action === "permissions") {
    await runWorkspacePermissionsMenu(runtime);
    return;
  }
  throw new Error(`未知 Workspace 操作：${String(action)}`);
}

async function createWorkspaceInteractively({
  runtime,
  eventQueuePath,
  fallbackDefaultWorkspace,
}) {
  const entered = await clackPrompts.text({
    message: "工作区名称",
    placeholder: "例如：数据分析",
    validate: (value) => {
      const trimmed = String(value ?? "").trim();
      if (!trimmed) {
        return "名称不能为空";
      }
      if ([...trimmed].length > 64) {
        return "名称最长 64 个字符";
      }
    },
  });
  if (clackPrompts.isCancel(entered)) {
    clackPrompts.cancel("已取消");
    return;
  }
  const name = String(entered).trim();
  const id = slugifyWorkspaceName(name);
  const directory = join(runtime.dataDir, `${id}-work`);
  if (existsSync(directory)) {
    throw new Error(`工作区目录已存在：${directory}`);
  }
  const confirmed = await clackPrompts.confirm({
    message: `将在 ${directory} 创建并注册（不会更改默认工作区），继续？`,
    initialValue: true,
  });
  if (clackPrompts.isCancel(confirmed) || confirmed === false) {
    clackPrompts.cancel("已取消");
    return;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const result = addWorkspaceToConfig({
    configPath: runtime.configPath,
    cwd: directory,
    id,
    name,
    fallbackDefaultWorkspace,
    eventQueuePath,
  });
  console.log("Workspace 已新增。");
  console.log(`${result.workspace.name} (${result.workspace.id})`);
  console.log(result.workspace.cwd);
  if (result.defaultChanged) {
    console.log(`默认 Workspace 已切换为：${result.defaultWorkspace.name} (${result.defaultWorkspace.id})`);
  }
  console.log("运行中的 Gateway 会自动热加载配置，必要时重启。");
}

async function removeWorkspaceInteractively({
  runtime,
  eventQueuePath,
  fallbackDefaultWorkspace,
}) {
  const document = readGatewayConfig(runtime.configPath);
  const { workspaces } = inspectWorkspaceConfig(document);
  if (workspaces.length === 0) {
    console.log("当前没有已配置的 Workspace。");
    return;
  }
  const selected = await clackPrompts.select({
    message: "选择要删除的 Workspace",
    showInstructions: false,
    options: workspaces.map((item) => ({
      value: item.id,
      label: `${item.name} · ${item.id}`,
      hint: item.cwd,
    })),
  });
  if (clackPrompts.isCancel(selected)) {
    clackPrompts.cancel("已取消");
    return;
  }
  const result = removeWorkspaceFromConfig({
    configPath: runtime.configPath,
    selector: selected,
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
}

async function runWorkspacePermissionsMenu(runtime) {
  const document = readGatewayConfig(runtime.configPath);
  const workspaces = Array.isArray(document.workspaces)
    ? document.workspaces
    : [];
  if (workspaces.length === 0) {
    console.log("当前没有已配置的 Workspace。");
    return;
  }
  const entries = workspaces.map((workspace) => table(workspace));
  const selectedId = entries.length === 1
    ? String(entries[0].id)
    : await clackPrompts.select({
        message: "选择要设置的 Workspace",
        showInstructions: false,
        options: entries.map((workspace) => ({
          value: String(workspace.id),
          label: String(workspace.name || workspace.id),
          hint: String(workspace.cwd),
        })),
      });
  if (clackPrompts.isCancel(selectedId)) {
    clackPrompts.cancel("已取消");
    return;
  }
  const entry = entries.find((workspace) => workspace.id === selectedId);
  if (!entry) {
    throw new Error(`未知 Workspace：${String(selectedId)}`);
  }
  const field = await clackPrompts.select({
    message: `选择 ${entry.name ?? entry.id} 的权限项`,
    showInstructions: false,
    options: [
      {
        value: "sandbox",
        label: "沙箱",
        hint: `当前：${entry.sandbox ?? "未配置（使用全局）"}`,
      },
      {
        value: "approval_policy",
        label: "审批策略",
        hint: `当前：${entry.approval_policy ?? "未配置（使用默认）"}`,
      },
      {
        value: "permissions",
        label: "权限 Profile",
        hint: `当前：${entry.permissions ?? "未配置"}`,
      },
      { value: "cancel", label: "取消" },
    ],
  });
  if (clackPrompts.isCancel(field) || field === "cancel") {
    clackPrompts.cancel("已取消");
    return;
  }
  if (field === "sandbox") {
    const selected = await clackPrompts.select({
      message: "沙箱模式",
      showInstructions: false,
      initialValue: entry.sandbox ?? "workspace-write",
      options: [
        { value: "read-only", label: "只读", hint: "禁止写文件" },
        { value: "workspace-write", label: "工作区可写", hint: "允许修改授权 Workspace" },
        { value: "danger-full-access", label: "完全访问", hint: "不启用文件系统沙箱" },
        { value: "clear", label: "清除（使用全局）", hint: "回退 codex.sandbox" },
      ],
    });
    if (clackPrompts.isCancel(selected)) {
      clackPrompts.cancel("已取消");
      return;
    }
    if (selected === "clear") {
      delete entry.sandbox;
    } else {
      if (entry.permissions !== undefined) {
        console.log("permissions 与 sandbox 互斥，请先清除权限 Profile。");
        return;
      }
      entry.sandbox = selected;
    }
  } else if (field === "approval_policy") {
    const selected = await clackPrompts.select({
      message: "审批策略",
      showInstructions: false,
      initialValue: entry.approval_policy ?? "on-request",
      options: [
        { value: "untrusted", label: "不信任", hint: "更严格地要求审批" },
        { value: "on-request", label: "按需审批", hint: "需要时请求审批" },
        { value: "never", label: "免审批", hint: "不再请求审批" },
        { value: "clear", label: "清除（使用默认）", hint: "回退 on-request" },
      ],
    });
    if (clackPrompts.isCancel(selected)) {
      clackPrompts.cancel("已取消");
      return;
    }
    if (selected === "clear") {
      delete entry.approval_policy;
    } else {
      entry.approval_policy = selected;
    }
  } else if (field === "permissions") {
    const entered = await clackPrompts.text({
      message: "权限 Profile（留空清除；例如 :read-only、:workspace、:danger-full-access）",
      initialValue: entry.permissions ?? "",
    });
    if (clackPrompts.isCancel(entered)) {
      clackPrompts.cancel("已取消");
      return;
    }
    const trimmed = String(entered).trim();
    if (trimmed.length > 0 && entry.sandbox !== undefined) {
      console.log("permissions 与 sandbox 互斥，请先清除沙箱。");
      return;
    }
    if (trimmed.length === 0) {
      delete entry.permissions;
    } else {
      entry.permissions = trimmed;
    }
  } else {
    throw new Error(`未知工作区权限项：${String(field)}`);
  }
  writeGatewayConfig(runtime.configPath, document);
  console.log("已更新工作区权限。");
  console.log(
    `沙箱：${entry.sandbox ?? "未配置"} · 审批：${entry.approval_policy ?? "未配置"} · 权限 Profile：${entry.permissions ?? "未配置"}`,
  );
  console.log("运行中的 Gateway 会自动热加载，对新建或恢复的 Thread 生效。");
}

function listWorkspaces(configPath) {
  const document = readGatewayConfig(configPath);
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

function state(args) {
  if (showRequestedHelp(args, "state") ||
    showSubcommandHelp(args, "upgrade", "state.upgrade")) {
    return;
  }
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) {
    console.log(helpText.state);
    return;
  }
  if (subcommand !== "upgrade" || rest.length > 0) {
    throw new Error("用法：codexc state upgrade");
  }
  runScript("scripts/upgrade-state.mjs", []);
}

async function metrics(args) {
  if (showRequestedHelp(args, "metrics") ||
    showSubcommandHelp(args, "run", "metrics.run") ||
    showSubcommandHelp(args, "status", "metrics.status") ||
    showSubcommandHelp(args, "reset", "metrics.reset") ||
    showSubcommandHelp(args, "report", "metrics.report") ||
    showSubcommandHelp(args, "export", "metrics.export")) {
    return;
  }
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) {
    if (!process.stdout.isTTY) {
      console.log(helpText.metrics);
      return;
    }
    await runMetricsMenu();
    return;
  }
  if (!new Set(["run", "status", "reset", "report", "export"]).has(subcommand)) {
    throw new Error("用法：codexc metrics <run|status|reset|report|export>");
  }
  if (subcommand === "status" && rest.length === 0) {
    run(
      process.execPath,
      [join(packageDir, "scripts/metrics-database.mjs"), subcommand],
      process.env,
      process.cwd(),
    );
    return;
  }
  if (subcommand === "reset" && rest.length > 0) {
    throw new Error("用法：codexc metrics reset");
  }
  runScript("scripts/metrics-database.mjs", [subcommand, ...rest]);
}

async function runMetricsMenu() {
  clackPrompts.intro("Codex Connect Metrics");
  const action = await clackPrompts.select({
    message: "选择指标操作",
    showInstructions: false,
    options: [
      {
        value: "run",
        label: "本次运行导出",
        hint: "指定 Thread 输出最近运行与累计汇总",
      },
      {
        value: "report",
        label: "聚合汇报",
        hint: "按时间范围与分组输出 Markdown",
      },
      {
        value: "export",
        label: "明细导出",
        hint: "导出脱敏请求记录 JSON/CSV",
      },
      {
        value: "status",
        label: "数据库状态",
        hint: "查看指标库路径、Schema 与记录数",
      },
      {
        value: "reset",
        label: "重置指标库",
        hint: "备份并重建（需 Gateway 停止）",
      },
      { value: "cancel", label: "取消" },
    ],
  });
  if (clackPrompts.isCancel(action) || action === "cancel") {
    clackPrompts.cancel("已取消");
    return;
  }
  if (action === "status") {
    run(
      process.execPath,
      [join(packageDir, "scripts/metrics-database.mjs"), "status"],
      process.env,
      process.cwd(),
    );
    return;
  }
  if (action === "reset") {
    const confirmed = await clackPrompts.confirm({
      message: "重置会先备份现有指标库，确认继续？",
      initialValue: false,
    });
    if (clackPrompts.isCancel(confirmed) || confirmed !== true) {
      clackPrompts.cancel("已取消");
      return;
    }
    runScript("scripts/metrics-database.mjs", ["reset"]);
    return;
  }
  if (action === "run") {
    const threadId = await clackPrompts.text({
      message: "Thread ID",
      placeholder: "例如：019fcb00-c0e1-7222-995d-a9e9f8f35443",
      validate: (value) => {
        const trimmed = String(value ?? "").trim();
        return trimmed ? undefined : "Thread ID 不能为空";
      },
    });
    if (clackPrompts.isCancel(threadId)) {
      clackPrompts.cancel("已取消");
      return;
    }
    runScript(
      "scripts/metrics-database.mjs",
      ["run", String(threadId).trim()],
    );
    return;
  }
  if (action === "report") {
    const range = await clackPrompts.select({
      message: "时间范围",
      showInstructions: false,
      options: [
        { value: "24h", label: "最近 24 小时" },
        { value: "7d", label: "最近 7 天" },
        { value: "30d", label: "最近 30 天" },
      ],
    });
    if (clackPrompts.isCancel(range)) {
      clackPrompts.cancel("已取消");
      return;
    }
    const group = await clackPrompts.select({
      message: "分组方式",
      showInstructions: false,
      options: [
        { value: "global", label: "全局汇总" },
        { value: "providers", label: "按提供商" },
        { value: "models", label: "按模型" },
      ],
    });
    if (clackPrompts.isCancel(group)) {
      clackPrompts.cancel("已取消");
      return;
    }
    runScript(
      "scripts/metrics-database.mjs",
      ["report", "--range", String(range), "--group", String(group)],
    );
    return;
  }
  if (action === "export") {
    const range = await clackPrompts.select({
      message: "时间范围",
      showInstructions: false,
      options: [
        { value: "24h", label: "最近 24 小时" },
        { value: "7d", label: "最近 7 天" },
        { value: "30d", label: "最近 30 天" },
      ],
    });
    if (clackPrompts.isCancel(range)) {
      clackPrompts.cancel("已取消");
      return;
    }
    const format = await clackPrompts.select({
      message: "导出格式",
      showInstructions: false,
      options: [
        { value: "json", label: "JSON" },
        { value: "csv", label: "CSV" },
      ],
    });
    if (clackPrompts.isCancel(format)) {
      clackPrompts.cancel("已取消");
      return;
    }
    const threadId = await clackPrompts.text({
      message: "Thread ID（留空导出全部）",
      initialValue: "",
    });
    if (clackPrompts.isCancel(threadId)) {
      clackPrompts.cancel("已取消");
      return;
    }
    const trimmedThreadId = String(threadId).trim();
    runScript(
      "scripts/metrics-database.mjs",
      [
        "export",
        "--range",
        String(range),
        "--format",
        String(format),
        ...(trimmedThreadId ? ["--thread", trimmedThreadId] : []),
      ],
    );
    return;
  }
  throw new Error(`未知指标操作：${String(action)}`);
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
    if (!new Set(["--cwd", "--id", "--name"]).has(option)) {
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

function slugifyWorkspaceName(name) {
  const slug = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-")
    .slice(0, 63);
  return /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(slug)
    ? slug
    : "workspace";
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
