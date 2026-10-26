import { AccountManagementError } from "./account-management-error.mjs";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { parse, stringify } from "smol-toml";

import { codexHomePath } from "../runtime/codex-home.mjs";
import {
  deepseekAccountDirectory, deepseekAccountMarkerPath, deepseekAccountsFilePath,
  loadDeepseekAccounts, validateDeepseekAccounts,
} from "../runtime/deepseek-accounts.mjs";
import { deepseekAccountDefinition } from "../runtime/model-provider-definitions.mjs";
import { createManagedProviderMarker } from "../runtime/model-provider-profile.mjs";
import {
  loadManagedModelProviderSettings,
  managedProviderDirectory,
} from "../runtime/model-provider-runtime.mjs";
import { createProviderFileReader } from "../runtime/provider-file-access.mjs";
import { applyProviderFileUpdates, assertProviderFileSnapshots, snapshotProviderFiles, stageManagedPrimaryCredential } from "./managed-provider-files.mjs";
import { createManagedProviderConfiguration, hasProviderBaseConfig, resolveManagedCatalogModel, restoreProviderBaseConfig } from "./managed-model-provider-setup.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { inspectManagedAccountRuntime, stopManagedAccountForRemoval } from "./managed-provider-account-runtime.mjs";
import { createManagedDeepseekCatalog, downloadDeepseekCatalog, deepseekSetupScriptUrl } from "./deepseek-setup.mjs";
import { readModelTemplateBindings } from "../runtime/model-template-bindings.mjs";
import { validateModelCatalogWithCodex } from "./model-catalog-validation.mjs";
import { assertManagedAccountMode, snapshotManagedAccountFiles, managedAccountRevision, assertManagedAccountRevision, managedAccountConfigurationEdit } from "./managed-provider-account-plan.mjs";

export function deepseekAccountPaths(environment, accountId) {
  const definition = deepseekAccountDefinition(accountId);
  const directory = managedProviderDirectory(environment, definition);
  return {
    config: join(codexHomePath(environment), "config.toml"),
    profile: join(codexHomePath(environment), definition.profileFileName),
    marker: deepseekAccountMarkerPath(environment, accountId),
    backup: join(deepseekAccountDirectory(environment, accountId), "backup", "config.json"),
    registry: deepseekAccountsFilePath(environment),
    catalog: join(directory, definition.catalogFileName),
    manifest: join(directory, definition.catalogManifestFileName),
  };
}

function readToml(path, environment) {
  try { return parse(createProviderFileReader(environment)(path, 2_097_152)); }
  catch (error) {
    if (error?.code === "ENOENT") return {};
    // TOML 解析错误可能包含凭据，不携带原始 cause。
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`无法安全读取 Provider 配置：${path}`);
  }
}

function readBackup(path, environment) {
  if (!existsSync(path)) return undefined;
  let value;
  try { value = JSON.parse(createProviderFileReader(environment)(path)); }
  catch { throw new Error("DeepSeek 安装备份无法安全读取"); }
  if (!value?.config || typeof value.config !== "object" || Array.isArray(value.config)) {
    throw new Error("DeepSeek 安装备份无效");
  }
  return value;
}

export function previewDeepseekAccountConfiguration(input, { environment = process.env } = {}) {
  return deepseekConfigurationPlan(input, environment).preview;
}

function deepseekConfigurationPlan(input, environment) {
  const definition = deepseekAccountDefinition(input.accountId);
  const accounts = loadDeepseekAccounts(environment);
  const previous = accounts.find((account) => account.id === input.accountId);
  if (Boolean(previous) !== (input.reconfigure === true)) {
    throw new AccountManagementError(previous ? "account-exists" : "account-not-found", "accountId", previous ? "账户已存在，请选择重新配置" : "DeepSeek 账户不存在");
  }
  validateDeepseekAccounts(previous ? accounts : [...accounts, { id: input.accountId, default: accounts.length === 0 }]);
  const configured = previous ? loadManagedModelProviderSettings(environment)
    .find((provider) => provider.provider === definition.id) : undefined;
  if (previous && !configured) throw new AccountManagementError("provider-state-unavailable", "accountId", "DeepSeek 账户配置不完整，请先恢复缺失文件");
  const { apiKey, ...edit } = managedAccountConfigurationEdit(input, configured, definition, environment);
  const { mode, willChange } = edit;
  assertManagedAccountMode(mode, definition, environment);
  return { apiKey, preview: {
    revision: managedAccountRevision(snapshotManagedAccountFiles(Object.values(deepseekAccountPaths(environment, input.accountId)), definition, environment)),
    operation: previous ? "reconfigure" : "add",
    account: { id: input.accountId, provider: definition.id, exists: Boolean(previous), default: previous?.default ?? accounts.length === 0 },
    ...edit,
    effects: { writesMainConfig: willChange && (mode === "exclusive" || configured?.mode === "exclusive"), writesIsolatedProfile: willChange && mode === "switching", downloadsCatalog: !existsSync(deepseekAccountPaths(environment, input.accountId).catalog) },
    confirmation: { required: willChange && (mode === "exclusive" || configured?.mode === "exclusive"), field: "confirmExclusiveConfigChange" },
    activation: willChange ? "restart-all" : "none",
  } };
}

export async function applyDeepseekAccountConfiguration(input, options = {}) {
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(environment, async () => {
    const { preview, apiKey } = deepseekConfigurationPlan(input, environment);
    assertManagedAccountRevision(input.expectedRevision, preview.revision);
    const definition = deepseekAccountDefinition(input.accountId);
    if (preview.effects.writesMainConfig && input.confirmExclusiveConfigChange !== true) throw new AccountManagementError("confirmation-required", "confirmExclusiveConfigChange", "修改 Codex 主配置前必须明确确认");
    const paths = deepseekAccountPaths(environment, input.accountId);
    const snapshots = snapshotManagedAccountFiles(Object.values(paths), definition, environment);
    assertManagedAccountRevision(preview.revision, managedAccountRevision(snapshots));
    const accounts = loadDeepseekAccounts(environment);
    const providers = loadManagedModelProviderSettings(environment);
    const previous = providers.find((provider) => provider.provider === definition.id);
    if (input.reconfigure && !previous) throw new AccountManagementError("provider-state-unavailable", "accountId", "DeepSeek 账户配置不完整，请先恢复缺失文件");
    const current = readToml(paths.config, environment);
    if (!previous && (hasProviderBaseConfig(current, definition) || existsSync(paths.profile) || existsSync(paths.marker))) throw new AccountManagementError("config-path-conflict", "accountId", "DeepSeek 账户配置路径已被占用");
    const backup = readBackup(paths.backup, environment);
    if (previous && !backup) throw new AccountManagementError("backup-unavailable", "accountId", "DeepSeek 账户初始备份缺失");
    const entersExclusiveMode = previous?.mode === "switching" && preview.mode === "exclusive";
    const initial = previous && !entersExclusiveMode ? backup : { config: current };
    const updates = new Map();
    if ((!previous || entersExclusiveMode) && backup) {
      const archive = join(dirname(paths.backup), `config-${randomUUID()}.json`);
      const [snapshot] = snapshotProviderFiles([archive], environment);
      if (snapshot.content !== undefined) throw new Error("DeepSeek 备份归档路径已被占用");
      snapshots.push(snapshot);
      updates.set(archive, snapshots.find((item) => item.path === paths.backup).content);
    }
    let catalog;
    if (existsSync(paths.catalog)) {
      catalog = JSON.parse(createProviderFileReader(environment)(paths.catalog, 2_097_152));
    } else {
      const downloaded = await (options.downloadCatalog ?? downloadDeepseekCatalog)(options.fetchImpl ?? fetch);
      catalog = createManagedDeepseekCatalog(downloaded.catalog, undefined, null, environment);
      updates.set(paths.catalog, `${JSON.stringify(catalog, null, 2)}\n`);
      const modelIds = catalog.models.map(model => model.slug);
      const modelTemplates = readModelTemplateBindings({ modelTemplates: Object.fromEntries(
        modelIds.map(model => [model, { source: "deepseek", model }]),
      ) }, modelIds);
      updates.set(paths.manifest, `${JSON.stringify({ source: deepseekSetupScriptUrl,
        downloadedAt: new Date().toISOString(), modelTemplates }, null, 2)}\n`);
    }
    await validateModelCatalogWithCodex(catalog, environment);
    const model = resolveManagedCatalogModel(catalog, definition, previous?.model);
    if (!preview.willChange) {
      await assertProviderFileSnapshots(snapshots);
      return { ...preview, action: "unchanged", model };
    }
    const configured = createManagedProviderConfiguration(current, initial.config, definition, {
      mode: preview.mode, previousMode: previous?.mode, apiKey,
      previousProfile: snapshots.find(item => item.path === paths.profile)?.content?.toString("utf8"),
      catalogPath: paths.catalog, catalog, model,
    });
    updates.set(paths.backup, `${JSON.stringify(initial, null, 2)}\n`);
    updates.set(paths.profile, configured.profile === undefined ? undefined : stringify(configured.profile));
    updates.set(paths.marker, stringify(createManagedProviderMarker(definition, preview.mode)));
    if (preview.mode === "exclusive" || previous?.mode === "exclusive") updates.set(paths.config, stringify(configured.config));
    if (!previous) updates.set(paths.registry, `${JSON.stringify(validateDeepseekAccounts([...accounts, { id: input.accountId, default: accounts.length === 0 }]), null, 2)}\n`);
    stageManagedPrimaryCredential(configured.credential, definition, environment, snapshots, updates);
    await applyProviderFileUpdates(updates, snapshots);
    return { ...preview, action: "configured", model };
  });
}

export function previewDeepseekDefaultAccount(accountId, { environment = process.env } = {}) {
  const snapshots = snapshotProviderFiles([deepseekAccountsFilePath(environment)], environment);
  const account = loadDeepseekAccounts(environment).find(entry => entry.id === accountId);
  if (!account) throw new AccountManagementError("account-not-found", "accountId", "DeepSeek 账户不存在");
  return { operation: "default", account: { ...account, provider: deepseekAccountDefinition(accountId).id },
    revision: managedAccountRevision(snapshots), willChange: !account.default, activation: account.default ? "none" : "restart-all" };
}

export async function setDeepseekDefaultAccount(accountId, { environment = process.env, expectedRevision } = {}) {
  return withModelProviderManagementTransaction(environment, async () => {
    const path = deepseekAccountsFilePath(environment);
    const snapshots = snapshotProviderFiles([path], environment);
    assertManagedAccountRevision(expectedRevision, managedAccountRevision(snapshots));
    const accounts = loadDeepseekAccounts(environment);
    if (!accounts.some((account) => account.id === accountId)) throw new AccountManagementError("account-not-found", "accountId", "DeepSeek 账户不存在");
    if (accounts.find(account => account.id === accountId).default) return { action: "unchanged", accountId, activation: "none" };
    await applyProviderFileUpdates(new Map([[path, `${JSON.stringify(
      accounts.map((account) => ({ ...account, default: account.id === accountId })), null, 2,
    )}\n`]]), snapshots);
    return { action: "default-set", accountId, activation: "restart-all" };
  });
}

function deepseekAccountRemovalPlan(accountId, environment) {
  const paths = deepseekAccountPaths(environment, accountId);
  const definition = deepseekAccountDefinition(accountId);
  const accounts = loadDeepseekAccounts(environment);
  if (!accounts.some((account) => account.id === accountId)) throw new AccountManagementError("account-not-found", "accountId", "DeepSeek 账户不存在");
  const configured = loadManagedModelProviderSettings(environment).find((provider) => provider.provider === definition.id);
  if (!configured) throw new AccountManagementError("provider-state-unavailable", "accountId", "DeepSeek 账户配置不完整，请先恢复缺失文件");
  const remaining = accounts.filter((account) => account.id !== accountId);
  if (remaining.length > 0 && !remaining.some((account) => account.default)) throw new AccountManagementError("default-account-conflict", "accountId", "请先选择其他默认账户");
  const snapshots = snapshotManagedAccountFiles(Object.values(paths), definition, environment);
  const updates = new Map([[paths.profile, undefined], [paths.marker, undefined], [paths.registry, remaining.length === 0 ? undefined : `${JSON.stringify(remaining, null, 2)}\n`]]);
  if (configured.mode === "exclusive") {
    const initial = readBackup(paths.backup, environment);
    if (!initial) throw new AccountManagementError("backup-unavailable", "accountId", "DeepSeek 账户初始备份缺失");
    updates.set(paths.config, stringify(restoreProviderBaseConfig(readToml(paths.config, environment), initial.config, definition)));
  }
  return { definition, updates, snapshots, restoresInitialConfig: configured.mode === "exclusive" };
}

export async function previewDeepseekAccountRemoval(accountId, options = {}) {
  const environment = options.environment ?? process.env;
  const plan = deepseekAccountRemovalPlan(accountId, environment);
  const runtime = await inspectManagedAccountRuntime(plan.definition.id, options);
  return {
    revision: managedAccountRevision(plan.snapshots),
    operation: "remove",
    account: { id: accountId, provider: plan.definition.id },
    effects: { stopsRunningAppServer: runtime.registered, historyThreadsBecomeUnavailable: true,
      preservesPrivateBackup: true, restoresInitialConfig: plan.restoresInitialConfig },
    activation: "restart-all",
  };
}

export async function removeDeepseekAccount({ accountId, confirmRemove = false, expectedRevision }, options = {}) {
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(environment, async () => {
    if (!confirmRemove) throw new AccountManagementError("confirmation-required", "confirmRemove", "删除账户必须明确确认");
    const { definition, updates, snapshots } = deepseekAccountRemovalPlan(accountId, environment);
    assertManagedAccountRevision(expectedRevision, managedAccountRevision(snapshots));
    const runtime = await stopManagedAccountForRemoval(definition.id, options);
    await applyProviderFileUpdates(updates, snapshots);
    return { action: "removed", accountId, runtime, activation: "restart-all" };
  });
}
