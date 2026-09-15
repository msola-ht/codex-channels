import { existsSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

import { parse } from "smol-toml";

import { codexHomePath } from "./codex-home.mjs";
import { deepseekProviderDefinition } from "./model-provider-definitions.mjs";
import {
  catalogHasModel,
  exclusiveManagedProviders,
  findManagedProviderDefinition,
  loadConfiguredProviderProfile,
  loadManagedProviderProfileFor,
  loadManagedProviderProfiles,
  providerDescriptor,
  readCodexConfigFile,
  readModelCatalogSetting,
  readPrivateFile,
  readProviderProfile,
  record,
  tomlString,
} from "./model-provider-managed-runtime.mjs";
import {
  customOfficialModelCatalogPath,
  loadConfiguredCustomPrimaryModelProvider,
  loadCustomModelProviderRoleCandidates,
  validProviderBaseUrl,
  validThirdPartyRoleReasoningEffort,
} from "./model-provider-custom-runtime.mjs";
import {
  thirdPartyProviderRequestMaxRetries,
  thirdPartyProviderStreamMaxRetries,
} from "./model-provider-profile.mjs";
import {
  loadOpencodeGoDefaultAccount,
  opencodeGoProviderId,
  readOpencodeGoAccountMarker,
} from "./opencode-go-accounts.mjs";
import { writePrivateFileAtomicSync } from "./private-file.mjs";

const managedThirdPartyRoleName = "external";
const managedThirdPartyRoleConfigFileName = "sf-agent.config.toml";
const deepseekProvider = providerDescriptor(deepseekProviderDefinition);

export function loadManagedModelProvider(environment = process.env) {
  return loadManagedModelProviders(environment)[0];
}

export function loadManagedModelProviders(environment = process.env) {
  return loadManagedProviderProfiles(environment)
    .map((profile) => ({ provider: profile.provider }));
}

export function loadManagedProviderAppServer(environment = process.env) {
  return loadManagedProviderAppServers(environment)[0];
}

export function loadManagedProviderAppServers(environment = process.env) {
  return loadManagedProviderProfiles(environment, { requireLaunchConfig: true })
    .map(providerAppServerRuntime);
}

function providerAppServerRuntime(profile) {
  return {
    provider: profile.provider,
    arguments: [
      "-c", `model=${JSON.stringify(profile.model)}`,
      "-c", `model_provider=${JSON.stringify(profile.provider)}`,
      "-c", 'service_tier="default"',
      "-c", `model_catalog_json=${JSON.stringify(profile.catalogPath)}`,
      ...(profile.reasoningEffort === undefined
        ? []
        : ["-c", `model_reasoning_effort=${JSON.stringify(profile.reasoningEffort)}`]),
      "-c", `model_providers.${profile.provider}.name=${JSON.stringify(profile.name)}`,
      "-c", `model_providers.${profile.provider}.base_url=${JSON.stringify(profile.baseUrl)}`,
      "-c", `model_providers.${profile.provider}.wire_api=${JSON.stringify(profile.wireApi)}`,
      "-c", `model_providers.${profile.provider}.env_key=${JSON.stringify(profile.apiKeyEnvironmentKey)}`,
      "-c", `model_providers.${profile.provider}.requires_openai_auth=false`,
      ...(profile.supportsWebsockets === undefined
        ? []
        : ["-c", `model_providers.${profile.provider}.supports_websockets=${profile.supportsWebsockets}`]),
      "-c", `model_providers.${profile.provider}.request_max_retries=${thirdPartyProviderRequestMaxRetries}`,
      "-c", `model_providers.${profile.provider}.stream_max_retries=${thirdPartyProviderStreamMaxRetries}`,
    ],
    childEnvironment: {
      [profile.apiKeyEnvironmentKey]: profile.apiKey,
    },
  };
}


export function loadPrimaryModelProvider(environment = process.env) {
  const exclusiveProviders = exclusiveManagedProviders(environment);
  if (exclusiveProviders.length > 1) {
    throw new Error("只能有一个受管第三方 Provider 使用固定模式");
  }
  if (exclusiveProviders[0] !== undefined) return exclusiveProviders[0].id;
  // Gateway 的主 App Server 始终使用稳定的 openai 路由键；自定义 Provider 只改变其上游。
  loadConfiguredCustomPrimaryModelProvider(environment);
  return "openai";
}


export function loadOpenAiBaseUrl(environment = process.env) {
  const path = join(codexHomePath(environment), "config.toml");
  let document;
  try {
    document = record(parse(readCodexConfigFile(path)));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    // TOML 解析错误可能包含用户配置原文，不能作为 cause 暴露。
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Codex OpenAI base URL 配置无法安全读取");
  }
  const configured = document.openai_base_url;
  if (configured === undefined) return undefined;
  if (typeof configured !== "string") {
    throw new Error("Codex openai_base_url 必须是 HTTP(S) URL");
  }
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("Codex openai_base_url 必须是 HTTP(S) URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error("Codex openai_base_url 必须是无凭据、查询和片段的 HTTP(S) URL");
  }
  return url.toString();
}


export function providerAppServerSocketPath(primarySocketPath, provider) {
  const extension = extname(primarySocketPath);
  const stem = basename(primarySocketPath, extension);
  return resolve(dirname(primarySocketPath), `${stem}-${provider}${extension}`);
}

export function providerMetricsSocketPath(primarySocketPath, provider) {
  const extension = extname(primarySocketPath);
  const stem = basename(primarySocketPath, extension);
  return resolve(dirname(primarySocketPath), `${stem}-${provider}-metrics${extension}`);
}

export function withProviderBaseUrl(argumentsList, provider, baseUrl) {
  const prefixes = [
    `model_providers.${provider}.base_url=`,
    `model_providers.${provider}.request_max_retries=`,
    `model_providers.${provider}.stream_max_retries=`,
  ];
  const kept = [];
  for (let index = 0; index < argumentsList.length; index += 1) {
    const value = argumentsList[index];
    if (value === "-c") {
      const next = argumentsList[index + 1];
      if (
        typeof next === "string"
        && prefixes.some((prefix) => next.startsWith(prefix))
      ) {
        index += 1;
        continue;
      }
    }
    kept.push(value);
  }
  return [
    ...kept,
    "-c",
    `model_providers.${provider}.base_url=${JSON.stringify(baseUrl)}`,
    "-c",
    `model_providers.${provider}.request_max_retries=${thirdPartyProviderRequestMaxRetries}`,
    "-c",
    `model_providers.${provider}.stream_max_retries=${thirdPartyProviderStreamMaxRetries}`,
  ];
}

export function withOpenAiBaseUrl(argumentsList, baseUrl) {
  const prefix = "openai_base_url=";
  const kept = [];
  for (let index = 0; index < argumentsList.length; index += 1) {
    const value = argumentsList[index];
    if (value === "-c") {
      const next = argumentsList[index + 1];
      if (typeof next === "string" && next.startsWith(prefix)) {
        index += 1;
        continue;
      }
    }
    kept.push(value);
  }
  return [...kept, "-c", `openai_base_url=${JSON.stringify(baseUrl)}`];
}

export function loadDeepseekAccountCredential(environment = process.env) {
  const managed = loadManagedProviderProfileFor(
    environment,
    deepseekProviderDefinition,
  );
  if (managed !== undefined) return managed.apiKey;
  const configPath = join(codexHomePath(environment), "config.toml");
  return readProviderProfile(configPath, deepseekProvider, { requireSelection: false }).apiKey;
}

export function loadOpencodeGoAccountCredential(environment = process.env) {
  const account = loadOpencodeGoDefaultAccount(environment);
  if (account === undefined) throw new Error("尚未配置 OpenCode Go 账户");
  return loadOpencodeGoAccountCredentialFor(opencodeGoProviderId(account.id), environment);
}

export function loadOpencodeGoAccountCredentialFor(provider, environment = process.env) {
  if (provider === undefined) return loadOpencodeGoAccountCredential(environment);
  const definition = findManagedProviderDefinition(environment, provider);
  if (!definition) {
    throw new Error(`未知 OpenCode Go 账户：${provider}`);
  }
  if (
    definition.accountId !== undefined
    && readOpencodeGoAccountMarker(environment, definition.accountId)?.mode === "exclusive"
  ) {
    const configPath = join(codexHomePath(environment), "config.toml");
    return readProviderProfile(
      configPath,
      providerDescriptor(definition),
      { requireSelection: false },
    ).apiKey;
  }
  const managed = loadManagedProviderProfileFor(environment, definition);
  if (managed !== undefined) return managed.apiKey;
  const profile = loadConfiguredProviderProfile(environment, definition);
  if (profile) return profile.apiKey;
  throw new Error(`OpenCode Go 账户尚未配置：${provider}`);
}

export function managedModelProviderRoleConfigPath(environment = process.env) {
  return join(codexHomePath(environment), managedThirdPartyRoleConfigFileName);
}

export function writeManagedModelProviderRoleConfig(
  environment = process.env,
  { provider, model, baseUrl } = {},
) {
  const selectedProvider = provider ?? loadManagedModelProviderRole(environment)?.provider;
  const definition = findManagedProviderDefinition(environment, selectedProvider);
  if (!definition) throw new Error("请先选择已配置的第三方 Provider");
  const profile = loadConfiguredProviderProfile(environment, definition);
  if (profile === undefined) throw new Error(`${definition.displayName} Provider 尚未配置`);
  const selectedModel = model ?? profile.model;
  if (!catalogHasModel(profile.catalogPath, definition, selectedModel)) {
    throw new Error(`${definition.displayName} 不支持模型：${selectedModel}`);
  }
  const selectedModelSettings = readModelCatalogSetting(
    profile.catalogPath,
    definition,
    selectedModel,
  );
  let url;
  try {
    url = new URL(baseUrl ?? profile.baseUrl);
  } catch {
    throw new Error("第三方子代理 base_url 无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("第三方子代理 base_url 只支持 HTTP(S)");
  }
  const lines = [
    `model = ${tomlString(selectedModel)}`,
    `model_provider = ${tomlString(profile.provider)}`,
    `model_reasoning_effort = ${tomlString(selectedModelSettings.reasoningEffort)}`,
    `developer_instructions = ${tomlString(
      "你是第三方模型单次子代理。此角色只用于 fork_turns=1 的一次性任务：把继承上下文中最后一条用户消息视为完整任务并直接执行；不要尝试解析 encrypted_content，不等待或请求后续消息，也不要调用子代理通信工具。若最后一条用户消息仍不足以确定任务，只返回一句明确错误。",
    )}`,
    `model_catalog_json = ${tomlString(profile.catalogPath)}`,
    "",
    `[model_providers.${profile.provider}]`,
    `name = ${tomlString(profile.name)}`,
    `base_url = ${tomlString(url.toString())}`,
    `wire_api = ${tomlString(profile.wireApi)}`,
    `env_key = ${tomlString(profile.apiKeyEnvironmentKey)}`,
    ...(profile.supportsWebsockets === undefined
      ? []
      : [`supports_websockets = ${profile.supportsWebsockets}`]),
    "requires_openai_auth = false",
    `request_max_retries = ${thirdPartyProviderRequestMaxRetries}`,
    `stream_max_retries = ${thirdPartyProviderStreamMaxRetries}`,
    "",
  ].join("\n");
  writePrivateFileAtomicSync(managedModelProviderRoleConfigPath(environment), lines);
  return { role: managedThirdPartyRoleName, provider: definition.id, model: selectedModel };
}

export function writeThirdPartyModelProviderRoleConfig(
  environment = process.env,
  { provider, model, baseUrl } = {},
) {
  const definition = findManagedProviderDefinition(environment, provider);
  if (definition !== undefined) {
    return writeManagedModelProviderRoleConfig(environment, { provider, model, baseUrl });
  }
  const candidate = loadCustomModelProviderRoleCandidates(environment)
    .find((entry) => entry.provider === provider);
  if (candidate === undefined) throw new Error("请先选择已配置的第三方 Provider");
  const selectedModel = model ?? candidate.model;
  if (selectedModel !== candidate.model) {
    throw new Error(`${candidate.displayName} 子代理当前只支持已配置模型：${candidate.model}`);
  }
  const url = validProviderBaseUrl(baseUrl ?? candidate.baseUrl, "第三方子代理 base_url");
  const officialCatalogPath = customOfficialModelCatalogPath(environment);
  const lines = [
    `model = ${tomlString(selectedModel)}`,
    `model_provider = ${tomlString(candidate.provider)}`,
    `model_reasoning_effort = ${tomlString(candidate.reasoningEffort)}`,
    `developer_instructions = ${tomlString(
      "你是第三方模型单次子代理。此角色只用于 fork_turns=1 的一次性任务：把继承上下文中最后一条用户消息视为完整任务并直接执行；不要尝试解析 encrypted_content，不等待或请求后续消息，也不要调用子代理通信工具。若最后一条用户消息仍不足以确定任务，只返回一句明确错误。",
    )}`,
    ...(existsSync(officialCatalogPath)
      ? [`model_catalog_json = ${tomlString(officialCatalogPath)}`]
      : []),
    "",
    `[model_providers.${candidate.provider}]`,
    `name = ${tomlString(candidate.displayName)}`,
    `base_url = ${tomlString(url)}`,
    'wire_api = "responses"',
    `env_key = ${tomlString(candidate.apiKeyEnvironmentKey)}`,
    `supports_websockets = ${candidate.supportsWebsockets}`,
    "requires_openai_auth = false",
    `request_max_retries = ${thirdPartyProviderRequestMaxRetries}`,
    `stream_max_retries = ${thirdPartyProviderStreamMaxRetries}`,
    "",
  ].join("\n");
  writePrivateFileAtomicSync(managedModelProviderRoleConfigPath(environment), lines);
  return { role: managedThirdPartyRoleName, provider: candidate.provider, model: selectedModel };
}

export function loadManagedModelProviderRole(environment = process.env) {
  const role = loadThirdPartyModelProviderRole(environment);
  return role?.providerType === "managed"
    ? {
        role: role.role,
        provider: role.provider,
        model: role.model,
        reasoningEffort: role.reasoningEffort,
      }
    : undefined;
}

export function loadThirdPartyModelProviderRole(environment = process.env) {
  const path = managedModelProviderRoleConfigPath(environment);
  if (!existsSync(path)) return undefined;
  const configPath = join(codexHomePath(environment), "config.toml");
  let document;
  try {
    const config = record(parse(readPrivateFile(configPath)));
    if (record(record(config.agents)[managedThirdPartyRoleName]).config_file !== path) {
      return undefined;
    }
    document = record(parse(readPrivateFile(path)));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    // TOML 解析错误可能包含用户配置原文，不能作为 cause 暴露。
    // eslint-disable-next-line preserve-caught-error
    throw new Error("第三方子代理角色配置无法安全读取");
  }
  const provider = document.model_provider;
  const model = document.model;
  const reasoningEffort = document.model_reasoning_effort;
  const definition = findManagedProviderDefinition(environment, provider);
  const custom = definition === undefined
    ? loadCustomModelProviderRoleCandidates(environment).find((entry) => entry.provider === provider)
    : undefined;
  if (
    (!definition && !custom)
    || typeof model !== "string"
    || !validThirdPartyRoleReasoningEffort(reasoningEffort)
    || (custom !== undefined
      && (model !== custom.model || reasoningEffort !== custom.reasoningEffort))
  ) {
    throw new Error("第三方子代理角色配置无效");
  }
  return {
    role: managedThirdPartyRoleName,
    provider: definition?.id ?? custom.provider,
    model,
    reasoningEffort,
    providerType: definition === undefined ? "custom" : "managed",
  };
}


export function loadConfiguredProviderCredential(provider, environment = process.env) {
  const definition = findManagedProviderDefinition(environment, provider);
  if (!definition) throw new Error(`未知第三方 Provider：${provider}`);
  const profile = loadConfiguredProviderProfile(environment, definition);
  if (!profile) throw new Error(`${definition.displayName} Provider 尚未配置`);
  return {
    environmentKey: profile.apiKeyEnvironmentKey,
    apiKey: profile.apiKey,
  };
}

export function loadThirdPartyProviderCredential(provider, environment = process.env) {
  const definition = findManagedProviderDefinition(environment, provider);
  if (definition !== undefined) return loadConfiguredProviderCredential(provider, environment);
  const candidate = loadCustomModelProviderRoleCandidates(environment)
    .find((entry) => entry.provider === provider);
  if (candidate === undefined) throw new Error(`未知第三方 Provider：${provider}`);
  return {
    environmentKey: candidate.apiKeyEnvironmentKey,
    apiKey: candidate.apiKey,
  };
}

export function removeManagedModelProviderRoleConfig(environment = process.env) {
  const path = managedModelProviderRoleConfigPath(environment);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // 角色文件是辅助产物，清理失败不阻断服务退出。
  }
}
