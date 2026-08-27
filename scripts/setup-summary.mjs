import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { gatewayChannelStates } from "./config-summary.mjs";
import { loadModelProviderManagementState } from "./model-provider-management.mjs";
import { listInstalledSkills } from "./skill-setup.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

export async function loadSetupConfigurationSummary({
  environment = process.env,
  loadGatewayDocument = defaultGatewayDocumentLoader,
  loadProviderState = defaultProviderStateLoader,
  loadInstalledSkills = listInstalledSkills,
} = {}) {
  const { configPath, document } = loadGatewayDocument(environment);
  const providerState = await loadProviderState(environment);
  const switchingProviders = providerState.switchingProviders.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    kind: provider.kind,
    mode: "switching",
  }));
  const modelDefaults = [
    ...providerState.managedProviders.map((provider) => ({
      providerId: provider.id,
      providerName: provider.displayName,
      model: provider.model,
      reasoningEffort: provider.reasoningEffort,
    })),
    ...providerState.customProviders.switchingProviders.map((provider) => ({
      providerId: provider.id,
      providerName: provider.displayName,
      model: provider.model,
      reasoningEffort: provider.reasoningEffort,
    })),
  ];
  const installedSkills = loadInstalledSkills({ environment });
  const apiProviderCount = Array.isArray(document.api_providers)
    ? document.api_providers.length
    : 0;
  return {
    primary: providerState.primary,
    codexDefaults: {
      model: providerState.defaults.model ?? undefined,
      effort: providerState.defaults.reasoningEffort ?? undefined,
    },
    switchingProviders,
    modelDefaults,
    channels: gatewayChannelStates(document),
    installedSkillCount: installedSkills.length,
    agent: providerState.externalAgent,
    apiProviderCount,
    configPath,
  };
}

export async function writeSetupConfigurationSummary({
  output = process.stdout,
  ...options
} = {}) {
  const summary = await loadSetupConfigurationSummary(options);
  output.write([
    "Setup 配置总览",
    `- 主 Provider：${primaryLabel(summary.primary)}`,
    `- Codex 全局默认值：${summary.codexDefaults.model ?? "跟随 Provider 默认模型"} · ${summary.codexDefaults.effort ?? "跟随模型默认思考等级"}`,
    `- 可切换 Provider：${summary.switchingProviders.map((provider) => provider.displayName).join("、") || "未配置"}`,
    `- 第三方模型默认值：${summary.modelDefaults.map(modelDefaultLabel).join("；") || "未配置"}`,
    `- 通讯渠道：${summary.channels.map(channelLabel).join("、") || "未配置"}`,
    `- 用户技能目录：${summary.installedSkillCount} 个技能`,
    `- 共享第三方子代理：${agentLabel(summary.agent)}`,
    `- 直接 API Provider（预留）：${summary.apiProviderCount} 个`,
    `- Gateway 配置：${summary.configPath}`,
    "- 作用范围：Provider、模型与登录由 Codex 配置管理；通讯渠道由 Gateway 配置管理。",
    "- 安全提示：API Key、Token、应用凭据、允许名单和代理值均不显示。",
    "",
  ].join("\n"));
  return summary;
}

function primaryLabel(provider) {
  if (provider.mode === "official") return provider.displayName;
  if (provider.mode === "backup") return `${provider.displayName}（自定义备份状态）`;
  if (provider.mode === "unknown") return `${provider.displayName}（状态未知）`;
  return `${provider.displayName}（${provider.kind === "custom" ? "自定义" : ""}固定模式）`;
}

function modelDefaultLabel(entry) {
  return `${entry.providerName} · ${entry.model} · ${entry.reasoningEffort ?? "默认思考等级"}`;
}

function channelLabel(channel) {
  return `${channel.displayName}（${channel.enabled ? "已启用" : "已配置，未启用"}）`;
}

function agentLabel(agent) {
  if (agent.status === "configured") return `${agent.provider} · ${agent.model}`;
  return agent.status === "unavailable" ? "已配置（Provider 或模型状态不可用）" : "未配置";
}

function defaultGatewayDocumentLoader(environment) {
  const { configPath } = requireUserConfig(environment);
  return { configPath, document: readGatewayConfig(configPath) };
}

function defaultProviderStateLoader(environment) {
  return loadModelProviderManagementState({ environment });
}
