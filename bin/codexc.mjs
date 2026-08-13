#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

import * as clackPrompts from "@clack/prompts";

import { HttpsProxyAgent } from "https-proxy-agent";

import { configEventQueuePath } from "../runtime/config-event-queue.mjs";
import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import {
  readGatewayConfig,
  validateCodexConfigDocument,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import {
  resolveProxyEnvironment,
  selectHttpProxyUrl,
} from "../runtime/network-proxy.mjs";
import {
  loadOpenAiBaseUrl,
  providerMetricsSocketPath,
  withOpenAiBaseUrl,
  withProviderBaseUrl,
  writeManagedModelProviderRoleConfig,
} from "../runtime/model-provider-runtime.mjs";
import { deepseekProviderDefinition } from "../runtime/model-provider-definitions.mjs";
import { writeCliMessage as printCliMessage } from "../runtime/cli-presentation.mjs";
import { effectiveCodexBinary } from "../runtime/executable.mjs";
import {
  defaultServiceTarget,
  parseServiceTarget,
  serviceTargetIncludes,
  serviceTargetUsage,
} from "../runtime/service-targets.mjs";
import {
  childProcessIsRunning,
  installProcessSignalHandlers,
  signalChildProcesses,
} from "../runtime/process-lifecycle.mjs";
import {
  AppServerSupervisorOwner,
  prepareAppServerSocketPaths,
} from "../runtime/app-server-supervisor.mjs";
import {
  initializeUserData,
  locateOptionalUserConfig,
  packageDir,
  requireUserConfig,
} from "../scripts/runtime-config.mjs";
import { checkProjectRules, initializeProjectRules } from "../scripts/codex-rules.mjs";
import { runMetricsMenu } from "../scripts/metrics-menu.mjs";
import {
  addWorkspaceToConfig,
  chooseWorkspaceId,
  inspectWorkspaceConfig,
  readWorkspaceConfig,
  removeWorkspaceFromConfig,
} from "../scripts/workspace-config.mjs";

const foregroundShutdownTimeoutMs = 5_000;
const foregroundProcessGroupExitTimeoutMs = 1_000;

const helpText = {
  main: `Codex Connect CLI

用法：codexc <命令>

初始化与诊断：
  init                         初始化用户目录和配置
  setup                        选择并配置 Gateway 模块
  config                       打开配置与设置菜单（显示、系统、工作区、指标、消息格式）
  doctor                       检查安装、配置、Codex、Linux 沙箱与服务

项目与会话：
  remote [参数]                启动共享 App Server 的 Codex TUI
  work [list|add|remove]       管理 Workspace（别名 ws；无子命令进入交互菜单）
  rules <init|check>           生成或检查项目 Codex 命令预设
  agents <enable-deepseek|disable-deepseek|status>   配置 multi_agent_v2 的 DeepSeek 子代理角色
  state upgrade               显式升级 Gateway 状态数据库
  metrics <run|turns|threads|report|export|status|reset>   查询、导出或重建模型请求指标
  metrics cleanup             备份并按保留策略清理旧指标
  channel send-image          提交本地图片，由 Gateway 发送回当前渠道会话
  webui                        启动本地只读指标 WebUI（默认回环地址）
  center [config|info]          多设备指标中心：启动服务、交互配置或查看地址

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
  start [目标]                 启动 gateway、app-server、webui、center 或 all
  stop [目标]                  停止 gateway、app-server、webui、center 或 all
  reload                       通知 Gateway 重新读取配置
  restart [目标]               重启 gateway、app-server、webui、center 或 all
  status [目标]                查看 gateway、app-server、webui、center 或 all
  logs [目标] [-f] [-n 行数]   查看后台日志

目标默认值：start/stop/status 为 all，restart/logs 为 gateway。`,
  "service.install": "用法：codexc service install",
  "service.uninstall": "用法：codexc service uninstall",
  "service.start": `用法：codexc service start [${serviceTargetUsage}]`,
  "service.stop": `用法：codexc service stop [${serviceTargetUsage}]`,
  "service.reload": "用法：codexc service reload",
  "service.restart": `用法：codexc service restart [${serviceTargetUsage}]`,
  "service.status": `用法：codexc service status [${serviceTargetUsage}]`,
  "service.logs": `用法：codexc service logs [${serviceTargetUsage}] [-f|--follow] [-n|--lines 行数]`,
  config: `用法：codexc config

打开交互式配置与设置菜单：显示设置（操作详情、计划更新、全局价格显示方式）、系统设置
（调试模式、审批超时、Sandbox、默认工作区与模型）、工作区设置（沙箱、审批策略、权限 Profile）、
多设备指标（本机接入中心、接入状态、停用接入）、Telegram 消息格式与配置路径查看。
非交互终端（脚本或管道）直接显示用户目录与配置文件路径。`,
  doctor: `用法：codexc doctor

只诊断当前安装、配置和服务状态，不修改配置；Linux 缺少 bubblewrap 时输出 [处理] 安装建议。`,
  rules: `用法：codexc rules <init|check>

具体用法：
  codexc rules init [--force]
  codexc rules check`,
  agents: `用法：codexc agents <enable-deepseek|disable-deepseek|status>

  enable-deepseek   启用 multi_agent_v2 并在 ~/.codex/config.toml 注册 agents.ds 角色
  disable-deepseek  移除 agents.ds 角色并关闭 multi_agent_v2
  status            查看当前状态`,
  "agents.enable-deepseek": `用法：codexc agents enable-deepseek

启用 multi_agent_v2 并在 ~/.codex/config.toml 注册 agents.ds 角色；
角色配置文件指向 codexc 服务启动时生成的 DeepSeek 子代理配置。`,
  "agents.disable-deepseek": `用法：codexc agents disable-deepseek

移除 agents.ds 角色并关闭 multi_agent_v2。`,
  "agents.status": `用法：codexc agents status

查看 multi_agent_v2 与 agents.ds 角色配置状态。`,
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
  codexc metrics run <Thread ID> [--format markdown|json|csv]   本次运行汇总（最近 Turn + 会话累计）
  codexc metrics turns <Thread ID> [--format markdown|json|csv]   会话每次对话明细
  codexc metrics threads [--format markdown|json|csv]   列出有指标的会话
  codexc metrics report [--range 时间范围 | --from 日期 --to 日期] [--group global|providers|models] [--format markdown|json|csv]   聚合汇报
  codexc metrics export [--range 时间范围 | --from 日期 --to 日期] [--format json|csv|markdown] [--thread Thread ID]   请求明细导出
  codexc metrics status   指标数据库状态
  codexc metrics upgrade  备份并升级指标库（需 Gateway 停止）
  codexc metrics reset    备份并重建指标库（需 Gateway 停止）
  codexc metrics sync-reset   备份并清零多端上报水位，重放修复中心历史
  codexc metrics cleanup [--keep-days 天数] [--max-rows 行数]   按策略备份并清理旧指标
  codexc metrics prune <provider>   备份并清理指定提供商请求指标（自动重启 Gateway 与中心）`,
  channel: `用法：codexc channel <send-image>

渠道能力：由 Gateway 使用渠道机器人凭据发送图片等媒体。`,
  "channel.send_image": `用法：codexc channel send-image <图片路径> [--thread <Thread ID>]

把本地 PNG/JPEG 图片（最大 10 MiB）交给 Gateway，发送回该 Thread 绑定的
飞书/微信/Telegram 会话。不指定 --thread 且存在多个绑定时会拒绝并提示指定。
图片会被复制到 ~/.codex-connect/data/channel-outbox/pending/，由网关轮询发送；
成功后归档到 done/，失败归档到 failed/ 并保留原因。`,
  webui: `用法：codexc webui [--host 地址] [--port 端口] [--token 令牌]

启动本地只读指标 WebUI（默认 http://127.0.0.1:8787/）。
参数优先级：命令行 > config.toml 的 [webui] 段 > 默认值。
--host 指定监听地址（127.0.0.1、::1 或 0.0.0.0），默认回环；
--port 指定监听端口，范围 1-65535；
--token 设置访问令牌，绑定非回环地址（0.0.0.0）时必须提供。
也可以使用 codexc config 的 WebUI 设置，或手工编辑 [webui] 段。
页面与 JSON API 均来自指标数据库，不提供任何写接口。`,
  center: `用法：codexc center [--host 地址] [--port 端口] [--token 查看令牌] [--device-token 上报令牌] [--database 路径]
      codexc center info      查看中心地址、双令牌状态与运行状态
      codexc center config    交互配置 [metrics.center]

启动多设备指标中心服务：接收各设备 Gateway 的增量上报，写入中心 SQLite，
并提供全局查询 API。默认 http://127.0.0.1:8790/。
参数优先级：命令行 > config.toml 的 [metrics.center] 段 > 默认值。
--host 指定监听地址（127.0.0.1、::1 或 0.0.0.0），默认回环；
--port 指定监听端口，范围 1-65535，默认 8790；
--token 设置只读查询令牌；
--device-token 设置设备上报令牌；绑定非回环地址（0.0.0.0）时两者必须提供且不同；
--database 指定中心 SQLite 路径，默认 <配置目录>/data/central-metrics.sqlite3。
上报接口：POST /api/ingest（Bearer 上报令牌）；查询接口使用 Bearer 查看令牌：/api/overview、/api/requests、
/api/subagents、/api/devices、/api/health。`,
  "metrics.status": `用法：codexc metrics status

只读显示指标数据库路径、Schema 兼容性和记录数量。`,
  "metrics.run": `用法：codexc metrics run <Thread ID> [--format markdown|json|csv]

导出指定 Thread 的本次运行汇总：最近 Turn 的请求数、Token、缓存命中率、速度、费用与耗时，
以及当前会话累计；默认输出 Markdown 并写入 ~/.codex-connect/output/<日期>/，加 --stdout 输出到标准输出。`,
  "metrics.turns": `用法：codexc metrics turns <Thread ID> [--format markdown|json|csv]

导出指定会话每一次对话的汇总（请求次数、Token、费用、速度、耗时）；默认写入
~/.codex-connect/output/<日期>/，加 --stdout 输出到标准输出。`,
  "metrics.threads": `用法：codexc metrics threads [--format markdown|json|csv]

列出指标库中有记录的所有会话及其对话数、请求数；默认写入 ~/.codex-connect/output/<日期>/。`,
  "metrics.reset": `用法：codexc metrics reset

要求 Gateway 已停止；先备份现有指标库，再让下次启动创建当前 Schema。`,
  "metrics.upgrade": `用法：codexc metrics upgrade [--restart-gateway]

默认要求 Gateway 已停止；加 --restart-gateway 时自动停止 Gateway、备份升级并重新启动。`,
  "metrics.sync_reset": `用法：codexc metrics sync-reset [--restart-gateway]

默认要求 Gateway 已停止；备份 ~/.codex-connect/data/metrics-sync-state.json 后清零
上报水位（保留设备 ID），重启 Gateway 后从第一条记录重新上报；中心按
(device_id, local_id) 覆盖写入，可修复云端历史数据。加 --restart-gateway 时自动
停止并重新启动 Gateway。`,
  "metrics.prune": `用法：codexc metrics prune <provider>

provider 当前支持 openai、deepseek。备份并删除本地与中心库中该提供商全部请求行，随后
自动重启 Gateway 与中心服务（即使任一步骤失败也会尝试把服务拉起来）。OpenAI 额度重置
后可用 openai 从零重新统计用量；备份保留在指标库同目录的 *.<provider>-prune-*.bak。`,
  "metrics.cleanup": `用法：codexc metrics cleanup [--before YYYY-MM-DD | --keep-days 天数] [--max-rows 行数] [--vacuum] [--restart-gateway]

按配置 [metrics.storage] 或命令行覆盖值清理最旧请求指标。默认要求 Gateway 已停止；
加 --restart-gateway 自动停止并重新启动。清理前创建 0600 备份；--vacuum 会立即回收文件空间。`,
  "metrics.report": `用法：codexc metrics report [--range <today|yesterday|this-week|last-week|this-month|last-month|24h|7d|30d|90d|365d|all> | --from YYYY-MM-DD --to YYYY-MM-DD] [--group <global|providers|models>] [--format markdown|json|csv]

只读输出汇报；默认最近 30 天并按模型分组，写入 ~/.codex-connect/output/<日期>/，加 --stdout 输出到标准输出。`,
  "metrics.export": `用法：codexc metrics export [--range <today|yesterday|this-week|last-week|this-month|last-month|24h|7d|30d|90d|365d|all> | --from YYYY-MM-DD --to YYYY-MM-DD] [--format <json|csv|markdown>] [--thread <Thread ID>]

只读导出脱敏请求记录；默认最近 30 天、JSON 格式并写入 ~/.codex-connect/output/<日期>/，加 --stdout 输出到标准输出。--thread 只导出指定 Thread。`,
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
      await runForegroundScript(
        "scripts/dev-all.mjs",
        args,
        { CODEX_CONNECT_GATEWAY_ENTRY: "dist" },
      );
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
    case "agents":
      agents(args);
      break;
    case "state":
      state(args);
      break;
    case "metrics":
      await metrics(args);
      break;
    case "channel":
      await channel(args);
      break;
    case "webui":
      if (showRequestedHelp(args, "webui")) {
        break;
      }
      runScript("scripts/webui-server.mjs", args);
      break;
    case "center":
      if (showRequestedHelp(args, "center")) {
        break;
      }
      runScript("scripts/metrics-center-server.mjs", args);
      break;
    default:
      throw new Error(`未知命令：${command}\n运行 codexc --help 查看用法`);
  }
} catch (error) {
  printCliMessage("failure", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function initialize(args) {
  if (args.length > 0) {
    throw new Error("用法：codexc init");
  }
  const result = initializeUserData({ cwd: process.cwd() });
  printCliMessage(
    result.created ? "success" : "note",
    result.created ? "Codex Connect 已初始化。" : "Codex Connect 已经初始化。",
  );
  console.log(`配置目录：${result.dataDir}`);
  console.log(`配置文件：${result.configPath}`);
  if (result.created) {
    console.log(`默认 Workspace：${result.workspace}`);
    printCliMessage("note", "请运行 codexc setup 配置通讯渠道，然后运行 codexc service install。");
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
  const forwardSignal = (signal) => signalChildProcesses([child], signal);
  const forwardReload = () => forwardSignal("SIGHUP");
  const forwardTerminate = () => forwardSignal("SIGTERM");
  const forwardInterrupt = () => forwardSignal("SIGINT");
  const cleanup = installProcessSignalHandlers({
    SIGHUP: forwardReload,
    SIGTERM: forwardTerminate,
    SIGINT: forwardInterrupt,
  });
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
  const { defaultWorkspace } = readWorkspaceConfig(runtime.document);
  const appServerRuntime = resolveAppServerRuntime(
    runtime.document,
    runtime.dataDir,
    runtime.environment,
  );
  const {
    primarySocketPath: socketPath,
    managedProvider,
    managedSocketPath: providerSocketPath,
    primaryProvider,
  } = appServerRuntime;
  const {
    ProviderProxy,
    sendProviderProxyMetrics,
  } = await import("../dist/provider-proxy/index.js");
  const providerProxies = [];
  const upstreamAgents = new Set();
  const supervisorOwner = new AppServerSupervisorOwner(
    socketPath,
    appServerRuntime.topology,
  );
  await supervisorOwner.start();
  try {
    await prepareAppServerSocketPaths(appServerRuntime.socketPaths);
  } catch (error) {
    await supervisorOwner.close();
    throw error;
  }
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
      try {
        writeManagedModelProviderRoleConfig(runtime.environment, {
          baseUrl: localBaseUrl,
        });
      } catch (error) {
        console.error(
          `DeepSeek 子代理角色配置生成失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      managedArguments = withProviderBaseUrl(
        managedProvider.arguments,
        managedProvider.provider,
        localBaseUrl,
      );
    }
  } catch (error) {
    await Promise.all(providerProxies.map((proxy) => proxy.close()));
    for (const agent of upstreamAgents) agent.destroy();
    await supervisorOwner.close();
    throw error;
  }
  const children = [spawn(runtime.environment.CODEX_BINARY, [
    ...primaryArguments,
    "app-server",
    "--listen",
    `unix://${socketPath}`,
  ], {
    stdio: "inherit",
    env: {
      ...runtime.environment,
      ...(managedProvider ? managedProvider.childEnvironment : {}),
    },
    cwd: defaultWorkspace.cwd,
  })];
  if (managedProvider && managedArguments) {
    children.push(spawn(runtime.environment.CODEX_BINARY, [
      ...managedArguments,
      "app-server",
      "--listen",
      `unix://${providerSocketPath}`,
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
    await supervisorOwner.close();
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
    printCliMessage(result.added ? "success" : "note", result.added ? "Workspace 已添加。" : "Workspace 已存在。");
    console.log(`${result.workspace.name} (${result.workspace.id})`);
    console.log(result.workspace.cwd);
    for (const removed of result.removedWorkspaces) {
      printCliMessage("success", `已清理失效 Workspace：${removed.name} (${removed.id})`);
      console.log(removed.cwd);
    }
    if (result.defaultChanged) {
      printCliMessage("success", `默认 Workspace 已切换为：${result.defaultWorkspace.name} (${result.defaultWorkspace.id})`);
    }
    if (result.added || result.removedWorkspaces.length > 0 || result.defaultChanged) {
      printCliMessage("note", "运行中的 Gateway 会自动热加载配置，必要时重启。");
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
    printCliMessage("success", `Workspace 注册已删除：${result.removedWorkspace.name} (${result.removedWorkspace.id})`);
    console.log(result.removedWorkspace.cwd);
    printCliMessage("note", "磁盘目录未删除。");
    if (result.defaultChanged) {
      printCliMessage("success", `默认 Workspace 已切换为：${result.defaultWorkspace.name} (${result.defaultWorkspace.id})`);
    }
    printCliMessage("note", "运行中的 Gateway 会自动重新加载配置，必要时重启。");
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
  const unavailableIds = inspectWorkspaceConfig(
    readGatewayConfig(runtime.configPath),
  ).workspaces.map((workspace) => workspace.id);
  let id;
  let directory;
  do {
    id = chooseWorkspaceId(name, unavailableIds);
    directory = join(runtime.dataDir, `${id}-work`);
    unavailableIds.push(id);
  } while (existsSync(directory));
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
  printCliMessage("success", "Workspace 已新增。");
  console.log(`${result.workspace.name} (${result.workspace.id})`);
  console.log(result.workspace.cwd);
  if (result.defaultChanged) {
    printCliMessage("success", `默认 Workspace 已切换为：${result.defaultWorkspace.name} (${result.defaultWorkspace.id})`);
  }
  printCliMessage("note", "运行中的 Gateway 会自动热加载配置，必要时重启。");
}

async function removeWorkspaceInteractively({
  runtime,
  eventQueuePath,
  fallbackDefaultWorkspace,
}) {
  const document = readGatewayConfig(runtime.configPath);
  const { workspaces } = inspectWorkspaceConfig(document);
  if (workspaces.length === 0) {
    printCliMessage("note", "当前没有已配置的 Workspace。");
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
  printCliMessage("success", `Workspace 注册已删除：${result.removedWorkspace.name} (${result.removedWorkspace.id})`);
  console.log(result.removedWorkspace.cwd);
  printCliMessage("note", "磁盘目录未删除。");
  if (result.defaultChanged) {
    printCliMessage("success", `默认 Workspace 已切换为：${result.defaultWorkspace.name} (${result.defaultWorkspace.id})`);
  }
  printCliMessage("note", "运行中的 Gateway 会自动重新加载配置，必要时重启。");
}

async function runWorkspacePermissionsMenu(runtime) {
  const document = readGatewayConfig(runtime.configPath);
  const workspaces = Array.isArray(document.workspaces)
    ? document.workspaces
    : [];
  if (workspaces.length === 0) {
    printCliMessage("note", "当前没有已配置的 Workspace。");
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
        printCliMessage("failure", "permissions 与 sandbox 互斥，请先清除权限 Profile。");
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
      printCliMessage("failure", "permissions 与 sandbox 互斥，请先清除沙箱。");
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
  printCliMessage("success", "已更新工作区权限。");
  console.log(
    `沙箱：${entry.sandbox ?? "未配置"} · 审批：${entry.approval_policy ?? "未配置"} · 权限 Profile：${entry.permissions ?? "未配置"}`,
  );
  printCliMessage("note", "运行中的 Gateway 会自动热加载，对新建或恢复的 Thread 生效。");
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
    && serviceTargetIncludes(target, "app-server")
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
    const result = checkProjectRules({
      cwd: process.cwd(),
      codexBinary: projectRulesCodexBinary(),
    });
    printCliMessage("success", "项目 Codex 规则检查通过。");
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
  printCliMessage("success", force ? "项目 Codex 规则已重新生成。" : "项目 Codex 规则已生成。");
  console.log(`项目目录：${result.projectRoot}`);
  console.log(`规则文件：${result.rulesPath}`);
  checkProjectRules({
    cwd: result.projectRoot,
    codexBinary: projectRulesCodexBinary(),
  });
  printCliMessage("success", "项目 Codex 规则检查通过。");
  printCliMessage("note", "重启 Codex 后生效；项目必须处于受信任状态。");
}

function projectRulesCodexBinary() {
  const located = locateOptionalUserConfig();
  if (!located) {
    return process.env.CODEX_BINARY?.trim() || "codex";
  }
  const document = readGatewayConfig(located.configPath);
  return effectiveCodexBinary(validateCodexConfigDocument(document.codex).binary);
}

function agents(args) {
  if (showRequestedHelp(args, "agents")) {
    return;
  }
  if (showSubcommandHelp(args, "status", "agents.status") ||
    showSubcommandHelp(args, "enable-deepseek", "agents.enable-deepseek") ||
    showSubcommandHelp(args, "disable-deepseek", "agents.disable-deepseek")) {
    return;
  }
  runScript("scripts/agents.mjs", args);
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

async function runForegroundScript(
  relativePath,
  args,
  additionalEnvironment = {},
  workingDirectory,
) {
  const runtime = configuredEnvironment();
  const child = spawn(
    process.execPath,
    [join(packageDir, relativePath), ...args],
    {
      stdio: "inherit",
      env: { ...runtime.environment, ...additionalEnvironment },
      cwd: workingDirectory ?? runtime.dataDir,
      detached: process.platform !== "win32",
    },
  );
  let forwardedSignal;
  let shutdownTimer;
  let forcedProcessGroupStop = false;
  const forceStop = () => {
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
        forcedProcessGroupStop = true;
        return;
      } catch (error) {
        if (error?.code === "ESRCH") return;
      }
    }
    if (!childProcessIsRunning(child)) return;
    child.kill("SIGKILL");
  };
  const forwardSignal = (signal) => {
    if (forwardedSignal) {
      forceStop();
      return;
    }
    forwardedSignal = signal;
    if (childProcessIsRunning(child)) {
      signalChildProcesses([child], signal);
      shutdownTimer = setTimeout(forceStop, foregroundShutdownTimeoutMs);
      shutdownTimer.unref();
    }
  };
  const forwardTerminate = () => forwardSignal("SIGTERM");
  const forwardInterrupt = () => forwardSignal("SIGINT");
  const cleanupSignals = installProcessSignalHandlers({
    SIGTERM: forwardTerminate,
    SIGINT: forwardInterrupt,
  });
  const cleanup = () => {
    if (shutdownTimer) clearTimeout(shutdownTimer);
    cleanupSignals();
  };

  await new Promise((resolveChild, rejectChild) => {
    child.once("error", (error) => {
      cleanup();
      rejectChild(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      void (async () => {
        if (forcedProcessGroupStop && child.pid !== undefined) {
          await waitForProcessGroupExit(
            child.pid,
            foregroundProcessGroupExitTimeoutMs,
          );
        }
        const resultingSignal = forwardedSignal ?? signal;
        if (resultingSignal) {
          process.kill(process.pid, resultingSignal);
          return;
        }
        if (code !== 0) {
          rejectChild(new Error(`子命令执行失败：exit=${code ?? 1}`));
          return;
        }
        resolveChild();
      })().catch(rejectChild);
    });
  });
}

async function waitForProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupIsRunning(processGroupId)) {
    if (Date.now() >= deadline) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

function processGroupIsRunning(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
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
    showSubcommandHelp(args, "turns", "metrics.turns") ||
    showSubcommandHelp(args, "threads", "metrics.threads") ||
    showSubcommandHelp(args, "status", "metrics.status") ||
    showSubcommandHelp(args, "upgrade", "metrics.upgrade") ||
    showSubcommandHelp(args, "reset", "metrics.reset") ||
    showSubcommandHelp(args, "sync-reset", "metrics.sync_reset") ||
    showSubcommandHelp(args, "cleanup", "metrics.cleanup") ||
    showSubcommandHelp(args, "prune", "metrics.prune") ||
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
    await runMetricsMenu({
      runDatabaseCommand: (commandArgs) => {
        if (commandArgs.length === 1 && commandArgs[0] === "status") {
          run(
            process.execPath,
            [join(packageDir, "scripts/metrics-database.mjs"), "status"],
            process.env,
            process.cwd(),
          );
          return;
        }
        runScript("scripts/metrics-database.mjs", commandArgs);
      },
      runMetricsCommand,
    });
    return;
  }
  if (
    !new Set(["run", "turns", "threads", "status", "upgrade", "reset", "sync-reset", "cleanup", "prune", "report", "export"])
      .has(subcommand)
  ) {
    throw new Error("用法：codexc metrics <run|turns|threads|status|upgrade|reset|sync-reset|cleanup|prune|report|export>");
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
  if (subcommand === "upgrade" && rest.length === 1 && rest[0] === "--restart-gateway") {
    runScript("scripts/metrics-database.mjs", ["upgrade-restart"]);
    return;
  }
  if (subcommand === "sync-reset" && rest.length === 1 && rest[0] === "--restart-gateway") {
    runScript("scripts/metrics-database.mjs", ["sync-reset-restart"]);
    return;
  }
  if (subcommand === "cleanup") {
    const restart = rest.includes("--restart-gateway");
    const cleanupArgs = rest.filter((argument) => argument !== "--restart-gateway");
    runScript("scripts/metrics-database.mjs", [restart ? "cleanup-restart" : "cleanup", ...cleanupArgs]);
    return;
  }
  if (subcommand === "prune" && rest.length !== 1) {
    throw new Error("用法：codexc metrics prune <openai|deepseek>");
  }
  if (new Set(["upgrade", "reset", "sync-reset"]).has(subcommand) && rest.length > 0) {
    throw new Error(`用法：codexc metrics ${subcommand}`);
  }
  if (new Set(["run", "turns", "threads", "report", "export"]).has(subcommand)) {
    runMetricsCommand([subcommand, ...rest]);
    return;
  }
  runScript("scripts/metrics-database.mjs", [subcommand, ...rest]);
}

async function channel(args) {
  if (
    showRequestedHelp(args, "channel")
    || showSubcommandHelp(args, "send-image", "channel.send_image")
  ) {
    return;
  }
  const [subcommand, ...rest] = args;
  if (subcommand !== "send-image") {
    throw new Error("用法：codexc channel <send-image>");
  }
  runScript("scripts/channel-send-image.mjs", rest);
}

function runMetricsCommand(args) {
  const withoutStdout = args.filter((argument) => argument !== "--stdout");
  const writeFile = withoutStdout.length === args.length;
  if (!writeFile) {
    runScript("scripts/metrics-database.mjs", withoutStdout);
    return;
  }
  const output = openMetricsExportFile(
    withoutStdout[0] ?? "metrics",
    withoutStdout,
  );
  let result;
  try {
    result = spawnSync(
      process.execPath,
      [join(packageDir, "scripts/metrics-database.mjs"), ...withoutStdout],
      { stdio: ["inherit", output.fileDescriptor, "inherit"] },
    );
  } finally {
    closeSync(output.fileDescriptor);
  }
  if (result.error || result.status !== 0) {
    rmSync(output.file, { force: true });
    if (result.error) printCliMessage("failure", `指标导出失败：${result.error.message}`);
    process.exitCode = result.status ?? 1;
    return;
  }
  chmodSync(output.file, 0o600);
  printCliMessage("success", "指标导出完成。");
  console.log(`已导出：${output.file}`);
}

function openMetricsExportFile(subcommand, args) {
  const { dataDir } = requireUserConfig();
  const dateDirectory = new Date().toLocaleDateString("en-CA");
  const directory = join(dataDir, "output", dateDirectory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const formatOption = args.findIndex((argument) => argument === "--format");
  const format = formatOption >= 0
    ? args[formatOption + 1] ?? "markdown"
    : subcommand === "export"
      ? "json"
      : "markdown";
  const extension = format === "markdown" ? "md" : format;
  const positional = metricsPositionalIdentifier(subcommand, args);
  const identifier = positional === undefined
    ? ""
    : `-${positional.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 12)}`;
  const timestamp = metricsTimestamp();
  const baseName = `${subcommand}${identifier}-${timestamp}`;
  for (let suffix = 1; ; suffix += 1) {
    const uniqueSuffix = suffix === 1 ? "" : `-${suffix}`;
    const file = join(directory, `${baseName}${uniqueSuffix}.${extension}`);
    try {
      return {
        file,
        fileDescriptor: openSync(file, "wx", 0o600),
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

function metricsPositionalIdentifier(subcommand, args) {
  if (subcommand !== "run" && subcommand !== "turns" && subcommand !== "export") {
    return undefined;
  }
  const valueOptions = new Set(["--range", "--group", "--format"]);
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--thread") {
      return args[index + 1];
    }
    if (valueOptions.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("--")) {
      return argument;
    }
  }
  return undefined;
}

function metricsTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join("-");
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
  const forward = (signal) => signalChildProcesses(children, signal);
  const terminate = () => forward("SIGTERM");
  const interrupt = () => forward("SIGINT");
  const cleanup = installProcessSignalHandlers({
    SIGTERM: terminate,
    SIGINT: interrupt,
  });
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
  const defaultTarget = defaultServiceTarget(action);
  return [parseServiceTarget(args[0] ?? defaultTarget)];
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
