import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

export async function runDebugSetup({
  environment = process.env,
  output = process.stdout,
  prompts,
  writeConfig = writeGatewayConfig,
} = {}) {
  if (!prompts) throw new Error("调试模式 Setup 缺少交互实现");
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const currentLevel = loggingLevel(document);
  const selected = await prompts.select({
    message: "选择全局调试模式",
    showInstructions: false,
    initialValue: currentLevel === "debug" || currentLevel === "trace"
      ? "enabled"
      : "disabled",
    options: [
      {
        value: "enabled",
        label: "开启",
        hint: "启用脱敏 debug 日志和渠道技术字段",
      },
      {
        value: "disabled",
        label: "关闭",
        hint: "恢复标准 info 日志并隐藏渠道技术字段",
      },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") {
    return { action: "back" };
  }
  if (selected !== "enabled" && selected !== "disabled") {
    throw new Error(`未知调试模式：${String(selected)}`);
  }
  document.logging = {
    ...table(document.logging),
    level: selected === "enabled" ? "debug" : "info",
  };
  writeConfig(configPath, document);
  const enabled = selected === "enabled";
  output.write(`全局调试模式已${enabled ? "开启" : "关闭"}：${configPath}\n`);
  writeGatewayConfigActivationNotice(output);
  return { enabled, configPath };
}

function loggingLevel(document) {
  const level = table(document.logging).level;
  return typeof level === "string" ? level : "info";
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
