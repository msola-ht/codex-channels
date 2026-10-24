import { isClinePassAccountProvider } from "./cline-pass-accounts.mjs";
import { resolveClinePassRequestProfile } from "./chat-reasoning.mjs";
import { validateClinePassProviderOptions } from "./cline-provider-options.mjs";
import { readModelTemplateBindings, validateClinePassCatalogManifest } from "./model-template-bindings.mjs";
import { assertProviderModelRequestPolicy } from "./model-request-policy.mjs";
import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { assertResponsesContextSyncComplete, responsesContextSyncPath } from "./model-provider-responses-catalog.mjs";
import { assertProviderCatalogIsolationComplete, providerCatalogIsolationPath } from "./provider-catalog-isolation.mjs";
import { join } from "node:path";

import { parse, stringify } from "smol-toml";

import { codexHomePath } from "./codex-home.mjs";
import { providerStorageRoot } from "./connect-home.mjs";
import {
  isManagedProviderApiKeyValid,
  loadManagedModelProviderDefinitions,
  managedProviderAccountFamilyForDefinition,
} from "./model-provider-definitions.mjs";
import { readPrivateFileSync, writePrivateFileAtomicSync } from "./private-file.mjs";
import { assertProviderHasNoPlaintextCredentials, createProviderFileAccess, createProviderFileReader, readCodexConfigFile } from "./provider-file-access.mjs";
export { readCodexConfigFile } from "./provider-file-access.mjs";
import { managedPrimaryCredentialPath, readManagedPrimaryCredential } from "./managed-provider-credentials.mjs";
import {
  catalogSlugSet,
  modelCatalogSetting,
  updateModelCatalogSettings,
  validateManagedModelSettings,
} from "./managed-model-catalog.mjs";
export {
  withManagedModelCatalogSettings,
  withPreservedManagedModelCatalogSettings,
} from "./managed-model-catalog.mjs";

const maximumConfigBytes = 1_048_576;
const maximumCatalogBytes = 2_097_152;

export function managedProviderDirectory(environment, definition) {
  return join(providerStorageRoot(environment), definition.storageId ?? definition.id);
}

export function managedProviderMarkerPath(environment, definition) {
  if (definition.accountId !== undefined) {
    const family = managedProviderAccountFamilyForDefinition(definition);
    return family.markerPath(environment, definition.accountId);
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
  assertProviderCatalogIsolationComplete(environment);
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
  assertProviderCatalogIsolationComplete(environment);
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

// 账户各自保留默认模型；目录内的模型设置由同家族账户共享。
export function loadManagedModelWindow(environment = process.env) {
  const configured = loadManagedModelProviderSettings(environment);
  const definitions = managedProviderDefinitions(environment);
  const familyProviders = provider => {
    const definition = definitions.find(entry => entry.id === provider);
    return configured.filter(candidate => definitions.find(entry => entry.id === candidate.provider)?.storageId === definition.storageId)
      .map(candidate => candidate.provider);
  };
  return configured.flatMap(provider =>
    (provider.models ?? []).map(model => ({
      provider: provider.provider,
      model: model.model,
      displayName: model.displayName ?? model.model,
      contextWindow: model.contextWindow,
      maxContextWindow: model.maxContextWindow,
      reasoningEfforts: model.reasoningEfforts ?? [],
      windowPercent: model.windowPercent,
      providers: familyProviders(provider.provider),
    })));
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
    new Map([[profilePath, stringify(document)]]), new Map([[profile.catalogPath,previousCatalog],[profilePath,previousProfile]]));
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
    updateModelCatalogSettings(previousContent, definition, settings), new Map(), new Map([[path,previousContent]]));
  return previous;
}

// 读取受管 Provider 模型目录的原始内容，供配置事务在失败时按原样回滚。
export function readManagedModelProviderCatalogContent(provider, environment = process.env) {
  return readPrivateFile(managedProviderCatalogPath(provider, environment).path, maximumCatalogBytes);
}

// 按原始内容恢复模型目录，并把同家族账户的等级镜像回恢复后的默认值。
export function restoreManagedModelProviderCatalogContent(
  provider,
  content,
  environment = process.env,
) {
  const { path } = managedProviderCatalogPath(provider, environment);
  writeCatalogWithProfileMirrors(environment, path, content);
}

function writeCatalogWithProfileMirrors(environment, catalogPath, content, updates = new Map(), originals = new Map()) {
  collectCatalogWithProfileMirrors(environment, catalogPath, content, updates, originals);
  writeCatalogUpdates(environment, updates, originals, catalogPath);
}

function collectCatalogWithProfileMirrors(environment, catalogPath, content, updates, originals) {
  if (!originals.has(catalogPath)) originals.set(catalogPath, readPrivateFile(catalogPath, maximumCatalogBytes));
  updates.set(catalogPath, content);
  const definition = findManagedProviderDefinitionByCatalog(environment, catalogPath);
  validateSettingsCatalog(content, definition);
  rememberSettingsSnapshot(originals, join(managedProviderDirectory(environment, definition), definition.catalogManifestFileName), environment);
  const family = managedProviderAccountFamilyForDefinition(definition);
  rememberSettingsSnapshot(originals, family.accountsFilePath(environment), environment);
  for (const sibling of managedCatalogDefinitions(environment, catalogPath)) {
    rememberSettingsSnapshot(originals, managedProviderMarkerPath(environment, sibling), environment);
    const marker = readManagedMarker(environment, sibling);
    if (!marker) continue;
    const path = configuredProfilePath(codexHomePath(environment), providerDescriptor(sibling), marker.mode);
    rememberSettingsSnapshot(originals, path, environment);
    readProviderProfile(path, providerDescriptor(sibling), {
      expectedCatalogPath: catalogPath,
      environment,
      reasoningEffortPolicy: marker.mode === "switching" ? "ignore" : "absent",
      tolerateMissingModel: true,
      readCredential: false,
    });
    if (marker.mode === "exclusive") {
      validateSettingsSelection(originals.get(path), content, sibling, marker.mode, catalogPath, originals.get(catalogPath));
      continue;
    }
    const previous = updates.get(path) ?? originals.get(path);
    let document;
    try { document = record(parse(previous)); }
    catch { throw new Error("账户模型选择配置无法安全解析"); }
    const model = modelCatalogSetting(content, sibling, document.model);
    if (document.model_reasoning_effort !== model.reasoningEffort) {
      document.model_reasoning_effort = model.reasoningEffort;
      updates.set(path, stringify(document));
    }
    validateSettingsSelection(updates.get(path) ?? previous, content, sibling, marker.mode, catalogPath);
  }
}

function rememberSettingsSnapshot(originals, path, environment) {
  if (!originals.has(path)) originals.set(path, readOptionalSettingsFile(path, environment));
}

function managedCatalogDefinitions(environment, catalogPath) {
  return managedProviderDefinitions(environment).filter(definition =>
    join(managedProviderDirectory(environment, definition), definition.catalogFileName) === catalogPath);
}

function validateSettingsCatalog(content, definition) {
  const slugs = readCatalogSlugSet(content, definition);
  const catalog = JSON.parse(content);
  if (!slugs.size || slugs.size !== catalog.models.length) throw new Error("模型目录成员无效");
  for (const slug of slugs) modelCatalogSetting(content, definition, slug);
}

function validateSettingsSelection(content, catalogContent, definition, mode, catalogPath, previousCatalogContent) {
  let document;
  try { document = record(parse(content)); }
  catch { throw new Error("恢复模型选择配置无法安全解析"); }
  // A fixed account may already select a delisted model. Preserve that state
  // while its default is repaired via config/batchWrite, but never delist a
  // previously valid selection. Recovery uses the same original catalog guard.
  const missingFixedSelection = mode === "exclusive" && typeof document.model === "string"
    && previousCatalogContent !== undefined
    && !readCatalogSlugSet(previousCatalogContent, definition).has(document.model)
    && !readCatalogSlugSet(catalogContent, definition).has(document.model);
  const model = missingFixedSelection ? undefined : modelCatalogSetting(catalogContent, definition, document.model);
  if (document.model_provider !== definition.id || document.model_catalog_json !== catalogPath
    || reasoningEffortMismatch(document, model, mode === "switching" ? "mirror" : "absent")
    || document.model_context_window !== undefined || document.model_auto_compact_token_limit !== undefined
    || document.model_auto_compact_token_limit_scope !== undefined) {
    throw new Error("模型选择配置与提供商家族目录不一致");
  }
}

/** Family catalog/manifest changes share settings recovery and every affected account mirror. */
export function writeManagedModelProviderCatalogUpdates(provider, updates, originals, environment = process.env) {
  const { definition, path } = managedProviderCatalogPath(provider, environment);
  const manifest = join(managedProviderDirectory(environment, definition), definition.catalogManifestFileName);
  const required = [path, manifest, `${path}.backup`, `${manifest}.backup`];
  if (!(updates instanceof Map) || !(originals instanceof Map) || updates.size !== required.length
    || required.some(file => !updates.has(file) || typeof updates.get(file) !== "string" || !originals.has(file))
    || typeof originals.get(path) !== "string" || typeof originals.get(manifest) !== "string"
    || updates.get(`${path}.backup`) !== originals.get(path) || updates.get(`${manifest}.backup`) !== originals.get(manifest)) {
    throw new Error("提供商家族模型目录更新必须包含准确的目录、来源及原始备份快照");
  }
  validateCatalogManifest(originals.get(path), originals.get(manifest), definition);
  validateCatalogManifest(updates.get(path), updates.get(manifest), definition);
  collectCatalogWithProfileMirrors(environment, path, updates.get(path), updates, originals);
  writeCatalogUpdates(environment, updates, originals, path);
}

function readOptionalSettingsFile(path, environment) {
  try { return createProviderFileReader(environment)(path, maximumCatalogBytes); }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

function assertCatalogUpdateSnapshots(environment, originals, written = new Map()) {
  for (const [path, previous] of originals) {
    if (readOptionalSettingsFile(path, environment) !== (written.has(path) ? written.get(path) : previous)) {
      throw new Error("模型目录或相关配置已变化，请重新预览");
    }
  }
}

function managedSettingsScope(environment, catalogPath) {
  const definitions = managedCatalogDefinitions(environment, catalogPath);
  const definition = definitions[0];
  if (!definition) throw new Error("模型设置目录不属于已配置的提供商家族");
  const family = managedProviderAccountFamilyForDefinition(definition);
  const manifestPath = join(managedProviderDirectory(environment, definition), definition.catalogManifestFileName);
  const backupPaths = new Set([`${catalogPath}.backup`, `${manifestPath}.backup`]);
  const profilePaths = new Set(definitions.map(entry => join(codexHomePath(environment), entry.profileFileName)));
  const markerPaths = definitions.map(entry => managedProviderMarkerPath(environment, entry));
  const registryPath = family.accountsFilePath(environment);
  const selections = definitions.flatMap(entry => {
    const marker = readManagedMarker(environment, entry);
    return marker ? [{ definition: entry, mode: marker.mode,
      path: configuredProfilePath(codexHomePath(environment), providerDescriptor(entry), marker.mode) }] : [];
  });
  const allowedUpdates = new Set([catalogPath, manifestPath, ...backupPaths,
    ...selections.filter(entry => entry.mode === "switching").map(entry => entry.path)]);
  const allowedGuards = new Set([registryPath, ...markerPaths, ...profilePaths, manifestPath, ...backupPaths,
    join(codexHomePath(environment), "config.toml")]);
  return { definition, manifestPath, backupPaths, profilePaths, selections, allowedUpdates, allowedGuards,
    requiredSnapshots: [registryPath, manifestPath, ...markerPaths, ...selections.map(entry => entry.path)] };
}

function settingsFileLimit(path, scope) {
  return scope.backupPaths.has(path) || path === scope.manifestPath
    || !scope.allowedGuards.has(path) ? maximumCatalogBytes : maximumConfigBytes;
}

function writeCatalogUpdates(environment, updates, originals, catalogPath) {
  assertProviderCatalogIsolationComplete(environment);
  assertResponsesContextSyncComplete(environment);
  assertManagedCatalogSettingsComplete(catalogPath);
  const scope = managedSettingsScope(environment, catalogPath);
  if (!updates.has(catalogPath) || [...updates.keys()].some(path => !scope.allowedUpdates.has(path))) {
    throw new Error("模型设置写入路径不属于同一提供商家族");
  }
  for (const path of scope.requiredSnapshots) rememberSettingsSnapshot(originals, path, environment);
  for (const path of updates.keys()) {
    rememberSettingsSnapshot(originals, path, environment);
  }
  assertCatalogUpdateSnapshots(environment, originals);
  const files = [...updates].map(([path, next]) => ({ path, previous: originals.get(path) ?? null, next }));
  const guards = [...originals].filter(([path]) => !updates.has(path) && scope.allowedGuards.has(path))
    .map(([path, content]) => ({ path, content: content ?? null }));
  // Recovery reads both snapshots with the same bound as ordinary readers.
  // Check formatted output before publishing a journal or replacing any file.
  if (files.some(file => typeof file.next !== "string"
    || file.previous === null && !scope.backupPaths.has(file.path)
    || Buffer.byteLength(file.next) > settingsFileLimit(file.path, scope)
    || file.previous !== null && Buffer.byteLength(file.previous) > settingsFileLimit(file.path, scope))
    || guards.some(file => file.content !== null && Buffer.byteLength(file.content) > settingsFileLimit(file.path, scope))) {
    throw new Error("模型设置保存结果超过文件大小限制（目录 2 MiB、Profile 1 MiB），未写入文件");
  }
  const journal = `${JSON.stringify({ schemaVersion: 2, files, guards }, null, 2)}\n`;
  if (Buffer.byteLength(journal) > 16 * 1024 * 1024) throw new Error("模型设置恢复记录超过大小限制");
  const pending = `${catalogPath}.settings-pending`;
  writePrivateFileAtomicSync(`${catalogPath}.settings-backup`, journal);
  writePrivateFileAtomicSync(pending, journal);
  const written = new Map();
  try {
    for (const [path, next] of updates) {
      assertCatalogUpdateSnapshots(environment, originals, written);
      writePrivateFileAtomicSync(path, next);
      written.set(path, next);
    }
    assertCatalogUpdateSnapshots(environment, originals, written);
    if (readPrivateFile(pending, 16 * 1024 * 1024) !== journal) throw new Error("模型设置恢复记录已变化");
    unlinkSync(pending);
  } catch (error) {
    const errors = [error];
    try {
      // Never overwrite subsequent edits, even while rolling back our own failure.
      assertCatalogUpdateSnapshots(environment, new Map([...originals].filter(([path]) => !updates.has(path))));
      for (const file of files) assertSettingsSnapshot(file, environment);
      for (const file of [...files].reverse()) {
        assertSettingsSnapshot(file, environment);
        restoreSettingsFile(file.path, file.previous);
      }
      for (const file of files) {
        if (readOptionalSettingsFile(file.path, environment) !== (file.previous ?? undefined)) throw new Error("模型设置回滚后发生变化", { cause: error });
      }
      if (readPrivateFile(pending, 16 * 1024 * 1024) !== journal) throw new Error("模型设置恢复记录已变化", { cause: error });
      unlinkSync(pending);
    } catch (rollbackError) {
      errors.push(rollbackError);
    }
    if (errors.length > 1) throw new AggregateError(errors, "模型目录与引用配置回滚未完成", { cause: error });
    throw error;
  }
}

function assertManagedCatalogSettingsComplete(path) {
  if (existsSync(`${path}.settings-pending`)) throw new Error("提供商家族模型设置尚未完成；请使用 codexc provider recover <Provider ID> keep 或 rollback 恢复");
}

function assertSettingsSnapshot(file, environment) {
  const current = readOptionalSettingsFile(file.path, environment);
  if (current !== (file.previous ?? undefined) && current !== file.next) throw new Error("模型设置存在后续修改，拒绝覆盖；请核对私有恢复记录");
}

function restoreSettingsFile(path, content) {
  if (content === null) {
    try { unlinkSync(path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  } else writePrivateFileAtomicSync(path, content);
}

function findManagedProviderDefinitionByCatalog(environment, path) {
  const definition = managedProviderDefinitions(environment).find(definition => join(managedProviderDirectory(environment, definition), definition.catalogFileName) === path);
  if (!definition) throw new Error("模型设置目录不属于已配置的账户");
  return definition;
}

function validateCatalogManifest(catalogContent, manifestContent, definition) {
  let catalog, manifest;
  try { catalog = JSON.parse(catalogContent); manifest = JSON.parse(manifestContent); }
  catch { throw new Error("模型目录或来源无法安全解析"); }
  const slugs = readCatalogSlugSet(catalogContent, definition);
  if (!Array.isArray(catalog.models) || !slugs.size || slugs.size !== catalog.models.length) throw new Error("模型目录成员无效");
  for (const slug of slugs) modelCatalogSetting(catalogContent, definition, slug);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || typeof manifest.source !== "string" || !manifest.source) throw new Error("模型来源无效");
  readModelTemplateBindings(manifest, [...slugs]);
  if (isClinePassAccountProvider(definition.id)) validateClinePassCatalogManifest(manifest, [...slugs], definition.defaultModel);
}

/** Called only by the explicit recovery command under the Provider management lock. */
export function recoverManagedCatalogSettings(provider, action, environment = process.env) {
  const definition = findManagedProviderDefinition(environment, provider);
  if (!definition) return false;
  if (!["keep", "rollback"].includes(action)) throw new Error("模型设置恢复操作无效");
  assertProviderCatalogIsolationComplete(environment);
  assertResponsesContextSyncComplete(environment);
  const catalogPath = join(managedProviderDirectory(environment, definition), definition.catalogFileName);
  const pending = `${catalogPath}.settings-pending`;
  const content = readPrivateFile(pending, 16 * 1024 * 1024);
  let journal;
  try { journal = JSON.parse(content); } catch { throw new Error("模型设置恢复记录无法安全解析"); }
  const scope = managedSettingsScope(environment, catalogPath);
  const { manifestPath, backupPaths } = scope;
  if (journal?.schemaVersion !== 2) throw new Error("模型设置恢复记录仅支持版本 2；请保留记录与备份，旧版记录须使用对应原版本恢复");
  if (Object.keys(journal).some(key => !["schemaVersion", "files", "guards"].includes(key))
    || !Array.isArray(journal.files) || journal.files.length < 1
    || journal.files.length > scope.allowedUpdates.size || new Set(journal.files.map(file => file?.path)).size !== journal.files.length
    || !journal.files.some(file => file?.path === catalogPath)
    || journal.files.some(file => !file || Object.keys(file).some(key => !["path", "previous", "next"].includes(key))
      || !scope.allowedUpdates.has(file.path) || !(typeof file.previous === "string" || file.previous === null && backupPaths.has(file.path)) || typeof file.next !== "string"
      || file.previous !== null && Buffer.byteLength(file.previous) > settingsFileLimit(file.path, scope)
      || Buffer.byteLength(file.next) > settingsFileLimit(file.path, scope))) {
    throw new Error("模型设置恢复记录字段或路径无效");
  }
  if (!Array.isArray(journal.guards) || journal.guards.length > scope.allowedGuards.size
    || new Set(journal.guards.map(file => file?.path)).size !== journal.guards.length
    || journal.guards.some(file => !file || Object.keys(file).some(key => !["path", "content"].includes(key))
      || !scope.allowedGuards.has(file.path) || journal.files.some(update => update.path === file.path)
      || !(typeof file.content === "string" || file.content === null)
      || file.content !== null && Buffer.byteLength(file.content) > settingsFileLimit(file.path, scope))
    || scope.requiredSnapshots.some(path => !journal.files.some(file => file.path === path)
      && !journal.guards.some(file => file.path === path))) {
    throw new Error("模型设置恢复记录缺少同家族账户快照，或包含不受支持的守卫路径");
  }
  const guards = new Map(journal.guards.map(file => [file.path, file.content ?? undefined]));
  assertCatalogUpdateSnapshots(environment, guards);
  const manifest = journal.files.find(file => file.path === manifestPath);
  if (manifest || journal.files.some(file => backupPaths.has(file.path))) {
    const catalog = journal.files.find(file => file.path === catalogPath);
    if (!manifest || ![...backupPaths].every(path => journal.files.some(file => file.path === path))
      || journal.files.find(file => file.path === `${catalogPath}.backup`).next !== catalog.previous
      || journal.files.find(file => file.path === `${manifestPath}.backup`).next !== manifest.previous) throw new Error("模型目录与来源恢复快照不完整");
    for (const snapshot of ["previous", "next"]) validateCatalogManifest(catalog[snapshot], manifest[snapshot], definition);
  }
  const selected = action === "keep" ? "next" : "previous";
  const catalogContent = journal.files.find(file => file.path === catalogPath)[selected];
  validateSettingsCatalog(catalogContent, definition);
  if (!scope.selections.some(entry => entry.definition.id === provider)) {
    throw new Error("模型设置所属账户配置缺失，请先恢复账户配置");
  }
  for (const selection of scope.selections) {
    const profile = journal.files.find(file => file.path === selection.path);
    const selectionContent = profile?.[selected] ?? guards.get(selection.path);
    validateSettingsSelection(selectionContent, catalogContent, selection.definition, selection.mode, catalogPath,
      journal.files.find(file => file.path === catalogPath).previous);
  }
  for (const file of journal.files) assertSettingsSnapshot(file, environment);
  const files = action === "rollback" ? [...journal.files].reverse() : journal.files;
  for (const file of files) {
    assertCatalogUpdateSnapshots(environment, guards);
    assertSettingsSnapshot(file, environment);
    restoreSettingsFile(file.path, action === "keep" ? file.next : file.previous);
  }
  for (const file of files) {
    if (readOptionalSettingsFile(file.path, environment) !== ((action === "keep" ? file.next : file.previous) ?? undefined)) throw new Error("模型设置恢复结果发生变化，保留恢复记录");
  }
  assertCatalogUpdateSnapshots(environment, guards);
  if (readPrivateFile(pending, 16 * 1024 * 1024) !== content) throw new Error("模型设置恢复记录已变化");
  unlinkSync(pending);
  return true;
}

function managedProviderCatalogPath(provider, environment) {
  assertProviderCatalogIsolationComplete(environment);
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

export function writeManagedModelWindow(
  { provider, model, windowPercent, contextWindow: requestedContext, environment = process.env } = {},
) {
  if (requestedContext !== undefined && windowPercent !== undefined) {
    throw new Error("Token 数和窗口百分比不能同时设置");
  }
  if (requestedContext === undefined) validateWindowPercent(windowPercent);
  if (typeof provider !== "string" || !provider || typeof model !== "string" || !model) throw new Error("必须提供准确的 Provider 和模型 ID");
  const configuredProviders = loadManagedModelProviderSettings(environment);
  const configured = configuredProviders.find(entry => entry.provider === provider);
  const modelEntry = configured?.models.find(entry => entry.model === model);
  if (!modelEntry) throw new Error(`未找到该 Provider 的已配置模型：${provider}/${model}`);
  const base = modelEntry.maxContextWindow;
  if (!Number.isSafeInteger(base) || base <= 0) throw new Error(`模型最大上下文窗口无效：${provider}/${model}`);
  const contextWindow = requestedContext ?? Math.round(base * windowPercent / 100);
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024 || contextWindow > base) {
    throw new Error(`模型上下文窗口必须是 1024-${base} 的整数：${model}`);
  }
  windowPercent = contextWindow * 100 / base;
  const updates = new Map();
  const originals = new Map();
  const { definition, path } = managedProviderCatalogPath(provider, environment);
  const members = configuredProviders.filter(entry => {
    const sibling = findManagedProviderDefinition(environment, entry.provider);
    return join(managedProviderDirectory(environment, sibling), sibling.catalogFileName) === path;
  });
  const overridden = modelEntry.windowPercent !== undefined && modelEntry.windowPercent !== windowPercent
    ? members.map(entry => ({ provider: entry.provider, previousPercent: modelEntry.windowPercent })) : [];
  const settings = { model, reasoningEffort: modelEntry.reasoningEffort ?? configured.reasoningEffort, contextWindow };
  validateManagedModelSettings(definition, settings);
  const previous = readPrivateFile(path, maximumCatalogBytes);
  originals.set(path, previous);
  collectCatalogWithProfileMirrors(environment, path,
    updateModelCatalogSettings(previous, definition, settings), updates, originals);
  writeCatalogUpdates(environment, updates, originals, path);
  return {
    provider,
    model,
    windowPercent,
    contextWindow,
    providers: members.map(entry => entry.provider),
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
    expectedCatalogPath,
    reasoningEffortPolicy: "mirror",
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
      expectedCatalogPath,
      reasoningEffortPolicy: "mirror",
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
  const family = managedProviderAccountFamilyForDefinition(definition);
  const paths = [family.accountsFilePath(environment), managedProviderMarkerPath(environment, definition), profilePath];
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
  const family = managedProviderAccountFamilyForDefinition(definition);
  if (family === undefined) throw new Error("Relay Provider 注册材料不受支持");
  const paths = [family.accountsFilePath(environment), managedProviderMarkerPath(environment, definition),
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
  assertProviderCatalogIsolationComplete(environment);
  const protocols = definition.upstreamWireApi === "chat_completions" ? ["chat"]
    : definition.storageId === "deepseek" ? ["chat", "responses"] : ["responses"];
  return { provider, baseUrl: profile.baseUrl, apiKey: profile.apiKey, models, modelInputs, protocols,
    ...(definition.storageId === "clp" ? { modelCapabilities: settings.map(model => ({ id: model.model,
      reasoning_efforts: model.reasoningEfforts.map(level => level.effort).filter(effort => effort !== "enabled"),
      cline_request_profile: model.clineRequestProfile,
      ...(model.clineProviderOptions === undefined ? {} : { cline_provider_options: model.clineProviderOptions }) })) } : {}),
    paths: [...paths, responsesContextSyncPath(environment), providerCatalogIsolationPath(environment), `${join(directory, definition.catalogFileName)}.settings-pending`], revision: before };
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
  assertProviderCatalogIsolationComplete(environment);
  if (expectedCatalogPath !== undefined) assertManagedCatalogSettingsComplete(expectedCatalogPath);
  let searchPending = true;
  try { readPrivateFileSync(`${path}.search-pending`, 4096); }
  catch (error) {
    if (error?.code !== "ENOENT") {
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Provider 搜索设置事务记录无法安全读取");
    }
    searchPending = false;
  }
  if (searchPending) throw new Error("Provider 搜索设置保存尚未完成；请保留事务记录及备份并核对文件，勿自动重试");
  let document;
  let fileAccess;
  try {
    fileAccess = createProviderFileAccess(environment);
    document = record(parse(fileAccess.read(path, maximumConfigBytes)));
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
  if (document.web_search !== undefined && !["disabled", "cached", "indexed", "live"].includes(document.web_search)) {
    throw new Error("Codex 模型提供商搜索模式无效");
  }
  if (expectedCatalogPath !== undefined && document.model_catalog_json !== expectedCatalogPath) {
    throw new Error(`Codex ${descriptor.definition.displayName} 必须使用提供商家族共享模型目录；当前版本不支持旧目录布局或目录迁移，请保留配置与目录完整备份，使用对应原版本处理旧配置`);
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
  assertProviderModelRequestPolicy(provider);
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
  const isMain = fileAccess.isMainConfig(path);
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
    webSearch: document.web_search,
    reasoningEffort: reasoningEffortPolicy === "mirror"
      ? document.model_reasoning_effort
      : selectedModel?.reasoningEffort,
    catalogPath: document.model_catalog_json,
    name: descriptor.id,
    baseUrl: descriptor.baseUrl,
    wireApi: descriptor.wireApi,
    apiKeyEnvironmentKey: isMain && provider.env_key !== undefined ? provider.env_key : descriptor.definition.apiKeyEnvironmentKey,
    supportsWebsockets: descriptor.definition.supportsWebsockets,
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
  const entries = definition.storageId === "clp" ? JSON.parse(content).models : undefined;
  return [...readCatalogSlugSet(content, definition)]
    .map((slug) => {
      const entry = entries?.find(model => model.slug === slug);
      return { ...modelCatalogSetting(content, definition, slug),
        ...(entries ? { clineRequestProfile: resolveClinePassRequestProfile(slug, entry?.cline_request_profile) } : {}),
        ...(entry?.cline_provider_options === undefined ? {} : {
          clineProviderOptions: validateClinePassProviderOptions(entry.cline_provider_options),
        }),
      };
    });
}

function readCatalogSlugSet(content, definition) {
  let catalog;
  try {
    catalog = JSON.parse(content);
  } catch {
    throw new Error(`Codex ${definition.displayName} 模型目录无法安全读取`);
  }
  validateClinePassRequestProfiles(catalog, definition);
  return catalogSlugSet(catalog, definition);
}

function validateClinePassRequestProfiles(catalog, definition) {
  if ((definition.storageId ?? definition.id) !== "clp" || !Array.isArray(catalog?.models)) return;
  for (const entry of catalog.models) {
    resolveClinePassRequestProfile(entry?.slug, entry?.cline_request_profile);
    validateClinePassProviderOptions(entry?.cline_provider_options);
  }
}

export function catalogHasModel(path, definition, model) {
  return readCatalogSlugSet(
    readPrivateFile(path, maximumCatalogBytes),
    definition,
  ).has(model);
}

export function readModelCatalogSetting(path, definition, model) {
  try {
    const content = readPrivateFile(path, maximumCatalogBytes);
    validateClinePassRequestProfiles(JSON.parse(content), definition);
    return modelCatalogSetting(
      content,
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
  validateClinePassRequestProfiles(catalog, definition);
  if (!catalogSlugSet(catalog, definition).has(model)) return undefined;
  return modelCatalogSetting(content, definition, model);
}

export function readManagedMarker(environment, definition) {
  const markerPath = managedProviderMarkerPath(environment, definition);
  let marker;
  try {
    marker = record(parse(readPrivateFile(markerPath)));
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (definition.accountId !== undefined
        && managedProviderAccountFamilyForDefinition(definition).loadAccounts(environment)
          .some(account => account.id === definition.accountId) && [
        join(providerStorageRoot(environment), definition.storageId ?? definition.id, "accounts", definition.accountId),
        join(providerStorageRoot(environment), definition.id),
      ].some(directory => existsSync(join(directory, definition.managedMarkerFileName)))) {
        throw new Error(`Provider ${definition.id} 仍使用不受支持的旧账户目录；请保留配置与目录完整备份，停止相关服务后使用对应原版本处理，当前版本不提供目录迁移`, { cause: error });
      }
      return undefined;
    }
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
