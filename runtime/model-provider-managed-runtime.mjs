import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";

import { parse, stringify } from "smol-toml";

import { codexHomePath } from "./codex-home.mjs";
import { providerStorageRoot } from "./connect-home.mjs";
import {
  isManagedProviderModelValid,
  isManagedProviderApiKeyValid,
  loadManagedModelProviderDefinitions,
} from "./model-provider-definitions.mjs";
import { opencodeGoAccountMarkerPath } from "./opencode-go-accounts.mjs";
import { deepseekAccountMarkerPath } from "./deepseek-accounts.mjs";
import { ccgAccountMarkerPath } from "./ccg-accounts.mjs";
import { readPrivateFileSync, writePrivateFileAtomicSync } from "./private-file.mjs";

const maximumConfigBytes = 1_048_576;
const maximumCatalogBytes = 2_097_152;
const managedThirdPartyRoleName = "external";
const managedThirdPartyRoleConfigFileName = "sf-agent.config.toml";

export function managedProviderDirectory(environment, definition) {
  return join(providerStorageRoot(environment), definition.storageId ?? definition.id);
}

export function managedProviderMarkerPath(environment, definition) {
  if (definition.accountId !== undefined) {
    if (definition.storageId === "deepseek") {
      return deepseekAccountMarkerPath(environment, definition.accountId);
    }
    if (definition.storageId === "ccg") {
      return ccgAccountMarkerPath(environment, definition.accountId);
    }
    return opencodeGoAccountMarkerPath(environment, definition.accountId);
  }
  return join(
    managedProviderDirectory(environment, definition),
    definition.managedMarkerFileName,
  );
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
    const profile = loadConfiguredProviderProfile(environment, definition, {
      tolerateMissingModel: true,
    });
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

// 按模型 slug 聚合所有已配置 Provider 的上下文窗口设置。
// 同名模型在多个 Provider（如 DeepSeek 与 OpenCode Go 各账户）中存在时，
// 只保留一份权威值：任一 Provider 设置了非空 windowPercent 即作为全局值，
// 全部未设置时省略该字段（目录里的官方窗口保持不变）。
export function loadManagedModelWindow(environment = process.env) {
  const providers = loadManagedModelProviderSettings(environment);
  const bySlug = new Map();
  for (const provider of providers) {
    for (const model of provider.models ?? []) {
      const slug = model.model;
      if (typeof slug !== "string" || slug === "") continue;
      const percent = model.windowPercent;
      const existing = bySlug.get(slug);
      if (existing === undefined) {
        bySlug.set(slug, {
          model: slug,
          displayName: model.displayName ?? slug,
          contextWindow: model.contextWindow,
          maxContextWindow: model.maxContextWindow,
          reasoningEfforts: model.reasoningEfforts ?? [],
          windowPercent: percent,
          providers: [provider.provider],
          perProvider: { [provider.provider]: percent },
          conflicts: false,
          windowConflict: false,
        });
        continue;
      }
      if (
        existing.windowPercent === undefined
        && percent !== undefined
      ) {
        existing.windowPercent = percent;
      }
      if (!existing.providers.includes(provider.provider)) {
        existing.providers.push(provider.provider);
      }
      existing.perProvider[provider.provider] = percent;
      const committed = Object.values(existing.perProvider).filter(
        (value) => value !== undefined,
      );
      if (
        committed.some((value) => value !== committed[0])
      ) {
        existing.conflicts = true;
      }
      if (
        existing.maxContextWindow !== model.maxContextWindow
      ) {
        existing.windowConflict = true;
      }
    }
  }
  return [...bySlug.values()];
}

// 读取官方主配置的上下文窗口与自动压缩覆盖值；未设置或读取失败返回 null。
// 只用于展示与完成卡片，不参与 Provider 路由。
export function readCodexConfigModelOverride(environment = process.env) {
  const path = join(codexHomePath(environment), "config.toml");
  let document;
  try {
    document = record(parse(readCodexConfigFile(path)));
  } catch {
    return { contextWindow: null, autoCompactTokenLimit: null };
  }
  return {
    contextWindow: safeConfigInteger(document.model_context_window),
    autoCompactTokenLimit: safeConfigInteger(document.model_auto_compact_token_limit),
  };
}

function safeConfigInteger(value) {
  if (value === null || value === undefined) return null;
  const normalized = typeof value === "bigint" ? Number(value) : value;
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
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
    tolerateMissingModel: true,
  });
  const previousCatalog = readPrivateFile(profile.catalogPath, maximumCatalogBytes);
  const nextCatalog = updateModelCatalogSettings(previousCatalog, definition, settings);
  const document = record(parse(readPrivateFile(profilePath)));
  document.model = model;
  document.model_reasoning_effort = settings.reasoningEffort;
  delete document.model_context_window;
  delete document.model_auto_compact_token_limit;
  delete document.model_auto_compact_token_limit_scope;
  writeCatalogWithProfileMirrors(environment, definition, profile.catalogPath, nextCatalog,
    new Map([[profilePath, stringify(document)]]));
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
  const { definition, path } = managedProviderCatalogPath(provider, environment);
  validateManagedModelSettings(definition, settings);
  const previousContent = readPrivateFile(path, maximumCatalogBytes);
  const previous = modelCatalogSetting(previousContent, definition, settings.model);
  writeCatalogWithProfileMirrors(environment, definition, path,
    updateModelCatalogSettings(previousContent, definition, settings));
  return previous;
}

// 读取受管 Provider 模型目录的原始内容，供配置事务在失败时按原样回滚。
export function readManagedModelProviderCatalogContent(provider, environment = process.env) {
  return readPrivateFile(managedProviderCatalogPath(provider, environment).path, maximumCatalogBytes);
}

// 把模型目录写回给定原始内容；只用于回滚，不解析也不改写内容。
export function restoreManagedModelProviderCatalogContent(
  provider,
  content,
  environment = process.env,
) {
  const { definition, path } = managedProviderCatalogPath(provider, environment);
  writeCatalogWithProfileMirrors(environment, definition, path, content);
}

function writeCatalogWithProfileMirrors(environment, definition, catalogPath, content, updates = new Map()) {
  // 同一目录的模型设置由所有引用方共享；Profile 与共享角色只保存所选模型的镜像。
  const catalog = JSON.parse(content);
  for (const sibling of managedProviderDefinitions(environment)) {
    if (join(managedProviderDirectory(environment, sibling), sibling.catalogFileName) !== catalogPath
      || readManagedMarker(environment, sibling)?.mode !== "switching") continue;
    const path = join(codexHomePath(environment), sibling.profileFileName);
    if (updates.has(path)) continue;
    const document = record(parse(readPrivateFile(path)));
    const model = catalog.models.find((entry) => entry.slug === document.model);
    if (!model) throw new Error(`${sibling.displayName} 目录不支持当前模型`);
    document.model_reasoning_effort = model.default_reasoning_level;
    updates.set(path, stringify(document));
  }
  addManagedRoleMirrorUpdate(environment, catalogPath, catalog, updates);
  updates = new Map([[catalogPath, content], ...updates]);
  const originals = new Map([...updates.keys()].map((path) => [path, readPrivateFile(path, maximumCatalogBytes)]));
  const written = [];
  try {
    for (const [path, next] of updates) {
      writePrivateFileAtomicSync(path, next);
      written.push(path);
    }
  } catch (error) {
    const errors = [error];
    for (const path of written.reverse()) {
      try { writePrivateFileAtomicSync(path, originals.get(path)); }
      catch (rollbackError) { errors.push(rollbackError); }
    }
    if (errors.length > 1) throw new AggregateError(errors, "模型目录与引用配置回滚未完成", { cause: error });
    throw error;
  }
}

function addManagedRoleMirrorUpdate(environment, catalogPath, catalog, updates) {
  const rolePath = join(codexHomePath(environment), managedThirdPartyRoleConfigFileName);
  let config;
  let role;
  try {
    config = record(parse(readCodexConfigFile(join(codexHomePath(environment), "config.toml"))));
    if (record(record(config.agents)[managedThirdPartyRoleName]).config_file !== rolePath) return;
    role = record(parse(readPrivateFile(rolePath)));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    // TOML 解析错误可能包含用户配置或角色文件原文，不能作为 cause 暴露。
    // eslint-disable-next-line preserve-caught-error
    throw new Error("第三方子代理角色配置无法安全读取");
  }
  const roleDefinition = findManagedProviderDefinition(environment, role.model_provider);
  if (roleDefinition === undefined
    || join(managedProviderDirectory(environment, roleDefinition), roleDefinition.catalogFileName) !== catalogPath) {
    return;
  }
  const model = catalog.models.find((entry) => entry.slug === role.model);
  if (!model) throw new Error(`${roleDefinition.displayName} 目录不支持共享第三方子代理当前模型`);
  role.model_reasoning_effort = model.default_reasoning_level;
  updates.set(rolePath, stringify(role));
}

function managedProviderCatalogPath(provider, environment) {
  const definition = findManagedProviderDefinition(environment, provider);
  if (!definition) throw new Error(`未知第三方 Provider：${provider}`);
  return {
    definition,
    path: join(
      managedProviderDirectory(environment, definition),
      definition.catalogFileName,
    ),
  };
}

// 按模型 slug 全局写入上下文窗口：百分比相对该模型的 max_context_window 换算，
// 把同一 context_window 广播到所有提供该模型且已配置的 Provider 目录。
// 自动压缩阈值不再写入目录，压缩由上游按窗口默认推导。
export function writeManagedModelWindowGlobal(
  { model, windowPercent, environment = process.env } = {},
) {
  validateWindowPercent(windowPercent);
  const providers = loadManagedModelProviderSettings(environment);
  const matches = providers.filter((provider) =>
    (provider.models ?? []).some((candidate) => candidate.model === model));
  if (matches.length === 0) {
    throw new Error(`未找到已配置模型：${model}`);
  }
  const bases = matches.map((provider) =>
    provider.models.find((entry) => entry.model === model)?.maxContextWindow);
  const base = bases[0];
  if (
    !Number.isSafeInteger(base)
    || base <= 0
    || bases.some((value) => value !== base)
  ) {
    throw new Error(`同名模型在不同 Provider 的最大上下文窗口不一致：${model}`);
  }
  const contextWindow = Math.round(base * windowPercent / 100);
  const previousCatalogs = new Map(matches.map((provider) => [
    provider.provider,
    readManagedModelProviderCatalogContent(provider.provider, environment),
  ]));
  const writtenProviders = [];
  const overridden = [];
  try {
    for (const provider of matches) {
      const modelEntry = provider.models.find((entry) => entry.model === model);
      if (
        modelEntry?.windowPercent !== undefined
        && modelEntry.windowPercent !== windowPercent
      ) {
        overridden.push({
          provider: provider.provider,
          previousPercent: modelEntry.windowPercent,
        });
      }
      writeManagedModelProviderCatalogSettings(
        provider.provider,
        {
          model,
          reasoningEffort: modelEntry?.reasoningEffort ?? provider.reasoningEffort,
          contextWindow,
        },
        environment,
      );
      writtenProviders.push(provider.provider);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const provider of writtenProviders.reverse()) {
      try {
        restoreManagedModelProviderCatalogContent(
          provider,
          previousCatalogs.get(provider),
          environment,
        );
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "模型上下文窗口写入失败，且未能恢复全部 Provider 模型目录",
        { cause: error },
      );
    }
    throw error;
  }
  return {
    model,
    windowPercent,
    contextWindow,
    providers: matches.map((provider) => provider.provider),
    overridden,
  };
}

function validateWindowPercent(windowPercent) {
  if (
    !Number.isInteger(windowPercent)
    || windowPercent < 10
    || windowPercent > 100
  ) {
    throw new Error("模型上下文窗口百分比无效");
  }
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
  const presentModels = catalogSlugSet(catalog, definition);
  let next = catalog;
  for (const previous of previousModels) {
    if (!presentModels.has(previous.model)) continue;
    const current = modelCatalogSetting(JSON.stringify(next), definition, previous.model);
    const reasoningEffort = current.reasoningEfforts.some(
      ({ effort }) => effort === previous.reasoningEffort,
    )
      ? previous.reasoningEffort
      : current.reasoningEffort;
    const contextWindow = previous.windowPercent === undefined
      ? undefined
      : Math.round(current.maxContextWindow * previous.windowPercent / 100);
    next = withManagedModelCatalogSettings(next, definition, {
      model: previous.model,
      reasoningEffort,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    });
  }
  return next;
}


export function loadManagedProviderProfileFor(
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

export function loadManagedProviderProfiles(environment, { requireLaunchConfig = false } = {}) {
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

export function loadConfiguredProviderProfile(
  environment,
  definition,
  { tolerateMissingModel = false } = {},
) {
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
    tolerateMissingModel,
  });
  if (!tolerateMissingModel) {
    validateModelCatalog(profile.catalogPath, definition, profile.model);
  }
  return { ...profile, mode: marker.mode };
}

export function readProviderProfile(
  path,
  descriptor,
  {
    requireSelection = true,
    expectedCatalogPath,
    reasoningEffortPolicy = "absent",
    tolerateMissingModel = false,
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
      typeof document.model !== "string"
      || document.model.length === 0
      || document.model_provider !== descriptor.id
    )
  ) {
    throw new Error(`Codex ${descriptor.definition.displayName} Profile 未选择受支持模型`);
  }
  const selectedModel = expectedCatalogPath === undefined
    ? undefined
    : tolerateMissingModel
      ? readOptionalModelCatalogSetting(
          expectedCatalogPath,
          descriptor.definition,
          document.model,
        )
      : readModelCatalogSetting(
          expectedCatalogPath,
          descriptor.definition,
          document.model,
        );
  if (
    expectedCatalogPath !== undefined
    && (
      document.model_catalog_json !== expectedCatalogPath
      || (selectedModel === undefined
        ? !tolerateMissingModel
        : reasoningEffortMismatch(document, selectedModel, reasoningEffortPolicy))
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
    !isManagedProviderApiKeyValid(descriptor.definition, apiKey)
  ) {
    throw new Error(`Codex ${descriptor.definition.displayName} API Key 缺失或无效`);
  }
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

export function readPrivateFile(path, maximumBytes = maximumConfigBytes) {
  return readPrivateFileSync(path, maximumBytes);
}

export function readCodexConfigFile(path) {
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
  return [...readCatalogSlugSet(content, definition)]
    .map((slug) => modelCatalogSetting(content, definition, slug));
}

function readCatalogSlugSet(content, definition) {
  let catalog;
  try {
    catalog = JSON.parse(content);
  } catch {
    throw new Error(`Codex ${definition.displayName} 模型目录无法安全读取`);
  }
  return catalogSlugSet(catalog, definition);
}

export function catalogHasModel(path, definition, model) {
  return readCatalogSlugSet(
    readPrivateFile(path, maximumCatalogBytes),
    definition,
  ).has(model);
}

function catalogSlugSet(catalog, definition) {
  if (Array.isArray(catalog?.models)
    && catalog.models.some((entry) =>
      !isManagedProviderModelValid(definition, record(entry).slug))) {
    throw new Error(`Codex ${definition.displayName} 模型目录包含无效模型名`);
  }
  return new Set(
    Array.isArray(catalog?.models)
      ? catalog.models.flatMap((entry) => {
          const slug = record(entry).slug;
          return typeof slug === "string" ? [slug] : [];
        })
      : [],
  );
}

export function readModelCatalogSetting(path, definition, model) {
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

// 迁移路径允许选中模型已从官方目录消失；目录本身不可读或条目无效仍然失败关闭。
function readOptionalModelCatalogSetting(path, definition, model) {
  const content = readPrivateFile(path, maximumCatalogBytes);
  let catalog;
  try {
    catalog = JSON.parse(content);
  } catch {
    throw new Error(`Codex ${definition.displayName} 模型目录无法安全读取`);
  }
  if (!catalogSlugSet(catalog, definition).has(model)) return undefined;
  return modelCatalogSetting(content, definition, model);
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
  const maxContextWindow = document.max_context_window;
  const legacyThreshold = document.auto_compact_token_limit;
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
  if (
    !Number.isSafeInteger(contextWindow)
    || contextWindow <= 0
    || reasoningEfforts.length === 0
    || typeof reasoningEffort !== "string"
    || !reasoningEfforts.some(({ effort }) => effort === reasoningEffort)
    || (maxContextWindow !== null && maxContextWindow !== undefined
      && (!Number.isSafeInteger(maxContextWindow) || maxContextWindow <= 0))
    || (legacyThreshold !== null && legacyThreshold !== undefined
      && (!Number.isSafeInteger(legacyThreshold) || legacyThreshold <= 0))
  ) {
    throw new Error(`Codex ${definition.displayName} 模型目录无效`);
  }
  const windowBase = maxContextWindow === null || maxContextWindow === undefined
    ? contextWindow
    : maxContextWindow;
  // v2 之前的目录把百分比写成自动压缩阈值；阈值按同一基准折算为窗口。
  const window = legacyThreshold === null || legacyThreshold === undefined
    ? contextWindow
    : Math.min(legacyThreshold, windowBase);
  return {
    model,
    displayName: typeof document.display_name === "string" ? document.display_name : model,
    contextWindow: window,
    maxContextWindow: windowBase,
    reasoningEffort,
    reasoningEfforts,
    windowPercent: Math.round(window * 100 / windowBase),
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
    settings.contextWindow !== undefined
    && (!Number.isSafeInteger(settings.contextWindow)
      || settings.contextWindow <= 0
      || settings.contextWindow > current.maxContextWindow)
  ) {
    throw new Error(`${definition.displayName} 模型上下文窗口无效`);
  }
  const entry = record(models[index]);
  models[index] = {
    ...entry,
    default_reasoning_level: settings.reasoningEffort,
    // 只有明确请求窗口变更时才写 context_window；其余情况下目录条目保持原样。
    ...(settings.contextWindow === undefined
      ? {}
      : {
          context_window: settings.contextWindow,
          // 缺少最大窗口的旧目录必须保留原始基准，避免下次按缩小后的窗口计算。
          max_context_window: current.maxContextWindow,
          // 旧版本写在目录里的压缩阈值会卡住新窗口，随窗口一并清掉。
          ...(entry.auto_compact_token_limit === undefined
            || entry.auto_compact_token_limit === null
            ? {}
            : { auto_compact_token_limit: null }),
        }),
  };
  return `${JSON.stringify({ ...catalog, models }, null, 2)}\n`;
}

function validateManagedModelSettings(definition, settings) {
  if (
    !settings
    || typeof settings.model !== "string"
    || typeof settings.reasoningEffort !== "string"
  ) {
    throw new Error(`${definition.displayName} 模型设置无效`);
  }
}

export function readManagedMarker(environment, definition) {
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

export function managedProviderDefinitions(environment) {
  return loadManagedModelProviderDefinitions(environment);
}

export function findManagedProviderDefinition(environment, provider) {
  if (provider === undefined) return undefined;
  return managedProviderDefinitions(environment).find(
    (candidate) => candidate.id === provider,
  );
}

export function providerDescriptor(definition) {
  return Object.freeze({
    definition,
    id: definition.id,
    profileName: definition.profileFileName,
    baseUrl: definition.baseUrl,
    wireApi: definition.wireApi,
  });
}

export function tomlString(value) {
  return JSON.stringify(String(value));
}

export function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function exclusiveManagedProviders(environment) {
  return managedProviderDefinitions(environment).filter((definition) =>
    readManagedMarker(environment, definition)?.mode === "exclusive");
}
