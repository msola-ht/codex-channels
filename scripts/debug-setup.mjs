import { writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import {
  loadGatewaySettings,
  updateGatewaySetting,
} from "./config-management.mjs";

export async function runDebugSetup({
  environment = process.env,
  output = process.stdout,
  prompts,
  writeConfig = writeGatewayConfig,
} = {}) {
  if (!prompts) throw new Error("调试模式 Setup 缺少交互实现");
  const settings = loadGatewaySettings(environment);
  const selected = await prompts.select({
    message: "选择全局调试模式",
    showInstructions: false,
    initialValue: settings.advanced.loggingLevel === "debug"
      || settings.advanced.loggingLevel === "trace"
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
  const level = selected === "enabled" ? "debug" : "info";
  const result = writeLoggingLevel({
    environment,
    expectedRevision: settings.revision,
    output,
    writeConfig,
    level,
    message: `全局调试模式已${selected === "enabled" ? "开启" : "关闭"}`,
  });
  return { enabled: selected === "enabled", configPath: result.configPath };
}

export function writeLoggingLevel({
  environment = process.env,
  expectedRevision,
  output = process.stdout,
  writeConfig = writeGatewayConfig,
  level,
  message = `日志等级已设为 ${level}`,
}) {
  if (!["fatal", "error", "warn", "info", "debug", "trace"].includes(level)) {
    throw new Error(`未知日志等级：${String(level)}`);
  }
  const result = updateGatewaySetting({
    kind: "advanced.logging-level",
    value: level,
  }, {
    environment,
    expectedRevision: expectedRevision ?? loadGatewaySettings(environment).revision,
    writeConfig,
  });
  output.write(`${message}：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, "restart");
  return { level, configPath: result.configPath };
}
