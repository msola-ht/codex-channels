import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

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
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const current = table(document.telegram).message_format;
  const selected = await prompts.select({
    message: "Telegram 消息格式",
    showInstructions: false,
    initialValue: current === "rich" ? "rich" : "html",
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
  const telegram = table(document.telegram);
  telegram.message_format = selected;
  document.telegram = telegram;
  writeConfig(configPath, document);
  output.write(`Telegram 消息格式已设为 ${selected}：${configPath}\n`);
  output.write("配置将在重启 Gateway 后生效；不需要重启 App Server。\n");
  return { messageFormat: selected, configPath };
}

async function runOperationUpdatesToggle({ environment, output, prompts, writeConfig }) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const current = table(document.display).operation_updates;
  const selected = await prompts.select({
    message: "操作详情显示",
    showInstructions: false,
    initialValue: current === "full" || current === "hidden" ? current : "compact",
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
  const display = table(document.display);
  display.operation_updates = selected;
  document.display = display;
  writeConfig(configPath, document);
  output.write(`操作详情显示已设为${selected}：${configPath}\n`);
  output.write("配置将在重启 Gateway 后生效；不需要重启 App Server。\n");
  return { operationUpdates: selected, configPath };
}

async function runPlanUpdatesToggle({ environment, output, prompts, writeConfig }) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const enabled = table(document.display).plan_updates !== false;
  const selected = await prompts.select({
    message: "计划更新显示",
    showInstructions: false,
    initialValue: enabled ? "enabled" : "disabled",
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
  const display = table(document.display);
  display.plan_updates = selected === "enabled";
  document.display = display;
  writeConfig(configPath, document);
  output.write(`计划更新显示已${selected === "enabled" ? "开启" : "关闭"}：${configPath}\n`);
  output.write("配置将在重启 Gateway 后生效；不需要重启 App Server。\n");
  return { planUpdatesEnabled: selected === "enabled", configPath };
}

async function runPriceCurrency({ environment, output, prompts, writeConfig }) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const display = table(document.display);
  const mode = await prompts.select({
    message: "全局价格显示方式",
    showInstructions: false,
    initialValue: display.price_currency === "usd" ? "usd" : "cny",
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
  display.price_currency = mode;
  delete display.price_currency_by_provider;
  document.display = display;
  writeConfig(configPath, document);
  output.write(`全局价格显示方式已设为 ${mode}：${configPath}\n`);
  output.write("配置将在重启 Gateway 后生效；不需要重启 App Server。\n");
  return { priceCurrency: mode, configPath };
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
