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
      options: [
        { value: "summary", label: "Gateway 配置总览", hint: "脱敏查看设置、来源与作用范围" },
        {
          value: "codex_user",
          label: "Codex 新会话与用户偏好",
          hint: "模型、思考等级、Fast、权限与用户偏好",
        },
        { value: "display", label: "显示设置", hint: "操作详情、计划更新、思考状态" },
        { value: "mcp", label: "新增 MCP", hint: "本地 stdio、远程 HTTP 或 Strata 视频预设" },
        {
          value: "system",
          label: "系统设置",
          hint: "调用记录、审批超时、默认工作区与渠道模型",
        },
        { value: "scheduled_tasks", label: "计划任务", hint: "启用或关闭无人值守任务" },
        { value: "network", label: "网络代理", hint: "HTTP、HTTPS、通用代理与直连规则" },
        { value: "advanced", label: "高级设置", hint: "日志等级与开发中功能" },
        { value: "relay", label: "模型转发监听", hint: "关闭、仅本机或局域网访问" },
        { value: "webui", label: "WebUI 设置", hint: "启用状态、监听地址、端口与访问令牌" },
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
    const handlers = {
      codex_user: () => codexUserSettingsSetup({ environment, output, prompts }),
      mcp: async (options) => (await import("./mcp-setup.mjs")).runMcpSetup(options),
      display: async (options) => (await import("./config-display-menu.mjs")).runDisplaySettings(options),
      system: async (options) => (await import("./config-system-menu.mjs")).runSystemSettings(options),
      scheduled_tasks: async (options) => (await import("./config-advanced-menu.mjs")).runScheduledTasks(options),
      network: async (options) => (await import("./config-advanced-menu.mjs")).runNetworkSettings(options),
      advanced: async (options) => (await import("./config-advanced-menu.mjs")).runAdvancedSettings(options),
      relay: async (options) => (await import("./model-relay-listen-menu.mjs")).runRelayListenMenu(options),
      webui: async (options) => (await import("./config-webui-menu.mjs")).runWebuiSettings(options),
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
