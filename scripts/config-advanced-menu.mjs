import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { resolveHttpProxyUrl } from "../runtime/network-proxy.mjs";
import {
  writeGatewayConfigActivationNotice,
} from "./config-activation-notice.mjs";
import { requireUserConfig } from "./runtime-config.mjs";
import { writeLoggingLevel } from "./debug-setup.mjs";

const proxyFields = [
  ["http_proxy", "HTTP 代理"],
  ["https_proxy", "HTTPS 代理"],
  ["all_proxy", "通用代理"],
  ["no_proxy", "直连规则（NO_PROXY）"],
];

export async function runAutomationSettings(options) {
  const { prompts } = options;
  const section = await prompts.select({
    message: "选择自动化设置",
    showInstructions: false,
    options: [
      { value: "scheduled_tasks", label: "计划任务", hint: "启用或关闭 Gateway 无人值守计划任务" },
      { value: "thread_sections", label: "Thread 分区管理员", hint: "从已启用渠道允许名单中选择" },
      { value: "back", label: "返回", hint: "返回配置菜单" },
    ],
  });
  if (prompts.isCancel(section) || section === "back") return { action: "back" };
  if (section === "scheduled_tasks") return runScheduledTasks(options);
  if (section === "thread_sections") return runThreadSectionAdministrators(options);
  throw new Error(`未知自动化设置：${String(section)}`);
}

export async function runNetworkSettings({
  environment,
  output,
  prompts,
  writeConfig = writeGatewayConfig,
}) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const network = { ...table(document.network) };
  const field = await prompts.select({
    message: "选择网络代理设置",
    showInstructions: false,
    options: [
      ...proxyFields.map(([value, label]) => ({
        value,
        label,
        hint: stringValue(network[value]) ? "已显式配置（内容不显示）" : "未配置",
      })),
      { value: "back", label: "返回", hint: "返回配置菜单" },
    ],
  });
  if (prompts.isCancel(field) || field === "back") return { action: "back" };
  if (!proxyFields.some(([value]) => value === field)) {
    throw new Error(`未知网络代理设置：${String(field)}`);
  }
  const configured = Boolean(stringValue(network[field]));
  const action = await prompts.select({
    message: proxyFields.find(([value]) => value === field)?.[1] ?? String(field),
    showInstructions: false,
    options: [
      { value: "set", label: configured ? "重新设置" : "设置", hint: "值不会在确认信息中回显" },
      ...(configured ? [{ value: "clear", label: "清除", hint: "恢复环境变量或系统自动发现" }] : []),
      { value: "back", label: "返回配置菜单" },
    ],
  });
  if (prompts.isCancel(action) || action === "back") return { action: "back" };
  if (action === "clear") {
    delete network[field];
  } else if (action === "set") {
    const value = field === "no_proxy"
      ? await prompts.text({
          message: "NO_PROXY（逗号分隔主机；留空取消）",
          validate: validateNoProxy,
        })
      : await prompts.password({
          message: "代理 URL（http:// 或 https://；留空取消）",
          validate: validateProxyUrl,
        });
    if (prompts.isCancel(value) || stringValue(value) === "") return { action: "back" };
    const normalized = stringValue(value);
    const validation = field === "no_proxy"
      ? validateNoProxy(normalized)
      : validateProxyUrl(normalized);
    if (validation) throw new Error(validation);
    network[field] = normalized;
  } else {
    throw new Error(`未知网络代理操作：${String(action)}`);
  }
  if (Object.keys(network).length > 0) document.network = network;
  else delete document.network;
  writeConfig(configPath, document);
  output.write(`${proxyFields.find(([value]) => value === field)?.[1]}已${action === "clear" ? "清除" : "更新"}：${configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, "reinstall");
  return { field, configured: action !== "clear", configPath };
}

export async function runAdvancedSettings(options) {
  const { prompts } = options;
  const section = await prompts.select({
    message: "选择高级设置",
    showInstructions: false,
    options: [
      { value: "logging", label: "日志等级", hint: "fatal / error / warn / info / debug / trace" },
      { value: "plugin_api", label: "Plugin API", hint: "开发中，仅支持 OpenAI Thread" },
      { value: "back", label: "返回", hint: "返回配置菜单" },
    ],
  });
  if (prompts.isCancel(section) || section === "back") return { action: "back" };
  if (section === "logging") return runLoggingLevel(options);
  if (section === "plugin_api") return runPluginApi(options);
  throw new Error(`未知高级设置：${String(section)}`);
}

async function runScheduledTasks({ environment, output, prompts, writeConfig = writeGatewayConfig }) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const enabled = table(document.scheduled_tasks).enabled === true;
  const selected = await prompts.select({
    message: "Gateway 计划任务",
    showInstructions: false,
    initialValue: enabled ? "enabled" : "disabled",
    options: [
      { value: "enabled", label: "开启", hint: "允许确认后的任务在后台无人值守执行" },
      { value: "disabled", label: "关闭", hint: "停止领取任务，不删除已有任务数据库" },
      { value: "back", label: "返回配置菜单" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
  if (selected !== "enabled" && selected !== "disabled") {
    throw new Error(`未知计划任务设置：${String(selected)}`);
  }
  document.scheduled_tasks = { ...table(document.scheduled_tasks), enabled: selected === "enabled" };
  writeConfig(configPath, document);
  output.write(`Gateway 计划任务已${selected === "enabled" ? "开启" : "关闭"}：${configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, "restart");
  return { scheduledTasksEnabled: selected === "enabled", configPath };
}

async function runThreadSectionAdministrators({ environment, output, prompts, writeConfig = writeGatewayConfig }) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const candidates = threadSectionAdministratorCandidates(document);
  if (candidates.length === 0) {
    output.write("已启用渠道的允许名单为空；请先通过 codexc setup 配置渠道用户。\n");
    return { action: "back" };
  }
  const current = Array.isArray(table(document.thread_sections).administrators)
    ? table(document.thread_sections).administrators.filter((value) => typeof value === "string")
    : [];
  const selected = await prompts.multiselect({
    message: "选择 Thread 分区管理员（可留空）",
    showInstructions: false,
    required: false,
    initialValues: current,
    options: candidates,
  });
  if (prompts.isCancel(selected)) return { action: "back" };
  if (!Array.isArray(selected) || selected.some((value) => !candidates.some((entry) => entry.value === value))) {
    throw new Error("Thread 分区管理员选择无效");
  }
  document.thread_sections = { administrators: selected };
  writeConfig(configPath, document);
  output.write(`Thread 分区管理员已更新（${selected.length} 个）：${configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, "restart");
  return { threadSectionAdministrators: selected, configPath };
}

async function runLoggingLevel({ environment, output, prompts, writeConfig = writeGatewayConfig }) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const current = stringValue(table(document.logging).level) || "info";
  const levels = ["fatal", "error", "warn", "info", "debug", "trace"];
  const selected = await prompts.select({
    message: "日志等级",
    showInstructions: false,
    initialValue: current,
    options: levels.map((value) => ({
      value,
      label: value,
      hint: value === "debug" || value === "trace" ? "启用脱敏调试模式" : undefined,
    })),
  });
  if (prompts.isCancel(selected)) return { action: "back" };
  if (!levels.includes(selected)) throw new Error(`未知日志等级：${String(selected)}`);
  const result = writeLoggingLevel({ environment, output, writeConfig, level: selected });
  return { logLevel: selected, configPath: result.configPath };
}

async function runPluginApi({ environment, output, prompts, writeConfig = writeGatewayConfig }) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const enabled = table(document.experimental).plugin_api === true;
  const selected = await prompts.select({
    message: "开发中 Plugin API",
    showInstructions: false,
    initialValue: enabled ? "enabled" : "disabled",
    options: [
      { value: "enabled", label: "开启", hint: "仅支持 OpenAI Thread；开放已安装 Plugin 查询与 mention 调用" },
      { value: "disabled", label: "关闭", hint: "保持默认失败关闭" },
      { value: "back", label: "返回配置菜单" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
  if (selected !== "enabled" && selected !== "disabled") {
    throw new Error(`未知 Plugin API 设置：${String(selected)}`);
  }
  document.experimental = { ...table(document.experimental), plugin_api: selected === "enabled" };
  writeConfig(configPath, document);
  output.write(`Plugin API 已${selected === "enabled" ? "开启" : "关闭"}：${configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, "restart");
  return { pluginApiEnabled: selected === "enabled", configPath };
}

function threadSectionAdministratorCandidates(document) {
  return [
    ...(stringValue(table(document.telegram).bot_token)
      ? numberArray(table(document.telegram).allowed_user_ids).map((actorId) => ({
          value: `telegram:${actorId}`,
          label: `Telegram · ${actorId}`,
        }))
      : []),
    ...(table(document.feishu).enabled === true
      ? stringArray(table(document.feishu).allowed_open_ids).map((actorId) => ({
          value: `feishu:${actorId}`,
          label: `飞书 · ${actorId}`,
        }))
      : []),
    ...(table(document.weixin).enabled === true
      ? stringArray(table(document.weixin).allowed_user_ids).map((actorId) => ({
          value: `weixin:${actorId}`,
          label: `微信 · ${actorId}`,
        }))
      : []),
  ];
}

function validateProxyUrl(value) {
  const normalized = stringValue(value);
  if (!normalized) return undefined;
  if (normalized.length > 2_048 || /[\0\r\n]/u.test(normalized)) return "代理 URL 无效或过长";
  try {
    resolveHttpProxyUrl(normalized, {});
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "代理 URL 无效";
  }
}

function validateNoProxy(value) {
  const normalized = stringValue(value);
  return normalized.length <= 4_096 && !/[\0\r\n]/u.test(normalized)
    ? undefined
    : "NO_PROXY 无效或过长";
}

function numberArray(value) {
  return Array.isArray(value) ? value.filter((entry) => Number.isInteger(entry) && entry > 0) : [];
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => stringValue(entry)) : [];
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
