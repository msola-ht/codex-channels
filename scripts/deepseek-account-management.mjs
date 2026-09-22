import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { parse, stringify } from "smol-toml";

import { codexHomePath } from "../runtime/codex-home.mjs";
import {
  deepseekAccountDirectory, deepseekAccountMarkerPath, deepseekAccountsFilePath,
  deepseekProviderId, loadDeepseekAccounts, validateDeepseekAccounts,
} from "../runtime/deepseek-accounts.mjs";
import { deepseekAccountDefinition, deepseekProviderDefinition, isManagedProviderApiKeyValid } from "../runtime/model-provider-definitions.mjs";
import { createManagedProviderMarker } from "../runtime/model-provider-profile.mjs";
import {
  loadManagedModelProviderSettings, loadPrimaryModelProvider, loadThirdPartyModelProviderRole,
  managedProviderDirectory, managedModelProviderRoleConfigPath,
} from "../runtime/model-provider-runtime.mjs";
import { readPrivateFileSync } from "../runtime/private-file.mjs";
import { applyProviderFileUpdates, snapshotProviderFiles } from "./managed-provider-files.mjs";
import { createManagedProviderConfiguration, hasProviderBaseConfig, resolveManagedCatalogModel, restoreProviderBaseConfig } from "./managed-model-provider-setup.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { createManagedDeepseekCatalog, downloadDeepseekCatalog, deepseekSetupScriptUrl } from "./deepseek-setup.mjs";

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
    role: managedModelProviderRoleConfigPath(environment),
  };
}

export function hasLegacyDeepseekConfiguration(environment = process.env) {
  return [
    join(managedProviderDirectory(environment, deepseekProviderDefinition), "managed.toml"),
    join(codexHomePath(environment), "sf-deepseek.managed.toml"),
    join(codexHomePath(environment), "codex-connect-deepseek.config.toml"),
  ].some((path) => existsSync(path));
}

function readToml(path) {
  try { return parse(readPrivateFileSync(path, 2_097_152)); }
  catch (error) {
    if (error?.code === "ENOENT") return {};
    // TOML 解析错误可能包含凭据，不携带原始 cause。
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`无法安全读取 Provider 配置：${path}`);
  }
}

function readBackup(path) {
  if (!existsSync(path)) return undefined;
  let value;
  try { value = JSON.parse(readPrivateFileSync(path)); }
  catch { throw new Error("DeepSeek 安装备份无法安全读取"); }
  if (!value?.config || typeof value.config !== "object" || Array.isArray(value.config)) {
    throw new Error("DeepSeek 安装备份无效");
  }
  return value;
}

export function previewDeepseekAccountConfiguration(input, { environment = process.env } = {}) {
  const definition = deepseekAccountDefinition(input.accountId);
  const mode = input.mode ?? "switching";
  if (!["switching", "exclusive"].includes(mode)) throw new Error("DeepSeek 模式无效");
  if (hasLegacyDeepseekConfiguration(environment)) throw new Error("请先迁移旧 DeepSeek 单账户配置");
  const accounts = loadDeepseekAccounts(environment);
  const previous = accounts.find((account) => account.id === input.accountId);
  if (Boolean(previous) !== (input.reconfigure === true)) {
    throw new Error(previous ? "账户已存在，请选择重新配置" : "DeepSeek 账户不存在");
  }
  validateDeepseekAccounts(previous ? accounts : [...accounts, { id: input.accountId, default: accounts.length === 0 }]);
  if (mode === "exclusive" && !["openai", definition.id].includes(loadPrimaryModelProvider(environment))) {
    throw new Error("请先移除当前固定 Provider");
  }
  return {
    operation: previous ? "reconfigure" : "add",
    account: { id: input.accountId, provider: definition.id, exists: Boolean(previous), default: previous?.default ?? accounts.length === 0 },
    mode,
    effects: { writesMainConfig: mode === "exclusive", writesIsolatedProfile: mode === "switching", downloadsCatalog: !existsSync(deepseekAccountPaths(environment, input.accountId).catalog) },
    confirmation: { required: mode === "exclusive", field: "confirmExclusiveConfigChange" },
    activation: "restart-all",
  };
}

export async function applyDeepseekAccountConfiguration(input, options = {}) {
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(environment, async () => {
    const preview = previewDeepseekAccountConfiguration(input, { environment });
    const definition = deepseekAccountDefinition(input.accountId);
    if (!isManagedProviderApiKeyValid(definition, input.apiKey)) throw new Error("DeepSeek API Key 无效");
    if (preview.mode === "exclusive" && input.confirmExclusiveConfigChange !== true) throw new Error("固定模式必须明确确认");
    const paths = deepseekAccountPaths(environment, input.accountId);
    const snapshots = snapshotProviderFiles(Object.values(paths));
    const accounts = loadDeepseekAccounts(environment);
    const providers = loadManagedModelProviderSettings(environment);
    const previous = providers.find((provider) => provider.provider === definition.id);
    if (input.reconfigure && !previous) throw new Error("DeepSeek 账户配置不完整，请先恢复缺失文件");
    const current = readToml(paths.config);
    if (!previous && (hasProviderBaseConfig(current, definition) || existsSync(paths.profile) || existsSync(paths.marker))) throw new Error("DeepSeek 账户配置路径已被占用");
    const backup = readBackup(paths.backup);
    if (previous && !backup) throw new Error("DeepSeek 账户初始备份缺失");
    const entersExclusiveMode = previous?.mode === "switching" && preview.mode === "exclusive";
    const initial = previous && !entersExclusiveMode ? backup : { config: current };
    const updates = new Map();
    if ((!previous || entersExclusiveMode) && backup) {
      const archive = join(dirname(paths.backup), `config-${randomUUID()}.json`);
      const [snapshot] = snapshotProviderFiles([archive]);
      if (snapshot.content !== undefined) throw new Error("DeepSeek 备份归档路径已被占用");
      snapshots.push(snapshot);
      updates.set(archive, snapshots.find((item) => item.path === paths.backup).content);
    }
    let catalog;
    if (existsSync(paths.catalog)) {
      catalog = JSON.parse(readPrivateFileSync(paths.catalog, 2_097_152));
    } else {
      const downloaded = await (options.downloadCatalog ?? downloadDeepseekCatalog)(options.fetchImpl ?? fetch);
      catalog = createManagedDeepseekCatalog(downloaded.catalog);
      updates.set(paths.catalog, `${JSON.stringify(catalog, null, 2)}\n`);
      updates.set(paths.manifest, `${JSON.stringify({ source: deepseekSetupScriptUrl, downloadedAt: new Date().toISOString() })}\n`);
    }
    const model = resolveManagedCatalogModel(catalog, definition, previous?.model);
    const configured = createManagedProviderConfiguration(current, initial.config, definition, {
      mode: preview.mode, previousMode: previous?.mode, apiKey: input.apiKey,
      catalogPath: paths.catalog, catalog, model,
    });
    updates.set(paths.backup, `${JSON.stringify(initial)}\n`);
    updates.set(paths.profile, configured.profile === undefined ? undefined : stringify(configured.profile));
    updates.set(paths.marker, stringify(createManagedProviderMarker(definition, preview.mode)));
    if (preview.mode === "exclusive" || previous?.mode === "exclusive") updates.set(paths.config, stringify(configured.config));
    if (!previous) updates.set(paths.registry, `${JSON.stringify(validateDeepseekAccounts([...accounts, { id: input.accountId, default: accounts.length === 0 }]))}\n`);
    await applyProviderFileUpdates(updates, snapshots);
    return { ...preview, action: "configured", model };
  });
}

export function previewDeepseekAccountMigration(accountId, { environment = process.env } = {}) {
  const paths = deepseekAccountPaths(environment, accountId);
  if (!hasLegacyDeepseekConfiguration(environment)) throw new Error("没有待迁移的 DeepSeek 单账户配置");
  const accounts = loadDeepseekAccounts(environment);
  if (accounts.some((account) => account.id === accountId) || existsSync(paths.profile) || existsSync(paths.marker) || existsSync(paths.backup)) throw new Error("DeepSeek 迁移目标账户已存在");
  validateDeepseekAccounts([...accounts, { id: accountId, default: accounts.length === 0 }]);
  return { operation: "migrate", account: { id: accountId, provider: deepseekProviderId(accountId) }, confirmation: { required: true, field: "confirmMigration" }, activation: "restart-all" };
}

export async function migrateDeepseekAccount({ accountId, confirmMigration = false }, { environment = process.env } = {}) {
  return withModelProviderManagementTransaction(environment, async () => {
    const preview = previewDeepseekAccountMigration(accountId, { environment });
    if (confirmMigration !== true) throw new Error("迁移 DeepSeek 账户必须明确确认");
    const definition = deepseekAccountDefinition(accountId);
    const paths = deepseekAccountPaths(environment, accountId);
    const directory = managedProviderDirectory(environment, deepseekProviderDefinition);
    const oldMarker = join(directory, "managed.toml");
    const oldProfile = join(codexHomePath(environment), deepseekProviderDefinition.profileFileName);
    const marker = readToml(oldMarker);
    if (marker.version !== 1 || marker.provider !== "deepseek" || !["switching", "exclusive"].includes(marker.mode)) throw new Error("DeepSeek 旧管理标记无效");
    const source = marker.mode === "exclusive" ? paths.config : oldProfile;
    const original = readToml(source);
    if (original.model_provider !== "deepseek" || !original.model_providers?.deepseek) throw new Error("DeepSeek 旧配置与管理标记不一致");
    const snapshots = snapshotProviderFiles([...Object.values(paths), oldMarker, oldProfile]);
    const updates = new Map();
    const rewrite = (document) => {
      const provider = document.model_providers?.deepseek;
      if (!provider) throw new Error("DeepSeek 旧配置缺少 Provider");
      document.model_provider = definition.id;
      document.model_providers[definition.id] = { ...provider, name: definition.id };
      if (provider.env_key !== undefined) document.model_providers[definition.id].env_key = definition.apiKeyEnvironmentKey;
      delete document.model_providers.deepseek;
      return stringify(document);
    };
    updates.set(marker.mode === "exclusive" ? paths.config : paths.profile, rewrite(original));
    const originalConfigPath = join(directory, "backup", "config.toml");
    let initialConfig = readToml(paths.config);
    if (marker.mode === "exclusive") {
      if (!existsSync(originalConfigPath)) {
        let state;
        try { state = JSON.parse(readPrivateFileSync(join(directory, "backup", "state.json"))); }
        catch { throw new Error("DeepSeek 原始主配置备份缺失，无法迁移固定账户"); }
        if (state?.originalConfigExisted !== false) throw new Error("DeepSeek 原始主配置备份缺失，无法迁移固定账户");
      }
      initialConfig = readToml(originalConfigPath);
    }
    updates.set(paths.backup, `${JSON.stringify({ config: initialConfig })}\n`);
    const role = readToml(paths.role);
    if (role.model_provider === "deepseek") updates.set(paths.role, rewrite(role));
    updates.set(paths.marker, stringify(createManagedProviderMarker(definition, marker.mode)));
    updates.set(paths.registry, `${JSON.stringify(validateDeepseekAccounts([...loadDeepseekAccounts(environment), { id: accountId, default: loadDeepseekAccounts(environment).length === 0 }]))}\n`);
    updates.set(oldProfile, undefined);
    updates.set(oldMarker, undefined);
    await applyProviderFileUpdates(updates, snapshots);
    return { ...preview, action: "migrated" };
  });
}

export async function setDeepseekDefaultAccount(accountId, { environment = process.env } = {}) {
  return withModelProviderManagementTransaction(environment, async () => {
    const accounts = loadDeepseekAccounts(environment);
    if (!accounts.some((account) => account.id === accountId)) throw new Error("DeepSeek 账户不存在");
    const path = deepseekAccountsFilePath(environment);
    await applyProviderFileUpdates(new Map([[path, `${JSON.stringify(accounts.map((account) => ({ ...account, default: account.id === accountId })))}\n`]]), snapshotProviderFiles([path]));
    return { action: "default-set", accountId, activation: "restart-all" };
  });
}

export async function removeDeepseekAccount({ accountId, confirmRemove = false }, { environment = process.env } = {}) {
  return withModelProviderManagementTransaction(environment, async () => {
    if (!confirmRemove) throw new Error("删除账户必须明确确认");
    const paths = deepseekAccountPaths(environment, accountId);
    const definition = deepseekAccountDefinition(accountId);
    const accounts = loadDeepseekAccounts(environment);
    if (!accounts.some((account) => account.id === accountId)) throw new Error("DeepSeek 账户不存在");
    if (loadThirdPartyModelProviderRole(environment)?.provider === definition.id) throw new Error("请先切换或停用该账户的共享子代理");
    const marker = readToml(paths.marker);
    if (!["switching", "exclusive"].includes(marker.mode)) throw new Error("DeepSeek 账户管理标记无效");
    const remaining = accounts.filter((account) => account.id !== accountId);
    if (remaining.length > 0 && !remaining.some((account) => account.default)) throw new Error("请先选择其他默认账户");
    const snapshots = snapshotProviderFiles(Object.values(paths));
    const updates = new Map([[paths.profile, undefined], [paths.marker, undefined], [paths.registry, remaining.length === 0 ? undefined : `${JSON.stringify(remaining)}\n`]]);
    if (marker.mode === "exclusive") {
      const initial = readBackup(paths.backup);
      if (!initial) throw new Error("DeepSeek 账户初始备份缺失");
      updates.set(paths.config, stringify(restoreProviderBaseConfig(readToml(paths.config), initial.config, definition)));
    }
    await applyProviderFileUpdates(updates, snapshots);
    return { action: "removed", accountId, activation: "restart-all" };
  });
}

export async function refreshDeepseekAccountsCatalog(environment = process.env, options = {}) {
  return withModelProviderManagementTransaction(environment, async () => {
    if (hasLegacyDeepseekConfiguration(environment)) throw new Error("请先通过 DeepSeek 账户迁移入口填写账户 ID");
    const accounts = loadDeepseekAccounts(environment);
    if (accounts.length === 0) return { status: "not-configured" };
    const providers = loadManagedModelProviderSettings(environment).filter((provider) => accounts.some((account) => deepseekProviderId(account.id) === provider.provider));
    if (providers.length !== accounts.length) {
      throw new Error("DeepSeek 账户配置不完整，请先恢复缺失文件");
    }
    const paths = deepseekAccountPaths(environment, accounts[0].id);
    const accountPaths = accounts.map((account) => deepseekAccountPaths(environment, account.id));
    const snapshots = snapshotProviderFiles(accountPaths.flatMap((entry) => Object.values(entry)));
    const downloaded = await (options.downloadCatalog ? options.downloadCatalog() : downloadDeepseekCatalog(options.fetchImpl ?? fetch));
    const catalog = createManagedDeepseekCatalog(downloaded.catalog, providers[0]?.models ?? []);
    const updates = new Map([
      [paths.catalog, `${JSON.stringify(catalog, null, 2)}\n`],
      [paths.manifest, `${JSON.stringify({ source: deepseekSetupScriptUrl, downloadedAt: (options.now?.() ?? new Date()).toISOString() })}\n`],
    ]);
    const migrated = [];
    for (const provider of providers) {
      const account = accounts.find((entry) => deepseekProviderId(entry.id) === provider.provider);
      const definition = deepseekAccountDefinition(account.id);
      const path = provider.mode === "exclusive" ? paths.config : deepseekAccountPaths(environment, account.id).profile;
      const document = readToml(path);
      const model = resolveManagedCatalogModel(catalog, definition, provider.model);
      document.model = model;
      if (provider.mode === "switching") document.model_reasoning_effort = catalog.models.find((entry) => entry.slug === model).default_reasoning_level;
      updates.set(path, stringify(document));
      if (model !== provider.model) migrated.push(provider.provider);
    }
    const role = readToml(paths.role);
    const roleAccount = accounts.find((entry) => deepseekProviderId(entry.id) === role.model_provider);
    let roleMigrated = false;
    if (roleAccount) {
      const model = resolveManagedCatalogModel(catalog, deepseekAccountDefinition(roleAccount.id), role.model);
      roleMigrated = model !== role.model;
      role.model = model;
      role.model_reasoning_effort = catalog.models.find((entry) => entry.slug === model).default_reasoning_level;
      updates.set(paths.role, stringify(role));
    }
    await applyProviderFileUpdates(updates, snapshots);
    return { status: "updated", catalogPath: paths.catalog, manifestPath: paths.manifest, modelCount: catalog.models.length, modelMigrated: migrated.length > 0, roleMigrated, migratedProviders: migrated };
  });
}
