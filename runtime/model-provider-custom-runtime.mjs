import { isResponsesProvider, responsesModelSettings, responsesProviderCatalogPath } from "./model-provider-responses-catalog.mjs";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { parse, stringify } from "smol-toml";

import { codexHomePath } from "./codex-home.mjs";
import { connectHomePath, providerStorageRoot } from "./connect-home.mjs";
import { withGatewayConfigLock } from "./gateway-config.mjs";
import {
  exclusiveManagedProviders,
  managedProviderDefinitions,
  readCodexConfigFile,
  record,
} from "./model-provider-managed-runtime.mjs";
import {
  modelProviderBlockEdits,
  thirdPartyProviderRequestMaxRetries,
  thirdPartyProviderStreamMaxRetries,
} from "./model-provider-profile.mjs";
import { isOpencodeGoProviderNamespace } from "./opencode-go-accounts.mjs";
import { readPrivateFileSync, writePrivateFileAtomicSync } from "./private-file.mjs";

const maximumConfigBytes = 1_048_576;
export const customPrimaryProviderProfileName = "sf-custom";
const builtInModelProviderIds = new Set(["openai", "ollama", "lmstudio", "amazon-bedrock"]);
const customProviderIdPattern = /^[A-Za-z0-9_-]{1,64}$/u;
const customSwitchingRegistryMaximumBytes = 262_144;
const customSwitchingDefaultReasoningEffort = "medium";

function readPrivateFile(path, maximumBytes = maximumConfigBytes) {
  return readPrivateFileSync(path, maximumBytes);
}

export function validateCustomPrimaryModelProviderId(id, environment = process.env) {
  if (typeof id !== "string" || !customProviderIdPattern.test(id)) {
    return "Provider ID 只能使用 1-64 位 ASCII 字母、数字、- 或 _";
  }
  if (
    builtInModelProviderIds.has(id)
    || id === "deepseek" || id.startsWith("ds-")
    || id === "clp" || id.startsWith("clp-")
    || id === "ccg" || id.startsWith("ccg-")
    || isOpencodeGoProviderNamespace(id)
    || managedProviderDefinitions(environment).some((definition) => definition.id === id)
  ) {
    return "该 Provider ID 已被 Codex 或 Gateway 保留";
  }
  return null;
}

export function listCustomPrimaryProviderCandidates(providers, environment = process.env) {
  const entries = record(providers);
  return Object.keys(entries).filter((candidate) => {
    if (validateCustomPrimaryModelProviderId(candidate, environment) !== null) {
      return false;
    }
    const provider = record(entries[candidate]);
    return typeof provider.base_url === "string" && provider.wire_api === "responses";
  });
}

export function primaryProviderBackupPath(environment = process.env) {
  return join(connectHomePath(environment), "private", "primary-providers.json");
}

export function readPrimaryProviderBackup(environment = process.env) {
  try {
    return record(JSON.parse(readPrivateFile(primaryProviderBackupPath(environment))));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    // 备份文件包含用户 Key，解析失败不能把原文作为 cause 暴露。
    // eslint-disable-next-line preserve-caught-error
    throw new Error("主 Provider 备份无法安全读取");
  }
}

export function backupPrimaryProviderCandidates(providers, environment = process.env) {
  const candidates = listCustomPrimaryProviderCandidates(providers, environment);
  if (candidates.length === 0) return candidates;
  const next = { ...readPrimaryProviderBackup(environment) };
  for (const id of candidates) {
    next[id] = record(providers[id]);
  }
  writePrivateFileAtomicSync(
    primaryProviderBackupPath(environment),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  return candidates;
}

export function restorePrimaryProviderCandidateEdits(id, environment = process.env) {
  const provider = record(readPrimaryProviderBackup(environment)[id]);
  if (typeof provider.base_url !== "string") return undefined;
  return modelProviderBlockEdits(id, provider);
}

export function removePrimaryProviderBackupCandidate(id, environment = process.env) {
  const backup = readPrimaryProviderBackup(environment);
  if (!Object.prototype.hasOwnProperty.call(backup, id)) return undefined;
  const removed = record(backup[id]);
  const next = { ...backup };
  delete next[id];
  writePrivateFileAtomicSync(
    primaryProviderBackupPath(environment),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  return removed;
}


export function loadConfiguredCustomPrimaryModelProvider(environment = process.env) {
  if (exclusiveManagedProviders(environment).length > 0) return undefined;
  const path = join(codexHomePath(environment), "config.toml");
  let document;
  try {
    document = record(parse(readCodexConfigFile(path)));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    // TOML 解析错误可能包含用户配置原文，不能作为 cause 暴露。
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Codex 主模型 Provider 配置无法安全读取");
  }
  const providers = record(document.model_providers);
  const configuredIds = listCustomPrimaryProviderCandidates(providers, environment);
  let id = document.model_provider;
  if (id === "openai") {
    // 显式选择官方时锁定官方，不自动激活候选。
    return undefined;
  }
  if (id === undefined) {
    if (configuredIds.length === 0) return undefined;
    if (configuredIds.length > 1) {
      // 多个候选且未显式选择时保持官方主 Provider，候选可通过 primary-provider 命令切换。
      return undefined;
    }
    [id] = configuredIds;
  }
  const reservedError = validateCustomPrimaryModelProviderId(id, environment);
  if (reservedError !== null) {
    throw new Error(`Codex 主模型 Provider 不受 Gateway 支持：${id}`);
  }
  const provider = record(providers[id]);
  if (
    typeof document.openai_base_url === "string"
    && document.openai_base_url.trim() !== ""
  ) {
    throw new Error(
      "官方顶层 openai_base_url 与自定义主 Provider 不能同时配置；请移除顶层 openai_base_url",
    );
  }
  const baseUrl = provider.base_url;
  if (typeof baseUrl !== "string") {
    throw new Error(`Codex 主模型 Provider ${id} 缺少 base_url`);
  }
  const normalizedBaseUrl = validProviderBaseUrl(baseUrl, `Codex 主模型 Provider ${id}`);
  if (provider.wire_api !== undefined && provider.wire_api !== "responses") {
    throw new Error(`Codex 主模型 Provider ${id} 只支持 Responses API`);
  }
  if (
    provider.supports_websockets !== undefined
    && typeof provider.supports_websockets !== "boolean"
  ) {
    throw new Error(`Codex 主模型 Provider ${id} 的 supports_websockets 无效`);
  }
  if (
    provider.requires_openai_auth !== undefined
    && typeof provider.requires_openai_auth !== "boolean"
  ) {
    throw new Error(`Codex 主模型 Provider ${id} 的 requires_openai_auth 无效`);
  }
  if (isResponsesProvider(id) && provider.name === "OpenAI") throw new Error("Responses Provider 不能使用 OpenAI 名称");
  const custom = isResponsesProvider(id) ? responsesModelSettings(environment, id, document.model) : undefined;
  if (custom && document.model_catalog_json !== custom.catalog.path) throw new Error("Responses Provider 模型目录引用无效");
  return {
    id,
    baseUrl: normalizedBaseUrl,
    ...(custom ? { catalogPath: custom.catalog.path } : {}),
  };
}

export function customPrimaryProviderProfilePath(environment = process.env, provider) {
  if (typeof provider !== "string" || !customProviderIdPattern.test(provider)) {
    throw new Error("自定义切换 Provider ID 无效");
  }
  return join(
    codexHomePath(environment),
    `${customPrimaryProviderProfileName}-${provider}.config.toml`,
  );
}

export function customSwitchingProviderRegistryPath(environment = process.env) {
  return join(providerStorageRoot(environment), "custom", "providers.json");
}

export function loadCustomSwitchingProviderIds(environment = process.env) {
  const path = customSwitchingProviderRegistryPath(environment);
  if (!existsSync(path)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readPrivateFileSync(path, customSwitchingRegistryMaximumBytes));
  } catch {
    throw new Error("自定义切换 Provider 注册表无法安全读取");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("自定义切换 Provider 注册表无效");
  }
  const seen = new Set();
  return parsed.map((entry) => {
    const provider = record(entry);
    const id = provider.id;
    if (
      Object.keys(provider).length !== 1
      || typeof id !== "string"
      || validateCustomPrimaryModelProviderId(id, environment) !== null
      || seen.has(id)
    ) {
      throw new Error("自定义切换 Provider 注册表包含重复或无效 Provider");
    }
    seen.add(id);
    return id;
  });
}

function writeCustomSwitchingProviderIds(environment, providers) {
  if (providers.length === 0) {
    const path = customSwitchingProviderRegistryPath(environment);
    try {
      unlinkSync(path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return;
  }
  writePrivateFileAtomicSync(
    customSwitchingProviderRegistryPath(environment),
    `${JSON.stringify(providers.map((id) => ({ id })), null, 2)}\n`,
  );
}

export function isCustomSwitchingModelProviderConfigCompatible(config, providerId) {
  const source = record(config);
  if (source.model_provider !== undefined && source.model_provider !== "openai") return false;
  if (typeof source.openai_base_url === "string" && source.openai_base_url.trim() !== "") {
    return false;
  }
  return !Object.prototype.hasOwnProperty.call(record(source.model_providers), providerId);
}

export function loadConfiguredCustomSwitchingModelProviders(environment = process.env, providerId) {
  const providers = loadCustomSwitchingProviderIds(environment);
  if (providers.length === 0) return [];
  if (exclusiveManagedProviders(environment).length > 0) {
    throw new Error("受管第三方固定模式不能同时启用自定义 Provider 切换模式");
  }
  const configPath = join(codexHomePath(environment), "config.toml");
  let config;
  try {
    config = record(parse(readCodexConfigFile(configPath)));
  } catch {
    throw new Error("Codex 主模型 Provider 配置无法安全读取");
  }
  if (config.model_provider !== undefined && config.model_provider !== "openai") {
    throw new Error("自定义 Provider 切换模式要求主 Provider 为官方 openai");
  }
  if (typeof config.openai_base_url === "string" && config.openai_base_url.trim() !== "") {
    throw new Error(
      "官方顶层 openai_base_url 与自定义 Provider 切换模式不能同时配置；请移除顶层 openai_base_url",
    );
  }
  for (const id of providers) {
    if (Object.prototype.hasOwnProperty.call(record(config.model_providers), id)) {
      throw new Error(`自定义切换 Provider ${id} 不得写入 Codex 主配置`);
    }
  }
  return providers.filter((provider) => providerId === undefined || provider === providerId)
    .map((provider) => loadCustomSwitchingProfile(environment, provider));
}

function loadCustomSwitchingProfile(environment, registeredProvider) {
  const path = customPrimaryProviderProfilePath(environment, registeredProvider);
  let profileContent;
  try {
    profileContent = readPrivateFileSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      // 缺失路径属于稳定配置错误，不能把用户目录作为 cause 暴露。
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`自定义切换 Provider ${registeredProvider} 的 Profile 缺失`);
    }
    // Profile 解析错误可能包含用户配置原文，不能作为 cause 暴露。
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Codex 自定义切换 Provider Profile 无法安全读取");
  }
  return configuredCustomSwitchingProfileFromContent(
    environment,
    registeredProvider,
    profileContent,
  );
}

function configuredCustomSwitchingProfileFromContent(
  environment,
  registeredProvider,
  profileContent,
) {
  let profile;
  try {
    profile = record(parse(profileContent));
  } catch {
    throw new Error("Codex 自定义切换 Provider Profile 无法安全读取");
  }
  if (!isResponsesProvider(registeredProvider) && profile.model_catalog_json !== undefined) {
    throw new Error("自定义切换 Provider 当前只支持 Codex 官方模型目录");
  }
  const custom = isResponsesProvider(registeredProvider)
    ? responsesModelSettings(environment, registeredProvider, profile.model) : undefined;
  const reasoningEffort = custom ? custom.reasoningEffort ?? "none" : customSwitchingDefaultReasoningEffort;
  if (custom && profile.model_catalog_json !== custom.catalog.path) throw new Error("Responses Provider 模型目录引用无效");
  const supportedProfileKeys = new Set([
    ...(custom ? ["model_catalog_json", "web_search"] : []),
    "model",
    "model_provider",
    "model_reasoning_effort",
    "service_tier",
    "model_providers",
  ]);
  if (
    Object.keys(profile).some((key) => !supportedProfileKeys.has(key))
    || profile.service_tier !== "default"
    || profile.model_reasoning_effort !== (reasoningEffort ?? undefined)
    || (custom && profile.web_search !== "disabled")
  ) {
    throw new Error("Codex 自定义切换 Provider Profile 包含不受支持的配置");
  }
  const id = profile.model_provider;
  const model = profile.model;
  const validationError = validateCustomPrimaryModelProviderId(id, environment);
  if (
    validationError !== null
    || id !== registeredProvider
    || typeof model !== "string"
    || model.trim() === ""
  ) {
    throw new Error("Codex 自定义切换 Provider Profile 无效");
  }
  const profileProviders = record(profile.model_providers);
  if (
    Object.keys(profileProviders).length !== 1
    || !Object.prototype.hasOwnProperty.call(profileProviders, id)
  ) {
    throw new Error("Codex 自定义切换 Provider Profile 只能包含已注册的 Provider 块");
  }
  const provider = record(profileProviders[id]);
  const supportedProviderKeys = new Set([
    "name",
    "base_url",
    "wire_api",
    "requires_openai_auth",
    "supports_websockets",
    "request_max_retries",
    "stream_max_retries",
    "experimental_bearer_token",
  ]);
  if (Object.keys(provider).some((key) => !supportedProviderKeys.has(key))) {
    throw new Error("Codex 自定义切换 Provider Profile 的 Provider 块包含不受支持的配置");
  }
  if (typeof provider.base_url !== "string") {
    throw new Error(`Codex 自定义切换 Provider ${id} 缺少 base_url`);
  }
  if (provider.wire_api !== undefined && provider.wire_api !== "responses") {
    throw new Error(`Codex 自定义切换 Provider ${id} 只支持 Responses API`);
  }
  if (
    provider.supports_websockets !== undefined
    && typeof provider.supports_websockets !== "boolean"
  ) {
    throw new Error(`Codex 自定义切换 Provider ${id} 的 supports_websockets 无效`);
  }
  if (
    provider.requires_openai_auth !== undefined
    && provider.requires_openai_auth !== false
  ) {
    throw new Error(`Codex 自定义切换 Provider ${id} 的 requires_openai_auth 无效`);
  }
  if (
    provider.request_max_retries !== undefined
    && provider.request_max_retries !== thirdPartyProviderRequestMaxRetries
  ) {
    throw new Error(`Codex 自定义切换 Provider ${id} 的 request_max_retries 无效`);
  }
  if (
    provider.stream_max_retries !== undefined
    && provider.stream_max_retries !== thirdPartyProviderStreamMaxRetries
  ) {
    throw new Error(`Codex 自定义切换 Provider ${id} 的 stream_max_retries 无效`);
  }
  const apiKey = provider.experimental_bearer_token;
  if (typeof apiKey !== "string" || apiKey.trim() === "" || /[\r\n]/u.test(apiKey)) {
    throw new Error(`Codex 自定义切换 Provider ${id} API Key 缺失或无效`);
  }
  const name = typeof provider.name === "string" && provider.name.trim() !== ""
    ? provider.name.trim()
    : id;
  if (custom && name === "OpenAI") throw new Error("Responses Provider 不能使用 OpenAI 名称");
  const supportsWebsockets = provider.supports_websockets === true;
  const environmentKey = customSwitchingProviderEnvironmentKey(id);
  const profileName = `${customPrimaryProviderProfileName}-${id}`;
  return {
    id,
    provider: id,
    model: model.trim(),
    name,
    baseUrl: validProviderBaseUrl(provider.base_url, `Codex 自定义切换 Provider ${id}`),
    apiKey,
    supportsWebsockets,
    profileName,
    profileContent,
    reasoningEffort: reasoningEffort ?? undefined,
    catalogSource: custom ? { kind: "custom", path: custom.catalog.path } : { kind: "official" },
    arguments: [
      "-c", `model=${JSON.stringify(model.trim())}`,
      "-c", `model_provider=${JSON.stringify(id)}`,
      "-c", 'service_tier="default"',
      ...(reasoningEffort === null ? [] : ["-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`]),
      ...(custom ? ["-c", `model_catalog_json=${JSON.stringify(custom.catalog.path)}`, "-c", 'web_search="disabled"'] : []),
      "-c", `model_providers.${id}.name=${JSON.stringify(name)}`,
      "-c", `model_providers.${id}.base_url=${JSON.stringify(validProviderBaseUrl(provider.base_url, `Codex 自定义切换 Provider ${id}`))}`,
      "-c", `model_providers.${id}.wire_api="responses"`,
      "-c", `model_providers.${id}.env_key=${JSON.stringify(environmentKey)}`,
      "-c", `model_providers.${id}.requires_openai_auth=false`,
      "-c", `model_providers.${id}.supports_websockets=${supportsWebsockets}`,
      "-c", `model_providers.${id}.request_max_retries=${thirdPartyProviderRequestMaxRetries}`,
      "-c", `model_providers.${id}.stream_max_retries=${thirdPartyProviderStreamMaxRetries}`,
    ],
    childEnvironment: { [environmentKey]: apiKey },
  };
}

export function writeCustomPrimaryProviderSwitchingProfile(
  options,
  environment = process.env,
  guards = {},
) {
  return withGatewayConfigLock(customSwitchingProviderRegistryPath(environment), () =>
    writeCustomPrimaryProviderSwitchingProfileUnlocked(options, environment, guards));
}

function writeCustomPrimaryProviderSwitchingProfileUnlocked(
  {
    provider,
    model,
    name = provider,
    baseUrl,
    apiKey,
    supportsWebsockets = false,
    catalogSource = { kind: "official" },
  },
  environment = process.env,
  {
    expectedProfilePresent,
    expectedProfileContent,
    expectedProviderIds,
  } = {},
) {
  const validationError = validateCustomPrimaryModelProviderId(provider, environment);
  if (validationError !== null) throw new Error(validationError);
  if (typeof model !== "string" || model.trim() === "") {
    throw new Error("自定义 Provider 默认模型不能为空");
  }
  if (catalogSource?.kind !== "official" && !(isResponsesProvider(provider) && catalogSource?.kind === "custom")) {
    throw new Error("自定义 Provider 当前只支持 Codex 官方模型目录");
  }
  if (isResponsesProvider(provider) && name === "OpenAI") throw new Error("Responses Provider 不能使用 OpenAI 名称");
  if (isResponsesProvider(provider) !== (catalogSource.kind === "custom")) throw new Error("Provider 类型与模型目录来源不一致");
  const normalizedBaseUrl = validProviderBaseUrl(
    baseUrl,
    `Codex 自定义切换 Provider ${provider}`,
  );
  if (typeof apiKey !== "string" || apiKey.trim() === "" || /[\r\n]/u.test(apiKey)) {
    throw new Error("自定义 Provider API Key 不能为空");
  }
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("自定义 Provider 显示名称不能为空");
  }
  const ids = loadCustomSwitchingProviderIds(environment);
  const profilePath = customPrimaryProviderProfilePath(environment, provider);
  let previousProfile;
  try {
    previousProfile = readPrivateFileSync(profilePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (
    (expectedProviderIds !== undefined && !sameStringArray(ids, expectedProviderIds))
    || (expectedProfilePresent === true && previousProfile !== expectedProfileContent)
    || (expectedProfilePresent === false && previousProfile !== undefined)
  ) {
    throw customSwitchingProfileChangedError(provider);
  }
  writePrivateFileAtomicSync(
    profilePath,
    stringify({
      model: model.trim(),
      model_provider: provider,
      ...(catalogSource.kind === "custom" ? {
        model_catalog_json: responsesProviderCatalogPath(environment, provider),
        web_search: "disabled",
        model_reasoning_effort: catalogSource.reasoningEffort ?? "none",
      } : { model_reasoning_effort: customSwitchingDefaultReasoningEffort }),
      service_tier: "default",
      model_providers: {
        [provider]: {
          name,
          base_url: normalizedBaseUrl,
          wire_api: "responses",
          requires_openai_auth: false,
          supports_websockets: supportsWebsockets === true,
          request_max_retries: thirdPartyProviderRequestMaxRetries,
          stream_max_retries: thirdPartyProviderStreamMaxRetries,
          experimental_bearer_token: apiKey,
        },
      },
    }),
  );
  if (!ids.includes(provider)) {
    try {
      writeCustomSwitchingProviderIds(environment, [...ids, provider]);
    } catch (error) {
      try {
        if (previousProfile === undefined) {
          unlinkSync(profilePath);
        } else {
          writePrivateFileAtomicSync(profilePath, previousProfile);
        }
      } catch (rollbackError) {
        // AggregateError 已保留注册表写入与 Profile 回滚两个原始错误。
        // eslint-disable-next-line preserve-caught-error
        throw new AggregateError(
          [error, rollbackError],
          "自定义切换 Provider 注册失败，且 Profile 回滚失败",
        );
      }
      throw error;
    }
  }
}

export function removeCustomPrimaryProviderSwitchingProfile(
  environment = process.env,
  provider,
  expectedProfileContent,
) {
  return withGatewayConfigLock(customSwitchingProviderRegistryPath(environment), () =>
    removeCustomPrimaryProviderSwitchingProfileUnlocked(
      environment,
      provider,
      expectedProfileContent,
    ));
}

function removeCustomPrimaryProviderSwitchingProfileUnlocked(
  environment,
  provider,
  expectedProfileContent,
) {
  const ids = loadCustomSwitchingProviderIds(environment);
  const registered = ids.includes(provider);
  const path = customPrimaryProviderProfilePath(environment, provider);
  try {
    const profileContent = readPrivateFileSync(path);
    if (
      expectedProfileContent !== undefined
      && profileContent !== expectedProfileContent
    ) {
      throw customSwitchingProfileChangedError(provider);
    }
    const remaining = ids.filter((id) => id !== provider);
    writeCustomSwitchingProviderIds(environment, remaining);
    try {
      unlinkSync(path);
    } catch (error) {
      try {
        writeCustomSwitchingProviderIds(environment, ids);
      } catch (rollbackError) {
        // AggregateError 已保留 Profile 删除与注册表回滚两个原始错误。
        // eslint-disable-next-line preserve-caught-error
        throw new AggregateError(
          [error, rollbackError],
          "自定义切换 Provider Profile 删除失败，且注册表回滚失败",
        );
      }
      throw error;
    }
    return true;
  } catch (error) {
    if (error?.code === "CUSTOM_SWITCHING_PROFILE_CHANGED") throw error;
    if (error instanceof AggregateError) throw error;
    if (error?.code === "ENOENT") {
      if (!registered) return false;
      try {
        writeCustomSwitchingProviderIds(environment, ids.filter((id) => id !== provider));
      } catch {
        throw new Error("Codex 自定义切换 Provider 注册表无法安全更新");
      }
      return true;
    }
    // 私有文件错误可能包含用户路径或配置细节，不能作为 cause 暴露。
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Codex 自定义切换 Provider Profile 无法安全删除");
  }
}

export function restoreCustomPrimaryProviderSwitchingProfile(
  environment = process.env,
  provider,
  profileContent,
) {
  return withGatewayConfigLock(customSwitchingProviderRegistryPath(environment), () =>
    restoreCustomPrimaryProviderSwitchingProfileUnlocked(environment, provider, profileContent));
}

function restoreCustomPrimaryProviderSwitchingProfileUnlocked(
  environment,
  provider,
  profileContent,
) {
  configuredCustomSwitchingProfileFromContent(environment, provider, profileContent);
  const ids = loadCustomSwitchingProviderIds(environment);
  const path = customPrimaryProviderProfilePath(environment, provider);
  if (ids.includes(provider) || existsSync(path)) {
    throw customSwitchingProfileChangedError(provider);
  }
  writePrivateFileAtomicSync(path, profileContent);
  try {
    writeCustomSwitchingProviderIds(environment, [...ids, provider]);
  } catch (error) {
    try {
      unlinkSync(path);
    } catch (rollbackError) {
      // AggregateError 已保留注册表写入与 Profile 回滚两个原始错误。
      // eslint-disable-next-line preserve-caught-error
      throw new AggregateError(
        [error, rollbackError],
        "自定义切换 Provider Profile 恢复失败，且文件回滚失败",
      );
    }
    throw error;
  }
}

function sameStringArray(left, right) {
  return Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function customSwitchingProfileChangedError(provider) {
  const error = new Error(`自定义切换 Provider ${provider} 的 Profile 在事务期间发生变化`);
  error.code = "CUSTOM_SWITCHING_PROFILE_CHANGED";
  return error;
}

function customSwitchingProviderEnvironmentKey(provider) {
  return `CODEX_CONNECT_CUSTOM_${Buffer.from(provider, "utf8").toString("hex").toUpperCase()}_API_KEY`;
}


export function validProviderBaseUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} base_url 必须是 HTTP(S) URL`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error(`${label} base_url 必须是无凭据、查询和片段的 HTTP(S) URL`);
  }
  return url.toString();
}
