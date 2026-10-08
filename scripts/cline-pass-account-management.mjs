import { existsSync } from "node:fs";
import { clinePassAccountDirectory, clinePassAccountMarkerPath, clinePassAccountsFilePath, loadClinePassAccounts, validateClinePassAccounts } from "../runtime/cline-pass-accounts.mjs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { deepseekProviderDefinition, clinePassProviderDefinition as definition, clinePassAccountDefinition, isManagedProviderApiKeyValid } from "../runtime/model-provider-definitions.mjs";
import { createManagedProviderMarker } from "../runtime/model-provider-profile.mjs";
import { downloadDeepseekCatalog, createManagedDeepseekCatalog, deepseekSetupScriptUrl } from "./deepseek-setup.mjs";
import { loadResponsesModelTemplates, responsesModelTemplatesFromCatalog } from "./responses-model-templates.mjs";
import { createResponsesModelCatalog } from "../runtime/model-provider-responses-catalog.mjs";
import { clineRelayCatalogSchema, clineRelayReasoningEfforts, clineRelayInputModalities } from "../runtime/cline-relay-catalog.mjs";
import { downloadClineRelayCatalog } from "../runtime/cline-relay-catalog-update.mjs";
import { managedProviderDirectory, loadManagedModelProviderSettings, loadPrimaryModelProvider, withPreservedManagedModelCatalogSettings } from "../runtime/model-provider-runtime.mjs";
import { createManagedProviderConfiguration, hasProviderBaseConfig, restoreProviderBaseConfig } from "./managed-model-provider-setup.mjs";
import { applyProviderFileUpdates, assertProviderFileSnapshots, snapshotProviderFiles } from "./managed-provider-files.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { validateModelCatalogWithCodex } from "./model-catalog-validation.mjs";
import { inspectManagedAccountRuntime, stopManagedAccountForRemoval } from "./managed-provider-account-runtime.mjs";

export function clinePassSetupPaths(environment, accountId) {
  const definition = clinePassAccountDefinition(accountId);
  const directory = managedProviderDirectory(environment, definition);
  return {
    config: join(codexHomePath(environment), "config.toml"),
    profile: join(codexHomePath(environment), definition.profileFileName),
    marker: clinePassAccountMarkerPath(environment, accountId),
    registry: clinePassAccountsFilePath(environment),
    catalog: join(directory, definition.catalogFileName),
    manifest: join(directory, definition.catalogManifestFileName),
    backup: join(clinePassAccountDirectory(environment, accountId), definition.backupDirectoryName, "config.json"),
  };
}

function projectClinePassModels(source) {
  const catalog = clineRelayCatalogSchema.parse(source);
  const models = [], excludedModels = [];
  for (const model of catalog.models) {
    const efforts = clineRelayReasoningEfforts(model);
    const modalities = clineRelayInputModalities(model);
    let reason;
    if (!model.id.startsWith("cline-pass/") || model.id.length <= "cline-pass/".length) reason = "不是 Cline Pass 模型";
    else if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1024 || model.contextWindow > 100_000_000) reason = "缺少有效上下文窗口";
    else if (!model.capabilities?.includes("tools") || !modalities.includes("text")) reason = "未声明文本和工具能力";
    else if (model.modalities && !model.modalities.output.includes("text")) reason = "未声明文本输出";
    else if (efforts.length === 0) reason = "未声明可映射的思考等级或关闭开关";
    if (reason) { excludedModels.push({ model: model.id, reason }); continue; }
    models.push({
      id: model.id, name: model.name ?? model.id,
      contextWindow: model.contextWindow, maxContextWindow: model.contextWindow,
      reasoningEfforts: efforts,
      defaultReasoningEffort: efforts.includes("high") ? "high" : efforts[0],
      supportsImages: modalities.includes("image"), applyPatchToolType: "freeform", supportsSearchTool: true,
    });
  }
  if (models.length === 0) throw new Error("Cline 官方目录没有可接入 Codex 的模型，未修改本地目录");
  return { models, excludedModels };
}

export function createClinePassCatalog(templates, source, enabledModels) {
  const projected = projectClinePassModels(source).models;
  const models = enabledModels === undefined ? projected : projected.filter(model => enabledModels.includes(model.id));
  if (models.some(model => model.id === definition.defaultModel)) {
    const matches = templates.filter(model => model.id === "deepseek-flash");
    if (matches.length !== 1) throw new Error("DS 模型目录必须包含唯一的 deepseek-flash 模板");
    const template = matches[0];
    if (template.reasoningEfforts.some(effort => !["none", "low", "high", "max"].includes(effort))) throw new Error("DS 模板包含 CLP 未支持的思考等级");
    const flash = {
      id: definition.defaultModel, name: "CLP DeepSeek V4.1 Flash",
      contextWindow: template.contextWindow, maxContextWindow: template.maxContextWindow,
      reasoningEfforts: [...new Set(["none", ...template.reasoningEfforts])],
      defaultReasoningEffort: template.defaultReasoningEffort, supportsImages: template.supportsImages,
      applyPatchToolType: "freeform",
      ...(template.instructions === undefined ? {} : {instructions: template.instructions}),
      supportsSearchTool: true,
    };
    models[models.findIndex(model => model.id === flash.id)] = flash;
  }
  const defaultModel = models.find(model => model.id === definition.defaultModel)?.id ?? models[0]?.id;
  return { models: createResponsesModelCatalog(models, defaultModel).models };
}

async function selectClinePassModels(models, providers, selectModels) {
  const requiredModels = [...new Set(providers.map(provider => provider.model))];
  const enabledModels = providers.length ? providers[0].models.map(model => model.model)
    : [models.find(model => model.id === definition.defaultModel)?.id ?? models[0].id];
  const selection = {
    models: models.map(model => ({ id: model.id, name: model.name, reasoningEffort: providers[0]?.models.find(previous => previous.model === model.id && model.reasoningEfforts.includes(previous.reasoningEffort))?.reasoningEffort ?? model.defaultReasoningEffort })),
    enabledModels, requiredModels,
  };
  const selected = selectModels ? await selectModels(selection) : providers.length ? enabledModels : models.map(model => model.id);
  if (selected === undefined) return undefined;
  if (!Array.isArray(selected) || selected.length === 0 || selected.length > 64 || new Set(selected).size !== selected.length
    || selected.some(id => !models.some(model => model.id === id))) throw new Error("请选择 1–64 个有效且不重复的 CLP 模型");
  if (requiredModels.some(id => !selected.includes(id))) throw new Error("不能停用账户当前默认模型；请先修改账户默认模型，再调整启用列表");
  return selected;
}

export function previewClinePassConfiguration(input, { environment = process.env } = {}) {
  if (existsSync(join(codexHomePath(environment), "sf-cline-pass.config.toml"))) throw new Error("CLP 单账户配置不受支持，请先移除旧配置再重新设置账户");
  const definition = clinePassAccountDefinition(input.accountId);
  const mode = input.mode ?? "switching";
  if (!["switching", "exclusive"].includes(mode)) throw new Error("CLP 模式无效");
  if (!isManagedProviderApiKeyValid(definition, input.apiKey)) throw new Error("CLP API Key 无效");
  const accounts = loadClinePassAccounts(environment);
  const account = accounts.find(item => item.id === input.accountId);
  if (Boolean(account) !== (input.reconfigure === true)) throw new Error(account ? "账户已存在，请选择重新配置" : "CLP 账户不存在");
  validateClinePassAccounts(account ? accounts : [...accounts, { id: input.accountId, default: accounts.length === 0 }]);
  const previous = loadManagedModelProviderSettings(environment).find(item => item.provider === definition.id);
  if (account && !previous) throw new Error("CLP 账户配置不完整，请先恢复缺失文件");
  if (mode === "exclusive" && !["openai", definition.id].includes(loadPrimaryModelProvider(environment))) throw new Error("请先恢复当前固定 Provider");
  return { operation: account ? "reconfigure" : "add", account: { id: input.accountId, provider: definition.id, default: account?.default ?? accounts.length === 0 }, mode,
    effects: { writesMainConfig: mode === "exclusive" || previous?.mode === "exclusive", writesIsolatedProfile: mode === "switching" }, activation: "restart-all" };
}

export async function applyClinePassConfiguration(input, { environment = process.env, loadTemplates = loadResponsesModelTemplates, downloadCatalog = downloadDeepseekCatalog, downloadClineCatalog = downloadClineRelayCatalog, selectModels } = {}) {
  const { accountId, apiKey, mode = "switching", confirmExclusiveConfigChange = false } = input;
  const definition = clinePassAccountDefinition(accountId);
  return withModelProviderManagementTransaction(environment, async () => {
    const preview = previewClinePassConfiguration(input, { environment });
    if (mode === "exclusive" && confirmExclusiveConfigChange !== true) throw new Error("固定模式修改 Codex 主配置前必须确认");
    const accounts = loadClinePassAccounts(environment);
    const paths = clinePassSetupPaths(environment, accountId);
    const dsDirectory = managedProviderDirectory(environment, deepseekProviderDefinition);
    const dsCatalogPath = join(dsDirectory, deepseekProviderDefinition.catalogFileName);
    const dsManifestPath = join(dsDirectory, deepseekProviderDefinition.catalogManifestFileName);
    const snapshots = snapshotProviderFiles(Object.values(paths));
    const content = key => snapshots.find(item => item.path === paths[key]).content?.toString("utf8");
    const current = content("config") === undefined ? {} : parsePrivateConfig(content("config"));
    const previous = loadManagedModelProviderSettings(environment).find(item => item.provider === definition.id);
    if (!previous && (content("profile") !== undefined || content("marker") !== undefined || hasProviderBaseConfig(current, definition))) throw new Error("CLP 配置路径已被占用");
    const backup = content("backup") === undefined ? undefined : parsePrivateBackup(content("backup"));
    if (previous && !backup?.config) throw new Error("CLP 初始备份缺失");
    let downloadedDs;
    let downloadedCline;
    let catalog;
    const writesCatalog = content("catalog") === undefined;
    if (!writesCatalog) {
      try { catalog = JSON.parse(content("catalog")); }
      catch { throw new Error("CLP 模型目录无法安全读取"); }
    } else {
      if (accounts.length > 0) throw new Error("CLP 共享模型目录缺失，请先恢复文件");
      downloadedCline = await downloadClineCatalog(environment);
      const selected = await selectClinePassModels(projectClinePassModels(downloadedCline).models, [], selectModels);
      if (!selected) return { ...preview, activation: "none", action: "back", excludedModels: [] };
      let templates = [];
      if (selected.includes(definition.defaultModel)) {
        snapshots.push(...snapshotProviderFiles([dsCatalogPath, dsManifestPath]));
        if (snapshots.find(item => item.path === dsCatalogPath).content === undefined) {
          downloadedDs = createManagedDeepseekCatalog((await downloadCatalog(globalThis.fetch)).catalog);
        } else templates = await loadTemplates("deepseek", environment);
      }
      catalog = createClinePassCatalog(downloadedDs
        ? responsesModelTemplatesFromCatalog(downloadedDs, "deepseek")
        : templates, downloadedCline, selected);
    }
    await validateModelCatalogWithCodex(catalog, environment);
    const initial = previous && !(previous.mode === "switching" && mode === "exclusive") ? backup.config : current;
    const { config, profile } = createManagedProviderConfiguration(current, initial, definition, {
      mode, previousMode: previous?.mode, apiKey, catalogPath: paths.catalog, catalog,
      model: previous?.model ?? (catalog.models.some(model => model.slug === definition.defaultModel) ? definition.defaultModel : catalog.models[0]?.slug),
    });
    const updates = new Map([
      [paths.backup, `${JSON.stringify({ config: initial })}\n`],
      [paths.profile, profile === undefined ? undefined : stringify(profile)],
      [paths.marker, stringify(createManagedProviderMarker(definition, mode))],
    ]);
    if (writesCatalog) {
      updates.set(paths.catalog, `${JSON.stringify(catalog, null, 2)}\n`);
      updates.set(paths.manifest, `${JSON.stringify(clinePassManifest(downloadedCline, catalog), null, 2)}\n`);
    }
    if (!previous) updates.set(paths.registry, `${JSON.stringify(validateClinePassAccounts([...accounts, { id: accountId, default: accounts.length === 0 }]))}\n`);
    if (downloadedDs) {
      updates.set(dsCatalogPath, `${JSON.stringify(downloadedDs, null, 2)}\n`);
      updates.set(dsManifestPath, `${JSON.stringify({ source: deepseekSetupScriptUrl, downloadedAt: new Date().toISOString() })}\n`);
    }
    if (content("backup") !== undefined && JSON.stringify(backup.config) !== JSON.stringify(initial)) {
      const archive = `${paths.backup}.${randomUUID()}`;
      snapshots.push(...snapshotProviderFiles([archive]));
      updates.set(archive, content("backup"));
    }
    if (mode === "exclusive" || previous?.mode === "exclusive") updates.set(paths.config, stringify(config));
    await applyProviderFileUpdates(updates, snapshots);
    return { ...preview, action: "configured", excludedModels: downloadedCline ? projectClinePassModels(downloadedCline).excludedModels : [] };
  });
}

function clinePassManifest(source, catalog) {
  return { ...(catalog.models.some(model => model.slug === definition.defaultModel)
    ? { source: "deepseek", model: "deepseek-flash" } : { source: "cline" }),
  cline: { commit: source.commit, downloadedAt: source.downloadedAt } };
}

/** Explicit shared catalog refresh; account credentials and selected models remain unchanged. */
export async function refreshClinePassCatalog({ environment = process.env, loadTemplates = loadResponsesModelTemplates, downloadCatalog = downloadDeepseekCatalog, downloadClineCatalog = downloadClineRelayCatalog, selectModels } = {}) {
  return withModelProviderManagementTransaction(environment, async () => {
    const accounts = loadClinePassAccounts(environment);
    if (accounts.length === 0) throw new Error("请先配置 CLP 账户");
    const paths = clinePassSetupPaths(environment, accounts[0].id);
    const dsCatalog = join(managedProviderDirectory(environment, deepseekProviderDefinition), deepseekProviderDefinition.catalogFileName);
    const dsManifest = join(managedProviderDirectory(environment, deepseekProviderDefinition), deepseekProviderDefinition.catalogManifestFileName);
    const backups = [paths.catalog, paths.manifest].map(path => `${path}.backup`);
    const snapshots = snapshotProviderFiles([
      ...accounts.flatMap(account => Object.values(clinePassSetupPaths(environment, account.id))), ...backups,
    ]);
    const providers = loadManagedModelProviderSettings(environment).filter(provider => accounts.some(account => provider.provider === clinePassAccountDefinition(account.id).id));
    if (providers.length !== accounts.length) throw new Error("CLP 账户配置不完整，未更新模型目录");
    const source = await downloadClineCatalog(environment);
    const projected = projectClinePassModels(source);
    const selectedModels = await selectClinePassModels(projected.models, providers, selectModels);
    if (!selectedModels) return { action: "back", activation: "none", models: [], excludedModels: projected.excludedModels, commit: source.commit };
    let downloadedDs, templates = [];
    if (selectedModels.includes(definition.defaultModel)) {
      snapshots.push(...snapshotProviderFiles([dsCatalog, dsManifest]));
      if (snapshots.find(snapshot => snapshot.path === dsCatalog).content === undefined) {
        downloadedDs = createManagedDeepseekCatalog((await downloadCatalog(globalThis.fetch)).catalog);
      } else templates = await loadTemplates("deepseek", environment);
    }
    let catalog = createClinePassCatalog(downloadedDs ? responsesModelTemplatesFromCatalog(downloadedDs, "deepseek") : templates, source, selectedModels);
    catalog = withPreservedManagedModelCatalogSettings(catalog, definition, providers[0].models.filter(model => model.model !== definition.defaultModel));
    for (const model of catalog.models) {
      const previous = providers[0].models.find(entry => entry.model === model.slug);
      // Flash follows the exact DS window; unchanged maxima must not round an existing window.
      if (model.slug === definition.defaultModel) {
        if (model.supported_reasoning_levels.some(level => level.effort === previous?.reasoningEffort)) model.default_reasoning_level = previous.reasoningEffort;
      } else if (previous?.maxContextWindow === model.max_context_window) model.context_window = previous.contextWindow;
    }
    for (const provider of providers) {
      const selected = catalog.models.find(model => model.slug === provider.model);
      if (!selected || selected.default_reasoning_level !== provider.reasoningEffort) {
        throw new Error(`CLP 账户 ${provider.provider} 的默认模型或思考等级已不受新目录支持；请先调整默认设置，原目录已保留`);
      }
    }
    await validateModelCatalogWithCodex(catalog, environment);
    const updates = new Map();
    for (const path of [paths.catalog, paths.manifest]) {
      const previous = snapshots.find(snapshot => snapshot.path === path)?.content;
      if (!previous) throw new Error("CLP 原模型目录或来源缺失，未更新");
      updates.set(`${path}.backup`, previous.toString("utf8"));
    }
    updates.set(paths.catalog, `${JSON.stringify(catalog, null, 2)}\n`);
    updates.set(paths.manifest, `${JSON.stringify(clinePassManifest(source, catalog), null, 2)}\n`);
    if (downloadedDs && catalog.models.some(model => model.slug === definition.defaultModel)) {
      updates.set(dsCatalog, `${JSON.stringify(downloadedDs, null, 2)}\n`);
      updates.set(dsManifest, `${JSON.stringify({ source: deepseekSetupScriptUrl, downloadedAt: new Date().toISOString() })}\n`);
    }
    await assertProviderFileSnapshots(snapshots);
    await applyProviderFileUpdates(updates, snapshots);
    return { action: "catalog-updated", activation: "restart-all", models: catalog.models.map(model => model.slug), excludedModels: projected.excludedModels, commit: source.commit };
  });
}

function clinePassRemovalPlan(accountId, environment) {
  const definition = clinePassAccountDefinition(accountId);
  const accounts = loadClinePassAccounts(environment);
  if (!accounts.some(account => account.id === accountId)) throw new Error("CLP 账户不存在");
  const remaining = accounts.filter(account => account.id !== accountId);
  if (remaining.length > 0 && !remaining.some(account => account.default)) throw new Error("请先选择其他默认账户");
  const paths = clinePassSetupPaths(environment, accountId);
  const previous = loadManagedModelProviderSettings(environment).find(item => item.provider === definition.id);
  if (!previous) throw new Error("CLP 账户配置不完整，请先恢复缺失文件");
  const snapshots = snapshotProviderFiles(Object.values(paths));
  const content = key => snapshots.find(item => item.path === paths[key]).content?.toString("utf8");
  const updates = new Map([paths.profile, paths.marker].map(path => [path, undefined]));
  updates.set(paths.registry, remaining.length === 0 ? undefined : `${JSON.stringify(remaining)}\n`);
  if (remaining.length === 0) {
    updates.set(paths.catalog, undefined);
    updates.set(paths.manifest, undefined);
  }
  if (previous.mode === "exclusive") {
    if (content("backup") === undefined) throw new Error("CLP 初始备份缺失");
    const backup = parsePrivateBackup(content("backup"));
    updates.set(paths.config, stringify(restoreProviderBaseConfig(parsePrivateConfig(content("config")), backup.config, definition)));
  }
  return { definition, updates, snapshots, restoresInitialConfig: previous.mode === "exclusive" };
}

export async function previewClinePassRemoval(accountId, options = {}) {
  const plan = clinePassRemovalPlan(accountId, options.environment ?? process.env);
  const runtime = await inspectManagedAccountRuntime(plan.definition.id, options);
  return { operation: "remove", account: { id: accountId, provider: plan.definition.id },
    effects: { stopsRunningAppServer: runtime.running, historyThreadsBecomeUnavailable: true, preservesPrivateBackup: true, restoresInitialConfig: plan.restoresInitialConfig }, activation: "restart-all" };
}

export async function removeClinePassConfiguration({ accountId, confirmRemove = false }, options = {}) {
  if (!confirmRemove) throw new Error("移除 CLP 前必须确认");
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(environment, async () => {
    const plan = clinePassRemovalPlan(accountId, environment);
    await stopManagedAccountForRemoval(plan.definition.id, options);
    await applyProviderFileUpdates(plan.updates, plan.snapshots);
    return { action: "removed", accountId, activation: "restart-all" };
  });
}

export function previewClinePassDefaultAccount(accountId, { environment = process.env } = {}) {
  const account = loadClinePassAccounts(environment).find(item => item.id === accountId);
  if (!account) throw new Error("CLP 账户不存在");
  return { operation: "default", account: { ...account, provider: clinePassAccountDefinition(accountId).id }, activation: "restart-all" };
}

export async function setClinePassDefaultAccount(accountId, { environment = process.env } = {}) {
  return withModelProviderManagementTransaction(environment, async () => {
    const preview = previewClinePassDefaultAccount(accountId, { environment });
    const accounts = loadClinePassAccounts(environment).map(account => ({ ...account, default: account.id === accountId }));
    const path = clinePassAccountsFilePath(environment);
    await applyProviderFileUpdates(new Map([[path, `${JSON.stringify(validateClinePassAccounts(accounts))}\n`]]), snapshotProviderFiles([path]));
    return { ...preview, account: { ...preview.account, default: true }, action: "default-set" };
  });
}


function parsePrivateConfig(content) {
  try { return parse(content); } catch {
    throw new Error("Codex 配置无法解析；请检查私有配置文件");
  }
}
function parsePrivateBackup(content) {
  try {
    const value = JSON.parse(content);
    if (!value?.config || typeof value.config !== "object" || Array.isArray(value.config)) throw new Error("invalid backup");
    return value;
  } catch {
    throw new Error("CLP 初始备份无效");
  }
}
