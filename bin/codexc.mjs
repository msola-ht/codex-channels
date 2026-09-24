#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import { isCommandHelp } from "../scripts/cli-help.mjs";
import { primaryProviderUsage } from "../scripts/primary-provider-usage.mjs";
import { writeCliMessage as printCliMessage } from "../runtime/cli-presentation.mjs";
import {
  assertSynchronousChildSuccess,
  childProcessIsRunning,
  ForwardedChildSignalError,
  installProcessSignalHandlers,
  ReportedChildExitError,
  signalChildProcesses,
} from "../runtime/process-lifecycle.mjs";
import {
  initializeUserData,
  packageDir,
  requireUserConfig,
} from "../scripts/runtime-config.mjs";
import { codexHomePath } from "../runtime/codex-home.mjs";
import {
  securePrivateFileSync,
} from "../runtime/private-file.mjs";
import {
  CODEX_REMOTE_USAGE,
  parseCodexRemoteOptions,
} from "../scripts/codex-remote-options.mjs";
import { parseChannelSendImageArgs } from "../scripts/channel-send-image-options.mjs";
import {
  parseTrafficCleanupArgs,
  parseTrafficCommandArgs,
  TRAFFIC_CLEANUP_USAGE,
  TRAFFIC_USAGE,
} from "../scripts/traffic-command-options.mjs";
import {
  desktopAppCommandUsage,
  runDesktopAppCommand,
} from "../scripts/desktop-app-command.mjs";
import {
  runTimezoneCommand,
  timezoneCommandUsage,
} from "../scripts/timezone-command.mjs";
import {
  metricsCommandUsage,
  validateMetricsCommandArgs,
} from "../scripts/metrics-command-options.mjs";
import { runMetricsMenu } from "../scripts/metrics-menu.mjs";
import { runCliMenu, runServiceMenu } from "../scripts/cli-menu.mjs";
import { cleanupUsage, runCleanupMenu } from "../scripts/cleanup-menu.mjs";
import { configuredEnvironment, serviceControlEnvironment } from "../scripts/runtime-environment.mjs";
import {
  runAppServerServiceCommand,
  runGatewayServiceCommand,
  runServiceCommand,
  serviceCommandActions,
  serviceCommandUsage,
} from "../scripts/service-command.mjs";
import { parseWebuiCliArgs } from "../scripts/webui-command-options.mjs";
import { runWorkspaceCommand } from "../scripts/workspace-command.mjs";

const foregroundShutdownTimeoutMs = 5_000;
const foregroundProcessGroupExitTimeoutMs = 1_000;
const nodeExperimentalWarningOption = "--disable-warning=ExperimentalWarning";

const helpText = {
  main: `Codex Connect CLI

用法：codexc [命令]

交互终端无参数时打开主菜单；非交互终端显示帮助。

初始化与配置：
  init                         初始化用户目录和配置
  setup [--json]               配置 Provider、通讯渠道与项目技能（接入向导）
  config [--json]              管理 Codex 新会话偏好与 Gateway 日常设置
  timezone                     设置 App Server、WebUI 或网关时区
  doctor                       诊断安装、配置和服务
  security                     修复本机私有路径权限

项目与 Codex：
  remote [参数]                启动共享 App Server 的 Codex TUI
  desktop-app                 管理 Codex Desktop App 共享连接
  work                         管理 Workspace（交互菜单或子命令）
  primary-provider             管理第三方主 Provider（新增、列表、切换、删除）
  opencode-go                  管理 OpenCode Go 多账户
  ccg                          移除 CCG 账户或旧单账户
  deepseek                     管理 DeepSeek 多账户

指标与工具：
  metrics                      查询、导出和维护模型指标（交互菜单或子命令）
  cleanup                      统一交互清理会话、转储和指标
  traffic                      查看模型请求与响应转储（列表、详情或持续跟随）
  sessions                     管理会话（包括按 Turn 清理旧会话）
  channel                      发送渠道图片
  webui                        启动指标 WebUI

服务与维护：
  start                        前台启动核心服务
  service                      管理后台服务
  update                       更新程序与配套 Codex CLI
  uninstall                    卸载受管源码与全局命令并保留用户数据

信息：
  version, -v, --version       显示版本

运行 codexc <命令> -h 查看详细用法。`,
  init: `用法：codexc init

初始化用户数据目录和 config.toml；已有配置不会被覆盖。`,
  setup: `用法：codexc setup [--json]

打开脱敏接入状态总览，以及模型与提供商、通讯渠道和项目技能设置菜单。

默认模式输出中文交互文本；--json 保留交互输入，将提示和进度写入 stderr，并将每次完成的设置以 JSON Lines 写入 stdout。

常用入口：
  codexc setup → 模型与提供商 → OpenAI 官方 → 登录并恢复官方
  codexc setup → 模型与提供商 → 第三方 Provider → 自定义 Responses Provider / DeepSeek 官方 / OpenCode Go 官方 / CCG（CommandCode） / 受管 Provider 模型设置
  codexc setup → 通讯渠道 → Telegram / 飞书 / 微信
  codexc setup → 项目技能（安装或卸载项目技能）

DeepSeek、OpenCode Go 与 CCG 子菜单中的“修改模型设置”会打开同一受管 Provider 设置，并预选当前 Provider。`,
  start: `用法：codexc start

在前台启动 Codex App Server 与 Gateway。`,
  remote: `${CODEX_REMOTE_USAGE}

连接 Gateway 共用的 App Server，并把其余参数传给原生 Codex CLI。
切换模式可用 --profile sf-ds-<账户>、sf-ocg-<账户>、sf-ccg-<账户> 或
sf-custom-<Provider ID> 连接对应的隔离 App Server；与原生 Codex Profile 名称一致。`,
  desktop_app: desktopAppCommandUsage,
  service: `用法：codexc service [命令]

交互终端无参数时选择操作和目标；非交互终端显示帮助。

  install                      生成全部后台服务定义，并启动 App Server 与 Gateway
  uninstall                    卸载全部后台服务并保留用户数据
  start [目标]                 启动 gateway、app-server、webui 或 all
  stop [目标]                  停止 gateway、app-server、webui 或 all
  reload                       通知 Gateway 重新读取配置
  restart [目标]               重启 gateway、app-server、webui 或 all
  status [目标] [--json]       查看 gateway、app-server、webui 或 all
  logs [目标] [-f] [-n 行数]   查看后台日志

目标默认值：start/stop/status 为 all，restart/logs 为 gateway。
all 只包含 App Server 与 Gateway；WebUI 需单独指定。`,
  "service.install": serviceCommandUsage.install,
  "service.uninstall": serviceCommandUsage.uninstall,
  "service.start": serviceCommandUsage.start,
  "service.stop": serviceCommandUsage.stop,
  "service.reload": serviceCommandUsage.reload,
  "service.restart": serviceCommandUsage.restart,
  "service.status": serviceCommandUsage.status,
  "service.logs": serviceCommandUsage.logs,
  config: `用法：codexc config [--json]

打开统一日常配置菜单：Codex 新会话与用户偏好、Gateway 脱敏配置总览、显示设置、系统设置、自动化（计划任务）、
网络代理、高级设置（日志等级与开发中功能）、WebUI 设置、
指标存储、Telegram 消息格式与配置路径查看。
非交互终端（脚本或管道）直接显示用户目录与配置文件路径；--json 输出路径和文件存在状态。`,
  timezone: timezoneCommandUsage,
  doctor: `用法：codexc doctor [--json]

只诊断当前安装、配置和服务状态，不修改配置；--json 输出结构化检查结果；
Linux 缺少 bubblewrap 时输出安装建议。`,
  security: `用法：codexc security repair

修复 Windows Codex 私有 TOML 配置文件的 ACL；不修改 Codex 沙箱目录权限，其他平台明确提示无需处理。`,
  "primary-provider": primaryProviderUsage,
  opencode_go: `用法：codexc opencode-go account <add|list|remove|default|stop> [id]

管理 OpenCode Go 多账户。Key 只写入 0600 私有 Codex Profile，不进入 Gateway config.toml、命令行或日志。

  add <id>     新增账户（交互输入邮箱或手机号、API Key）
  list         列出账户与默认标记
  remove <id>  备份后删除账户 Profile 与注册表项
  default <id> 设置新会话默认账户
  stop <id>    立即释放该账户的隔离 App Server（空闲可自动重新拉起）

旧单账户：codexc opencode-go legacy remove`,
  "opencode_go.account": `用法：codexc opencode-go account <add|list|remove|default|stop> [id]`,
  "opencode_go.account.add": "用法：codexc opencode-go account add <id>（交互输入邮箱或手机号、API Key）",
  "opencode_go.account.list": "用法：codexc opencode-go account list [--json]",
  "opencode_go.account.remove": "用法：codexc opencode-go account remove <id>",
  "opencode_go.account.default": "用法：codexc opencode-go account default <id>",
  "opencode_go.account.stop": "用法：codexc opencode-go account stop <id>",
  update: `用法：codexc update

Git 源码安装检查并构建官方 main 最新提交，校验当前配置、数据库与配套 Codex CLI 合同后，
在一个停机窗口更新程序与所需 CLI，执行目标版本的数据库升级入口，再恢复核心服务。
CLI 版本不匹配时询问是否安装精确版本。npm 安装同步配套 CLI 并执行必要的数据库升级，不更新 Gateway 程序包。
当前数据库基线无迁移写入；配置与模型目录不改写。数据库升级未完成时不启动服务，其他失败报告阶段并尝试恢复服务。必须从本机终端执行。`,
  uninstall: `用法：codexc uninstall

卸载后台服务、受管 Git 源码仓库与对应 npm 全局命令，并清理旧安装写入的 Shell PATH 配置；保留
config.toml、数据库、凭据、日志和输出。直接从 npm Registry 安装的版本使用
codexc service uninstall 和 npm uninstall -g @hegenai/codexc。`,
  metrics: `用法：codexc metrics

无参数时进入查询与导出菜单；交互清理和重置请用 codexc cleanup。直接命令：
  ${metricsCommandUsage.run.slice("用法：".length)}   本次运行汇总（最近 Turn + 会话累计）
  ${metricsCommandUsage.turns.slice("用法：".length)}   会话每次对话明细
  ${metricsCommandUsage.threads.slice("用法：".length)}   列出有指标的会话
  ${metricsCommandUsage.report.slice("用法：".length)}   聚合汇报
  ${metricsCommandUsage.export.slice("用法：".length)}   请求明细导出
  ${metricsCommandUsage.quota.slice("用法：".length)}   历史额度周期
  codexc metrics status [--json]   指标数据库状态
  codexc metrics reset    备份并重建指标库（需 Gateway 停止）
  codexc metrics cleanup [--keep-days 天数] [--max-rows 行数]   按策略备份并清理旧指标
  codexc metrics prune <provider>   备份并清理指定提供商请求指标（按原服务状态恢复）`,
  traffic: TRAFFIC_USAGE,
  "traffic.cleanup": TRAFFIC_CLEANUP_USAGE,
  channel: `用法：codexc channel <send-image>

渠道图片能力：由 Gateway 使用 Thread 绑定渠道的机器人凭据发送本地 PNG/JPEG 图片。`,
  "channel.send_image": `用法：codexc channel send-image <图片路径> [--thread <Thread ID>]

把本地 PNG/JPEG 图片（最大 10 MiB）交给 Gateway，发送回该 Thread 绑定的
飞书/微信/Telegram 会话。不指定 --thread 且存在多个绑定时会拒绝并提示指定。
图片会被复制到 ~/.codex-connect/data/channel-outbox/pending/，由网关轮询发送；
成功后归档到 done/，失败归档到 failed/ 并保留原因。`,
  webui: `用法：codexc webui [--host 地址] [--port 端口]

启动本地指标 WebUI（默认 http://127.0.0.1:8787/）；设置页可在同一令牌下修改已开放的低风险设置。
参数优先级：命令行 > config.toml 的 [webui] 段 > 默认值。
--host 指定监听地址（127.0.0.1、::1 或 0.0.0.0），默认回环；
--port 指定监听端口，范围 1-65535；
访问令牌请使用 codexc config 的 WebUI 设置，或手工编辑 [webui] 段。
指标 JSON API 来自指标数据库；设置管理只允许白名单字段并复用 Config 修订保护。`,
  "metrics.status": `用法：codexc metrics status [--json]

只读显示指标数据库路径、Schema 兼容性和记录数量；--json 输出稳定 JSON。`,
  "metrics.run": `${metricsCommandUsage.run}

导出指定 Thread 的本次运行汇总：最近 Turn 的请求数、Token、缓存命中率、速度与耗时，
以及当前会话累计；默认输出 Markdown 并写入 ~/.codex-connect/output/<日期>/，加 --stdout 输出到标准输出。`,
  "metrics.turns": `${metricsCommandUsage.turns}

按时间、模型、操作和状态筛选指定会话自身的每轮请求与 Token；默认全部保留历史，写入
~/.codex-connect/output/<日期>/，加 --stdout 输出到标准输出。`,
  "metrics.threads": `${metricsCommandUsage.threads}

按时间和组合条件列出指标库中有记录的会话及其期间轮数、请求数；默认全部保留历史，写入 ~/.codex-connect/output/<日期>/，
加 --stdout 输出到标准输出。`,
  "metrics.reset": `用法：codexc metrics reset

要求 Gateway 已停止；先备份现有指标库，再让下次启动创建当前 Schema。`,
  "metrics.prune": `用法：codexc metrics prune <provider>

provider 支持 openai、已配置的受管 Provider、OpenCode Go 账户，以及当前或已备份的自定义主 Provider ID。备份并删除本地指标库中该提供商全部请求行，随后
按原状态恢复 Gateway。OpenAI 额度重置
后可用 openai 从零重新统计用量；备份保留在指标库同目录的 *.<provider>-prune-*.bak。`,
  "metrics.cleanup": `用法：codexc metrics cleanup [--before YYYY-MM-DD | --keep-days 天数] [--max-rows 行数] [--vacuum] [--restart-gateway]

按配置 [metrics.storage] 或命令行覆盖值清理最旧请求指标。默认要求 Gateway 已停止；
加 --restart-gateway 自动停止并重新启动。清理前创建 0600 备份；--vacuum 会立即回收文件空间。`,
  cleanup: cleanupUsage,
  sessions: "用法：codexc sessions [cleanup <最大轮数> [--idle-days <天数>] [--confirm]]\n\n交互归档请运行 codexc cleanup；清理默认只预览，交互终端确认后才归档。执行前必须停止 Gateway。",
  "sessions.cleanup": "用法：codexc sessions cleanup <最大轮数> [--idle-days <天数>] [--confirm]",
  "metrics.report": `${metricsCommandUsage.report}

只读输出汇报；默认最近 30 天并按模型分组，写入 ~/.codex-connect/output/<日期>/，加 --stdout 输出到标准输出。`,
  "metrics.export": `${metricsCommandUsage.export}

只读导出脱敏请求记录；默认最近 30 天、JSON 格式并写入 ~/.codex-connect/output/<日期>/，加 --stdout 输出到标准输出。支持 --thread、--turn 及模型、操作、状态组合筛选；--turn 必须同时指定 --thread。`,
  "metrics.quota": `${metricsCommandUsage.quota}

只读查询已记录的 OpenAI 与 OpenCode Go 历史额度窗口；按实际重置时间归并，并显示窗口起止、请求、Token 和本机样本估算。`,
  version: "用法：codexc version",
  gateway: `用法：codexc gateway

内部 Gateway 服务入口。`,
  "service-app-server": `用法：codexc service-app-server

内部 Codex App Server 服务入口。`,
};

const [command, ...args] = process.argv.slice(2);

try {
  if (command === undefined && process.stdin.isTTY && process.stdout.isTTY) {
    await runCliMenu({ runCommand: ([name, ...values]) => executeCommand(name, values) });
  } else {
    await executeCommand(command, args);
  }
} catch (error) {
  if (
    !(error instanceof ReportedChildExitError)
    && !(error instanceof ForwardedChildSignalError)
  ) {
    printCliMessage("failure", error instanceof Error ? error.message : String(error));
  }
  if (error instanceof ReportedChildExitError) {
    process.exitCode = error.exitCode;
  } else if (!(error instanceof ForwardedChildSignalError)) {
    process.exitCode = 1;
  }
}

async function executeCommand(command, args) {
  switch (command) {
    case undefined:
      printHelp();
      break;
    case "--help":
    case "-h":
      requireNoArguments(args, "用法：codexc --help");
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
      if (!(args.length === 0 || (args.length === 1 && args[0] === "--json"))) {
        throw new Error("用法：codexc setup [--json]");
      }
      runSetup(args);
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
      await runGatewayServiceCommand(args);
      break;
    case "service-app-server":
      if (showRequestedHelp(args, "service-app-server")) {
        break;
      }
      await runAppServerServiceCommand(args);
      break;
    case "remote":
      if (showRequestedHelp(args, "remote")) {
        break;
      }
      parseCodexRemoteOptions(args);
      runScript("scripts/codex-remote.mjs", args, {
        workingDirectory: process.cwd(),
        failureReportedByChild: true,
      });
      break;
    case "desktop-app":
      if (showRequestedHelp(args, "desktop_app")) {
        break;
      }
      if (isCommandHelp(args, [[], ["enable"], ["disable"], ["status"], ["open"]], desktopAppCommandUsage)) {
        console.log(desktopAppCommandUsage);
        break;
      }
      await runDesktopAppCommand(args);
      break;
    case "work":
      await runWorkspaceCommand(args);
      break;
    case "service":
      await handleServiceCommand(args);
      break;
    case "config":
      if (showRequestedHelp(args, "config")) {
        break;
      }
      if (!(args.length === 0 || (args.length === 1 && args[0] === "--json"))) {
        throw new Error("用法：codexc config [--json]");
      }
      run(
        process.execPath,
        [join(packageDir, "scripts/config.mjs"), ...args],
        process.env,
        process.cwd(),
        { failureReportedByChild: true },
      );
      break;
    case "timezone":
      if (showRequestedHelp(args, "timezone")) {
        break;
      }
      await runTimezoneCommand(args);
      break;
    case "doctor":
      if (showRequestedHelp(args, "doctor")) {
        break;
      }
      runDoctor(args);
      break;
    case "security":
      security(args);
      break;
    case "primary-provider":
      if (isCommandHelp(args, [[], ["add"], ["list"], ["switch"], ["remove"]], primaryProviderUsage)) {
        console.log(primaryProviderUsage);
        break;
      }
      runScript("scripts/primary-provider-cli.mjs", args, {
        failureReportedByChild: true,
      });
      break;
    case "ccg":
      if (args.some(isHelpArgument)) {
        runStandaloneScript("scripts/ccg-setup.mjs", args);
      } else {
        if (!(args.length === 2 && args[0] === "legacy" && args[1] === "remove")
          && !(args.length === 3 && args[0] === "account" && args[1] === "remove")) {
          throw new Error("用法：codexc ccg account remove <id> 或 codexc ccg legacy remove");
        }
        runScript("scripts/ccg-setup.mjs", args, { failureReportedByChild: true });
      }
      break;
    case "deepseek":
      if (args.some(isHelpArgument)) runStandaloneScript("scripts/deepseek-account-setup.mjs", args);
      else runScript("scripts/deepseek-account-setup.mjs", args, { failureReportedByChild: true });
      break;
    case "opencode-go":
      opencodeGoAccount(args);
      break;
    case "update":
      if (showRequestedHelp(args, "update")) {
        break;
      }
      requireNoArguments(args, "用法：codexc update");
      runScript("scripts/source-update.mjs", [], { failureReportedByChild: true });
      break;
    case "uninstall":
      if (showRequestedHelp(args, "uninstall")) {
        break;
      }
      requireNoArguments(args, "用法：codexc uninstall");
      runStandaloneScript("scripts/source-uninstall.mjs", [], serviceControlEnvironment());
      break;
    case "metrics":
      await metrics(args);
      break;
    case "cleanup":
      if (showRequestedHelp(args, "cleanup")) break;
      requireNoArguments(args, cleanupUsage);
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log(cleanupUsage);
        break;
      }
      await runCleanupMenu({
        runSessionCleanup: (values) => runScript("scripts/session-cleanup.mjs", values, { failureReportedByChild: true }),
        runTrafficCleanup: (values) => runStandaloneScript("scripts/traffic-cleanup.mjs", values),
        runDatabaseCommand: (values) => runScript("scripts/metrics-database.mjs", values, { failureReportedByChild: true }),
      });
      break;
    case "traffic":
      if (showRequestedHelp(args, "traffic") || showSubcommandHelp(args, "cleanup", "traffic.cleanup")) break;
      if (args.some(isHelpArgument)) throw new Error(TRAFFIC_USAGE);
      if (args[0] === "cleanup") {
        parseTrafficCleanupArgs(args.slice(1));
        runStandaloneScript("scripts/traffic-cleanup.mjs", args.slice(1));
        break;
      }
      parseTrafficCommandArgs(args);
      runStandaloneScript("scripts/traffic-command.mjs", args);
      break;
    case "sessions":
      if (showRequestedHelp(args, "sessions") || showSubcommandHelp(args, "cleanup", "sessions.cleanup")) break;
      if (args.length === 0) {
        console.log(helpText.sessions);
        break;
      }
      if (args[0] !== "cleanup") throw new Error("用法：codexc sessions cleanup <最大轮数> [--idle-days <天数>] [--confirm]");
      runScript("scripts/session-cleanup.mjs", args.slice(1), { failureReportedByChild: true });
      break;
    case "channel":
      await channel(args);
      break;
    case "webui":
      if (showRequestedHelp(args, "webui")) {
        break;
      }
      if (args.some(isHelpArgument)) {
        throw new Error(helpText.webui);
      }
      parseWebuiCliArgs(args);
      runScript("scripts/webui-server.mjs", args, { failureReportedByChild: true });
      break;
    default:
      throw new Error(`未知命令：${command}\n运行 codexc --help 查看用法`);
  }
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

async function handleServiceCommand(args) {
  if (showRequestedHelp(args, "service")) return;
  if (args.length === 0) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) console.log(helpText.service);
    else await runServiceMenu({ runCommand: runServiceCommand });
    return;
  }
  const [action, ...rest] = args;
  if (
    serviceCommandActions.includes(action)
    && showRequestedHelp(rest, `service.${action}`)
  ) {
    return;
  }
  await runServiceCommand(args);
}

function runDoctor(args) {
  if (!(args.length === 0 || (args.length === 1 && args[0] === "--json"))) {
    throw new Error("用法：codexc doctor [--json]");
  }
  const result = spawnSync(process.execPath, nodeArguments([
    join(packageDir, "scripts/doctor.mjs"),
    ...args,
  ]), {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
  });
  assertSynchronousChildSuccess(result, { failureReportedByChild: true });
}

function opencodeGoAccount(args) {
  isCommandHelp(args, [
    [], ["account"], ["legacy"], ["legacy", "remove"],
    ...["add", "list", "remove", "default", "stop"].map((action) => ["account", action]),
  ], helpText.opencode_go);
  if (args[0] === "legacy") {
    if (args.some(isHelpArgument)) runStandaloneScript("scripts/opencode-go-setup.mjs", args);
    else {
      if (args.length !== 2 || args[1] !== "remove") throw new Error("用法：codexc opencode-go legacy remove");
      runScript("scripts/opencode-go-setup.mjs", args, { failureReportedByChild: true });
    }
    return;
  }
  if (showRequestedHelp(args, "opencode_go")) {
    return;
  }
  if (
    showSubcommandHelp(args, "account", "opencode_go.account")
  ) {
    return;
  }
  if (args.some(isHelpArgument)) {
    const usage = {
      add: helpText["opencode_go.account.add"],
      list: helpText["opencode_go.account.list"],
      remove: helpText["opencode_go.account.remove"],
      default: helpText["opencode_go.account.default"],
      stop: helpText["opencode_go.account.stop"],
    }[args[1]];
    if (usage !== undefined) {
      console.log(usage);
      return;
    }
    throw new Error(helpText.opencode_go);
  }
  const [subcommand, ...rest] = args;
  if (subcommand !== "account") {
    throw new Error(helpText.opencode_go);
  }
  const [action, ...accountArgs] = rest;
  if (
    !new Set(["add", "list", "remove", "default", "stop"]).has(action)
    || (action === "list" && !(accountArgs.length === 0 || (accountArgs.length === 1 && accountArgs[0] === "--json")))
    || (action !== "list" && accountArgs.length !== 1)
  ) {
    throw new Error(helpText.opencode_go);
  }
  runScript("scripts/opencode-go-setup.mjs", ["account", action, ...accountArgs], {
    failureReportedByChild: true,
  });
}

function runSetup(args = []) {
  initializeUserData({ cwd: process.cwd() });
  runScript("scripts/setup.mjs", args, { failureReportedByChild: true });
}

function runScript(relativePath, args, {
  additionalEnvironment = {},
  workingDirectory,
  failureReportedByChild = false,
} = {}) {
  const runtime = configuredEnvironment();
  run(
    process.execPath,
    [join(packageDir, relativePath), ...args],
    { ...runtime.environment, ...additionalEnvironment },
    workingDirectory ?? runtime.dataDir,
    { failureReportedByChild },
  );
}

function runStandaloneScript(relativePath, args, environment = process.env) {
  run(
    process.execPath,
    [join(packageDir, relativePath), ...args],
    environment,
    process.cwd(),
    { failureReportedByChild: true },
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
    nodeArguments([join(packageDir, relativePath), ...args]),
    {
      stdio: process.platform === "win32"
        ? ["inherit", "inherit", "inherit", "ipc"]
        : "inherit",
      env: { ...runtime.unresolvedProxyEnvironment, ...additionalEnvironment },
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
    signalChildProcesses([child], "SIGKILL");
  };
  const forwardSignal = (signal) => {
    if (forwardedSignal) {
      forceStop();
      return;
    }
    forwardedSignal = signal;
    if (childProcessIsRunning(child)) {
      if (!sendForegroundStopMessage(child, signal)) {
        signalChildProcesses([child], signal);
      }
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
          rejectChild(new ReportedChildExitError(code ?? 1));
          return;
        }
        resolveChild();
      })().catch(rejectChild);
    });
  });
}

function security(args) {
  if (showRequestedHelp(args, "security") || showSubcommandHelp(args, "repair", "security")) return;
  if (args.length !== 1 || args[0] !== "repair") {
    throw new Error("用法：codexc security repair");
  }
  if (process.platform !== "win32") {
    printCliMessage("note", "当前平台使用 Unix 文件权限，无需 Windows ACL 修复。");
    return;
  }
  const home = codexHomePath(process.env);
  const files = readdirSync(home, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
    .map((entry) => join(home, entry.name));
  for (const file of files) {
    if (statSync(file).isFile()) securePrivateFileSync(file);
  }
  printCliMessage("success", `Windows 私有 TOML 文件 ACL 已修复：${home}（${files.length} 个文件）`);
}

function sendForegroundStopMessage(child, signal) {
  if (process.platform !== "win32" || !child.connected) return false;
  try {
    child.send({ type: "codexc-stop", signal }, (error) => {
      if (error && childProcessIsRunning(child)) {
        signalChildProcesses([child], signal);
      }
    });
    return true;
  } catch {
    return false;
  }
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

async function metrics(args) {
  if (showRequestedHelp(args, "metrics") ||
    showSubcommandHelp(args, "run", "metrics.run") ||
    showSubcommandHelp(args, "turns", "metrics.turns") ||
    showSubcommandHelp(args, "threads", "metrics.threads") ||
    showSubcommandHelp(args, "status", "metrics.status") ||
    showSubcommandHelp(args, "reset", "metrics.reset") ||
    showSubcommandHelp(args, "cleanup", "metrics.cleanup") ||
    showSubcommandHelp(args, "prune", "metrics.prune") ||
    showSubcommandHelp(args, "report", "metrics.report") ||
    showSubcommandHelp(args, "export", "metrics.export") ||
    showSubcommandHelp(args, "quota", "metrics.quota")) {
    return;
  }
  if (args.some(isHelpArgument)) {
    const key = {
      run: "metrics.run",
      turns: "metrics.turns",
      threads: "metrics.threads",
      status: "metrics.status",
      reset: "metrics.reset",
      cleanup: "metrics.cleanup",
      prune: "metrics.prune",
      report: "metrics.report",
      export: "metrics.export",
      quota: "metrics.quota",
    }[args[0]];
    throw new Error(key === undefined ? helpText.metrics : helpText[key]);
  }
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
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
            { failureReportedByChild: true },
          );
          return;
        }
        runScript("scripts/metrics-database.mjs", commandArgs, { failureReportedByChild: true });
      },
      runMetricsCommand,
    });
    return;
  }
  if (
    !new Set(["run", "turns", "threads", "status", "reset", "cleanup", "prune", "report", "export", "quota"])
      .has(subcommand)
  ) {
    throw new Error("用法：codexc metrics <run|turns|threads|status|reset|cleanup|prune|report|export|quota>");
  }
  validateMetricsCommandArgs(subcommand, rest);
  if (
    subcommand === "status"
    && (rest.length === 0 || (rest.length === 1 && rest[0] === "--json"))
  ) {
    run(
      process.execPath,
      [join(packageDir, "scripts/metrics-database.mjs"), subcommand, ...rest],
      process.env,
      process.cwd(),
      { failureReportedByChild: true },
    );
    return;
  }
  if (subcommand === "cleanup") {
    const restart = rest.includes("--restart-gateway");
    const cleanupArgs = rest.filter((argument) => argument !== "--restart-gateway");
    runScript(
      "scripts/metrics-database.mjs",
      [restart ? "cleanup-restart" : "cleanup", ...cleanupArgs],
      { failureReportedByChild: true },
    );
    return;
  }
  if (subcommand === "prune" && rest.length !== 1) {
    throw new Error("用法：codexc metrics prune <provider>");
  }
  if (subcommand === "reset" && rest.length > 0) {
    throw new Error(`用法：codexc metrics ${subcommand}`);
  }
  if (new Set(["run", "turns", "threads", "report", "export"]).has(subcommand)) {
    runMetricsCommand([subcommand, ...rest]);
    return;
  }
  runScript("scripts/metrics-database.mjs", [subcommand, ...(
    subcommand === "quota" ? rest.filter((argument) => argument !== "--stdout") : rest
  )], { failureReportedByChild: true });
}

async function channel(args) {
  if (
    showRequestedHelp(args, "channel")
    || showSubcommandHelp(args, "send-image", "channel.send_image")
  ) {
    return;
  }
  if (args.some(isHelpArgument)) {
    throw new Error(
      args[0] === "send-image" ? helpText["channel.send_image"] : helpText.channel,
    );
  }
  const [subcommand, ...rest] = args;
  if (subcommand !== "send-image") {
    throw new Error("用法：codexc channel <send-image>");
  }
  parseChannelSendImageArgs(rest);
  runScript("scripts/channel-send-image.mjs", rest, { failureReportedByChild: true });
}

function runMetricsCommand(args) {
  const withoutStdout = args.filter((argument) => argument !== "--stdout");
  const writeFile = withoutStdout.length === args.length;
  if (!writeFile) {
    runScript("scripts/metrics-database.mjs", withoutStdout, { failureReportedByChild: true });
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
      nodeArguments([
        join(packageDir, "scripts/metrics-database.mjs"),
        ...withoutStdout,
      ]),
      { stdio: ["inherit", output.fileDescriptor, "inherit"] },
    );
  } finally {
    closeSync(output.fileDescriptor);
  }
  if (result.error) {
    rmSync(output.file, { force: true });
    throw new Error(`指标导出失败：${result.error.message}`);
  }
  try {
    assertSynchronousChildSuccess(result, { failureReportedByChild: true });
  } catch (error) {
    rmSync(output.file, { force: true });
    throw error;
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
  if (subcommand === "export") {
    const threadOption = args.findIndex((argument) => argument === "--thread");
    return threadOption >= 0 ? args[threadOption + 1] : undefined;
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

function run(executable, args, environment, cwd, options = {}) {
  const result = spawnSync(
    executable,
    executable === process.execPath ? nodeArguments(args) : args,
    {
      stdio: "inherit",
      env: environment,
      ...(cwd ? { cwd } : {}),
    },
  );
  assertSynchronousChildSuccess(result, options);
}

function nodeArguments(args) {
  return [nodeExperimentalWarningOption, ...args];
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
