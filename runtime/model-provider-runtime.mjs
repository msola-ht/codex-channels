import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

import { parse, stringify } from "smol-toml";

import { codexHomePath } from "./codex-home.mjs";
import { connectHomePath, providerStorageRoot } from "./connect-home.mjs";
import { withGatewayConfigLock } from "./gateway-config.mjs";
import {
  deepseekProviderDefinition,
  loadManagedModelProviderDefinitions,
  opencodeGoProviderDefinition,
} from "./model-provider-definitions.mjs";
import { modelProviderBlockEdits } from "./model-provider-profile.mjs";
import {
  isOpencodeGoProviderNamespace,
  opencodeGoAccountMarkerPath,
} from "./opencode-go-accounts.mjs";
import {
  readPrivateFileSync,
  writePrivateFileAtomicSync,
} from "./private-file.mjs";

const maximumConfigBytes = 1_048_576;
const maximumCatalogBytes = 2_097_152;
const managedThirdPartyRoleName = "external";
const managedThirdPartyRoleConfigFileName = "sf-agent.config.toml";
export const customPrimaryProviderProfileName = "sf-custom";
const customSwitchingProviderProfileName = "custom";
const builtInModelProviderIds = new Set(["openai", "ollama", "lmstudio", "amazon-bedrock"]);
const customProviderIdPattern = /^[A-Za-z0-9_-]{1,64}$/u;
const thirdPartyRoleReasoningEffortPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u;
const customSwitchingRegistryMaximumBytes = 262_144;
const customSwitchingDefaultReasoningEffort = "medium";

const deepseekProvider = providerDescriptor(deepseekProviderDefinition);

export function validateCustomPrimaryModelProviderId(id, environment = process.env) {
  if (typeof id !== "string" || !customProviderIdPattern.test(id)) {
    return "Provider ID 只能使用 1-64 位 ASCII 字母、数字、- 或 _";
  }
  if (
    builtInModelProviderIds.has(id)
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

export function managedProviderDirectory(environment, definition) {
  return join(providerStorageRoot(environment), definition.storageId ?? definition.id);
}

export function managedProviderMarkerPath(environment, definition) {
  if (definition.accountId !== undefined) {
    return opencodeGoAccountMarkerPath(environment, definition.accountId);
  }
  return join(
    managedProviderDirectory(environment, definition),
    definition.managedMarkerFileName,
  );
}

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
    ],
    childEnvironment: {
      [profile.apiKeyEnvironmentKey]: profile.apiKey,
    },
  };
}

export function validateConfiguredModelProvider(environment = process.env) {
  return validateConfiguredModelProviders(environment)[0];
}

export function validateConfiguredModelProviders(environment = process.env) {
  const definitions = managedProviderDefinitions(environment);
  const exclusiveProviders = definitions.filter((definition) =>
    readManagedMarker(environment, definition)?.mode === "exclusive");
  if (exclusiveProviders.length > 1) {
    throw new Error("只能有一个受管第三方 Provider 使用固定模式");
  }
  return definitions.flatMap((definition) => {
    const marker = readManagedMarker(environment, definition);
    if (!marker) return [];
    if (marker.mode === "exclusive") {
      const configured = loadConfiguredProviderProfile(environment, definition);
      return [{ provider: configured.provider, mode: configured.mode }];
    }
    loadManagedProviderProfileFor(environment, definition, { requireLaunchConfig: true });
    return [{ provider: definition.id, mode: "switching" }];
  });
}

export function loadManagedModelProviderSettings(environment = process.env) {
  return managedProviderDefinitions(environment).flatMap((definition) => {
    const marker = readManagedMarker(environment, definition);
    if (!marker) return [];
    const profile = loadConfiguredProviderProfile(environment, definition);
    return [{
      provider: definition.id,
      displayName: definition.displayName,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
      mode: marker.mode,
      models: loadModelCatalogSettings(profile.catalogPath, definition),
    }];
  });
}

export function writeManagedModelProviderProfileDefault(
  provider,
  settings,
  environment = process.env,
) {
  const definition = findManagedProviderDefinition(environment, provider);
  if (!definition) throw new Error(`未知第三方 Provider：${provider}`);
  const model = settings?.model;
  validateManagedModelSettings(definition, settings);
  const codexHome = codexHomePath(environment);
  const marker = readManagedMarker(environment, definition);
  if (!marker) throw new Error(`${definition.displayName} Provider 尚未配置`);
  if (marker.mode !== "switching") {
    throw new Error(`${definition.displayName} 固定模式必须通过 Codex 配置事务修改默认模型`);
  }
  const descriptor = providerDescriptor(definition);
  const profilePath = join(codexHome, definition.profileFileName);
  const expectedCatalogPath = join(
    managedProviderDirectory(environment, definition),
    definition.catalogFileName,
  );
  const profile = readProviderProfile(profilePath, descriptor, {
    expectedCatalogPath,
    reasoningEffortPolicy: "ignore",
  });
  const previousCatalog = readPrivateFile(profile.catalogPath, maximumCatalogBytes);
  const nextCatalog = updateModelCatalogSettings(previousCatalog, definition, settings);
  const document = record(parse(readPrivateFile(profilePath)));
  document.model = model;
  document.model_reasoning_effort = settings.reasoningEffort;
  delete document.model_context_window;
  delete document.model_auto_compact_token_limit;
  delete document.model_auto_compact_token_limit_scope;
  writePrivateFileAtomicSync(profile.catalogPath, nextCatalog);
  try {
    writePrivateFileAtomicSync(profilePath, stringify(document));
  } catch (error) {
    writePrivateFileAtomicSync(profile.catalogPath, previousCatalog);
    throw error;
  }
  readProviderProfile(profilePath, descriptor, {
    expectedCatalogPath,
    reasoningEffortPolicy: "mirror",
  });
  return { provider: definition.id, ...settings, mode: marker.mode };
}

export function writeManagedModelProviderCatalogSettings(
  provider,
  settings,
  environment = process.env,
) {
  const definition = findManagedProviderDefinition(environment, provider);
  if (!definition) throw new Error(`未知第三方 Provider：${provider}`);
  validateManagedModelSettings(definition, settings);
  const catalogPath = join(
    managedProviderDirectory(environment, definition),
    definition.catalogFileName,
  );
  const previousContent = readPrivateFile(catalogPath, maximumCatalogBytes);
  const previous = modelCatalogSetting(previousContent, definition, settings.model);
  writePrivateFileAtomicSync(
    catalogPath,
    updateModelCatalogSettings(previousContent, definition, settings),
  );
  return previous;
}

export function withManagedModelCatalogSettings(catalog, definition, settings) {
  validateManagedModelSettings(definition, settings);
  const content = JSON.stringify(catalog);
  return JSON.parse(updateModelCatalogSettings(content, definition, settings));
}

export function withPreservedManagedModelCatalogSettings(
  catalog,
  definition,
  previousModels = [],
) {
  let next = catalog;
  for (const previous of previousModels) {
    if (!definition.models.some(({ slug, available }) => available && slug === previous.model)) {
      continue;
    }
    const current = modelCatalogSetting(JSON.stringify(next), definition, previous.model);
    const reasoningEffort = current.reasoningEfforts.some(
      ({ effort }) => effort === previous.reasoningEffort,
    )
      ? previous.reasoningEffort
      : current.reasoningEffort;
    const autoCompactLimit = previous.autoCompactPercent === undefined
      ? undefined
      : Math.round(current.contextWindow * previous.autoCompactPercent / 100);
    next = withManagedModelCatalogSettings(next, definition, {
      model: previous.model,
      reasoningEffort,
      ...(autoCompactLimit === undefined ? {} : { autoCompactLimit }),
    });
  }
  return next;
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
  return {
    id,
    baseUrl: normalizedBaseUrl,
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

export function loadConfiguredCustomSwitchingModelProviders(environment = process.env) {
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
  return providers.map((provider) => loadCustomSwitchingProfile(environment, provider));
}

export function loadCustomModelProviderRoleCandidates(environment = process.env) {
  const switching = loadConfiguredCustomSwitchingModelProviders(environment).map((provider) => ({
    provider: provider.id,
    displayName: provider.name,
    model: provider.model,
    reasoningEffort: provider.reasoningEffort,
    mode: "switching",
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    apiKeyEnvironmentKey: customSwitchingProviderEnvironmentKey(provider.id),
    supportsWebsockets: provider.supportsWebsockets,
  }));
  const primary = loadConfiguredCustomPrimaryModelProvider(environment);
  if (primary === undefined) return switching;
  const configPath = join(codexHomePath(environment), "config.toml");
  let document;
  try {
    document = record(parse(readCodexConfigFile(configPath)));
  } catch {
    throw new Error("Codex 自定义固定 Provider 配置无法安全读取");
  }
  const provider = record(record(document.model_providers)[primary.id]);
  const model = document.model;
  const reasoningEffort = document.model_reasoning_effort ?? customSwitchingDefaultReasoningEffort;
  const apiKey = provider.experimental_bearer_token;
  if (
    typeof model !== "string"
    || model.trim() === ""
    || !validThirdPartyRoleReasoningEffort(reasoningEffort)
    || typeof apiKey !== "string"
    || apiKey.trim() === ""
    || /[\r\n]/u.test(apiKey)
  ) {
    throw new Error(`Codex 自定义固定 Provider ${primary.id} 不具备可用的子代理配置`);
  }
  return [...switching, {
    provider: primary.id,
    displayName: typeof provider.name === "string" && provider.name.trim() !== ""
      ? provider.name.trim()
      : primary.id,
    model: model.trim(),
    reasoningEffort: reasoningEffort.trim(),
    mode: "exclusive",
    baseUrl: primary.baseUrl,
    apiKey,
    apiKeyEnvironmentKey: customSwitchingProviderEnvironmentKey(primary.id),
    supportsWebsockets: provider.supports_websockets === true,
  }];
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
  if (profile.model_catalog_json !== undefined) {
    throw new Error("自定义切换 Provider 当前只支持 Codex 官方模型目录");
  }
  const supportedProfileKeys = new Set([
    "model",
    "model_provider",
    "model_reasoning_effort",
    "service_tier",
    "model_providers",
  ]);
  if (
    Object.keys(profile).some((key) => !supportedProfileKeys.has(key))
    || profile.service_tier !== "default"
    || profile.model_reasoning_effort !== customSwitchingDefaultReasoningEffort
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
  const apiKey = provider.experimental_bearer_token;
  if (typeof apiKey !== "string" || apiKey.trim() === "" || /[\r\n]/u.test(apiKey)) {
    throw new Error(`Codex 自定义切换 Provider ${id} API Key 缺失或无效`);
  }
  const name = typeof provider.name === "string" && provider.name.trim() !== ""
    ? provider.name.trim()
    : id;
  const supportsWebsockets = provider.supports_websockets === true;
  const environmentKey = customSwitchingProviderEnvironmentKey(id);
  const profileName = `${customSwitchingProviderProfileName}-${id}`;
  const codexProfileName = `${customPrimaryProviderProfileName}-${id}`;
  return {
    id,
    provider: id,
    model: model.trim(),
    name,
    baseUrl: validProviderBaseUrl(provider.base_url, `Codex 自定义切换 Provider ${id}`),
    apiKey,
    supportsWebsockets,
    profileName,
    codexProfileName,
    profileContent,
    reasoningEffort: customSwitchingDefaultReasoningEffort,
    catalogSource: { kind: "official" },
    arguments: [
      "-c", `model=${JSON.stringify(model.trim())}`,
      "-c", `model_provider=${JSON.stringify(id)}`,
      "-c", 'service_tier="default"',
      "-c", `model_reasoning_effort=${JSON.stringify(customSwitchingDefaultReasoningEffort)}`,
      "-c", `model_providers.${id}.name=${JSON.stringify(name)}`,
      "-c", `model_providers.${id}.base_url=${JSON.stringify(validProviderBaseUrl(provider.base_url, `Codex 自定义切换 Provider ${id}`))}`,
      "-c", `model_providers.${id}.wire_api="responses"`,
      "-c", `model_providers.${id}.env_key=${JSON.stringify(environmentKey)}`,
      "-c", `model_providers.${id}.requires_openai_auth=false`,
      "-c", `model_providers.${id}.supports_websockets=${supportsWebsockets}`,
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
  if (catalogSource?.kind !== "official") {
    throw new Error("自定义 Provider 当前只支持 Codex 官方模型目录");
  }
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
      model_reasoning_effort: customSwitchingDefaultReasoningEffort,
      service_tier: "default",
      model_providers: {
        [provider]: {
          name,
          base_url: normalizedBaseUrl,
          wire_api: "responses",
          requires_openai_auth: false,
          supports_websockets: supportsWebsockets === true,
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

function exclusiveManagedProviders(environment) {
  return managedProviderDefinitions(environment).filter((definition) =>
    readManagedMarker(environment, definition)?.mode === "exclusive");
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
  const prefix = `model_providers.${provider}.base_url=`;
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
  return [
    ...kept,
    "-c",
    `model_providers.${provider}.base_url=${JSON.stringify(baseUrl)}`,
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
  const managed = loadManagedProviderProfileFor(
    environment,
    opencodeGoProviderDefinition,
  );
  if (managed !== undefined) return managed.apiKey;
  const configPath = join(codexHomePath(environment), "config.toml");
  return readProviderProfile(
    configPath,
    providerDescriptor(opencodeGoProviderDefinition),
    { requireSelection: false },
  ).apiKey;
}

export function loadOpencodeGoAccountCredentialFor(provider, environment = process.env) {
  if (provider === undefined) {
    return loadOpencodeGoAccountCredential(environment);
  }
  const definition = findManagedProviderDefinition(environment, provider);
  if (!definition) {
    // 默认账户在账户注册表出现前使用旧版单 Provider 布局。
    if (provider === "opencode-go") {
      return loadOpencodeGoAccountCredential(environment);
    }
    throw new Error(`未知 OpenCode Go 账户：${provider}`);
  }
  const managed = loadManagedProviderProfileFor(environment, definition);
  if (managed !== undefined) return managed.apiKey;
  const profile = loadConfiguredProviderProfile(environment, definition);
  if (!profile) throw new Error(`OpenCode Go 账户尚未配置：${provider}`);
  return profile.apiKey;
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
  if (!definition.models.some((candidate) => candidate.slug === selectedModel && candidate.available)) {
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
  const lines = [
    `model = ${tomlString(selectedModel)}`,
    `model_provider = ${tomlString(candidate.provider)}`,
    `model_reasoning_effort = ${tomlString(candidate.reasoningEffort)}`,
    `developer_instructions = ${tomlString(
      "你是第三方模型单次子代理。此角色只用于 fork_turns=1 的一次性任务：把继承上下文中最后一条用户消息视为完整任务并直接执行；不要尝试解析 encrypted_content，不等待或请求后续消息，也不要调用子代理通信工具。若最后一条用户消息仍不足以确定任务，只返回一句明确错误。",
    )}`,
    "",
    `[model_providers.${candidate.provider}]`,
    `name = ${tomlString(candidate.displayName)}`,
    `base_url = ${tomlString(url)}`,
    'wire_api = "responses"',
    `env_key = ${tomlString(candidate.apiKeyEnvironmentKey)}`,
    `supports_websockets = ${candidate.supportsWebsockets}`,
    "requires_openai_auth = false",
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

function validThirdPartyRoleReasoningEffort(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && thirdPartyRoleReasoningEffortPattern.test(value);
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

function loadManagedProviderProfileFor(
  environment,
  definition,
  { requireLaunchConfig = false } = {},
) {
  const codexHome = codexHomePath(environment);
  const marker = readManagedMarker(environment, definition);
  if (!marker || marker.mode === "exclusive") return undefined;
  const descriptor = providerDescriptor(definition);
  const expectedCatalogPath = join(
    managedProviderDirectory(environment, definition),
    definition.catalogFileName,
  );
  const profile = readProviderProfile(join(codexHome, descriptor.profileName), descriptor, {
    ...(requireLaunchConfig
      ? {
          expectedCatalogPath,
          reasoningEffortPolicy: "mirror",
        }
      : {}),
  });
  if (requireLaunchConfig) {
    validateModelCatalog(profile.catalogPath, definition, profile.model);
  }
  return profile;
}

function loadManagedProviderProfiles(environment, { requireLaunchConfig = false } = {}) {
  const codexHome = codexHomePath(environment);
  return managedProviderDefinitions(environment).flatMap((definition) => {
    const marker = readManagedMarker(environment, definition);
    if (!marker || marker.mode === "exclusive") return [];
    const descriptor = providerDescriptor(definition);
    const expectedCatalogPath = join(
      managedProviderDirectory(environment, definition),
      definition.catalogFileName,
    );
    const profile = readProviderProfile(join(codexHome, descriptor.profileName), descriptor, {
      ...(requireLaunchConfig
        ? {
            expectedCatalogPath,
            reasoningEffortPolicy: "mirror",
          }
        : {}),
    });
    if (requireLaunchConfig) {
      validateModelCatalog(profile.catalogPath, definition, profile.model);
    }
    return [profile];
  });
}

function loadConfiguredProviderProfile(environment, definition) {
  const codexHome = codexHomePath(environment);
  const marker = readManagedMarker(environment, definition);
  if (!marker) return undefined;
  const descriptor = providerDescriptor(definition);
  const expectedCatalogPath = join(
    managedProviderDirectory(environment, definition),
    definition.catalogFileName,
  );
  const profilePath = marker.mode === "exclusive"
    ? join(codexHome, "config.toml")
    : join(codexHome, descriptor.profileName);
  const profile = readProviderProfile(profilePath, descriptor, {
    expectedCatalogPath,
    reasoningEffortPolicy: marker.mode === "switching" ? "mirror" : "absent",
  });
  validateModelCatalog(profile.catalogPath, definition, profile.model);
  return { ...profile, mode: marker.mode };
}

function readProviderProfile(
  path,
  descriptor,
  {
    requireSelection = true,
    expectedCatalogPath,
    reasoningEffortPolicy = "absent",
  } = {},
) {
  let document;
  try {
    document = record(parse(readPrivateFile(path)));
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    // TOML 解析错误可能包含带 API Key 的原始配置行，不能作为 cause 暴露。
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Codex 模型提供商配置无法安全读取");
  }
  if (
    requireSelection
    && (
      !descriptor.definition.models.some(({ slug, available }) =>
        available && slug === document.model)
      || document.model_provider !== descriptor.id
    )
  ) {
    throw new Error(`Codex ${descriptor.definition.displayName} Profile 未选择受支持模型`);
  }
  const selectedModel = expectedCatalogPath === undefined
    ? undefined
    : readModelCatalogSetting(
        expectedCatalogPath,
        descriptor.definition,
        document.model,
      );
  if (
    expectedCatalogPath !== undefined
    && (
      document.model_catalog_json !== expectedCatalogPath
      || reasoningEffortMismatch(document, selectedModel, reasoningEffortPolicy)
      || document.model_context_window !== undefined
      || document.model_auto_compact_token_limit !== undefined
      || document.model_auto_compact_token_limit_scope !== undefined
    )
  ) {
    throw new Error(`Codex ${descriptor.definition.displayName} Profile 模型目录或思考等级无效`);
  }
  const provider = record(record(document.model_providers)[descriptor.id]);
  if (
    provider.name !== descriptor.id
    || provider.base_url !== descriptor.baseUrl
    || provider.wire_api !== descriptor.wireApi
    || provider.requires_openai_auth !== false
    || (descriptor.definition.supportsWebsockets !== undefined
      && provider.supports_websockets !== descriptor.definition.supportsWebsockets)
  ) {
    throw new Error(`Codex ${descriptor.definition.displayName} 提供商配置无效`);
  }
  const apiKey = provider.experimental_bearer_token;
  if (
    typeof apiKey !== "string"
    || !/^sk-[^\s"]+$/u.test(apiKey)
    || apiKey.length > 4_096
    || /[\r\n]/u.test(apiKey)
  ) {
    throw new Error(`Codex ${descriptor.definition.displayName} API Key 缺失或无效`);
  }
  const autoCompactLimit = selectedModel?.autoCompactLimit;
  return {
    provider: descriptor.id,
    model: document.model,
    reasoningEffort: reasoningEffortPolicy === "mirror"
      ? document.model_reasoning_effort
      : selectedModel?.reasoningEffort,
    catalogPath: document.model_catalog_json,
    name: descriptor.id,
    baseUrl: descriptor.baseUrl,
    wireApi: descriptor.wireApi,
    apiKeyEnvironmentKey: descriptor.definition.apiKeyEnvironmentKey,
    supportsWebsockets: descriptor.definition.supportsWebsockets,
    apiKey,
    ...(autoCompactLimit === undefined
      ? {}
      : {
          autoCompactLimit,
          autoCompactScope: "total",
        }),
  };
}

// 切换模式 Profile 必须镜像所选模型的目录默认思考等级（"mirror"）；
// 固定模式基础配置不得携带该字段（"absent"）；
// 写入器预读允许暂缺，以便为旧 Profile 补写镜像（"ignore"）。
function reasoningEffortMismatch(document, selectedModel, reasoningEffortPolicy) {
  switch (reasoningEffortPolicy) {
    case "mirror":
      return document.model_reasoning_effort !== selectedModel.reasoningEffort;
    case "ignore":
      return false;
    default:
      return document.model_reasoning_effort !== undefined;
  }
}

function readPrivateFile(path, maximumBytes = maximumConfigBytes) {
  return readPrivateFileSync(path, maximumBytes);
}

function readCodexConfigFile(path) {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(realpathSync(path), constants.O_RDONLY | noFollow);
  try {
    const metadata = fstatSync(descriptor);
    const currentUid = process.getuid?.();
    if (
      !metadata.isFile()
      || metadata.size > maximumConfigBytes
      || (currentUid !== undefined && metadata.uid !== currentUid)
    ) {
      throw new Error("Codex 配置文件权限、类型或大小无效");
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function validateModelCatalog(path, definition, model = definition.defaultModel) {
  readModelCatalogSetting(path, definition, model);
}

function loadModelCatalogSettings(path, definition) {
  const content = readPrivateFile(path, maximumCatalogBytes);
  let catalog;
  try {
    catalog = JSON.parse(content);
  } catch {
    throw new Error(`Codex ${definition.displayName} 模型目录无法安全读取`);
  }
  const presentModels = new Set(
    Array.isArray(catalog?.models)
      ? catalog.models.flatMap((entry) => {
          const slug = record(entry).slug;
          return typeof slug === "string" ? [slug] : [];
        })
      : [],
  );
  return definition.models.flatMap(({ slug, available }) => {
    if (!available || !presentModels.has(slug)) return [];
    return [modelCatalogSetting(content, definition, slug)];
  });
}

function readModelCatalogSetting(path, definition, model) {
  try {
    return modelCatalogSetting(
      readPrivateFile(path, maximumCatalogBytes),
      definition,
      model,
    );
  } catch {
    throw new Error(`Codex ${definition.displayName} 模型目录无法安全读取`);
  }
}

function modelCatalogSetting(content, definition, model) {
  let catalog;
  try {
    catalog = JSON.parse(content);
  } catch {
    throw new Error(`Codex ${definition.displayName} 模型目录无法安全读取`);
  }
  const candidate = Array.isArray(catalog?.models)
    ? catalog.models.find((entry) => record(entry).slug === model)
    : undefined;
  const document = record(candidate);
  const contextWindow = document.context_window;
  const levels = Array.isArray(document.supported_reasoning_levels)
    ? document.supported_reasoning_levels
    : [];
  const reasoningEfforts = levels.flatMap((entry) => {
    const level = record(entry);
    return typeof level.effort === "string" && typeof level.description === "string"
      ? [{ effort: level.effort, description: level.description }]
      : [];
  });
  const reasoningEffort = document.default_reasoning_level;
  const autoCompactLimit = document.auto_compact_token_limit;
  if (
    !definition.models.some(({ slug, available }) => available && slug === model)
    || !Number.isSafeInteger(contextWindow)
    || contextWindow <= 0
    || reasoningEfforts.length === 0
    || typeof reasoningEffort !== "string"
    || !reasoningEfforts.some(({ effort }) => effort === reasoningEffort)
    || (autoCompactLimit !== null && autoCompactLimit !== undefined
      && (!Number.isSafeInteger(autoCompactLimit)
        || autoCompactLimit <= 0
        || autoCompactLimit > contextWindow))
  ) {
    throw new Error(`Codex ${definition.displayName} 模型目录无效`);
  }
  return {
    model,
    displayName: typeof document.display_name === "string" ? document.display_name : model,
    contextWindow,
    reasoningEffort,
    reasoningEfforts,
    ...(autoCompactLimit === null || autoCompactLimit === undefined
      ? {}
      : {
          autoCompactLimit,
          autoCompactPercent: Math.round(autoCompactLimit * 100 / contextWindow),
        }),
  };
}

function updateModelCatalogSettings(content, definition, settings) {
  let catalog;
  try {
    catalog = JSON.parse(content);
  } catch {
    throw new Error(`Codex ${definition.displayName} 模型目录无法安全读取`);
  }
  const models = Array.isArray(catalog?.models) ? [...catalog.models] : [];
  const index = models.findIndex((entry) => record(entry).slug === settings.model);
  if (index < 0) throw new Error(`Codex ${definition.displayName} 模型目录无效`);
  const current = modelCatalogSetting(content, definition, settings.model);
  if (!current.reasoningEfforts.some(({ effort }) => effort === settings.reasoningEffort)) {
    throw new Error(`${definition.displayName} 模型不支持思考等级：${settings.reasoningEffort}`);
  }
  if (
    settings.autoCompactLimit !== undefined
    && (!Number.isSafeInteger(settings.autoCompactLimit)
      || settings.autoCompactLimit <= 0
      || settings.autoCompactLimit > Math.floor(current.contextWindow * 0.9))
  ) {
    throw new Error(`${definition.displayName} 模型自动压缩阈值无效`);
  }
  models[index] = {
    ...record(models[index]),
    default_reasoning_level: settings.reasoningEffort,
    auto_compact_token_limit: settings.autoCompactLimit ?? null,
  };
  return `${JSON.stringify({ ...catalog, models }, null, 2)}\n`;
}

function validateManagedModelSettings(definition, settings) {
  if (
    !settings
    || typeof settings.model !== "string"
    || typeof settings.reasoningEffort !== "string"
    || !definition.models.some(
      ({ slug, available }) => available && slug === settings.model,
    )
  ) {
    throw new Error(`${definition.displayName} 模型设置无效`);
  }
}

function readManagedMarker(environment, definition) {
  const markerPath = managedProviderMarkerPath(environment, definition);
  let marker;
  try {
    marker = record(parse(readPrivateFile(markerPath)));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    // TOML 解析错误可能包含带 API Key 的原始配置行，不能作为 cause 暴露。
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Codex Connect 模型 Provider 标记无法安全读取");
  }
  if (
    marker.version !== 1
    || marker.provider !== definition.id
    || ![undefined, "switching", "exclusive"].includes(marker.mode)
  ) {
    throw new Error("Codex Connect 模型 Provider 标记无效");
  }
  return {
    provider: marker.provider,
    mode: marker.mode ?? "switching",
  };
}

function managedProviderDefinitions(environment) {
  return loadManagedModelProviderDefinitions(environment);
}

function findManagedProviderDefinition(environment, provider) {
  if (provider === undefined) return undefined;
  return managedProviderDefinitions(environment).find(
    (candidate) => candidate.id === provider,
  );
}

function providerDescriptor(definition) {
  return Object.freeze({
    definition,
    id: definition.id,
    profileName: definition.profileFileName,
    baseUrl: definition.baseUrl,
    wireApi: definition.wireApi,
  });
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
