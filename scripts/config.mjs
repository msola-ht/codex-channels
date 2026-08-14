import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as clackPrompts from "@clack/prompts";

import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import {
  runDisplaySettings,
  runTelegramMessageFormat,
} from "./config-display-menu.mjs";
import { runSystemSettings } from "./config-system-menu.mjs";
import { runWebuiSettings } from "./config-webui-menu.mjs";
import { runDebugSetup } from "./debug-setup.mjs";
import { runMetricsSettings } from "./metrics-config-menu.mjs";

export { runCenterSettings } from "./metrics-config-menu.mjs";

export async function runConfig({
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  prompts = clackPrompts,
  writeConfig = writeGatewayConfig,
  debugSetup = runDebugSetup,
} = {}) {
  if (!prompts) throw new Error("Config 菜单缺少交互实现");
  const { configPath, dataDir } = resolveConfigPaths(environment);
  if (!output.isTTY) {
    output.write(`用户目录：${dataDir}\n配置文件：${configPath}\n`);
    return { action: "paths", configPath, dataDir };
  }
  prompts.intro("Codex Connect Config");
  while (true) {
    const document = readGatewayConfig(configPath);
    const telegram = table(document.telegram);
    const telegramConfigured = typeof telegram.bot_token === "string"
      && telegram.bot_token.trim().length > 0;
    const section = await prompts.select({
      message: "选择配置项",
      showInstructions: false,
      options: [
        { value: "display", label: "显示设置", hint: "操作详情、计划更新、参考价人民币换算" },
        {
          value: "system",
          label: "系统设置",
          hint: "调试模式、审批超时、Sandbox、默认工作区与渠道模型覆盖",
        },
        { value: "webui", label: "WebUI 设置", hint: "监听地址、端口与访问令牌" },
        { value: "metrics", label: "指标设置", hint: "本地保留、中心接入与全局视图" },
        ...(telegramConfigured
          ? [{ value: "message_format", label: "Telegram 消息格式", hint: "html 或 rich" }]
          : []),
        { value: "paths", label: "查看配置路径", hint: "显示用户目录与配置文件位置" },
        { value: "cancel", label: "取消", hint: "退出 Config" },
      ],
    });
    if (prompts.isCancel(section) || section === "cancel") {
      prompts.cancel("Config 已取消");
      return undefined;
    }
    const common = { environment, output, prompts, writeConfig };
    switch (section) {
      case "display": {
        const result = await runDisplaySettings(common);
        if (isBackResult(result)) continue;
        return result;
      }
      case "system": {
        const result = await runSystemSettings({ ...common, input, debugSetup });
        if (isBackResult(result)) continue;
        return result;
      }
      case "webui": {
        const result = await runWebuiSettings(common);
        if (isBackResult(result)) continue;
        return result;
      }
      case "metrics": {
        const result = await runMetricsSettings(common);
        if (isBackResult(result)) continue;
        return result;
      }
      case "message_format": {
        const result = await runTelegramMessageFormat(common);
        if (isBackResult(result)) continue;
        return result;
      }
      case "paths":
        output.write(`用户目录：${dataDir}\n配置文件：${configPath}\n`);
        continue;
      default:
        throw new Error(`未知 Config 类别：${String(section)}`);
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
  runConfig().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
