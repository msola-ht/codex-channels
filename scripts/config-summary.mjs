import { readCodexProxySettings } from "../runtime/codex-proxy-env.mjs";
import { isTelegramEnabled, validateDebugConfigDocument, validateGatewayConfigStructureDocument } from "../runtime/gateway-config.mjs";
import { projectWebuiSettings } from "./config-webui-management.mjs";
import { projectMetricsSettings } from "./config-metrics-management.mjs";

export function writeGatewayConfigSummary(output, document, configPath, environment = process.env) {
  const summary = gatewayConfigSummary(document, configPath, environment);
  output.write([
    "Gateway 配置总览",
    `- 配置来源：${summary.configPath}`,
    `- 默认 Workspace：${summary.defaultWorkspace}`,
    `- 渠道新会话模型：${summary.defaultModel}`,
    `- 通讯渠道：${summary.channels.join("、") || "未配置"}`,
    `- 操作详情：${summary.operationUpdates}`,
    `- 计划显示：${enabledLabel(summary.planUpdates)}`,
    `- 思考状态：${enabledLabel(summary.reasoning)}`,
    `- 计划任务：${enabledLabel(summary.scheduledTasks)}`,
    `- 会话空闲自动解除：${summary.idleReleaseMinutes === 0 ? "关闭" : `${summary.idleReleaseMinutes} 分钟`}`,
    `- 调用详情记录：${enabledLabel(summary.modelTrafficDump)}`,
    `- 调用记录预设：${({ production: "生产", debug: "调试", custom: "自定义" })[summary.modelTrafficMode]}（输入项 ${summary.modelTrafficInputItems} / 单项字节 ${summary.modelTrafficItemMaxBytes}）`,
    `- 调用记录按时间自动清理：${summary.modelTrafficRetentionDays === 0 ? "关闭" : `保留 ${summary.modelTrafficRetentionDays} 天`}`,
    `- 日志等级：${summary.logLevel}`,
    `- Codex .env 代理：${summary.networkFields.join("、") || "未配置（使用环境变量或系统发现）"}`,
    `- WebUI：${summary.webui}`,
    `- 本地指标保留：${summary.metricsRetentionDays} 天 / ${summary.metricsMaxRows} 行`,
    "- 作用范围：代理统一保存在 Codex .env；其他项目为 Gateway 配置。Codex 用户偏好由当前 Config 菜单管理，Codex 官方与第三方 Provider 配置由 codexc setup 管理。",
    "",
  ].join("\n"));
  return summary;
}

export function gatewayConfigSummary(document, configPath, environment = process.env) {
  const effective = validateGatewayConfigStructureDocument(document);
  const codex = table(document.codex);
  const display = effective.display;
  const conversation = effective.conversation;
  const debug = effective.debug ?? validateDebugConfigDocument({});
  const scheduledTasks = effective.scheduled_tasks;
  const logging = effective.logging;
  const network = readCodexProxySettings(environment);
  const metrics = projectMetricsSettings(effective);
  const webui = table(document.webui);
  const webuiSettings = projectWebuiSettings(document);
  const workspaces = Array.isArray(document.workspaces) ? document.workspaces : [];
  const defaultWorkspaceId = stringValue(document.default_workspace);
  const defaultWorkspace = workspaces
    .map((entry) => table(entry))
    .find((entry) => entry.id === defaultWorkspaceId);

  return {
    configPath,
    defaultWorkspace: defaultWorkspace
      ? `${stringValue(defaultWorkspace.name) || defaultWorkspaceId}（${defaultWorkspaceId}）`
      : defaultWorkspaceId || "未配置",
    defaultModel: stringValue(codex.default_model) || "跟随当前 Provider 默认值",
    channels: channelLabels(document),
    operationUpdates: display.operation_updates,
    planUpdates: display.plan_updates,
    reasoning: display.reasoning,
    idleReleaseMinutes: conversation.idle_release_minutes,
    scheduledTasks: scheduledTasks.enabled,
    modelTrafficDump: debug.model_traffic_dump,
    ...projectModelTrafficSettings(debug),
    modelTrafficRetentionDays: debug.model_traffic_retention_days,
    logLevel: logging.level,
    networkFields: ["http_proxy", "https_proxy", "all_proxy", "no_proxy"]
      .filter((field) => stringValue(network[field])),
    webui: webui.enabled === false
      ? "已关闭（需要时用 codexc start webui 单独启动）"
      : Object.keys(webui).length === 0
        ? "使用命令行默认值"
        : formatHostPort(
            webuiSettings.host,
            webuiSettings.port,
          ),
    metricsRetentionDays: metrics.storage.retentionDays,
    metricsMaxRows: metrics.storage.maxRows,
  };
}

/** Project effective capture values without changing custom clipping settings. */
export function projectModelTrafficSettings(debug) {
  const modelTrafficInputItems = debug.model_traffic_input_items;
  const modelTrafficItemMaxBytes = debug.model_traffic_item_max_bytes;
  return {
    modelTrafficMode: modelTrafficInputItems === 0 && modelTrafficItemMaxBytes === 0
      ? "debug"
      : modelTrafficInputItems === 3 && modelTrafficItemMaxBytes === 65536 ? "production" : "custom",
    modelTrafficInputItems,
    modelTrafficItemMaxBytes,
  };
}

export function gatewayChannelStates(document) {
  const channels = [];
  const telegram = table(document.telegram);
  if (stringValue(telegram.bot_token)) {
    channels.push({ id: "telegram", displayName: "Telegram", configured: true, enabled: isTelegramEnabled(telegram) });
  }
  const feishu = table(document.feishu);
  if (feishu.enabled === true || configuredFeishu(feishu)) {
    channels.push({
      id: "feishu",
      displayName: "飞书",
      configured: true,
      enabled: feishu.enabled === true,
    });
  }
  if (isTable(document.weixin)) {
    channels.push({
      id: "weixin",
      displayName: "微信",
      configured: true,
      enabled: table(document.weixin).enabled === true,
    });
  }
  if (isTable(document.qq)) {
    channels.push({
      id: "qq",
      displayName: "QQ",
      configured: true,
      enabled: table(document.qq).enabled === true,
    });
  }
  return channels;
}

function channelLabels(document) {
  return gatewayChannelStates(document)
    .map((channel) => channelStatusLabel(channel.displayName, channel.enabled));
}

function channelStatusLabel(label, enabled) {
  return `${label}（${enabled ? "已启用" : "已配置，未启用"}）`;
}

function configuredFeishu(feishu) {
  return Boolean(
    stringValue(feishu.app_id)
    && stringValue(feishu.app_secret)
    && Array.isArray(feishu.allowed_open_ids)
    && feishu.allowed_open_ids.length > 0,
  );
}

function enabledLabel(value) {
  return value ? "开启" : "关闭";
}

function formatHostPort(host, port) {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function table(value) {
  return isTable(value) ? value : {};
}

function isTable(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
