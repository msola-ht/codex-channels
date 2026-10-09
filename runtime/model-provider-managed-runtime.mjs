import { clinePassAccountMarkerPath, clinePassAccountsFilePath, isClinePassAccountProvider } from "./cline-pass-accounts.mjs";
import { createHash } from "node:crypto";
import { writeResponsesContextFollowers, clinePassFollowsDeepseekContext } from "./responses-context-sync.mjs";
import { assertResponsesContextSyncComplete, responsesContextSyncPath } from "./model-provider-responses-catalog.mjs";
import { join, resolve } from "node:path";

import { parse, stringify } from "smol-toml";

import { codexHomePath } from "./codex-home.mjs";
import { providerStorageRoot } from "./connect-home.mjs";
import {
  deepseekProviderDefinition,
  isManagedProviderModelValid,
  isManagedProviderApiKeyValid,
  loadManagedModelProviderDefinitions,
} from "./model-provider-definitions.mjs";
import { opencodeGoAccountMarkerPath, opencodeGoAccountsFilePath } from "./opencode-go-accounts.mjs";
import { deepseekAccountMarkerPath, deepseekAccountsFilePath } from "./deepseek-accounts.mjs";
import { ccgAccountMarkerPath, ccgAccountsFilePath } from "./ccg-accounts.mjs";
import { readPrivateFileSync, writePrivateFileAtomicSync } from "./private-file.mjs";
import { assertProviderHasNoPlaintextCredentials, createProviderFileReader, readCodexConfigFile } from "./provider-file-access.mjs";
export { readCodexConfigFile } from "./provider-file-access.mjs";
import { managedPrimaryCredentialPath, readManagedPrimaryCredential } from "./managed-provider-credentials.mjs";

const maximumConfigBytes = 1_048_576;
const maximumCatalogBytes = 2_097_152;

export function managedProviderDirectory(environment, definition) {
  return join(providerStorageRoot(environment), definition.storageId ?? definition.id);
}

export function managedProviderMarkerPath(environment, definition) {
  if (definition.accountId !== undefined) {
    if (definition.storageId === "clp") return clinePassAccountMarkerPath(environment, definition.accountId);
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
  assertResponsesContextSyncComplete(environment);
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
  assertResponsesContextSyncComplete(environment);
  return managedProviderDefinitions(environment).flatMap((definition) => {
    const marker = readManagedMarker(environment, definition);
    if (!marker) return [];
    const profile = loadConfiguredProviderProfile(environment, definition, {
      tolerateMissingModel: true,
      readCredential: false,
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
  const clineFollows = clinePassFollowsDeepseekContext(environment);
  const bySlug = new Map();
  for (const provider of providers) {
    for (const model of provider.models ?? []) {
      const slug = clineFollows && isClinePassAccountProvider(provider.provider)
        && model.model === "cline-pass/deepseek-v4.1-flash" ? "deepseek-flash" : model.model;
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
    environment,
    reasoningEffortPolicy: "ignore",
    tolerateMissingModel: true,
  });
  const previousCatalog = readPrivateFile(profile.catalogPath, maximumCatalogBytes);
  const nextCatalog = updateModelCatalogSettings(previousCatalog, definition, settings);
  const previousProfile = readPrivateFile(profilePath);
  const document = record(parse(previousProfile));
  document.model = model;
  document.model_reasoning_effort = settings.reasoningEffort;
  delete document.model_context_window;
  delete document.model_auto_compact_token_limit;
  delete document.model_auto_compact_token_limit_scope;
  writeCatalogWithProfileMirrors(environment, profile.catalogPath, nextCatalog,
    new Map([[profilePath, stringify(document)]]), new Map([[profile.catalogPath,previousCatalog],[profilePath,previousProfile]]),model);
  readProviderProfile(profilePath, descriptor, {
    expectedCatalogPath,
    environment,
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
  writeCatalogWithProfileMirrors(environment, path,
    updateModelCatalogSettings(previousContent, definition, settings), new Map(), new Map([[path,previousContent]]),settings.model);
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
  const { path } = managedProviderCatalogPath(provider, environment);
  writeCatalogWithProfileMirrors(environment, path, content);
}

function writeCatalogWithProfileMirrors(environment, catalogPath, content, updates = new Map(), originals = new Map(), targetModel) {
  collectCatalogWithProfileMirrors(environment, catalogPath, content, updates, originals);
  writeCatalogUpdates(environment, updates, originals, targetModel);
}

function collectCatalogWithProfileMirrors(environment, catalogPath, content, updates, originals) {
  if (!originals.has(catalogPath)) originals.set(catalogPath,readPrivateFile(catalogPath,maximumCatalogBytes));
  updates.set(catalogPath, content);
  // 账户 Profile 镜像目录默认值；角色独立选择模型与思考等级。
  const catalog = JSON.parse(content);
  for (const sibling of managedProviderDefinitions(environment)) {
    if (join(managedProviderDirectory(environment, sibling), sibling.catalogFileName) !== catalogPath
      || readManagedMarker(environment, sibling)?.mode !== "switching") continue;
    const path = join(codexHomePath(environment), sibling.profileFileName);
    if (updates.has(path)) continue;
    const previousProfile=readPrivateFile(path);
    originals.set(path,previousProfile);
    const document = record(parse(previousProfile));
    const model = catalog.models.find((entry) => entry.slug === document.model);
    if (!model) throw new Error(`${sibling.displayName} 目录不支持当前模型`);
    document.model_reasoning_effort = model.default_reasoning_level;
    updates.set(path, stringify(document));
  }
}

function writeCatalogUpdates(environment, updates, originals, targetModel) {
  assertResponsesContextSyncComplete(environment);
  if (writeResponsesContextFollowers(updates, environment, originals, targetModel)) return;
  for (const path of updates.keys()) {
    if (!originals.has(path)) originals.set(path,readPrivateFile(path,maximumCatalogBytes));
    if (readPrivateFile(path,maximumCatalogBytes) !== originals.get(path)) throw new Error("模型目录或 Profile 已变化，请重新预览");
  }
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
  const clineFollows = clinePassFollowsDeepseekContext(environment);
  const localModel = provider => clineFollows && isClinePassAccountProvider(provider.provider) && model === "deepseek-flash"
    ? "cline-pass/deepseek-v4.1-flash" : model;
  const matches = providers.filter((provider) =>
    (provider.models ?? []).some((candidate) => candidate.model === localModel(provider)));
  if (matches.length === 0) {
    throw new Error(`未找到已配置模型：${model}`);
  }
  const bases = matches.map((provider) =>
    provider.models.find((entry) => entry.model === localModel(provider))?.maxContextWindow);
  const base = bases[0];
  if (
    !Number.isSafeInteger(base)
    || base <= 0
    || bases.some((value) => value !== base)
  ) {
    throw new Error(`同名模型在不同 Provider 的最大上下文窗口不一致：${model}`);
  }
  const contextWindow = Math.round(base * windowPercent / 100);
  const updates = new Map();
  const originals = new Map();
  const overridden = [];
  for (const provider of matches) {
    const modelEntry = provider.models.find((entry) => entry.model === localModel(provider));
    if (modelEntry?.windowPercent !== undefined && modelEntry.windowPercent !== windowPercent) {
      overridden.push({provider: provider.provider, previousPercent: modelEntry.windowPercent});
    }
    const { definition, path } = managedProviderCatalogPath(provider.provider, environment);
    // 多个账户共享同一目录；每个目录及其 Profile 只计划和写入一次。
    if (updates.has(path)) continue;
    const settings = {
      model: localModel(provider),
      reasoningEffort: modelEntry?.reasoningEffort ?? provider.reasoningEffort,
      contextWindow,
    };
    validateManagedModelSettings(definition, settings);
    const previous = readPrivateFile(path, maximumCatalogBytes);
    originals.set(path, previous);
    collectCatalogWithProfileMirrors(environment, path,
      updateModelCatalogSettings(previous, definition, settings), updates, originals);
  }
  // Cline can own the first configuration while the shared DS template has no account yet.
  if (clineFollows && model === "deepseek-flash") {
    const path = join(managedProviderDirectory(environment, deepseekProviderDefinition), deepseekProviderDefinition.catalogFileName);
    if (!updates.has(path)) {
      const previous = readPrivateFile(path, maximumCatalogBytes);
      const sourceModel = modelCatalogSetting(previous, deepseekProviderDefinition, model);
      originals.set(path, previous);
      collectCatalogWithProfileMirrors(environment, path, updateModelCatalogSettings(previous, deepseekProviderDefinition, {
        model, contextWindow, reasoningEffort: sourceModel.reasoningEffort,
      }), updates, originals);
    }
  }
  // 全部受管目录、Profile 与 RS 跟随目录共享一次提交和原始快照回滚。
  writeCatalogUpdates(environment, updates, originals, model);
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
    environment,
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
  assertResponsesContextSyncComplete(environment);
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
      environment,
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
  { tolerateMissingModel = false, readCredential = true } = {},
) {
  const codexHome = codexHomePath(environment);
  const marker = readManagedMarker(environment, definition);
  if (!marker) return undefined;
  const descriptor = providerDescriptor(definition);
  const expectedCatalogPath = join(
    managedProviderDirectory(environment, definition),
    definition.catalogFileName,
  );
  const profilePath = configuredProfilePath(codexHome, descriptor, marker.mode);
  const profile = readProviderProfile(profilePath, descriptor, {
    expectedCatalogPath,
    reasoningEffortPolicy: marker.mode === "switching" ? "mirror" : "absent",
    environment,
    tolerateMissingModel,
    readCredential,
  });
  if (!tolerateMissingModel) {
    validateModelCatalog(profile.catalogPath, definition, profile.model);
  }
  return { ...profile, mode: marker.mode };
}

function configuredProfilePath(codexHome, descriptor, mode) {
  return join(codexHome, mode === "exclusive" ? "config.toml" : descriptor.profileName);
}

/** Relay shares the account credential, never its Codex model selection or catalog. */
export function loadConfiguredManagedProviderCredentials(provider, environment = process.env) {
  const definition = findManagedProviderDefinition(environment, provider);
  if (!definition || !isClinePassAccountProvider(provider)) throw new Error("Relay CLP account is not registered");
  const marker = readManagedMarker(environment, definition);
  if (!marker) throw new Error("Relay CLP account marker is missing");
  const descriptor = providerDescriptor(definition);
  const profilePath = configuredProfilePath(codexHomePath(environment), descriptor, marker.mode);
  const paths = [clinePassAccountsFilePath(environment), managedProviderMarkerPath(environment, definition), profilePath];
  const credentialKey = addManagedCredentialMaterialPath(paths, profilePath, environment, definition);
  const fingerprint = () => {
    const hash = createHash("sha256");
    const read = createProviderFileReader(environment);
    for (const path of paths) hash.update(JSON.stringify([path, read(path, maximumConfigBytes)]));
    return hash.digest("hex");
  };
  const before = fingerprint();
  const profile = readProviderProfile(profilePath, descriptor, { requireSelection: false, environment });
  if (profile.apiKeyEnvironmentKey !== (credentialKey ?? definition.apiKeyEnvironmentKey)
    || fingerprint() !== before || !findManagedProviderDefinition(environment, provider)
    || readManagedMarker(environment, definition)?.mode !== marker.mode) throw new Error("Relay CLP account changed during read");
  return { provider, baseUrl: profile.baseUrl, apiKey: profile.apiKey, paths,
    revision: createHash("sha256").update(JSON.stringify([provider, profile.baseUrl, profile.apiKey])).digest("hex") };
}

/** Narrow read-only native model material snapshot. All paths and credential parsing remain in the managed provider owner. */
export function loadConfiguredManagedProviderMaterial(provider, environment = process.env) {
  assertResponsesContextSyncComplete(environment);
  const definition = findManagedProviderDefinition(environment, provider);
  if (!definition) {
    throw new Error("Relay Provider 尚未注册");
  }
  const marker = readManagedMarker(environment, definition);
  if (!marker) throw new Error("Relay Provider 管理标记不存在");
  const directory = managedProviderDirectory(environment, definition);
  const registry = { clp: clinePassAccountsFilePath, deepseek: deepseekAccountsFilePath, "opencode-go": opencodeGoAccountsFilePath, ccg: ccgAccountsFilePath }[definition.storageId ?? definition.id];
  if (!registry) throw new Error("Relay Provider 注册材料不受支持");
  const paths = [registry(environment), managedProviderMarkerPath(environment, definition),
    configuredProfilePath(codexHomePath(environment), providerDescriptor(definition), marker.mode),
    join(directory, definition.catalogFileName), join(directory, definition.catalogManifestFileName)];
  const credentialKey = addManagedCredentialMaterialPath(paths, paths[2], environment, definition);
  const fingerprint = () => {
    const hash = createHash("sha256");
    const read = createProviderFileReader(environment);
    for (const path of paths) hash.update(JSON.stringify([path, read(path, maximumCatalogBytes)]));
    return hash.digest("hex");
  };
  const before = fingerprint();
  const profile = loadConfiguredProviderProfile(environment, definition);
  if (!profile) throw new Error("Relay Provider 已撤销");
  const settings = loadModelCatalogSettings(profile.catalogPath, definition);
  const models = settings.map(model => model.model);
  const modelInputs = Object.fromEntries(settings.map(model => [model.model, model.inputModalities]));
  if (profile.apiKeyEnvironmentKey !== (credentialKey ?? definition.apiKeyEnvironmentKey)
    || fingerprint() !== before) throw new Error("Relay Provider 材料读取期间发生变化");
  if (!findManagedProviderDefinition(environment, provider) || readManagedMarker(environment, definition)?.mode !== marker.mode) {
    throw new Error("Relay Provider 账户或模式读取期间发生变化");
  }
  assertResponsesContextSyncComplete(environment);
  const protocols = definition.upstreamWireApi === "chat_completions" ? ["chat"]
    : definition.storageId === "deepseek" ? ["chat", "responses"] : ["responses"];
  return { provider, baseUrl: profile.baseUrl, apiKey: profile.apiKey, models, modelInputs, protocols,
    paths: [...paths, responsesContextSyncPath(environment)], revision: before };
}

export function readProviderProfile(
  path,
  descriptor,
  {
    requireSelection = true,
    expectedCatalogPath,
    reasoningEffortPolicy = "absent",
    tolerateMissingModel = false,
    environment,
    readCredential = true,
  } = {},
) {
  let document;
  try {
    document = record(parse(createProviderFileReader(environment)(path, maximumConfigBytes)));
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
  const mainPath = resolve(join(codexHomePath(environment), "config.toml"));
  const selectedPath = resolve(path);
  const isMain = process.platform === "win32" ? mainPath.toLowerCase() === selectedPath.toLowerCase() : mainPath === selectedPath;
  if (readCredential && isMain) assertProviderHasNoPlaintextCredentials(provider);
  if (readCredential && provider.env_key !== undefined && provider.experimental_bearer_token !== undefined) {
    throw new Error("受管 Provider 凭据配置存在歧义");
  }
  if (readCredential && isMain && provider.experimental_bearer_token !== undefined) {
    throw new Error("受管固定 Provider 使用不安全的明文凭据；请显式重新配置账户后重启 App Server");
  }
  if (readCredential && !isMain && provider.env_key !== undefined) throw new Error("受管切换 Provider 凭据配置无效");
  const apiKey = !readCredential ? undefined : isMain && provider.env_key !== undefined
    ? readManagedPrimaryCredential(environment, descriptor.definition, provider.env_key)
    : provider.experimental_bearer_token;
  if (
    readCredential && !isManagedProviderApiKeyValid(descriptor.definition, apiKey)
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
    apiKeyEnvironmentKey: isMain && provider.env_key !== undefined ? provider.env_key : descriptor.definition.apiKeyEnvironmentKey,
    supportsWebsockets: descriptor.definition.supportsWebsockets,
    ...(descriptor.definition.webSearch ? { webSearch: descriptor.definition.webSearch } : {}),
    apiKey,
  };
}

function addManagedCredentialMaterialPath(paths, profilePath, environment, definition) {
  let config;
  try { config = record(parse(createProviderFileReader(environment)(profilePath, maximumConfigBytes))); }
  catch { throw new Error("受管 Provider 凭据引用无法安全读取"); }
  const key = record(record(config.model_providers)[definition.id]).env_key;
  if (key !== undefined) paths.push(managedPrimaryCredentialPath(environment, definition, key));
  return key;
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

// 目录刷新允许原选中模型已下架；目录本身不可读或条目无效仍然失败关闭。
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
  const compactThreshold = document.auto_compact_token_limit;
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
    || (compactThreshold !== null && compactThreshold !== undefined
      && (!Number.isSafeInteger(compactThreshold) || compactThreshold <= 0))
  ) {
    throw new Error(`Codex ${definition.displayName} 模型目录无效`);
  }
  const windowBase = maxContextWindow === null || maxContextWindow === undefined
    ? contextWindow
    : maxContextWindow;
  return {
    model,
    inputModalities: Array.isArray(document.input_modalities) ? document.input_modalities : [],
    displayName: typeof document.display_name === "string" ? document.display_name : model,
    contextWindow,
    maxContextWindow: windowBase,
    reasoningEffort,
    reasoningEfforts,
    windowPercent: Math.round(contextWindow * 100 / windowBase),
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
          // 最大窗口是可选字段；首次修改时保存基准，避免后续按缩小后的窗口计算。
          max_context_window: current.maxContextWindow,
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
