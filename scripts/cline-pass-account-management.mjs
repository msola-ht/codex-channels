import { existsSync } from "node:fs";
import { AccountManagementError } from "./account-management-error.mjs";
import { clinePassAccountDirectory, clinePassAccountMarkerPath, clinePassAccountsFilePath, loadClinePassAccounts, validateClinePassAccounts } from "../runtime/cline-pass-accounts.mjs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { clinePassProviderDefinition as definition, clinePassAccountDefinition } from "../runtime/model-provider-definitions.mjs";
import { createManagedProviderMarker } from "../runtime/model-provider-profile.mjs";
import { loadResponsesModelTemplates } from "./responses-model-templates.mjs";
import { createResponsesModelCatalog } from "../runtime/model-provider-responses-catalog.mjs";
import { validateEnabledModelSelection } from "./provider-model-selection.mjs";
import { createClinePassCatalogWithTemplateBindings } from "./provider-model-catalog.mjs";
import { managedProviderDirectory, loadManagedModelProviderSettings } from "../runtime/model-provider-runtime.mjs";
import { createManagedProviderConfiguration, hasProviderBaseConfig, restoreProviderBaseConfig } from "./managed-model-provider-setup.mjs";
import { applyProviderFileUpdates, assertProviderFileSnapshots, snapshotProviderFiles, stageManagedPrimaryCredential } from "./managed-provider-files.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { validateModelCatalogWithCodex } from "./model-catalog-validation.mjs";
import { inspectManagedAccountRuntime, stopManagedAccountForRemoval } from "./managed-provider-account-runtime.mjs";
import { assertManagedAccountMode, snapshotManagedAccountFiles, managedAccountRevision, assertManagedAccountRevision, managedAccountConfigurationEdit } from "./managed-provider-account-plan.mjs";

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

export function createClinePassCatalog(templates, enabledModels, environment = process.env) {
  const generated = createClinePassCatalogWithTemplateBindings(createResponsesModelCatalog(templates, templates[0]?.id, undefined, environment), environment);
  if (enabledModels !== undefined) {
    generated.catalog.models = generated.catalog.models.filter(model => enabledModels.includes(model.slug));
    generated.templateBindings = Object.fromEntries(Object.entries(generated.templateBindings).filter(([id]) => enabledModels.includes(id)));
  }
  return generated;
}

async function selectClinePassModels(models, providers, selectModels) {
  const requiredModels = [...new Set(providers.map(provider => provider.model))];
  const enabledModels = providers.length ? providers[0].models.map(model => model.model)
    : [models.find(model => model.id === definition.defaultModel)?.id ?? models[0].id];
  const selection = {
    models: models.map(model => ({ id: model.id, name: model.name, reasoningEffort: providers[0]?.models.find(previous => previous.model === model.id && model.reasoningEfforts?.includes(previous.reasoningEffort))?.reasoningEffort ?? model.defaultReasoningEffort })),
    enabledModels, requiredModels, retainedModels: providers.length ? enabledModels : [],
  };
  const selected = selectModels ? await selectModels(selection) : providers.length ? enabledModels : models.map(model => model.id);
  if (selected === undefined) return undefined;
  return validateEnabledModelSelection(selected, { models, requiredModels, retainedModels: selection.retainedModels });
}

export function previewClinePassConfiguration(input, { environment = process.env } = {}) {
  return clinePassConfigurationPlan(input, environment).preview;
}

function clinePassConfigurationPlan(input, environment) {
  if (existsSync(join(codexHomePath(environment), "sf-cline-pass.config.toml"))) throw new AccountManagementError("provider-state-unavailable", "accountId", "CLP 单账户配置不受支持，请先移除旧配置再重新设置账户");
  const definition = clinePassAccountDefinition(input.accountId);
  const accounts = loadClinePassAccounts(environment);
  const account = accounts.find(item => item.id === input.accountId);
  if (Boolean(account) !== (input.reconfigure === true)) throw new AccountManagementError(account ? "account-exists" : "account-not-found", "accountId", account ? "账户已存在，请选择重新配置" : "CLP 账户不存在");
  validateClinePassAccounts(account ? accounts : [...accounts, { id: input.accountId, default: accounts.length === 0 }]);
  const previous = loadManagedModelProviderSettings(environment).find(item => item.provider === definition.id);
  if (account && !previous) throw new AccountManagementError("provider-state-unavailable", "accountId", "CLP 账户配置不完整，请先恢复缺失文件");
  const { apiKey, ...edit } = managedAccountConfigurationEdit(input, previous, definition, environment);
  const { mode, willChange } = edit;
  assertManagedAccountMode(mode, definition, environment);
  return { apiKey, preview: { revision: managedAccountRevision(snapshotManagedAccountFiles(Object.values(clinePassSetupPaths(environment, input.accountId)), definition, environment)), operation: account ? "reconfigure" : "add", account: { id: input.accountId, provider: definition.id, default: account?.default ?? accounts.length === 0 }, ...edit,
    effects: { writesMainConfig: willChange && (mode === "exclusive" || previous?.mode === "exclusive"), writesIsolatedProfile: willChange && mode === "switching" }, activation: willChange ? "restart-all" : "none" } };
}

export async function applyClinePassConfiguration(input, { environment = process.env, loadTemplates = loadResponsesModelTemplates, selectModels } = {}) {
  const { accountId, confirmExclusiveConfigChange = false } = input;
  const definition = clinePassAccountDefinition(accountId);
  return withModelProviderManagementTransaction(environment, async () => {
    const { preview, apiKey } = clinePassConfigurationPlan(input, environment);
    const { mode } = preview;
    assertManagedAccountRevision(input.expectedRevision, preview.revision);
    if (preview.effects.writesMainConfig && confirmExclusiveConfigChange !== true) throw new AccountManagementError("confirmation-required", "confirmExclusiveConfigChange", "修改 Codex 主配置前必须明确确认");
    const accounts = loadClinePassAccounts(environment);
    const paths = clinePassSetupPaths(environment, accountId);
    const snapshots = snapshotManagedAccountFiles(Object.values(paths), definition, environment);
    assertManagedAccountRevision(preview.revision, managedAccountRevision(snapshots));
    const content = key => snapshots.find(item => item.path === paths[key]).content?.toString("utf8");
    const current = content("config") === undefined ? {} : parsePrivateConfig(content("config"));
    const previous = loadManagedModelProviderSettings(environment).find(item => item.provider === definition.id);
    if (!previous && (content("profile") !== undefined || content("marker") !== undefined || hasProviderBaseConfig(current, definition))) throw new AccountManagementError("config-path-conflict", "accountId", "CLP 配置路径已被占用");
    const backup = content("backup") === undefined ? undefined : parsePrivateBackup(content("backup"));
    if (previous && !backup?.config) throw new AccountManagementError("backup-unavailable", "accountId", "CLP 初始备份缺失");
    let templateBindings;
    let catalog;
    const writesCatalog = content("catalog") === undefined;
    if (!writesCatalog) {
      try { catalog = JSON.parse(content("catalog")); }
      catch { throw new Error("CLP 模型目录无法安全读取"); }
    } else {
      const templates = await loadTemplates("deepseek", environment);
      const generated = createClinePassCatalog(templates, undefined, environment);
      const models = generated.catalog.models.map(model => ({ id: model.slug, name: model.display_name, defaultReasoningEffort: model.default_reasoning_level }));
      const selected = await selectClinePassModels(models, [], selectModels);
      if (!selected) return { ...preview, activation: "none", action: "back", excludedModels: [] };
      ({ catalog, templateBindings } = createClinePassCatalog(templates, selected, environment));
    }
    await validateModelCatalogWithCodex(catalog, environment);
    if (!preview.willChange) {
      await assertProviderFileSnapshots(snapshots);
      return { ...preview, action: "unchanged", excludedModels: [] };
    }
    const initial = previous && !(previous.mode === "switching" && mode === "exclusive") ? backup.config : current;
    const { config, profile, credential } = createManagedProviderConfiguration(current, initial, definition, {
      mode, previousMode: previous?.mode, apiKey, catalogPath: paths.catalog, catalog,
      previousProfile: content("profile"),
      model: previous?.model ?? (catalog.models.some(model => model.slug === definition.defaultModel) ? definition.defaultModel : catalog.models[0]?.slug),
    });
    const updates = new Map([
      [paths.backup, `${JSON.stringify({ config: initial }, null, 2)}\n`],
      [paths.profile, profile === undefined ? undefined : stringify(profile)],
      [paths.marker, stringify(createManagedProviderMarker(definition, mode))],
    ]);
    if (writesCatalog) {
      updates.set(paths.catalog, `${JSON.stringify(catalog, null, 2)}\n`);
      updates.set(paths.manifest, `${JSON.stringify({ source: "deepseek", modelTemplates: templateBindings }, null, 2)}\n`);
    }
    if (!previous) updates.set(paths.registry, `${JSON.stringify(validateClinePassAccounts([...accounts, { id: accountId, default: accounts.length === 0 }]), null, 2)}\n`);
    if (content("backup") !== undefined && JSON.stringify(backup.config) !== JSON.stringify(initial)) {
      const archive = `${paths.backup}.${randomUUID()}`;
      snapshots.push(...snapshotProviderFiles([archive], environment));
      updates.set(archive, content("backup"));
    }
    if (mode === "exclusive" || previous?.mode === "exclusive") updates.set(paths.config, stringify(config));
    stageManagedPrimaryCredential(credential, definition, environment, snapshots, updates);
    await applyProviderFileUpdates(updates, snapshots);
    return { ...preview, action: "configured", excludedModels: [] };
  });
}

function clinePassRemovalPlan(accountId, environment) {
  const definition = clinePassAccountDefinition(accountId);
  const accounts = loadClinePassAccounts(environment);
  if (!accounts.some(account => account.id === accountId)) throw new AccountManagementError("account-not-found", "accountId", "CLP 账户不存在");
  const remaining = accounts.filter(account => account.id !== accountId);
  if (remaining.length > 0 && !remaining.some(account => account.default)) throw new AccountManagementError("default-account-conflict", "accountId", "请先选择其他默认账户");
  const paths = clinePassSetupPaths(environment, accountId);
  const previous = loadManagedModelProviderSettings(environment).find(item => item.provider === definition.id);
  if (!previous) throw new AccountManagementError("provider-state-unavailable", "accountId", "CLP 账户配置不完整，请先恢复缺失文件");
  const snapshots = snapshotManagedAccountFiles(Object.values(paths), definition, environment);
  const content = key => snapshots.find(item => item.path === paths[key]).content?.toString("utf8");
  const updates = new Map([paths.profile, paths.marker].map(path => [path, undefined]));
  updates.set(paths.registry, remaining.length === 0 ? undefined : `${JSON.stringify(remaining, null, 2)}\n`);
  if (previous.mode === "exclusive") {
    if (content("backup") === undefined) throw new AccountManagementError("backup-unavailable", "accountId", "CLP 初始备份缺失");
    const backup = parsePrivateBackup(content("backup"));
    updates.set(paths.config, stringify(restoreProviderBaseConfig(parsePrivateConfig(content("config")), backup.config, definition)));
  }
  return { definition, updates, snapshots, restoresInitialConfig: previous.mode === "exclusive" };
}

export async function previewClinePassRemoval(accountId, options = {}) {
  const plan = clinePassRemovalPlan(accountId, options.environment ?? process.env);
  const runtime = await inspectManagedAccountRuntime(plan.definition.id, options);
  return { revision: managedAccountRevision(plan.snapshots), operation: "remove", account: { id: accountId, provider: plan.definition.id },
    effects: { stopsRunningAppServer: runtime.registered, historyThreadsBecomeUnavailable: true, preservesPrivateBackup: true, restoresInitialConfig: plan.restoresInitialConfig }, activation: "restart-all" };
}

export async function removeClinePassConfiguration({ accountId, confirmRemove = false, expectedRevision }, options = {}) {
  if (!confirmRemove) throw new AccountManagementError("confirmation-required", "confirmRemove", "移除 CLP 前必须确认");
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(environment, async () => {
    const plan = clinePassRemovalPlan(accountId, environment);
    assertManagedAccountRevision(expectedRevision, managedAccountRevision(plan.snapshots));
    await stopManagedAccountForRemoval(plan.definition.id, options);
    await applyProviderFileUpdates(plan.updates, plan.snapshots);
    return { action: "removed", accountId, activation: "restart-all" };
  });
}

export function previewClinePassDefaultAccount(accountId, { environment = process.env } = {}) {
  const revision = managedAccountRevision(snapshotProviderFiles([clinePassAccountsFilePath(environment)], environment));
  const account = loadClinePassAccounts(environment).find(item => item.id === accountId);
  if (!account) throw new AccountManagementError("account-not-found", "accountId", "CLP 账户不存在");
  return { revision, operation: "default", account: { ...account, provider: clinePassAccountDefinition(accountId).id }, willChange: !account.default, activation: account.default ? "none" : "restart-all" };
}

export async function setClinePassDefaultAccount(accountId, { environment = process.env, expectedRevision } = {}) {
  return withModelProviderManagementTransaction(environment, async () => {
    const preview = previewClinePassDefaultAccount(accountId, { environment });
    assertManagedAccountRevision(expectedRevision, preview.revision);
    const path = clinePassAccountsFilePath(environment);
    const snapshots = snapshotProviderFiles([path], environment);
    assertManagedAccountRevision(preview.revision, managedAccountRevision(snapshots));
    if (!preview.willChange) return { ...preview, action: "unchanged" };
    const accounts = loadClinePassAccounts(environment).map(account => ({ ...account, default: account.id === accountId }));
    await applyProviderFileUpdates(new Map([[path, `${JSON.stringify(validateClinePassAccounts(accounts), null, 2)}\n`]]), snapshots);
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
