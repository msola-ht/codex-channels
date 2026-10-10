import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as clackPrompts from "@clack/prompts";

import { codexHomePath, hasCodexAuthFile } from "../runtime/codex-home.mjs";
import {
  effectiveCodexBinary,
  executableInvocation,
  resolveExecutable,
} from "../runtime/executable.mjs";
import { readGatewayConfig, webuiServiceEnabled } from "../runtime/gateway-config.mjs";
import { gatewayChannelStates } from "./config-summary.mjs";
import { loadGatewaySettings, updateGatewaySetting } from "./config-management.mjs";
import { runRelayListenMenu } from "./model-relay-listen-menu.mjs";
import { packageDir } from "./package-path.mjs";
import { requireUserConfig } from "./runtime-config.mjs";
import { runSetup } from "./setup.mjs";

/**
 * `codexc init` 的交互向导：检测现状，然后按需引导接入、可选功能与后台服务安装。
 * 非交互调用不进入本模块，保持原有的只创建配置行为。
 */
export async function runInitWizard({
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  prompts = clackPrompts,
  configCreated = false,
  setupWizard = runSetup,
  relayListenMenu = runRelayListenMenu,
  loadSettings = loadGatewaySettings,
  applySetting = updateGatewaySetting,
} = {}) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("初始化向导需要终端标准输入与输出");
  }
  prompts.intro("Codex Connect 初始化");
  const { configPath } = requireUserConfig(environment);
  let document = readDocument(environment);
  output.write(`${detectionSummary({ environment, configPath, document }).join("\n")}\n`);

  const configure = await prompts.confirm({
    message: "现在配置模型提供商与通讯渠道？",
    initialValue: true,
  });
  if (prompts.isCancel(configure)) return cancelWizard(prompts);
  if (configure === true) {
    let setupCancelled = false;
    await setupWizard({
      input,
      output,
      prompts,
      stayOnMenu: false,
      // 只有类别菜单的取消（无 category 的 cancelled 事件）才中止整套初始化；
      // 子流程返回 undefined 或 {action:"cancelled"} 只结束该子流程，不中止本向导。
      onResult: (event) => {
        if (event?.event === "cancelled" && event.category === undefined) setupCancelled = true;
      },
    });
    if (setupCancelled) {
      output.write(configCreated
        ? "接入向导已取消：配置已创建，未继续初始化；可重新运行 codexc init 或运行 codexc setup。\n"
        : "接入向导已取消：未继续初始化；可重新运行 codexc init 或运行 codexc setup。\n");
      return cancelWizard(prompts);
    }
    document = readDocument(environment);
  }

  const optional = await configureOptionalFeatures({
    environment,
    output,
    prompts,
    configCreated,
    document,
    relayListenMenu,
    loadSettings,
    applySetting,
  });
  if (optional.cancelled) return cancelWizard(prompts);

  let install = false;
  if (!gatewayChannelStates(document).some(channel => channel.enabled === true)) {
    output.write("尚未启用通讯渠道：后台服务安装会因配置校验失败而中止，已跳过安装；"
      + "请先运行 codexc setup 完成接入，再运行 codexc install。\n");
  } else {
    const answer = await prompts.confirm({
      message: "现在安装并启动后台服务？（codexc install）",
      initialValue: true,
    });
    if (prompts.isCancel(answer)) return cancelWizard(prompts);
    install = answer === true;
  }
  if (install === true) {
    output.write("将安装后台服务并启动 App Server 与 Gateway。\n");
  } else {
    output.write("已跳过安装。之后可运行 codexc install 安装并启动后台服务。\n");
    prompts.outro("初始化完成");
  }
  return { action: "completed", install: install === true };
}

function cancelWizard(prompts) {
  prompts.cancel("初始化向导已取消");
  return { action: "cancelled" };
}

async function configureOptionalFeatures({
  environment,
  output,
  prompts,
  configCreated,
  document,
  relayListenMenu,
  loadSettings,
  applySetting,
}) {
  // 默认值沿用当前状态：首次初始化默认关闭，已有配置未设置时视为启用。
  const storedWebui = webuiServiceEnabled(document);
  const webui = await prompts.confirm({
    message: `启用 WebUI 后台服务？（当前：${webuiStateLabel(storedWebui)}；默认仅本机 127.0.0.1:8787）`,
    initialValue: storedWebui ?? !configCreated,
  });
  if (prompts.isCancel(webui)) return { cancelled: true };

  const storedTrafficDump = table(document.debug).model_traffic_dump === true;
  const trafficDump = await prompts.confirm({
    message: `记录模型调用详情（本地转储 prompt、工具输出与代码）？（当前：${storedTrafficDump ? "开启" : "关闭"}）`,
    initialValue: storedTrafficDump,
  });
  if (prompts.isCancel(trafficDump)) return { cancelled: true };

  const storedRelay = table(document.model_relay).enabled === true;
  const relay = await prompts.confirm({
    message: `现在配置模型转发监听？（当前：${storedRelay ? "已启用" : "关闭"}；`
      + "选择“是”进入监听设置，选择“否”保持现状）",
    initialValue: false,
  });
  if (prompts.isCancel(relay)) return { cancelled: true };

  const applied = [];
  try {
    if (webui !== storedWebui) {
      applySetting({ kind: "webui.enabled", value: webui === true }, {
        environment,
        expectedRevision: loadSettings(environment).revision,
      });
      applied.push(`webui.enabled=${webui === true}`);
      output.write(webui === true
        ? "WebUI 已启用：codexc start/restart all 会启动它；地址与访问令牌用 codexc config → WebUI 设置 修改。\n"
        : "WebUI 已关闭：codexc start/restart all 不再启动它；需要时用 codexc start webui 单独启动。\n");
    }
    if (trafficDump !== storedTrafficDump) {
      applySetting({ kind: "system.model-traffic-dump", value: trafficDump === true }, {
        environment,
        expectedRevision: loadSettings(environment).revision,
      });
      applied.push(`model_traffic_dump=${trafficDump === true}`);
      output.write(trafficDump === true
        ? "调用详情记录已开启：写入本地 traffic 目录，不含 Authorization/Cookie；重启 App Server 后生效。\n"
        : "调用详情记录已关闭。\n");
    }
    if (relay === true) await relayListenMenu({ environment, output, prompts });
  } catch (error) {
    if (applied.length > 0) output.write(`已写入：${applied.join("、")}；后续步骤失败。\n`);
    throw error;
  }

  return { cancelled: false };
}

function webuiStateLabel(stored) {
  if (stored === true) return "已启用";
  if (stored === false) return "已关闭";
  return "未设置";
}

function readDocument(environment) {
  const { configPath } = requireUserConfig(environment);
  return readGatewayConfig(configPath);
}

function detectionSummary({ environment, configPath, document }) {
  const codex = table(document.codex);
  const workspaces = Array.isArray(document.workspaces) ? document.workspaces : [];
  const defaultWorkspace = workspaces.find(workspace => table(workspace).id === document.default_workspace);
  const channels = gatewayChannelStates(document)
    .map(channel => (channel.enabled ? channel.displayName : `${channel.displayName}（未启用）`));
  const relay = table(document.model_relay);
  const webuiEnabled = webuiServiceEnabled(document);
  return [
    "检测结果",
    `- 配置文件：${configPath}`,
    `- Codex CLI：${codexCliStatus(environment, codex)}`,
    `- 官方登录：${hasCodexAuthFile(environment) ? "已登录" : `未登录（${join(codexHomePath(environment), "auth.json")} 不存在）`}`,
    `- 通讯渠道：${channels.join("、") || "未配置"}`,
    `- 默认模型：${stringValue(codex.default_model) || "跟随 Provider 默认模型"}`,
    `- 默认 Workspace：${stringValue(table(defaultWorkspace).id) || stringValue(document.default_workspace)} → ${stringValue(table(defaultWorkspace).cwd)}`,
    `- 可选功能：WebUI ${webuiEnabled === undefined ? "未设置" : webuiEnabled ? "已启用" : "已关闭"}`
      + ` · 调用详情记录 ${table(document.debug).model_traffic_dump === true ? "开启" : "关闭"}`
      + ` · 模型转发监听 ${relay.enabled === true ? `开启（${stringValue(relay.host) || "127.0.0.1"}:${numberValue(relay.port) || 4119}）` : "关闭"}`,
  ];
}

function codexCliStatus(environment, codex) {
  const command = effectiveCodexBinary(stringValue(codex.binary) || "codex", environment);
  let expected;
  try {
    expected = JSON.parse(readFileSync(join(packageDir, "src", "codex-protocol", "version.json"), "utf8")).codexCli;
  } catch {
    expected = undefined;
  }
  try {
    const binary = resolveExecutable(command, environment);
    const invocation = executableInvocation(binary, ["--version"], environment);
    const result = spawnSync(invocation.file, invocation.args, {
      encoding: "utf8",
      env: environment,
      timeout: 5_000,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    if (result.error) return `${command}（无法读取版本）`;
    const actual = (result.stdout || "").trim() || (result.stderr || "").trim();
    if (result.status !== 0 || actual === "") return `${command}（无法读取版本）`;
    return expected === undefined || actual === expected
      ? `${actual}`
      : `${actual}（要求 ${expected}）`;
  } catch {
    return `未找到（请安装 Codex CLI 或运行 codexc update）`;
  }
}

function table(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value) {
  return Number.isInteger(value) ? value : undefined;
}
