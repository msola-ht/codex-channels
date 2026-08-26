import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  loadConfiguredCustomPrimaryModelProvider,
  loadConfiguredCustomSwitchingModelProviders,
  loadManagedModelProviderSettings,
} from "../runtime/model-provider-runtime.mjs";
import { gatewayConfigSummary } from "./config-summary.mjs";
import { createCodexUserConfigClient } from "./codex-user-config.mjs";
import { listInstalledSkills } from "./skill-setup.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

export async function writeSetupConfigurationSummary({
  environment = process.env,
  output = process.stdout,
  loadGatewayDocument = defaultGatewayDocumentLoader,
  loadManagedProviders = loadManagedModelProviderSettings,
  loadCustomPrimary = loadConfiguredCustomPrimaryModelProvider,
  loadCustomSwitching = loadConfiguredCustomSwitchingModelProviders,
  loadInstalledSkills = listInstalledSkills,
  loadCodexDefaults = defaultCodexDefaultsLoader,
} = {}) {
  const { configPath, document } = loadGatewayDocument(environment);
  const gateway = gatewayConfigSummary(document, configPath);
  const managed = loadManagedProviders(environment);
  const customPrimary = loadCustomPrimary(environment);
  const customSwitching = loadCustomSwitching(environment);
  const codexDefaults = await loadCodexDefaults(environment);
  const exclusive = managed.filter((provider) => provider.mode === "exclusive");
  if (exclusive.length > 1) {
    throw new Error("只能有一个第三方 Provider 使用固定模式");
  }
  const primary = exclusive[0] === undefined
    ? customPrimary === undefined
      ? "OpenAI 官方"
      : `${customPrimary.id}（自定义固定模式）`
    : `${exclusive[0].displayName}（固定模式）`;
  const switching = [
    ...managed
      .filter((provider) => provider.mode === "switching")
      .map((provider) => provider.displayName),
    ...customSwitching.map((provider) => displayLabel(provider.name, provider.id)),
  ];
  const modelDefaults = [
    ...managed.map((provider) =>
      `${provider.displayName} · ${provider.model} · ${provider.reasoningEffort ?? "默认思考等级"}`
    ),
    ...customSwitching.map((provider) =>
      `${displayLabel(provider.name, provider.id)} · ${provider.model} · ${provider.reasoningEffort ?? "默认思考等级"}`
    ),
  ];
  const installedSkills = loadInstalledSkills({ environment });

  output.write([
    "Setup 配置总览",
    `- 主 Provider：${primary}`,
    `- Codex 全局默认值：${codexDefaults.model ?? "跟随 Provider 默认模型"} · ${codexDefaults.effort ?? "跟随模型默认思考等级"}`,
    `- 可切换 Provider：${switching.join("、") || "未配置"}`,
    `- 第三方模型默认值：${modelDefaults.join("；") || "未配置"}`,
    `- 通讯渠道：${gateway.channels.join("、") || "未配置"}`,
    `- 用户技能目录：${installedSkills.length} 个技能`,
    `- Gateway 配置：${configPath}`,
    "- 作用范围：Provider、模型与登录由 Codex 配置管理；通讯渠道由 Gateway 配置管理。",
    "- 安全提示：API Key、Token、应用凭据、允许名单和代理值均不显示。",
    "",
  ].join("\n"));
  return {
    primary,
    codexDefaults,
    switching,
    modelDefaults,
    channels: gateway.channels,
    installedSkillCount: installedSkills.length,
    configPath,
  };
}

function defaultGatewayDocumentLoader(environment) {
  const { configPath } = requireUserConfig(environment);
  return { configPath, document: readGatewayConfig(configPath) };
}

async function defaultCodexDefaultsLoader(environment) {
  const client = await createCodexUserConfigClient({ environment });
  try {
    await client.connect();
    return await client.readDefaultModelSettings();
  } finally {
    await client.close().catch(() => undefined);
  }
}

function displayLabel(value, fallback) {
  let safe = "";
  for (const character of typeof value === "string" ? value : "") {
    const codePoint = character.codePointAt(0);
    safe += codePoint !== undefined
      && (codePoint < 32 || (codePoint >= 127 && codePoint <= 159))
      ? " "
      : character;
  }
  const normalized = safe.replace(/\s+/gu, " ").trim();
  return (normalized || fallback).slice(0, 120);
}
