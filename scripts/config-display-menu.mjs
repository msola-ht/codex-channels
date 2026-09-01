import { writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import {
  loadGatewaySettings,
  updateGatewaySetting,
} from "./config-management.mjs";

export async function runDisplaySettings({
  environment,
  output,
  prompts,
  writeConfig = writeGatewayConfig,
}) {
  const section = await prompts.select({
    message: "选择显示设置",
    showInstructions: false,
    options: [
      { value: "operation_updates", label: "操作详情显示", hint: "full / compact / hidden" },
      { value: "plan_updates", label: "计划更新显示", hint: "是否显示 Codex 计划" },
      { value: "reasoning", label: "思考状态显示", hint: "是否显示“思考中”状态卡" },
      { value: "price_currency", label: "价格显示方式", hint: "全局统一人民币或美元" },
      { value: "back", label: "返回", hint: "返回配置菜单" },
    ],
  });
  if (prompts.isCancel(section) || section === "back") return { action: "back" };
  if (section === "operation_updates") {
    return runOperationUpdatesToggle({ environment, output, prompts, writeConfig });
  }
  if (section === "plan_updates") {
    return runPlanUpdatesToggle({ environment, output, prompts, writeConfig });
  }
  if (section === "reasoning") {
    return runReasoningToggle({ environment, output, prompts, writeConfig });
  }
  if (section === "price_currency") {
    return runPriceCurrency({ environment, output, prompts, writeConfig });
  }
  throw new Error(`未知显示设置：${String(section)}`);
}

export async function runTelegramMessageFormat({
  environment,
  output,
  prompts,
  writeConfig = writeGatewayConfig,
}) {
  const settings = loadGatewaySettings(environment);
  const selected = await prompts.select({
    message: "Telegram 消息格式",
    showInstructions: false,
    initialValue: settings.telegram.messageFormat,
    options: [
      { value: "html", label: "HTML", hint: "使用 HTML 格式" },
      { value: "rich", label: "富文本", hint: "使用富文本消息" },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
  if (selected !== "html" && selected !== "rich") {
    throw new Error(`未知 Telegram 消息格式：${String(selected)}`);
  }
  const result = updateGatewaySetting({
    kind: "telegram.message-format",
    value: selected,
  }, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(`Telegram 消息格式已设为 ${selected}：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { messageFormat: selected, configPath: result.configPath, activation: result.activation };
}

async function runOperationUpdatesToggle({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const selected = await prompts.select({
    message: "操作详情显示",
    showInstructions: false,
    initialValue: settings.display.operationUpdates,
    options: [
      { value: "full", label: "完整详情", hint: "显示完整操作过程" },
      { value: "compact", label: "单行摘要", hint: "压缩为摘要行" },
      { value: "hidden", label: "隐藏", hint: "不显示操作过程" },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
  if (selected !== "full" && selected !== "compact" && selected !== "hidden") {
    throw new Error(`未知操作详情显示设置：${String(selected)}`);
  }
  const result = updateGatewaySetting({
    kind: "display.operation-updates",
    value: selected,
  }, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(`操作详情显示已设为${selected}：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { operationUpdates: selected, configPath: result.configPath, activation: result.activation };
}

async function runPlanUpdatesToggle({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const selected = await prompts.select({
    message: "计划更新显示",
    showInstructions: false,
    initialValue: settings.display.planUpdatesEnabled ? "enabled" : "disabled",
    options: [
      { value: "enabled", label: "开启", hint: "显示 Codex 计划" },
      { value: "disabled", label: "关闭", hint: "隐藏 Codex 计划" },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
  if (selected !== "enabled" && selected !== "disabled") {
    throw new Error(`未知计划更新显示设置：${String(selected)}`);
  }
  const enabled = selected === "enabled";
  const result = updateGatewaySetting({
    kind: "display.plan-updates",
    value: enabled,
  }, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(`计划更新显示已${enabled ? "开启" : "关闭"}：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { planUpdatesEnabled: enabled, configPath: result.configPath, activation: result.activation };
}

async function runReasoningToggle({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const selected = await prompts.select({
    message: "思考状态显示",
    showInstructions: false,
    initialValue: settings.display.reasoningEnabled ? "enabled" : "disabled",
    options: [
      { value: "enabled", label: "开启", hint: "显示“思考中”状态卡" },
      { value: "disabled", label: "关闭", hint: "隐藏“思考中”状态卡" },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
  if (selected !== "enabled" && selected !== "disabled") {
    throw new Error(`未知思考状态显示设置：${String(selected)}`);
  }
  const enabled = selected === "enabled";
  const result = updateGatewaySetting({
    kind: "display.reasoning",
    value: enabled,
  }, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(`思考状态显示已${enabled ? "开启" : "关闭"}：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { reasoningEnabled: enabled, configPath: result.configPath, activation: result.activation };
}

async function runPriceCurrency({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const mode = await prompts.select({
    message: "全局价格显示方式",
    showInstructions: false,
    initialValue: settings.display.priceCurrency,
    options: [
      { value: "cny", label: "人民币", hint: "全局统一人民币（需要汇率缓存）" },
      { value: "usd", label: "美元", hint: "全局统一美元" },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(mode) || mode === "back") return { action: "back" };
  if (mode !== "cny" && mode !== "usd") {
    throw new Error(`未知价格显示方式：${String(mode)}`);
  }
  const result = updateGatewaySetting({
    kind: "display.price-currency",
    value: mode,
  }, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(`全局价格显示方式已设为 ${mode}：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { priceCurrency: mode, configPath: result.configPath, activation: result.activation };
}
