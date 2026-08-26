export function writeGatewayConfigSummary(output, document, configPath) {
  const summary = gatewayConfigSummary(document, configPath);
  output.write([
    "Gateway 配置总览",
    `- 配置来源：${summary.configPath}`,
    `- 默认 Workspace：${summary.defaultWorkspace}`,
    `- 渠道新会话模型：${summary.defaultModel}`,
    `- 全局 Sandbox：${summary.sandbox}`,
    `- 通讯渠道：${summary.channels.join("、") || "未配置"}`,
    `- 操作详情：${summary.operationUpdates}`,
    `- 计划显示：${enabledLabel(summary.planUpdates)}`,
    `- 思考状态：${enabledLabel(summary.reasoning)}`,
    `- 价格币种：${summary.priceCurrency.toUpperCase()}`,
    `- 计划任务：${enabledLabel(summary.scheduledTasks)}`,
    `- Plugin API：${enabledLabel(summary.pluginApi)}（开发中）`,
    `- 日志等级：${summary.logLevel}`,
    `- 显式网络代理：${summary.networkFields.join("、") || "未配置（使用环境变量或系统发现）"}`,
    `- Thread 分区管理员：${summary.threadSectionAdministratorCount} 个`,
    `- WebUI：${summary.webui}`,
    `- 指标中心接入：${enabledLabel(summary.metricsSync)}`,
    "- 作用范围：以上均为 Gateway 配置；Codex 官方与第三方 Provider 配置由 codexc setup 管理。",
    "",
  ].join("\n"));
  return summary;
}

export function gatewayConfigSummary(document, configPath) {
  const codex = table(document.codex);
  const display = table(document.display);
  const experimental = table(document.experimental);
  const scheduledTasks = table(document.scheduled_tasks);
  const logging = table(document.logging);
  const network = table(document.network);
  const threadSections = table(document.thread_sections);
  const metrics = table(document.metrics);
  const metricsSync = table(metrics.sync);
  const webui = table(document.webui);
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
    sandbox: codex.sandbox === "read-only" ? "read-only" : "workspace-write",
    channels: channelLabels(document),
    operationUpdates: ["full", "compact", "hidden"].includes(display.operation_updates)
      ? display.operation_updates
      : "compact",
    planUpdates: display.plan_updates !== false,
    reasoning: display.reasoning !== false,
    priceCurrency: display.price_currency === "usd" ? "usd" : "cny",
    scheduledTasks: scheduledTasks.enabled === true,
    pluginApi: experimental.plugin_api === true,
    logLevel: stringValue(logging.level) || "info",
    networkFields: ["http_proxy", "https_proxy", "all_proxy", "no_proxy"]
      .filter((field) => stringValue(network[field])),
    threadSectionAdministratorCount: Array.isArray(threadSections.administrators)
      ? threadSections.administrators.length
      : 0,
    webui: Object.keys(webui).length === 0
      ? "使用命令行默认值"
      : formatHostPort(
          stringValue(webui.host) || "127.0.0.1",
          numberValue(webui.port) || 8787,
        ),
    metricsSync: metricsSync.enabled === true,
  };
}

export function gatewayChannelStates(document) {
  const channels = [];
  const telegram = table(document.telegram);
  if (stringValue(telegram.bot_token)) {
    channels.push({ id: "telegram", displayName: "Telegram", configured: true, enabled: true });
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

function numberValue(value) {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
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
