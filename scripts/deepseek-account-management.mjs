import { listResponsesContextFollowers } from "../runtime/responses-context-sync.mjs";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { parse, stringify } from "smol-toml";

import { codexHomePath } from "../runtime/codex-home.mjs";
import {
  deepseekAccountDirectory, deepseekAccountMarkerPath, deepseekAccountsFilePath,
  loadDeepseekAccounts, validateDeepseekAccounts,
} from "../runtime/deepseek-accounts.mjs";
import { deepseekAccountDefinition, deepseekProviderDefinition, isManagedProviderApiKeyValid } from "../runtime/model-provider-definitions.mjs";
import { createManagedProviderMarker } from "../runtime/model-provider-profile.mjs";
import {
  loadManagedModelProviderSettings, loadPrimaryModelProvider,
  managedProviderDirectory,
} from "../runtime/model-provider-runtime.mjs";
import { readPrivateFileSync } from "../runtime/private-file.mjs";
import { applyProviderFileUpdates, snapshotProviderFiles } from "./managed-provider-files.mjs";
import { createManagedProviderConfiguration, hasProviderBaseConfig, resolveManagedCatalogModel, restoreProviderBaseConfig } from "./managed-model-provider-setup.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { inspectManagedAccountRuntime, stopManagedAccountForRemoval } from "./managed-provider-account-runtime.mjs";
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
  if (!existsSync(deepseekAccountPaths(environment,input.accountId).catalog)) assertNoResponsesContextFollowers(environment,"重建 DS 目录");
  const mode = input.mode ?? "switching";
  if (!["switching", "exclusive"].includes(mode)) throw new Error("DeepSeek 模式无效");
  if (hasLegacyDeepseekConfiguration(environment)) throw new Error("请先运行 codexc deepseek legacy remove 移除旧账户，再重新添加");
  const accounts = loadDeepseekAccounts(environment);
  const previous = accounts.find((account) => account.id === input.accountId);
  if (Boolean(previous) !== (input.reconfigure === true)) {
    throw new Error(previous ? "账户已存在，请选择重新配置" : "DeepSeek 账户不存在");
  }
  validateDeepseekAccounts(previous ? accounts : [...accounts, { id: input.accountId, default: accounts.length === 0 }]);
  const configured = previous ? loadManagedModelProviderSettings(environment)
    .find((provider) => provider.provider === definition.id) : undefined;
  if (previous && !configured) throw new Error("DeepSeek 账户配置不完整，请先恢复缺失文件");
  if (mode === "exclusive" && !["openai", definition.id].includes(loadPrimaryModelProvider(environment))) {
    throw new Error("请先移除当前固定 Provider");
  }
  return {
    operation: previous ? "reconfigure" : "add",
    account: { id: input.accountId, provider: definition.id, exists: Boolean(previous), default: previous?.default ?? accounts.length === 0 },
    mode,
    effects: { writesMainConfig: mode === "exclusive" || configured?.mode === "exclusive", writesIsolatedProfile: mode === "switching", downloadsCatalog: !existsSync(deepseekAccountPaths(environment, input.accountId).catalog) },
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
      assertNoResponsesContextFollowers(environment,"重建 DS 目录");
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

function legacyDeepseekRemovalPlan(environment) {
  const home = codexHomePath(environment);
  const directory = managedProviderDirectory(environment, deepseekProviderDefinition);
  const configPath = join(home, "config.toml");
  const markers = [join(directory, "managed.toml"), join(home, "sf-deepseek.managed.toml"), join(home, "codex-connect-deepseek.config.toml")].filter(existsSync);
  if (markers.length !== 1) throw new Error("旧 DeepSeek 管理标记缺失或存在多个版本，请先核对配置");
  const marker = readToml(markers[0]);
  if (marker.version !== 1 || marker.provider !== "deepseek" || !["switching", "exclusive"].includes(marker.mode)) throw new Error("DeepSeek 旧管理标记无效");
  const config = readToml(configPath);
  const files = [...markers, join(home, "sf-deepseek.config.toml"), join(home, "deepseek.config.toml")];
  if (loadDeepseekAccounts(environment).length === 0) {
    files.push(join(directory, "models.json"), join(directory, "models.manifest.json"));
    for (const prefix of ["deepseek", "sf-deepseek"]) {
      files.push(join(home, `${prefix}.models.json`), join(home, `${prefix}.models.manifest.json`));
    }
  }
  const updates = new Map(files.filter(existsSync).map((path) => [path, undefined]));
  const readPaths = [configPath, ...files];
  if (marker.mode === "exclusive") {
    if (config.model_provider !== "deepseek") throw new Error("旧 DeepSeek 固定模式与主配置不一致，未删除文件");
    const backupDirectories = [join(directory, "backup"), join(home, "backup-codex-connect-deepseek")];
    const backups = backupDirectories.map((path) => join(path, "config.toml")).filter(existsSync);
    const states = backupDirectories.map((path) => join(path, "state.json")).filter(existsSync);
    readPaths.push(...backups, ...states);
    if (backups.length > 1) throw new Error("旧 DeepSeek 主配置备份存在多个版本，请先核对");
    let initial;
    if (backups.length === 1) initial = readToml(backups[0]);
    else {
      if (states.length !== 1) throw new Error("旧 DeepSeek 原始主配置备份缺失，未删除文件");
      let state;
      try { state = JSON.parse(readPrivateFileSync(states[0])); }
      catch { throw new Error("旧 DeepSeek 原始主配置备份状态无效"); }
      if (state.originalConfigExisted !== false) throw new Error("旧 DeepSeek 原始主配置备份缺失，未删除文件");
      initial = {};
    }
    updates.set(configPath, stringify(restoreProviderBaseConfig(config, initial, deepseekProviderDefinition)));
  } else if (config.model_provider === "deepseek") {
    throw new Error("旧 DeepSeek 切换模式与主配置不一致，未删除文件");
  }
  return { updates, snapshots: snapshotProviderFiles(readPaths), files: [...updates.keys()], mode: marker.mode };
}

export async function previewLegacyDeepseekRemoval(options = {}) {
  const environment = options.environment ?? process.env;
  const plan = legacyDeepseekRemovalPlan(environment);
  const runtime = await inspectManagedAccountRuntime("deepseek", options);
  return { operation: "legacy-remove", account: { provider: "deepseek" }, mode: plan.mode,
    files: plan.files, effects: { stopsRunningAppServer: runtime.running, restoresInitialConfig: plan.mode === "exclusive", preservesPrivateBackup: true }, activation: "restart-all" };
}

export async function removeLegacyDeepseekAccount({ confirmRemove = false } = {}, options = {}) {
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(environment, async () => {
    if (confirmRemove !== true) throw new Error("移除旧 DeepSeek 账户必须明确确认");
    const plan = legacyDeepseekRemovalPlan(environment);
    const runtime = await stopManagedAccountForRemoval("deepseek", options);
    await applyProviderFileUpdates(plan.updates, plan.snapshots);
    return { action: "legacy-removed", runtime, activation: "restart-all" };
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

function deepseekAccountRemovalPlan(accountId, environment) {
  const paths = deepseekAccountPaths(environment, accountId);
  const definition = deepseekAccountDefinition(accountId);
  const accounts = loadDeepseekAccounts(environment);
  if (!accounts.some((account) => account.id === accountId)) throw new Error("DeepSeek 账户不存在");
  const configured = loadManagedModelProviderSettings(environment).find((provider) => provider.provider === definition.id);
  if (!configured) throw new Error("DeepSeek 账户配置不完整，请先恢复缺失文件");
  const remaining = accounts.filter((account) => account.id !== accountId);
  if (remaining.length > 0 && !remaining.some((account) => account.default)) throw new Error("请先选择其他默认账户");
  const snapshots = snapshotProviderFiles(Object.values(paths));
  const updates = new Map([[paths.profile, undefined], [paths.marker, undefined], [paths.registry, remaining.length === 0 ? undefined : `${JSON.stringify(remaining)}\n`]]);
  if (remaining.length === 0) {
    assertNoResponsesContextFollowers(environment,"删除最后一个 DS 账户");
    updates.set(paths.catalog, undefined);
    updates.set(paths.manifest, undefined);
  }
  if (configured.mode === "exclusive") {
    const initial = readBackup(paths.backup);
    if (!initial) throw new Error("DeepSeek 账户初始备份缺失");
    updates.set(paths.config, stringify(restoreProviderBaseConfig(readToml(paths.config), initial.config, definition)));
  }
  return { definition, updates, snapshots, restoresInitialConfig: configured.mode === "exclusive" };
}

export async function previewDeepseekAccountRemoval(accountId, options = {}) {
  const environment = options.environment ?? process.env;
  const plan = deepseekAccountRemovalPlan(accountId, environment);
  const runtime = await inspectManagedAccountRuntime(plan.definition.id, options);
  return {
    operation: "remove",
    account: { id: accountId, provider: plan.definition.id },
    effects: { stopsRunningAppServer: runtime.running, historyThreadsBecomeUnavailable: true,
      preservesPrivateBackup: true, restoresInitialConfig: plan.restoresInitialConfig },
    activation: "restart-all",
  };
}

export async function removeDeepseekAccount({ accountId, confirmRemove = false }, options = {}) {
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(environment, async () => {
    if (!confirmRemove) throw new Error("删除账户必须明确确认");
    const { definition, updates, snapshots } = deepseekAccountRemovalPlan(accountId, environment);
    const runtime = await stopManagedAccountForRemoval(definition.id, options);
    await applyProviderFileUpdates(updates, snapshots);
    return { action: "removed", accountId, runtime, activation: "restart-all" };
  });
}

function assertNoResponsesContextFollowers(environment, operation) {
  const followers=listResponsesContextFollowers(environment);
  if (followers.length > 0) throw new Error(`${operation}前，请先关闭关联 RS 模型的上下文跟随：${[...new Set(followers.map(entry=>entry.providerId))].join("、")}`);
}
