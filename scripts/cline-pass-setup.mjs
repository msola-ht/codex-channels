import { promptManagedAccountId } from "./managed-provider-account-prompt.mjs";
import { existsSync } from "node:fs";
import { clinePassAccountDirectory, clinePassAccountMarkerPath, clinePassAccountsFilePath, loadClinePassAccounts, validateClinePassAccounts } from "../runtime/cline-pass-accounts.mjs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import * as clackPrompts from "@clack/prompts";
import { parse, stringify } from "smol-toml";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { deepseekProviderDefinition, clinePassProviderDefinition as definition, clinePassAccountDefinition, isManagedProviderApiKeyValid } from "../runtime/model-provider-definitions.mjs";
import { downloadDeepseekCatalog, createManagedDeepseekCatalog, deepseekSetupScriptUrl } from "./deepseek-setup.mjs";
import { loadResponsesModelTemplates, responsesModelTemplatesFromCatalog } from "./responses-model-templates.mjs";
import { createResponsesModelCatalog } from "../runtime/model-provider-responses-catalog.mjs";
import { managedProviderDirectory, loadManagedModelProviderSettings, loadPrimaryModelProvider } from "../runtime/model-provider-runtime.mjs";
import { applyManagedProviderAccountConfiguration, planManagedProviderAccountConfiguration, hasProviderBaseConfig, restoreProviderBaseConfig } from "./managed-model-provider-setup.mjs";
import { addProviderFileArchive, applyProviderFileUpdates, snapshotProviderFiles } from "./managed-provider-files.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { validateModelCatalogWithCodex } from "./model-catalog-validation.mjs";
import { inspectManagedAccountRuntime, stopManagedAccountForRemoval } from "./managed-provider-account-runtime.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";

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

export function createClinePassCatalog(templates) {
  const matches = templates.filter(model => model.id === "deepseek-flash");
  if (matches.length !== 1) throw new Error("DS 模型目录必须包含唯一的 deepseek-flash 模板");
  const template = matches[0];
  if (template.reasoningEfforts.some(effort => !["none", "low", "high", "max"].includes(effort))) throw new Error("DS 模板包含 CLP 未支持的思考等级");
  return { models: createResponsesModelCatalog([{
    id: definition.defaultModel, name: "CLP DeepSeek V4.1 Flash",
    contextWindow: template.contextWindow, maxContextWindow: template.maxContextWindow,
    reasoningEfforts: [...new Set(["none", ...template.reasoningEfforts])],
    defaultReasoningEffort: template.defaultReasoningEffort, supportsImages: template.supportsImages,
    applyPatchToolType: "freeform",
    ...(template.instructions === undefined ? {} : {instructions: template.instructions}),
    supportsSearchTool: true,
  }], definition.defaultModel).models };
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

export async function applyClinePassConfiguration(input, { environment = process.env, loadTemplates = loadResponsesModelTemplates, downloadCatalog = downloadDeepseekCatalog } = {}) {
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
    const snapshots = snapshotProviderFiles([...Object.values(paths), dsCatalogPath, dsManifestPath]);
    const content = key => snapshots.find(item => item.path === paths[key]).content?.toString("utf8");
    const current = content("config") === undefined ? {} : parsePrivateConfig(content("config"));
    const previous = loadManagedModelProviderSettings(environment).find(item => item.provider === definition.id);
    if (!previous && (content("profile") !== undefined || content("marker") !== undefined || hasProviderBaseConfig(current, definition))) throw new Error("CLP 配置路径已被占用");
    const backup = content("backup") === undefined ? undefined : parsePrivateBackup(content("backup"));
    if (previous && !backup?.config) throw new Error("CLP 初始备份缺失");
    let downloadedDs;
    let catalog;
    const writesCatalog = content("catalog") === undefined;
    if (!writesCatalog) {
      try { catalog = JSON.parse(content("catalog")); }
      catch { throw new Error("CLP 模型目录无法安全读取"); }
    } else {
      if (accounts.length > 0) throw new Error("CLP 共享模型目录缺失，请先恢复文件");
      if (snapshots.find(item => item.path === dsCatalogPath).content === undefined) {
        downloadedDs = createManagedDeepseekCatalog((await downloadCatalog(globalThis.fetch)).catalog);
      }
      catalog = createClinePassCatalog(downloadedDs
        ? responsesModelTemplatesFromCatalog(downloadedDs, "deepseek")
        : await loadTemplates("deepseek", environment));
    }
    await validateModelCatalogWithCodex(catalog, environment);
    const { initial, updates } = planManagedProviderAccountConfiguration(current, backup, definition, {
      paths, mode, previousMode: previous?.mode, apiKey, catalog, model: definition.defaultModel,
    });
    if (writesCatalog) {
      updates.set(paths.catalog, `${JSON.stringify(catalog, null, 2)}\n`);
      updates.set(paths.manifest, `${JSON.stringify({ source: "deepseek", model: "deepseek-flash" })}\n`);
    }
    if (!previous) updates.set(paths.registry, `${JSON.stringify(validateClinePassAccounts([...accounts, { id: accountId, default: accounts.length === 0 }]))}\n`);
    if (downloadedDs) {
      updates.set(dsCatalogPath, `${JSON.stringify(downloadedDs, null, 2)}\n`);
      updates.set(dsManifestPath, `${JSON.stringify({ source: deepseekSetupScriptUrl, downloadedAt: new Date().toISOString() })}\n`);
    }
    if (content("backup") !== undefined && JSON.stringify(backup.config) !== JSON.stringify(initial.config)) {
      const archive = `${paths.backup}.${randomUUID()}`;
      addProviderFileArchive(updates, snapshots, paths.backup, archive);
    }
    await applyManagedProviderAccountConfiguration(updates, snapshots, paths);
    return { ...preview, action: "configured" };
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

export async function runClinePassSetup({ environment = process.env, prompts = clackPrompts, output = process.stdout } = {}) {
  const accounts = loadClinePassAccounts(environment);
  const action = await prompts.select({ message: "Cline Pass 官方", options: [
    { value: "configure", label: "添加账户" },
    ...(accounts.length ? [{ value: "reconfigure", label: "重新配置账户" }, { value: "default", label: "设置默认账户" }, { value: "remove", label: "移除账户" }] : []),
    { value: "back", label: "返回" },
  ] });
  if (prompts.isCancel(action) || action === "back") return { action: "back" };
  const accountId = action === "configure"
    ? await promptManagedAccountId(prompts, accounts)
    : await prompts.select({ message: "选择账户", options: accounts.map(account => ({ value: account.id, label: `${account.id}${account.default ? "（默认）" : ""}` })) });
  if (prompts.isCancel(accountId)) return { action: "back" };
  let result;
  if (action === "remove") {
    await previewClinePassRemoval(accountId, { environment });
    if (await prompts.confirm({ message: "移除账户配置与 Key 后，该账户历史会话将不可用；保留备份和历史统计，是否继续？", initialValue: false }) !== true) return { action: "back" };
    result = await removeClinePassConfiguration({ accountId, confirmRemove: true }, { environment });
  } else if (action === "default") {
    result = await setClinePassDefaultAccount(accountId, { environment });
  } else {
    const apiKey = await prompts.password({ message: "Cline Pass API Key", validate: value => isManagedProviderApiKeyValid(definition, value) ? undefined : "请输入有效 API Key" });
    if (prompts.isCancel(apiKey)) return { action: "back" };
    const mode = await prompts.select({ message: "运行模式", options: [{ value: "switching", label: "切换模式" }, { value: "exclusive", label: "固定模式" }] });
    if (prompts.isCancel(mode)) return { action: "back" };
    if (mode === "exclusive" && await prompts.confirm({ message: "固定模式会修改 Codex 主配置，是否继续？", initialValue: false }) !== true) return { action: "back" };
    result = await applyClinePassConfiguration({ accountId, apiKey, mode, reconfigure: action === "reconfigure", confirmExclusiveConfigChange: mode === "exclusive" }, { environment });
  }
  writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
  return result;
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
