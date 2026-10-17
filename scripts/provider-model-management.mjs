import { createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import { parse } from "smol-toml";

import { codexHomePath } from "../runtime/codex-home.mjs";
import { clineRelayCatalogSchema } from "../runtime/cline-relay-catalog.mjs";
import { managedProviderAccountFamilies, loadManagedModelProviderDefinitions, isManagedProviderModelValid } from "../runtime/model-provider-definitions.mjs";
import { managedProviderDirectory, managedProviderMarkerPath, customPrimaryProviderProfilePath, customSwitchingProviderRegistryPath, primaryProviderBackupPath, loadConfiguredCustomPrimaryModelProvider, writeManagedModelWindow, writeManagedModelProviderCatalogUpdates } from "../runtime/model-provider-runtime.mjs";
import { customProviderUpstreamMetadataPath } from "../runtime/model-provider-upstream-metadata.mjs";
import { customOfficialModelCatalogPath } from "../runtime/model-provider-official-catalog.mjs";
import { compileResponsesModelCatalog, isCustomCatalogProvider, readResponsesModelCatalog, responsesProviderCatalogPath, responsesContextSyncPath, writeResponsesModelCatalog, writeResponsesModelContextWindow, withResponsesModelCatalogWrite, finishResponsesModelCatalogWrite } from "../runtime/model-provider-responses-catalog.mjs";
import { validateGatewayConfigStructureDocument, parseGatewayConfig } from "../runtime/gateway-config.mjs";
import { loadModelProviderManagementState } from "./model-provider-management.mjs";
import { locateOptionalUserConfig, userDataDir } from "./runtime-config.mjs";
import { snapshotProviderFiles, assertProviderFileSnapshots } from "./managed-provider-files.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { validateModelCatalogWithCodex } from "./model-catalog-validation.mjs";
import { createProviderFileReader } from "../runtime/provider-file-access.mjs";
import { projectModelCatalogEntries, projectModelPrompts } from "../runtime/model-catalog-presentation.mjs";
import { providerCatalogIsolationPath } from "../runtime/provider-catalog-isolation.mjs";
import { readModelTemplateBindings } from "../runtime/model-template-bindings.mjs";

// Revisions cover private profiles too; avoid exposing a reusable credential fingerprint.
const revisionSecret = randomBytes(32);
const clineSourceMetadataSchema = clineRelayCatalogSchema.pick({ commit: true, downloadedAt: true });

export class ProviderModelManagementError extends Error {
  constructor(code, field, message, options) {
    super(message, options);
    this.name = "ProviderModelManagementError";
    this.code = code;
    this.field = field;
  }
}

/** Saved directories are the enabled set. Aggregates and Relay grants remain derived consumers. */
export async function loadProviderModelCatalogs({ environment = process.env } = {}) {
  try {
    const state = await readManagementState(environment, true);
    const catalogs = [];
    const definitions = loadManagedModelProviderDefinitions(environment);
    const seenFamilies = new Set();
    for (const definition of definitions) {
      const member = state.managedProviders.find(provider => provider.id === definition.id);
      if (!member) continue;
      if (seenFamilies.has(definition.storageId)) continue;
      seenFamilies.add(definition.storageId);
      const family = managedProviderAccountFamilies.find(entry => entry.storageId === definition.storageId);
      const members = state.managedProviders.filter(provider => definitions.some(entry => entry.storageId === definition.storageId && entry.id === provider.id));
      const canRemove = definition.storageId !== "deepseek";
      catalogs.push({ provider: definition.id, displayName: family.definition.displayName, providers: members.map(entry => entry.id),
        models: member.models.map(model => ({ id: model.id, displayName: model.displayName, isDefault: members.some(entry => entry.model === model.id) })), canRemove,
        ...(!canRemove ? { unavailableReason: "deepseek-template-source" } : {}),
      });
    }
    const candidates = [...state.customProviders.fixedCandidates.filter(provider => provider.active), ...state.customProviders.switchingProviders];
    let officialModels;
    for (const provider of candidates) {
      const custom = isCustomCatalogProvider(provider.id);
      if (!custom && officialModels === undefined) officialModels = await savedOfficialModels(environment);
      const models = custom ? provider.models.map(model => ({ id: model.id, displayName: model.name, isDefault: model.id === provider.model }))
        : officialModels.map(model => ({ ...model, isDefault: model.id === (provider.model ?? state.defaults.model) }));
      catalogs.push({ provider: provider.id, displayName: provider.displayName, providers: [provider.id], models, canRemove: custom,
        ...(!custom ? { unavailableReason: models.length ? "official-shared-catalog" : "official-catalog-unavailable" } : {}),
      });
    }
    return { catalogs };
  } catch (error) { throw stateError(error); }
}

/** Presentation is derived from the saved source, never from global window aggregates. */
export async function loadProviderModelCatalogPresentations({ environment = process.env } = {}) {
  try {
    const { catalogs } = await loadProviderModelCatalogs({ environment });
    const result = catalogs.map(catalog => {
      const snapshot = readPresentationSnapshot(catalog, environment);
      return { ...catalog, source: snapshot.source, revision: snapshot.revision,
        models: snapshot.models.map(presentation => ({
          id: presentation.model, displayName: presentation.displayName,
          isDefault: catalog.models.some(model => model.id === presentation.model && model.isDefault),
          presentation,
        })) };
    });
    // Account defaults and membership must not change between the discovery and projection.
    const current = await loadProviderModelCatalogs({ environment });
    if (JSON.stringify(current.catalogs) !== JSON.stringify(catalogs)) {
      throw invalid("stale-preview", "provider", "模型目录或账户已变化，请刷新");
    }
    return { catalogs: result };
  } catch (error) { throw stateError(error); }
}

export async function loadProviderModelPrompts(input, { environment = process.env } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["provider", "model", "revision"].includes(key))
    || typeof input.revision !== "string" || !/^[a-f0-9]{64}$/u.test(input.revision)) {
    throw invalid("invalid-input", "revision", "模型提示词请求参数无效");
  }
  validateInput({ provider: input.provider, model: input.model });
  try {
    const { catalogs } = await loadProviderModelCatalogs({ environment });
    const catalog = catalogs.find(entry => entry.providers.includes(input.provider));
    if (!catalog) throw invalid("stale-preview", "provider", "提供商目录已变化，请刷新");
    const snapshot = readPresentationSnapshot(catalog, environment);
    if (snapshot.revision !== input.revision) throw invalid("stale-preview", "revision", "模型目录已变化，请刷新");
    if (!snapshot.models.some(model => model.model === input.model)) {
      throw invalid("invalid-input", "model", "模型不在当前可见目录中");
    }
    const model = snapshot.document.models.find(entry => entry.slug === input.model);
    const definition = snapshot.document.definitions?.find(entry => entry.id === input.model);
    return { revision: snapshot.revision, model: input.model, groups: projectModelPrompts(model.model_messages),
      ...(definition?.template === undefined ? {} : { template: definition.template }),
      ...(definition?.sampling === undefined ? {} : { sampling: definition.sampling }) };
  } catch (error) { throw stateError(error); }
}

function readPresentationSnapshot(catalog, environment) {
  const definition = loadManagedModelProviderDefinitions(environment).find(entry => entry.id === catalog.provider);
  const custom = isCustomCatalogProvider(catalog.provider);
  const source = definition ? "managed" : custom ? "custom" : "official-shared";
  let content, document;
  if (custom) {
    const saved = readResponsesModelCatalog(environment, catalog.provider);
    content = saved.content;
    document = saved;
  } else {
    const path = definition
      ? join(managedProviderDirectory(environment, definition), definition.catalogFileName)
      : customOfficialModelCatalogPath(environment);
    try { content = createProviderFileReader(environment)(path, definition ? 2_097_152 : 8_388_608); }
    catch (error) {
      if (!definition && error?.code === "ENOENT" && catalog.models.length === 0) content = "";
      else throw error;
    }
    document = content === "" ? { models: [] } : parseJson(content);
    if (definition) validateManagedCatalog(document, definition);
  }
  const models = document.models.length === 0 ? [] : projectModelCatalogEntries(document.models, false, custom ? document.definitions : undefined);
  const expected = catalog.models.map(model => model.id).sort();
  if (JSON.stringify(models.map(model => model.model).sort()) !== JSON.stringify(expected)) {
    throw invalid("stale-preview", "provider", "目录模型已变化，请刷新");
  }
  const revision = createHmac("sha256", revisionSecret)
    .update(JSON.stringify([catalog.provider, catalog.providers, catalog.models, content])).digest("hex");
  return { source, revision, document, models };
}

export async function previewProviderModelContextChange(input, { environment = process.env } = {}) {
  try { return (await buildContextPlan(input, environment)).preview; }
  catch (error) { throw stateError(error); }
}

export async function applyProviderModelContextChange(input, { environment = process.env, preview } = {}) {
  return withModelProviderManagementTransaction(environment, async () => {
    let plan;
    try { plan = await buildContextPlan(input, environment); }
    catch (error) { throw stateError(error); }
    if (!preview || preview.operation !== "model.context" || preview.provider !== plan.preview.provider
      || preview.model?.id !== plan.preview.model.id || preview.contextWindow !== plan.preview.contextWindow
      || preview.revision !== plan.preview.revision) {
      throw invalid("stale-preview", "revision", "模型目录已变化，请重新预览");
    }
    if (plan.preview.willChange) {
      try {
        if (plan.snapshot.source === "managed") {
          writeManagedModelWindow({ provider: input.provider, model: input.model, contextWindow: input.contextWindow, environment });
        } else {
          const transaction = writeResponsesModelContextWindow(environment, input.provider, input.model, input.contextWindow, plan.snapshot.document.revision);
          await withResponsesModelCatalogWrite(transaction, async () => {
            const saved = readResponsesModelCatalog(environment, input.provider);
            const read = createProviderFileReader(environment);
            if (saved.content !== transaction.content
              || read(`${transaction.path}.backup`, 2_097_152) !== transaction.previous.content
              || read(`${transaction.path}.pending`, 1024) !== transaction.pendingContent) {
              throw invalid("readback-failed", "contextWindow", "模型上下文保存结果无法确认，已保留 pending 和备份；勿自动重试");
            }
            finishResponsesModelCatalogWrite(transaction);
          });
        }
      } catch (error) {
        if (error instanceof ProviderModelManagementError) throw error;
        throw invalid("operation-failed", "contextWindow", "模型上下文保存未完成；请检查目录与备份，勿自动重试", error);
      }
    }
    return { ...plan.preview, action: "updated" };
  });
}

async function buildContextPlan(input, environment) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["provider", "model", "contextWindow", "revision"].includes(key))
    || typeof input.revision !== "string" || !/^[a-f0-9]{64}$/u.test(input.revision)) {
    throw invalid("invalid-input", "revision", "模型上下文请求参数无效，请刷新模型目录后重新编辑");
  }
  validateInput({ provider: input.provider, model: input.model });
  const { catalogs } = await loadProviderModelCatalogs({ environment });
  const catalog = catalogs.find(entry => entry.providers.includes(input.provider));
  if (!catalog) throw invalid("stale-preview", "provider", "提供商目录已变化，请刷新");
  const snapshot = readPresentationSnapshot(catalog, environment);
  if (snapshot.revision !== input.revision) throw invalid("stale-preview", "revision", "模型目录已变化，请刷新");
  if (snapshot.source === "official-shared") throw invalid("context-not-supported", "provider", "官方共享模型目录仅支持只读查看");
  const model = snapshot.models.find(entry => entry.model === input.model);
  if (!model) throw invalid("invalid-input", "model", "模型不在当前可见目录中");
  if (!Number.isSafeInteger(model.maxContextWindow) || !Number.isSafeInteger(input.contextWindow)
    || input.contextWindow < 1024 || input.contextWindow > model.maxContextWindow) {
    throw invalid("invalid-window", "contextWindow", `模型上下文窗口必须是 1024-${model.maxContextWindow} 的整数`);
  }
  const definition = snapshot.document.definitions?.find(entry => entry.id === input.model);
  if (definition?.autoCompactTokenLimit > Math.floor(input.contextWindow * 9 / 10)) {
    throw invalid("context-auto-compact-limit", "contextWindow", "模型上下文窗口不能小于已配置自动压缩阈值所需的窗口，请先调整模型详情中的自动压缩阈值");
  }
  return { snapshot, preview: { operation: "model.context", provider: input.provider,
    model: { id: model.model, displayName: model.displayName, contextWindow: model.contextWindow, maxContextWindow: model.maxContextWindow },
    contextWindow: input.contextWindow, providers: catalog.providers, revision: snapshot.revision,
    willChange: model.contextWindow !== input.contextWindow, activation: "restart-app-server" } };
}

export async function previewProviderModelRemoval(input, { environment = process.env } = {}) {
  try { return (await buildRemovalPlan(input, environment)).preview; }
  catch (error) { throw stateError(error); }
}

export async function applyProviderModelRemoval(input, { environment = process.env, preview } = {}) {
  return withModelProviderManagementTransaction(environment, async () => {
    let plan;
    try { plan = await buildRemovalPlan(input, environment); }
    catch (error) { throw stateError(error); }
    if (!preview || preview.operation !== "model.remove" || preview.provider?.id !== plan.preview.provider.id
      || preview.model?.id !== plan.preview.model.id || preview.revision !== plan.preview.revision) {
      throw invalid("stale-preview", "revision", "模型或相关配置已变化，请重新预览");
    }
    try { await validateModelCatalogWithCodex(plan.catalog, environment); }
    catch { throw invalid("catalog-validation-failed", "model", "模型目录未通过当前 Codex CLI 校验，未执行移除"); }
    await assertProviderFileSnapshots(plan.snapshots).catch(() => { throw invalid("stale-preview", "revision", "模型或相关配置已变化，请重新预览"); });
    try {
      if (plan.custom) await applyCustomRemoval(plan, environment);
      else {
        writeManagedModelProviderCatalogUpdates(input.provider, plan.updates,
          new Map(plan.snapshots.map(snapshot => [snapshot.path, snapshot.content?.toString("utf8")])), environment);
        // An uncertain readback preserves the backup; never repeat the write automatically.
        assertSavedUpdates(plan);
      }
    } catch (error) {
      if (error instanceof ProviderModelManagementError) throw error;
      throw invalid("operation-failed", "model", "模型移除未完成；请检查目录与备份，勿自动重试", error);
    }
    return { ...plan.preview, action: "model-removed" };
  });
}

async function buildRemovalPlan(input, environment) {
  validateInput(input);
  const definitions = loadManagedModelProviderDefinitions(environment);
  const definition = definitions.find(entry => entry.id === input.provider);
  const family = definition && managedProviderAccountFamilies.find(candidate => definition.storageId === candidate.storageId);
  if (!family && !isCustomCatalogProvider(input.provider)) throw invalid("removal-not-supported", "provider", "该提供商不支持本地模型移除");
  if (family?.proxyKey === "deepseek") throw invalid("removal-not-supported", "provider", "DeepSeek 暂不支持单模型移除");
  const memberDefinitions = definition ? definitions.filter(entry => entry.storageId === definition.storageId) : [];
  const configPath = join(codexHomePath(environment), "config.toml");
  const paths = [configPath, customSwitchingProviderRegistryPath(environment), primaryProviderBackupPath(environment), responsesContextSyncPath(environment), providerCatalogIsolationPath(environment),
    ...(family ? [family.accountsFilePath(environment)] : []),
    ...memberDefinitions.flatMap(definition => [managedProviderMarkerPath(environment, definition), join(codexHomePath(environment), definition.profileFileName)]),
  ];
  let catalogPath, manifestPath;
  if (family) {
    const directory = managedProviderDirectory(environment, definition);
    catalogPath = join(directory, definition.catalogFileName);
    manifestPath = join(directory, definition.catalogManifestFileName);
    paths.push(catalogPath, manifestPath, `${catalogPath}.backup`, `${manifestPath}.backup`);
  } else {
    catalogPath = responsesProviderCatalogPath(environment, input.provider);
    paths.push(catalogPath, `${catalogPath}.backup`, `${catalogPath}.pending`, customPrimaryProviderProfilePath(environment, input.provider), customProviderUpstreamMetadataPath(environment, input.provider));
  }
  const snapshots = snapshotProviderFiles(paths, environment);
  const gateway = gatewaySnapshot(environment);
  snapshots.push(gateway);
  requiredContent(snapshots, configPath);
  const state = await readManagementState(environment);
  if (family && !loadManagedModelProviderDefinitions(environment).some(entry => entry.id === definition.id)) {
    throw invalid("stale-preview", "revision", "账户已变化，请重新预览");
  }
  const gatewayContent = gateway.content?.toString("utf8");
  const gatewayDefault = gatewayContent === undefined ? undefined
    : validateGatewayConfigStructureDocument(parseGatewayConfig(gatewayContent)).codex?.default_model;
  let catalog, nextManifest, custom;
  let providers, displayName, defaults;
  if (family) {
    const members = state.managedProviders.filter(provider => memberDefinitions.some(definition => definition.id === provider.id));
    if (!members.some(member => member.id === input.provider)) throw invalid("provider-not-configured", "provider", "请先完成该账户配置");
    providers = members.map(provider => provider.id);
    displayName = family.definition.displayName;
    defaults = members.map(provider => provider.model);
    catalog = parseJson(requiredContent(snapshots, catalogPath));
    const manifest = parseJson(requiredContent(snapshots, manifestPath));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || typeof manifest.source !== "string" || !manifest.source) {
      throw invalid("provider-state-unavailable", "provider", "模型来源文件无效，未执行移除");
    }
    validateManagedCatalog(catalog, definition);
    const templateBindings = readModelTemplateBindings(manifest, catalog.models.map(model => model.slug));
    if (members.some(member => !catalog.models.some(model => model.slug === member.model
      && model.default_reasoning_level === member.reasoningEffort))) {
      throw invalid("provider-state-unavailable", "provider", "账户默认模型或思考等级与目录不一致，请先修复默认设置");
    }
    if (family.proxyKey === "clp") {
      if (!clineSourceMetadataSchema.safeParse(manifest.cline).success
        || !["deepseek", "cline"].includes(manifest.source)
        || (manifest.source === "deepseek" && manifest.model !== "deepseek-flash")) {
        throw invalid("catalog-source-invalid", "provider", "CLP 模型来源信息无效，请先核对账户目录来源，未执行移除");
      }
      const hasDsTemplate = catalog.models.some(model => model.slug === family.definition.defaultModel);
      if (hasDsTemplate !== (manifest.source === "deepseek")) throw invalid("catalog-source-invalid", "provider", "CLP 目录与模板来源不一致，未执行移除");
      nextManifest = { ...manifest };
      if (input.model === family.definition.defaultModel) {
        nextManifest.source = "cline";
        delete nextManifest.model;
      }
    } else nextManifest = { ...manifest, updatedAt: new Date().toISOString() };
    if (Object.hasOwn(manifest, "modelTemplates")) {
      nextManifest.modelTemplates = { ...templateBindings };
      delete nextManifest.modelTemplates[input.model];
    }
    if (Object.hasOwn(manifest, "templateUpdates")) {
      if (!manifest.templateUpdates || typeof manifest.templateUpdates !== "object" || Array.isArray(manifest.templateUpdates)) {
        throw invalid("catalog-source-invalid", "provider", "模型模板更新记录无效，未执行移除");
      }
      nextManifest.templateUpdates = { ...manifest.templateUpdates };
      delete nextManifest.templateUpdates[input.model];
    }
  } else {
    const provider = [...state.customProviders.fixedCandidates.filter(candidate => candidate.active), ...state.customProviders.switchingProviders]
      .find(candidate => candidate.id === input.provider);
    if (!provider) throw invalid("provider-not-configured", "provider", "当前没有可管理的自定义提供商");
    if (!state.customProviders.switchingProviders.some(candidate => candidate.id === input.provider)) {
      try {
        if (loadConfiguredCustomPrimaryModelProvider(environment)?.id !== input.provider) throw new Error("Provider 不匹配");
      } catch (error) {
        throw invalid("provider-state-unavailable", "provider", "当前固定提供商配置不受支持，请先修复连接配置", error);
      }
    }
    custom = readResponsesModelCatalog(environment, input.provider);
    catalog = custom;
    providers = [provider.id];
    displayName = provider.displayName;
    defaults = [custom.defaultModel, provider.model];
  }
  const models = catalog.models;
  const model = models.find(candidate => candidate.slug === input.model);
  if (!model) throw invalid("model-not-found", "model", "模型 ID 不在当前目录中");
  if (models.length === 1) throw invalid("last-model-protected", "model", "不能移除最后一个启用模型");
  if (defaults.includes(input.model)) throw invalid("default-model-protected", "model", "模型是账户或目录默认值，请先更改默认模型");
  if (gatewayDefault === input.model && providers.includes(state.primary.id)) throw invalid("gateway-default-protected", "model", "模型是当前主提供商的 Gateway 显式默认值，请先更改配置");
  const nextCatalog = custom ? compileResponsesModelCatalog(custom.definitions.filter(model => model.id !== input.model), custom.defaultModel)
    : { ...catalog, models: models.filter(model => model.slug !== input.model) };
  await assertProviderFileSnapshots(snapshots);
  const revision = createHmac("sha256", revisionSecret).update(JSON.stringify({ provider: input.provider, model: input.model,
    files: snapshots.map(snapshot => [snapshot.path, snapshot.content?.toString("base64") ?? null]),
  })).digest("hex");
  const warnings = [{ code: "historical-references" }, ...(family?.proxyKey === "clp"
    ? [{ code: "clp-relay-independent" }]
    : [{ code: "provider-relay-inflight" }, { code: "shared-relay-grants-retained" }])];
  const preview = { operation: "model.remove", provider: { id: input.provider, displayName },
    model: { id: input.model, displayName: model.display_name ?? input.model }, providers, revision, warnings, activation: "restart-all" };
  return { preview, snapshots, catalog: nextCatalog, catalogPath, custom,
    updates: new Map(custom ? [] : [
      [`${catalogPath}.backup`, requiredContent(snapshots, catalogPath).toString("utf8")], [`${manifestPath}.backup`, requiredContent(snapshots, manifestPath).toString("utf8")],
      [catalogPath, `${JSON.stringify(nextCatalog, null, 2)}\n`], [manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`],
    ]),
  };
}

async function applyCustomRemoval(plan, environment) {
  const transaction = writeResponsesModelCatalog(environment, plan.preview.provider.id, plan.catalog.definitions, plan.catalog.defaultModel, plan.custom.revision);
  await withResponsesModelCatalogWrite(transaction, async () => {
    const current = readResponsesModelCatalog(environment, plan.preview.provider.id);
    if (current.content !== `${JSON.stringify(plan.catalog, null, 2)}\n`) throw invalid("readback-failed", "model", "模型目录保存结果无法确认，已保留 pending 和备份；勿自动重试");
    const backup = plan.snapshots.find(snapshot => snapshot.path === `${plan.catalogPath}.backup`).readCurrent();
    const pending = plan.snapshots.find(snapshot => snapshot.path === `${plan.catalogPath}.pending`).readCurrent();
    if (!backup?.equals(Buffer.from(plan.custom.content)) || pending?.toString("utf8") !== transaction.pendingContent) {
      throw invalid("readback-failed", "model", "目录备份或 pending 已变化，请人工核对，勿自动重试");
    }
    const unchanged = plan.snapshots.filter(snapshot => ![plan.catalogPath, `${plan.catalogPath}.backup`, `${plan.catalogPath}.pending`].includes(snapshot.path));
    await assertProviderFileSnapshots(unchanged).catch(() => { throw invalid("readback-failed", "model", "保存期间相关配置已变化，已保留 pending 和备份；请人工核对"); });
    finishResponsesModelCatalogWrite(transaction);
  });
}

function assertSavedUpdates(plan) {
  for (const snapshot of plan.snapshots) {
    const expected = plan.updates.has(snapshot.path) ? Buffer.from(plan.updates.get(snapshot.path)) : snapshot.content;
    const current = snapshot.readCurrent();
    if (expected === undefined ? current !== undefined : current === undefined || !expected.equals(current)) {
      throw invalid("readback-failed", "model", "模型目录保存结果无法确认，已保留备份；请人工核对，勿自动重试");
    }
  }
}

async function readManagementState(environment, allowMissingConfig = false) {
  return loadModelProviderManagementState({ environment, checkOfficialAuth: () => false,
    readUserConfig: async () => {
      const [snapshot] = snapshotProviderFiles([join(codexHomePath(environment), "config.toml")], environment);
      if (snapshot.content === undefined && allowMissingConfig) return { config: {} };
      if (!snapshot.content) throw invalid("provider-state-unavailable", "provider", "Codex 主配置缺失，无法核对模型默认值");
      let config;
      try { config = parse(snapshot.content.toString("utf8")); }
      catch { throw invalid("provider-state-unavailable", "provider", "Codex 主配置无法安全解析"); }
      for (const key of ["model_provider", "model"]) {
        if (config[key] !== undefined && (typeof config[key] !== "string" || !config[key].trim())) {
          throw invalid("provider-state-unavailable", "provider", "Codex 主配置的提供商或模型默认值无效");
        }
      }
      return { config };
    },
  });
}

function gatewaySnapshot(environment) {
  const located = locateOptionalUserConfig(environment);
  const path = located?.configPath ?? join(userDataDir(environment), "config.toml");
  const [snapshot] = snapshotProviderFiles([path], environment);
  if (located && snapshot.content === undefined) throw invalid("provider-state-unavailable", "provider", "Gateway 配置缺失，无法核对模型默认值");
  return { ...snapshot, writeCurrent: () => { throw new Error("模型移除不能写入 Gateway 配置"); } };
}

async function savedOfficialModels(environment) {
  let content;
  try { content = createProviderFileReader(environment)(customOfficialModelCatalogPath(environment), 8_388_608); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const catalog = parseJson(content);
  if (!Array.isArray(catalog.models)) throw invalid("provider-state-unavailable", "provider", "官方共享模型目录无效");
  return catalog.models.filter(model => model.supported_in_api && model.visibility === "list")
    .map(model => ({ id: model.slug, displayName: model.display_name ?? model.slug }));
}

function validateManagedCatalog(catalog, definition) {
  if (!Array.isArray(catalog?.models) || !catalog.models.length
    || catalog.models.some(model => !isManagedProviderModelValid(definition, model?.slug))
    || new Set(catalog.models.map(model => model.slug)).size !== catalog.models.length) {
    throw invalid("provider-state-unavailable", "model", "账户模型目录为空或包含无效、重复的模型 ID");
  }
}

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["provider", "model"].includes(key))
    || typeof input.provider !== "string" || !input.provider.length || input.provider.trim() !== input.provider || input.provider.length > 100
    || typeof input.model !== "string" || !input.model.length || input.model.trim() !== input.model || input.model.length > 200
    || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(input.provider + input.model)) throw invalid("invalid-input", "model", "必须提供准确的 provider 和 model ID，不能包含额外字段");
}

function requiredContent(snapshots, path) {
  const content = snapshots.find(snapshot => snapshot.path === path)?.content;
  if (content === undefined) throw invalid("provider-state-unavailable", "provider", "模型目录或关联配置缺失，未执行移除");
  return content;
}

function parseJson(content) {
  try { return JSON.parse(content.toString("utf8")); }
  catch { throw invalid("provider-state-unavailable", "model", "模型目录或来源文件无法安全解析"); }
}

function invalid(code, field, message, cause) {
  return new ProviderModelManagementError(code, field, message, cause === undefined ? undefined : { cause });
}

function stateError(error) {
  return error instanceof ProviderModelManagementError ? error
    : invalid("provider-state-unavailable", "provider", "模型目录或关联配置无法安全读取，未执行模型操作", error);
}
