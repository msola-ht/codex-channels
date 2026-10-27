import { AccountManagementError } from "./account-management-error.mjs";
import { ollamaCloudAccountDirectory, ollamaCloudAccountMarkerPath, ollamaCloudAccountsFilePath, loadOllamaCloudAccounts, validateOllamaCloudAccounts } from "../runtime/ollama-cloud-accounts.mjs";
import { randomUUID } from "node:crypto";
import { ProxyAgent } from "undici";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { ollamaCloudProviderDefinition as definition, ollamaCloudAccountDefinition, isManagedProviderModelValid } from "../runtime/model-provider-definitions.mjs";
import { createManagedProviderMarker } from "../runtime/model-provider-profile.mjs";
import { createProxyFetch } from "../runtime/proxy-fetch.mjs";
import { readCodexProxySettings } from "../runtime/codex-proxy-env.mjs";
import { resolveProxyEnvironment } from "../runtime/network-proxy.mjs";
import { validateOllamaCloudCatalogManifest } from "../runtime/model-template-bindings.mjs";
import { modelBaseSnapshotPath, readDeepseekModelTemplateCatalog, readModelBaseSnapshot, withModelBaseSnapshotLock } from "../runtime/model-base-snapshot.mjs";
import { createOllamaCloudCatalogWithTemplateBindings } from "./provider-model-catalog.mjs";
import { managedProviderDirectory, loadManagedModelProviderSettings, withManagedModelCatalogSettings } from "../runtime/model-provider-runtime.mjs";
import { createManagedProviderConfiguration, hasProviderBaseConfig, restoreProviderBaseConfig } from "./managed-model-provider-setup.mjs";
import { applyProviderFileUpdates, assertProviderFileSnapshots, snapshotProviderFiles, stageManagedPrimaryCredential } from "./managed-provider-files.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { validateModelCatalogWithCodex } from "./model-catalog-validation.mjs";
import { inspectManagedAccountRuntime, stopManagedAccountForRemoval } from "./managed-provider-account-runtime.mjs";
import { assertManagedAccountMode, snapshotManagedAccountFiles, managedAccountRevision, assertManagedAccountRevision, managedAccountConfigurationEdit } from "./managed-provider-account-plan.mjs";

export function ollamaCloudSetupPaths(environment, accountId) {
  const definition = ollamaCloudAccountDefinition(accountId);
  const directory = managedProviderDirectory(environment, definition);
  return {
    config: join(codexHomePath(environment), "config.toml"),
    profile: join(codexHomePath(environment), definition.profileFileName),
    marker: ollamaCloudAccountMarkerPath(environment, accountId),
    registry: ollamaCloudAccountsFilePath(environment),
    catalog: join(directory, definition.catalogFileName),
    manifest: join(directory, definition.catalogManifestFileName),
    backup: join(ollamaCloudAccountDirectory(environment, accountId), definition.backupDirectoryName, "config.json"),
  };
}

export function loadOllamaCloudModelChoices(environment = process.env) {
  const paths = ollamaCloudSetupPaths(environment, "catalog");
  const snapshots = snapshotProviderFiles([paths.catalog, paths.manifest, `${paths.catalog}.settings-pending`], environment);
  if (snapshots[2].content !== undefined) throw new AccountManagementError("provider-state-unavailable", "model", "Ollama Cloud 模型目录事务尚未完成，请先恢复目录后再管理账户");
  const content = snapshots[0].content;
  if (content === undefined) {
    if (snapshots[1].content !== undefined) throw new AccountManagementError("provider-state-unavailable", "model", "共享目录与来源文件不完整");
    const { catalog } = createOllamaCloudCatalogWithTemplateBindings(readDeepseekModelTemplateCatalog(environment), environment);
    return { catalogExists: false, models: catalog.models.map(model => ({ id: model.slug, name: model.display_name })) };
  }
  try {
    const catalog = JSON.parse(content.toString("utf8"));
    const manifest = JSON.parse(snapshots[1].content?.toString("utf8"));
    if (!Array.isArray(catalog.models) || catalog.models.length === 0) throw new Error("invalid catalog");
    validateOllamaCloudCatalogManifest(manifest, catalog.models.map(model => model.slug));
    for (const model of catalog.models) withManagedModelCatalogSettings(catalog, definition, { model: model.slug, reasoningEffort: model.default_reasoning_level });
    return { catalogExists: true, models: catalog.models.map(model => ({ id: model.slug, name: model.display_name })) };
  } catch {
    throw new AccountManagementError("provider-state-unavailable", "model", "Ollama Cloud 共享模型目录无法安全读取");
  }
}

export async function previewOllamaCloudConfiguration(input, options = {}) {
  const environment = options.environment ?? process.env;
  const plan = ollamaCloudConfigurationPlan(input, environment);
  // A submit-time preview only recomputes the confirmation; apply performs a
  // fresh authentication before publication, never accepting an old preview.
  if (plan.preview.credentialAction === "replace" && options.authentication !== "defer-to-apply") await authenticateOllamaCloudKey(plan.apiKey, options);
  options.signal?.throwIfAborted();
  assertManagedAccountRevision(plan.preview.revision, ollamaCloudConfigurationPlan(input, environment).preview.revision);
  return plan.preview;
}

function ollamaCloudConfigurationPlan(input, environment) {
  const allowed = ["accountId", "apiKey", "reconfigure", "mode", "model", "confirmExclusiveConfigChange", "expectedRevision", "operation"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new AccountManagementError("invalid-input", "accountId", "账户请求包含不支持的字段");
  const definition = ollamaCloudAccountDefinition(input.accountId);
  const accounts = loadOllamaCloudAccounts(environment);
  const account = accounts.find(item => item.id === input.accountId);
  if (Boolean(account) !== (input.reconfigure === true)) throw new AccountManagementError(account ? "account-exists" : "account-not-found", "accountId", account ? "账户已存在，请选择重新配置" : "Ollama Cloud 账户不存在");
  validateOllamaCloudAccounts(account ? accounts : [...accounts, { id: input.accountId, default: accounts.length === 0 }]);
  const previous = loadManagedModelProviderSettings(environment).find(item => item.provider === definition.id);
  if (account && !previous) throw new AccountManagementError("provider-state-unavailable", "accountId", "Ollama Cloud 账户配置不完整，请先恢复缺失文件");
  const paths = ollamaCloudSetupPaths(environment, input.accountId);
  const choices = loadOllamaCloudModelChoices(environment);
  const baseRevision = choices.catalogExists ? undefined : readModelBaseSnapshot(environment).revision;
  const snapshots = snapshotManagedAccountFiles([...Object.values(paths), `${paths.catalog}.settings-pending`,
    ...(choices.catalogExists ? [] : [modelBaseSnapshotPath(environment)])], definition, environment);
  const content = key => snapshots.find(item => item.path === paths[key]).content?.toString("utf8");
  const current = content("config") === undefined ? {} : parsePrivateConfig(content("config"));
  if (!previous && (content("profile") !== undefined || content("marker") !== undefined || hasProviderBaseConfig(current, definition))) throw new AccountManagementError("config-path-conflict", "accountId", "Ollama Cloud 配置路径已被占用");
  if (previous && content("backup") === undefined) throw new AccountManagementError("backup-unavailable", "accountId", "Ollama Cloud 初始备份缺失");
  const model = input.model === undefined ? previous?.model : input.model;
  if (!isManagedProviderModelValid(definition, model)) throw new AccountManagementError("invalid-input", "model", "新增账户必须明确选择准确模型 ID");
  let initialCatalog;
  let initialBindings;
  if (choices.catalogExists) {
    if (!choices.models.some(entry => entry.id === model)) throw new AccountManagementError("model-not-found", "model", "默认模型不在共享目录中");
  } else {
    if (previous) throw new AccountManagementError("provider-state-unavailable", "model", "已有账户的共享目录缺失，请先恢复目录");
    ({ catalog: initialCatalog, templateBindings: initialBindings } = createOllamaCloudCatalogWithTemplateBindings(readDeepseekModelTemplateCatalog(environment), environment));
    if (!initialCatalog.models.some(entry => entry.slug === model)) throw new AccountManagementError("model-not-found", "model", "请选择受管目录中的默认模型");
    if (readModelBaseSnapshot(environment).revision !== baseRevision) throw new AccountManagementError("stale-preview", "revision", "模型底座已变化，请重新预览");
  }
  const { apiKey, ...edit } = managedAccountConfigurationEdit(input, previous, definition, environment);
  const { mode } = edit;
  const willChange = edit.willChange || model !== previous?.model;
  assertManagedAccountMode(mode, definition, environment);
  const revision = managedAccountRevision([...snapshots, ...(initialCatalog ? [{ path: "ollama-managed-catalog", content: Buffer.from(JSON.stringify({ baseRevision, initialCatalog, initialBindings })) }] : [])]);
  return { apiKey, initialCatalog, initialBindings, baseRevision, preview: { revision, operation: account ? "reconfigure" : "add", account: { id: input.accountId, provider: definition.id, default: account?.default ?? accounts.length === 0 }, ...edit, model, willChange,
    ...(initialCatalog ? { initialModels: initialCatalog.models.map(entry => ({ id: entry.slug, name: entry.display_name })) } : {}),
    effects: { writesMainConfig: willChange && (mode === "exclusive" || previous?.mode === "exclusive"), writesIsolatedProfile: willChange && mode === "switching", writesInitialCatalog: initialCatalog !== undefined, readsAccountAuthentication: edit.credentialAction === "replace" }, activation: willChange ? "restart-all" : "none" } };
}

export async function applyOllamaCloudConfiguration(input, options = {}) {
  const environment = options.environment ?? process.env;
  const { accountId, confirmExclusiveConfigChange = false } = input;
  const definition = ollamaCloudAccountDefinition(accountId);
  return withModelProviderManagementTransaction(environment, async () => {
    const { preview, apiKey, initialCatalog, initialBindings, baseRevision } = ollamaCloudConfigurationPlan(input, environment);
    const { mode } = preview;
    assertManagedAccountRevision(input.expectedRevision, preview.revision);
    if (preview.effects.writesMainConfig && confirmExclusiveConfigChange !== true) throw new AccountManagementError("confirmation-required", "confirmExclusiveConfigChange", "修改 Codex 主配置前必须明确确认");
    const accounts = loadOllamaCloudAccounts(environment);
    const paths = ollamaCloudSetupPaths(environment, accountId);
    const snapshots = snapshotManagedAccountFiles([...Object.values(paths), `${paths.catalog}.settings-pending`,
      ...(initialCatalog === undefined ? [] : [modelBaseSnapshotPath(environment)])], definition, environment);
    assertManagedAccountRevision(preview.revision, ollamaCloudConfigurationPlan(input, environment).preview.revision);
    const content = key => snapshots.find(item => item.path === paths[key]).content?.toString("utf8");
    const current = content("config") === undefined ? {} : parsePrivateConfig(content("config"));
    const previous = loadManagedModelProviderSettings(environment).find(item => item.provider === definition.id);
    if (!previous && (content("profile") !== undefined || content("marker") !== undefined || hasProviderBaseConfig(current, definition))) throw new AccountManagementError("config-path-conflict", "accountId", "Ollama Cloud 配置路径已被占用");
    const backup = content("backup") === undefined ? undefined : parsePrivateBackup(content("backup"));
    if (previous && !backup?.config) throw new AccountManagementError("backup-unavailable", "accountId", "Ollama Cloud 初始备份缺失");
    if (!preview.willChange) {
      options.signal?.throwIfAborted();
      await assertProviderFileSnapshots(snapshots);
      return { ...preview, action: "unchanged" };
    }
    if (preview.credentialAction === "replace") await authenticateOllamaCloudKey(apiKey, options);
    options.signal?.throwIfAborted();
    await assertProviderFileSnapshots(snapshots);
    const writesCatalog = initialCatalog !== undefined;
    const catalog = initialCatalog ?? JSON.parse(content("catalog"));
    await validateModelCatalogWithCodex(catalog, environment);
    options.signal?.throwIfAborted();
    await assertProviderFileSnapshots(snapshots);
    const initial = previous && !(previous.mode === "switching" && mode === "exclusive") ? backup.config : current;
    const { config, profile, credential } = createManagedProviderConfiguration(current, initial, definition, {
      mode, previousMode: previous?.mode, apiKey, catalogPath: paths.catalog, catalog,
      previousProfile: content("profile"),
      model: preview.model,
    });
    const updates = new Map([
      [paths.backup, `${JSON.stringify({ config: initial }, null, 2)}\n`],
      [paths.profile, profile === undefined ? undefined : stringify(profile)],
      [paths.marker, stringify(createManagedProviderMarker(definition, mode))],
    ]);
    if (writesCatalog) {
      updates.set(paths.catalog, `${JSON.stringify(catalog, null, 2)}\n`);
      updates.set(paths.manifest, `${JSON.stringify({ source: "ollama-cloud", modelTemplates: initialBindings }, null, 2)}\n`);
    }
    if (!previous) updates.set(paths.registry, `${JSON.stringify(validateOllamaCloudAccounts([...accounts, { id: accountId, default: accounts.length === 0 }]), null, 2)}\n`);
    if (content("backup") !== undefined && JSON.stringify(backup.config) !== JSON.stringify(initial)) {
      const archive = `${paths.backup}.${randomUUID()}`;
      snapshots.push(...snapshotProviderFiles([archive], environment));
      updates.set(archive, content("backup"));
    }
    if (mode === "exclusive" || previous?.mode === "exclusive") updates.set(paths.config, stringify(config));
    stageManagedPrimaryCredential(credential, definition, environment, snapshots, updates);
    const save = async () => {
      options.signal?.throwIfAborted();
      if (baseRevision !== undefined && readModelBaseSnapshot(environment).revision !== baseRevision) throw new AccountManagementError("stale-preview", "revision", "模型底座已变化，请重新预览");
      await assertProviderFileSnapshots(snapshots);
      options.signal?.throwIfAborted();
      await applyProviderFileUpdates(updates, snapshots);
    };
    if (writesCatalog) await withModelBaseSnapshotLock(environment, save);
    else await save();
    assertOllamaCloudSaveConfirmed(updates, snapshots, paths.config, () => {
      const saved = loadManagedModelProviderSettings(environment).find(entry => entry.provider === definition.id);
      if (!saved || saved.model !== preview.model || saved.mode !== mode) throw new Error("account readback mismatch");
    });
    return { ...preview, action: "configured" };
  });
}

function ollamaCloudRemovalPlan(accountId, environment) {
  const definition = ollamaCloudAccountDefinition(accountId);
  const accounts = loadOllamaCloudAccounts(environment);
  if (!accounts.some(account => account.id === accountId)) throw new AccountManagementError("account-not-found", "accountId", "Ollama Cloud 账户不存在");
  const remaining = accounts.filter(account => account.id !== accountId);
  if (remaining.length > 0 && !remaining.some(account => account.default)) throw new AccountManagementError("default-account-conflict", "accountId", "请先选择其他默认账户");
  const paths = ollamaCloudSetupPaths(environment, accountId);
  const previous = loadManagedModelProviderSettings(environment).find(item => item.provider === definition.id);
  if (!previous) throw new AccountManagementError("provider-state-unavailable", "accountId", "Ollama Cloud 账户配置不完整，请先恢复缺失文件");
  const snapshots = snapshotManagedAccountFiles(Object.values(paths), definition, environment);
  const content = key => snapshots.find(item => item.path === paths[key]).content?.toString("utf8");
  const updates = new Map([paths.profile, paths.marker].map(path => [path, undefined]));
  updates.set(paths.registry, remaining.length === 0 ? undefined : `${JSON.stringify(remaining, null, 2)}\n`);
  if (previous.mode === "exclusive") {
    if (content("backup") === undefined) throw new AccountManagementError("backup-unavailable", "accountId", "Ollama Cloud 初始备份缺失");
    const backup = parsePrivateBackup(content("backup"));
    updates.set(paths.config, stringify(restoreProviderBaseConfig(parsePrivateConfig(content("config")), backup.config, definition)));
  }
  return { definition, updates, snapshots, restoresInitialConfig: previous.mode === "exclusive" };
}

export async function previewOllamaCloudRemoval(accountId, options = {}) {
  const plan = ollamaCloudRemovalPlan(accountId, options.environment ?? process.env);
  const runtime = await inspectManagedAccountRuntime(plan.definition.id, options);
  return { revision: managedAccountRevision(plan.snapshots), operation: "remove", account: { id: accountId, provider: plan.definition.id },
    effects: { stopsRunningAppServer: runtime.registered, historyThreadsBecomeUnavailable: true, preservesPrivateBackup: true, restoresInitialConfig: plan.restoresInitialConfig }, activation: "restart-all" };
}

export async function removeOllamaCloudConfiguration({ accountId, confirmRemove = false, expectedRevision }, options = {}) {
  if (!confirmRemove) throw new AccountManagementError("confirmation-required", "confirmRemove", "移除 Ollama Cloud 前必须确认");
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(environment, async () => {
    const plan = ollamaCloudRemovalPlan(accountId, environment);
    assertManagedAccountRevision(expectedRevision, managedAccountRevision(plan.snapshots));
    options.signal?.throwIfAborted();
    await stopManagedAccountForRemoval(plan.definition.id, options);
    options.signal?.throwIfAborted();
    await applyProviderFileUpdates(plan.updates, plan.snapshots);
    assertOllamaCloudSaveConfirmed(plan.updates, plan.snapshots, ollamaCloudSetupPaths(environment, accountId).config);
    return { action: "removed", accountId, activation: "restart-all" };
  });
}

export function previewOllamaCloudDefaultAccount(accountId, { environment = process.env } = {}) {
  const revision = managedAccountRevision(snapshotProviderFiles([ollamaCloudAccountsFilePath(environment)], environment));
  const account = loadOllamaCloudAccounts(environment).find(item => item.id === accountId);
  if (!account) throw new AccountManagementError("account-not-found", "accountId", "Ollama Cloud 账户不存在");
  return { revision, operation: "default", account: { ...account, provider: ollamaCloudAccountDefinition(accountId).id }, willChange: !account.default, activation: account.default ? "none" : "restart-all" };
}

export async function setOllamaCloudDefaultAccount(accountId, { environment = process.env, expectedRevision, signal } = {}) {
  return withModelProviderManagementTransaction(environment, async () => {
    signal?.throwIfAborted();
    const preview = previewOllamaCloudDefaultAccount(accountId, { environment });
    assertManagedAccountRevision(expectedRevision, preview.revision);
    const path = ollamaCloudAccountsFilePath(environment);
    const snapshots = snapshotProviderFiles([path], environment);
    assertManagedAccountRevision(preview.revision, managedAccountRevision(snapshots));
    if (!preview.willChange) return { ...preview, action: "unchanged" };
    const accounts = loadOllamaCloudAccounts(environment).map(account => ({ ...account, default: account.id === accountId }));
    signal?.throwIfAborted();
    const updates = new Map([[path, `${JSON.stringify(validateOllamaCloudAccounts(accounts), null, 2)}\n`]]);
    await applyProviderFileUpdates(updates, snapshots);
    assertOllamaCloudSaveConfirmed(updates, snapshots);
    return { ...preview, account: { ...preview.account, default: true }, action: "default-set" };
  });
}

function assertOllamaCloudSaveConfirmed(updates, snapshots, mainConfigPath, validate = () => {}) {
  try {
    for (const [path, expected] of updates) {
      // The official versioned writer already confirms main-config field edits.
      if (path === mainConfigPath) continue;
      const current = snapshots.find(snapshot => snapshot.path === path).readCurrent();
      if (expected === undefined ? current !== undefined : current?.toString("utf8") !== expected) throw new Error("readback mismatch");
    }
    validate();
  } catch {
    throw new AccountManagementError("save-unconfirmed", "accountId", "账户配置已写入，但回读未确认；保留目录、凭据和备份，请核对后操作，勿直接重试");
  }
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
    throw new Error("Ollama Cloud 初始备份无效");
  }
}

/** Authentication only; older plans need not expose USD balance fields. */
export async function authenticateOllamaCloudKey(apiKey, { fetchImpl, environment = process.env, signal } = {}) {
  const operation = globalThis.AbortSignal.any([globalThis.AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
  const dispatchers = [];
  const url = "https://ollama.com/api/balance";
  let reader;
  let response;
  try {
    operation.throwIfAborted();
    const proxy = fetchImpl ? undefined : resolveProxyEnvironment(readCodexProxySettings(environment), environment);
    const request = fetchImpl ?? createProxyFetch({
      http: proxy.HTTP_PROXY,
      https: proxy.HTTPS_PROXY,
      all: proxy.ALL_PROXY,
      no: proxy.NO_PROXY,
    }, { createDispatcher: proxyUrl => {
      const dispatcher = new ProxyAgent(proxyUrl);
      dispatchers.push(dispatcher);
      return dispatcher;
    } });
    response = await abortable(request(url, { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${apiKey}` }, redirect: "error", signal: operation }), operation);
    if ([401, 403].includes(response.status)) throw new AccountManagementError("invalid-api-key", "apiKey", "Ollama Cloud Key 认证失败");
    if (response.status === 429) throw new AccountManagementError("authentication-rate-limited", "apiKey", "Ollama Cloud 认证请求受限，请稍后重试");
    if (!response.ok || response.url && response.url !== url || !response.body) throw new AccountManagementError("authentication-unavailable", "apiKey", "Ollama Cloud 认证接口暂不可用");
    reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const { value, done } = await abortable(reader.read(), operation);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65_536) throw new AccountManagementError("authentication-unavailable", "apiKey", "Ollama Cloud 认证响应超出读取限制");
      chunks.push(value);
    }
    operation.throwIfAborted();
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!body || typeof body !== "object" || Array.isArray(body)
      || !body.included || typeof body.included !== "object" || Array.isArray(body.included)
      || !body.purchased || typeof body.purchased !== "object" || Array.isArray(body.purchased)) throw new Error("invalid balance response");
  } catch (error) {
    if (signal?.aborted) throw new AccountManagementError("operation-cancelled", "apiKey", "账户认证已取消");
    if (operation.aborted) throw new AccountManagementError("authentication-timeout", "apiKey", "Ollama Cloud 认证读取超时");
    if (error instanceof AccountManagementError) throw error;
    throw new AccountManagementError("authentication-unavailable", "apiKey", "Ollama Cloud 认证响应无法安全读取");
  } finally {
    if (reader) { await abortable(reader.cancel(), operation).catch(() => undefined); reader.releaseLock(); }
    else if (response?.body) await abortable(response.body.cancel(), operation).catch(() => undefined);
    await Promise.allSettled(dispatchers.map(dispatcher => dispatcher.destroy()));
  }
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
