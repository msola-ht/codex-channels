import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as clackPrompts from "@clack/prompts";

import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import {
  runDisplaySettings,
} from "./config-display-menu.mjs";
import { runSystemSettings } from "./config-system-menu.mjs";
import { runWebuiSettings } from "./config-webui-menu.mjs";
import { reportMenuError } from "./cli-menu.mjs";
import { runMetricsSettings } from "./metrics-config-menu.mjs";
import { writeGatewayConfigSummary } from "./config-summary.mjs";
import { runCodexUserSettingsSetup } from "./codex-user-settings-setup.mjs";
import {
  runAdvancedSettings,
  runScheduledTasks,
  runNetworkSettings,
} from "./config-advanced-menu.mjs";

export async function runConfig({
  environment = process.env,
  input = process.stdin,
  json = false,
  output = process.stdout,
  prompts = clackPrompts,
  writeConfig = writeGatewayConfig,
  codexUserSettingsSetup = runCodexUserSettingsSetup,
  stayOnMenu = false,
} = {}) {
  const { configPath, dataDir } = resolveConfigPaths(environment);
  if (json) {
    const result = { dataDir, configPath, exists: pathExists(configPath) };
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return { action: "paths", ...result };
  }
  if (!prompts) throw new Error("Config 菜单缺少交互实现");
  if (!input.isTTY || !output.isTTY) {
    output.write(`用户目录：${dataDir}\n配置文件：${configPath}\n`);
    return { action: "paths", configPath, dataDir };
  }
  prompts.intro("Codex Connect Config");
  while (true) {
    let document;
    let gatewayConfigError;
    try {
      document = readGatewayConfig(configPath);
    } catch (error) {
      gatewayConfigError = error;
    }
    const telegram = table(document?.telegram);
    const telegramConfigured = typeof telegram.bot_token === "string"
      && telegram.bot_token.trim().length > 0;
    const section = await prompts.select({
      message: "选择配置项",
      showInstructions: false,
      options: [
        { value: "summary", label: "Gateway 配置总览", hint: "脱敏显示当前 Gateway 设置、来源与作用范围" },
        {
          value: "codex_user",
          label: "Codex 新会话与用户偏好",
          hint: "默认模型、思考等级、Fast、权限、推理摘要与其他用户偏好",
        },
        { value: "display", label: "显示设置", hint: "操作详情、计划更新、思考状态" },
        {
          value: "system",
          label: "系统设置",
          hint: "调用详情记录、审批超时、Sandbox、默认工作区与渠道模型覆盖",
        },
        { value: "scheduled_tasks", label: "计划任务", hint: "启用或关闭无人值守任务" },
        { value: "network", label: "网络代理", hint: "显式 HTTP、HTTPS、通用代理与直连规则" },
        { value: "advanced", label: "高级设置", hint: "日志等级与开发中功能" },
        { value: "webui", label: "WebUI 设置", hint: "监听地址、端口与访问令牌" },
        { value: "metrics", label: "指标存储", hint: "本地保留天数与最大记录数" },
        { value: "paths", label: "查看配置路径", hint: "显示用户目录与配置文件位置" },
        { value: "cancel", label: "取消", hint: "退出 Config" },
      ],
    });
    if (prompts.isCancel(section) || section === "cancel") {
      prompts.cancel("Config 已取消");
      return undefined;
    }
    const handlers = {
      codex_user: () => codexUserSettingsSetup({ environment, output, prompts }),
      display: runDisplaySettings,
      system: runSystemSettings,
      scheduled_tasks: runScheduledTasks,
      network: runNetworkSettings,
      advanced: runAdvancedSettings,
      webui: runWebuiSettings,
      metrics: runMetricsSettings,
    };
    if (!["summary", "paths"].includes(section) && !Object.hasOwn(handlers, section)) {
      throw new Error(`未知 Config 类别：${String(section)}`);
    }
    try {
      if (section !== "codex_user" && section !== "paths" && gatewayConfigError !== undefined) {
        throw gatewayConfigError;
      }
      if (section === "paths") {
        output.write(`用户目录：${dataDir}\n配置文件：${configPath}\n`);
        continue;
      }
      if (section === "summary") {
        writeGatewayConfigSummary(output, document, configPath, environment);
        continue;
      }
      const result = await handlers[section]({
        environment, input, output, prompts, writeConfig, telegramConfigured,
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
  if (explicit) return { configPath: explicit, dataDir: dirname(explicit) };
  const home = environment.CODEX_CONNECT_HOME?.trim()
    || join(homedir(), ".codex-connect");
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
  const json = args.length === 1 && args[0] === "--json";
  if (!(args.length === 0 || json)) {
    writeCliMessage("failure", "用法：codexc config [--json]");
    process.exitCode = 1;
  } else {
    runConfig({
      json,
      stayOnMenu: true,
    }).catch((error) => {
      writeCliMessage("failure", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
