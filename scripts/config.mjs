import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as clackPrompts from "@clack/prompts";

import {
  readGatewayConfig,
  validateGatewayConfigStructureDocument,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { reportMenuError } from "./cli-menu.mjs";

export async function runConfig({
  environment = process.env,
  input = process.stdin,
  json = false,
  paths = false,
  output = process.stdout,
  prompts = clackPrompts,
  writeConfig = writeGatewayConfig,
  codexUserSettingsSetup = async (options) => (await import("./codex-user-settings-setup.mjs")).runCodexUserSettingsSetup(options),
  stayOnMenu = false,
} = {}) {
  const { configPath, dataDir } = resolveConfigPaths(environment);
  if (json) {
    const result = { dataDir, configPath, exists: pathExists(configPath) };
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return { action: "paths", ...result };
  }
  if (paths) {
    output.write(`用户目录：${dataDir}\n配置文件：${configPath}\n`);
    return { action: "paths", configPath, dataDir };
  }
  if (!prompts) throw new Error("Config 菜单缺少交互实现");
  if (!input.isTTY || !output.isTTY) {
    output.write("用法：codexc config [paths [--json]]\n交互设置需要终端；查询配置路径使用 codexc config paths。\n");
    return undefined;
  }
  prompts.intro("日常设置");
  let selected = "summary";
  while (true) {
    let document;
    let gatewayConfigError;
    try {
      document = readGatewayConfig(configPath);
      validateGatewayConfigStructureDocument(document);
    } catch (error) {
      gatewayConfigError = error;
    }
    const telegram = table(document?.telegram);
    const telegramConfigured = typeof telegram.bot_token === "string"
      && telegram.bot_token.trim().length > 0;
    const section = await prompts.select({
      message: "设置项目",
      showInstructions: false,
      initialValue: selected,
      options: [
        { value: "summary", label: "Gateway 配置总览", hint: "脱敏查看设置、来源与作用范围" },
        {
          value: "codex_user",
          label: "Codex 新会话与用户偏好",
          hint: "模型、思考等级、Fast、权限与用户偏好",
        },
        { value: "mcp", label: "工具与 MCP", hint: "新增 MCP、电脑、浏览器与已有 MCP 访问管理" },
        { value: "display", label: "Gateway 显示设置", hint: "渠道操作详情、计划更新、思考状态" },
        {
          value: "system",
          label: "Gateway 会话设置",
          hint: "审批超时、空闲解除、Sandbox、默认工作区与渠道模型",
        },
        { value: "identity", label: "身份与时区", hint: "官方 TUI 身份、终端标识、模型与网关时区" },
        { value: "traffic", label: "调用记录", hint: "Codex 与 Relay 共用的采集、记录模式与保留天数" },
        { value: "scheduled_tasks", label: "Gateway 计划任务", hint: "启用或关闭无人值守任务" },
        { value: "network", label: "网络代理", hint: "Codex 与 Gateway 共用 HTTP、HTTPS、通用代理与直连规则" },
        { value: "services", label: "服务访问", hint: "Relay 监听与 WebUI 启用、监听、访问令牌" },
        { value: "advanced", label: "日志与高级功能", hint: "Gateway 日志等级与开发中 Plugin API" },
        { value: "metrics", label: "指标存储", hint: "本地保留天数与最大记录数" },
        { value: "paths", label: "查看配置路径", hint: "用户目录与配置文件位置" },
        { value: "cancel", label: "返回", hint: "结束日常设置" },
      ],
    });
    if (prompts.isCancel(section)) {
      prompts.cancel("已取消设置");
      return undefined;
    }
    if (section === "cancel") {
      prompts.outro("已退出设置菜单");
      return undefined;
    }
    selected = section;
    const handlers = {
      codex_user: () => codexUserSettingsSetup({ environment, output, prompts }),
      mcp: runMcpSettings,
      display: async (options) => (await import("./config-display-menu.mjs")).runDisplaySettings(options),
      system: async (options) => (await import("./config-system-menu.mjs")).runSystemSettings(options),
      identity: async (options) => (await import("./config-system-menu.mjs")).runSystemSettings({ ...options, group: "identity" }),
      traffic: async (options) => (await import("./config-system-menu.mjs")).runSystemSettings({ ...options, group: "traffic" }),
      scheduled_tasks: async (options) => (await import("./config-advanced-menu.mjs")).runScheduledTasks(options),
      network: async (options) => (await import("./config-advanced-menu.mjs")).runNetworkSettings(options),
      advanced: async (options) => (await import("./config-advanced-menu.mjs")).runAdvancedSettings(options),
      services: runServiceAccessSettings,
      metrics: async (options) => (await import("./metrics-config-menu.mjs")).runMetricsSettings(options),
    };
    if (!["summary", "paths"].includes(section) && !Object.hasOwn(handlers, section)) {
      throw new Error(`未知 Config 类别：${String(section)}`);
    }
    try {
      if (!["codex_user", "mcp", "paths"].includes(section) && gatewayConfigError !== undefined) {
        throw gatewayConfigError;
      }
      if (section === "paths") {
        output.write(`用户目录：${dataDir}\n配置文件：${configPath}\n`);
        continue;
      }
      if (section === "summary") {
        const { writeGatewayConfigSummary } = await import("./config-summary.mjs");
        writeGatewayConfigSummary(output, document, configPath, environment);
        continue;
      }
      const result = await handlers[section]({
        environment, configPath, dataDir, input, output, prompts, writeConfig, telegramConfigured,
      });
      if (isBackResult(result) || stayOnMenu) continue;
      return result;
    } catch (error) {
      if (!stayOnMenu) throw error;
      reportMenuError(error);
    }
  }
}

async function runMcpSettings(options) {
  const { prompts } = options;
  const action = await prompts.select({
    message: "工具与 MCP",
    showInstructions: false,
    options: [
      { value: "add", label: "新增 MCP", hint: "本地 stdio、远程 HTTP 或 Strata 视频预设" },
      { value: "manage", label: "电脑、浏览器与已有 MCP", hint: "查看并设置启用状态、工具开关与调用审批" },
      { value: "back", label: "返回配置菜单" },
    ],
  });
  if (prompts.isCancel(action) || action === "back") return { action: "back" };
  if (action === "add") return (await import("./mcp-setup.mjs")).runMcpSetup(options);
  if (action === "manage") return (await import("./codex-user-settings-setup.mjs")).runCodexToolAccess(options);
  throw new Error(`未知 MCP 设置：${String(action)}`);
}

async function runServiceAccessSettings(options) {
  const { prompts } = options;
  const action = await prompts.select({
    message: "服务访问",
    showInstructions: false,
    options: [
      { value: "relay", label: "模型转发监听", hint: "关闭、仅本机或局域网访问" },
      { value: "webui", label: "WebUI 设置", hint: "启用状态、监听地址、端口与访问令牌" },
      { value: "back", label: "返回配置菜单" },
    ],
  });
  if (prompts.isCancel(action) || action === "back") return { action: "back" };
  if (action === "relay") return (await import("./model-relay-listen-menu.mjs")).runRelayListenMenu(options);
  if (action === "webui") return (await import("./config-webui-menu.mjs")).runWebuiSettings(options);
  throw new Error(`未知服务访问设置：${String(action)}`);
}

function resolveConfigPaths(environment) {
  const explicit = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  if (explicit) {
    const configPath = resolve(explicit);
    return { configPath, dataDir: dirname(configPath) };
  }
  const home = resolve(environment.CODEX_CONNECT_HOME?.trim()
    || join(homedir(), ".codex-connect"));
  return { configPath: join(home, "config.toml"), dataDir: home };
}

function pathExists(path) {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isBackResult(value) {
  return value !== null && typeof value === "object" && value.action === "back";
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const paths = args[0] === "paths";
  const json = paths && args.length === 2 && args[1] === "--json";
  if (!(args.length === 0 || (paths && args.length === 1) || json)) {
    writeCliMessage("failure", "用法：codexc config [paths [--json]]");
    process.exitCode = 1;
  } else {
    runConfig({
      json,
      paths,
      stayOnMenu: true,
    }).catch((error) => {
      writeCliMessage("failure", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
