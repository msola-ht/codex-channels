import { promptManagedAccountId, promptManagedAccountEdit, confirmManagedAccountEdit } from "./managed-provider-account-prompt.mjs";
import { validateModelCatalogWithCodex } from "./model-catalog-validation.mjs";
import { isCommandHelp } from "./cli-help.mjs";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import * as clackPrompts from "@clack/prompts";
import { parse, stringify } from "smol-toml";

import {
  ccgAccountDirectory,
  ccgAccountMarkerPath,
  ccgAccountsFilePath,
  ccgProviderId,
  loadCcgAccounts,
  validateCcgAccountId,
  validateCcgAccounts,
} from "../runtime/ccg-accounts.mjs";
import { codexHomePath } from "../runtime/codex-home.mjs";
import {
  ccgAccountDefinition,
  commandCodeProviderDefinition as baseDefinition,
  isManagedProviderModelValid,
} from "../runtime/model-provider-definitions.mjs";
import { createManagedProviderMarker } from "../runtime/model-provider-profile.mjs";
import {
  loadManagedModelProviderSettings,
  managedProviderDirectory,
  withManagedModelCatalogSettings,
  withPreservedManagedModelCatalogSettings,
} from "../runtime/model-provider-runtime.mjs";
import { readPrivateFileSync } from "../runtime/private-file.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { deepseekSetupScriptUrl, downloadDeepseekCatalog } from "./deepseek-setup.mjs";
import {
  createManagedProviderConfiguration,
  hasProviderBaseConfig,
  restoreProviderBaseConfig,
} from "./managed-model-provider-setup.mjs";
import {
  applyProviderFileUpdates,
  assertProviderFileSnapshots,
  readOptionalProviderFile,
  snapshotProviderFiles,
  stageManagedPrimaryCredential,
} from "./managed-provider-files.mjs";
import { runProviderModelSetup } from "./provider-model-setup.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { stopManagedAccountForRemoval } from "./managed-provider-account-runtime.mjs";
import { createCcgCatalogWithTemplateBindings } from "./provider-model-catalog.mjs";
import { readModelTemplateBindings } from "../runtime/model-template-bindings.mjs";
import { assertManagedAccountMode, snapshotManagedAccountFiles, managedAccountRevision, assertManagedAccountRevision, managedAccountConfigurationEdit } from "./managed-provider-account-plan.mjs";

const maximumCatalogBytes = 2 * 1024 * 1024;

async function validateCcgCatalog(catalog, environment) {
  checkCcgCatalog(catalog);
  await validateModelCatalogWithCodex(catalog, environment);
}

function checkCcgCatalog(catalog) {
  if (!Array.isArray(catalog?.models) || catalog.models.length === 0) {
    throw new Error("CCG 模型目录缺少 models");
  }
  const slugs = new Set();
  for (const entry of catalog.models) {
    if (!isManagedProviderModelValid(baseDefinition, entry?.slug) || slugs.has(entry.slug)
      || typeof entry.display_name !== "string" || entry.display_name.length === 0
      || !Array.isArray(entry.input_modalities) || !entry.input_modalities.includes("text")
      || new Set(entry.input_modalities).size !== entry.input_modalities.length
      || entry.input_modalities.some((value) => !["text", "image", "audio"].includes(value))) {
      throw new Error("CCG 模型目录包含无效模型名称或输入能力");
    }
    withManagedModelCatalogSettings(catalog, baseDefinition, {
      model: entry.slug, reasoningEffort: entry.default_reasoning_level,
    });
    slugs.add(entry.slug);
  }
  return catalog;
}

export function ccgSetupPaths(environment = process.env, accountId) {
  const definition = ccgAccountDefinition(accountId);
  const directory = managedProviderDirectory(environment, definition);
  const accountDirectory = ccgAccountDirectory(environment, accountId);
  return {
    config: join(codexHomePath(environment), "config.toml"),
    profile: join(codexHomePath(environment), definition.profileFileName),
    marker: ccgAccountMarkerPath(environment, accountId),
    catalog: join(directory, definition.catalogFileName),
    manifest: join(directory, definition.catalogManifestFileName),
    backup: join(accountDirectory, definition.backupDirectoryName, "config.json"),
    registry: ccgAccountsFilePath(environment),
  };
}

function ccgConfigurationPlan(input, environment) {
  const definition = ccgAccountDefinition(input.accountId);
  const accounts = loadCcgAccounts(environment);
  const existing = accounts.find(account => account.id === input.accountId);
  if (Boolean(existing) !== (input.reconfigure === true)) throw new Error(existing ? "CCG 账户已存在，请选择编辑账户" : "CCG 账户不存在");
  const previous = loadManagedModelProviderSettings(environment).find(item => item.provider === definition.id);
  if (existing && !previous) throw new Error("CCG 账户配置不完整，请先恢复缺失文件");
  const { apiKey, ...edit } = managedAccountConfigurationEdit(input, previous, definition, environment);
  if (input.model !== undefined && !isManagedProviderModelValid(definition, input.model)) throw new Error("请选择有效的 CCG 模型 ID");
  const model = input.model === undefined ? previous?.model : input.model;
  const willChange = edit.willChange || model !== previous?.model;
  assertManagedAccountMode(edit.mode, definition, environment);
  return { apiKey, preview: {
    ...edit, willChange, model,
    revision: managedAccountRevision(snapshotManagedAccountFiles(Object.values(ccgSetupPaths(environment, input.accountId)), definition, environment)),
    account: { id: input.accountId, provider: definition.id, default: existing?.default ?? accounts.length === 0 },
    effects: { writesMainConfig: willChange && (edit.mode === "exclusive" || previous?.mode === "exclusive"), writesIsolatedProfile: willChange && edit.mode === "switching" },
    activation: willChange ? "restart-all" : "none",
  } };
}

export function previewCcgConfiguration(input, { environment = process.env } = {}) {
  return ccgConfigurationPlan(input, environment).preview;
}

export async function applyCcgConfiguration(input, {
  environment = process.env,
} = {}) {
  const { accountId, catalog: source, templateBindings, model, reconfigure = false, confirmExclusiveConfigChange = false, expectedRevision } = input;
  validateCcgAccountId(accountId);
  const definition = ccgAccountDefinition(accountId);
  return withModelProviderManagementTransaction(environment, async () => {
    const { preview, apiKey } = ccgConfigurationPlan(input, environment);
    const { mode } = preview;
    assertManagedAccountRevision(expectedRevision, preview.revision);
    const accounts = loadCcgAccounts(environment);
    const existing = accounts.find((account) => account.id === accountId);
    if (Boolean(existing) !== (reconfigure === true)) {
      throw new Error(existing ? "CCG 账户已存在，请选择重新配置" : "CCG 账户不存在");
    }
    const paths = ccgSetupPaths(environment, accountId);
    const snapshots = snapshotManagedAccountFiles(Object.values(paths), definition, environment);
    assertManagedAccountRevision(preview.revision, managedAccountRevision(snapshots));
    assertManagedAccountMode(mode, definition, environment);
    const previous = loadManagedModelProviderSettings(environment)
      .find((item) => item.provider === definition.id);
    if (existing && previous === undefined) throw new Error("CCG 账户配置不完整，请先恢复缺失文件");
    if (preview.effects.writesMainConfig && confirmExclusiveConfigChange !== true) {
      throw new Error("修改 Codex 主配置前必须明确确认");
    }
    const current = await readConfig(paths.config, environment);
    if (!previous && (hasProviderBaseConfig(current, definition)
      || await readOptionalProviderFile(paths.profile, environment) !== undefined
      || await readOptionalProviderFile(paths.marker, environment) !== undefined)) {
      throw new Error("CCG 账户配置路径已被占用，请先处理现有配置");
    }
    const backup = await readInitialConfig(paths.backup, environment);
    if (previous && !backup) throw new Error("CCG 账户初始配置备份缺失，请先恢复原始备份");
    const entersExclusiveMode = previous?.mode === "switching" && mode === "exclusive";
    const initial = previous && !entersExclusiveMode ? backup : { config: current };
    let catalog;
    let writesCatalog = false;
    if (existsSync(paths.catalog)) {
      catalog = JSON.parse(readPrivateFileSync(paths.catalog, maximumCatalogBytes));
    } else {
      checkCcgCatalog(source);
      catalog = withPreservedManagedModelCatalogSettings(source, definition, []);
      writesCatalog = true;
    }
    checkCcgCatalog(catalog);
    const selectedModel = model ?? previous?.model;
    if (!catalog.models.some((entry) => entry.slug === selectedModel)) {
      throw new Error("请选择 CCG 模型目录中的模型");
    }
    await validateCcgCatalog(catalog, environment);
    if (!preview.willChange) {
      await assertProviderFileSnapshots(snapshots);
      return { ...preview, action: "unchanged", model: selectedModel };
    }
    const { config: nextConfig, profile, credential } = createManagedProviderConfiguration(
      current, initial.config, definition, {
        mode, previousMode: previous?.mode,
        previousProfile: snapshots.find(item => item.path === paths.profile)?.content?.toString("utf8"),
        apiKey, catalogPath: paths.catalog, catalog, model: selectedModel,
      },
    );
    const updates = new Map();
    if ((!previous || entersExclusiveMode) && backup) {
      const archive = join(dirname(paths.backup), `config-${randomUUID()}.json`);
      const [snapshot] = snapshotProviderFiles([archive], environment);
      if (snapshot.content !== undefined) throw new Error("CCG 备份归档路径已被占用");
      snapshots.push(snapshot);
      updates.set(archive, snapshots.find((item) => item.path === paths.backup).content);
    }
    updates.set(paths.backup, `${JSON.stringify(initial, null, 2)}\n`);
    if (writesCatalog) {
      const modelTemplates = templateBindings === undefined ? undefined
        : readModelTemplateBindings({ modelTemplates: templateBindings }, catalog.models.map(entry => entry.slug));
      updates.set(paths.catalog, `${JSON.stringify(catalog, null, 2)}\n`);
      updates.set(paths.manifest, `${JSON.stringify({
        source: deepseekSetupScriptUrl,
        downloadedAt: new Date().toISOString(),
        ...(modelTemplates === undefined ? {} : { modelTemplates }),
      }, null, 2)}\n`);
    }
    updates.set(paths.profile, profile === undefined ? undefined : stringify(profile));
    updates.set(paths.marker, stringify(createManagedProviderMarker(definition, mode)));
    if (mode === "exclusive" || previous?.mode === "exclusive") {
      updates.set(paths.config, stringify(nextConfig));
    }
    const nextAccounts = existing
      ? accounts
      : [...accounts, { id: accountId, default: accounts.length === 0 }];
    updates.set(paths.registry, `${JSON.stringify(validateCcgAccounts(nextAccounts), null, 2)}\n`);
    stageManagedPrimaryCredential(credential, definition, environment, snapshots, updates);
    await applyProviderFileUpdates(updates, snapshots);
    return {
      ...preview, action: "configured",
      account: { id: accountId, provider: definition.id, default: existing?.default ?? accounts.length === 0 },
      mode,
      model: selectedModel,
      activation: "restart-all",
    };
  });
}

export async function setCcgDefaultAccount(accountId, { environment = process.env } = {}) {
  validateCcgAccountId(accountId);
  return withModelProviderManagementTransaction(environment, async () => {
    const accounts = loadCcgAccounts(environment);
    if (!accounts.some((account) => account.id === accountId)) throw new Error("CCG 账户不存在");
    if (accounts.find(account => account.id === accountId).default) return { action: "unchanged", accountId, activation: "none" };
    const path = ccgAccountsFilePath(environment);
    const updates = new Map([[path, `${JSON.stringify(
      accounts.map((account) => ({ ...account, default: account.id === accountId })), null, 2,
    )}\n`]]);
    await applyProviderFileUpdates(updates, snapshotProviderFiles([path], environment));
    return { action: "default-set", accountId, activation: "restart-all" };
  });
}

export async function removeCcgConfiguration({ accountId, confirmRemove = false, expectedRevision } = {}, options = {}) {
  const environment = options.environment ?? process.env;
  validateCcgAccountId(accountId);
  if (confirmRemove !== true) throw new Error("删除 CCG 账户前必须明确确认");
  return withModelProviderManagementTransaction(environment, async () => {
    const accounts = loadCcgAccounts(environment);
    const currentAccount = accounts.find((account) => account.id === accountId);
    if (currentAccount === undefined) throw new Error("CCG 账户不存在");
    const definition = ccgAccountDefinition(accountId);
    const remaining = accounts.filter((account) => account.id !== accountId);
    if (remaining.length > 0 && currentAccount.default) throw new Error("请先选择其他 CCG 默认账户");
    const paths = ccgSetupPaths(environment, accountId);
    const current = loadManagedModelProviderSettings(environment)
      .find((item) => item.provider === definition.id);
    if (current === undefined) throw new Error("CCG 账户配置不完整");
    const snapshots = snapshotManagedAccountFiles(Object.values(paths), definition, environment);
    assertManagedAccountRevision(expectedRevision, managedAccountRevision(snapshots));
    const initial = await readInitialConfig(paths.backup, environment);
    if (!initial) throw new Error("CCG 账户初始配置备份缺失");
    const updates = new Map([
      [paths.profile, undefined],
      [paths.marker, undefined],
      [paths.registry, remaining.length === 0 ? undefined : `${JSON.stringify(remaining, null, 2)}\n`],
    ]);
    if (current.mode === "exclusive") {
      updates.set(paths.config, stringify(restoreProviderBaseConfig(
        await readConfig(paths.config, environment), initial.config, definition,
      )));
    }
    const runtime = await stopManagedAccountForRemoval(definition.id, options);
    await applyProviderFileUpdates(updates, snapshots);
    return { action: "removed", accountId, runtime, activation: "restart-all" };
  });
}

export async function runCcgSetup(options = {}) {
  while (true) {
    const result = await runCcgSetupOperation(options);
    if (result.action === "menu-back") return { action: "back" };
    if (result.action === "back" && options.action === undefined) continue;
    return result;
  }
}

async function runCcgSetupOperation({
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  downloadCatalog = downloadDeepseekCatalog,
  fetchImpl = globalThis.fetch,
  action: requestedAction,
  accountId: requestedAccountId,
} = {}) {
  const accounts = loadCcgAccounts(environment);
  const action = requestedAction ?? await prompts.select({
    message: "CCG（CommandCode）",
    options: [
      { value: "add", label: "添加账户" },
      ...(accounts.length === 0 ? [] : [
        { value: "reconfigure", label: "编辑账户", hint: "API Key 与运行模式" },
        { value: "models", label: "模型管理", hint: "所有 CCG 账户共用目录；默认模型按账户设置" },
        { value: "default", label: "设置默认账户", hint: "用于渠道默认选择，已有会话保持原账户" },
        { value: "remove", label: "移除本地账户配置" },
      ]),
      { value: "back", label: "返回" },
    ],
  });
  if (prompts.isCancel(action) || action === "back") return { action: "menu-back" };
  if (action === "models") return runProviderModelSetup({ environment, prompts, output, provider: "ccg" });
  const accountId = requestedAccountId ?? (action === "add"
    ? await promptManagedAccountId(prompts, accounts)
    : await prompts.select({
        message: "选择 CCG 账户",
        options: accounts.map((account) => ({
          value: account.id,
          label: `${account.id}${account.default ? "（默认）" : ""}`,
        })),
      }));
  if (prompts.isCancel(accountId)) return { action: "back" };
  validateCcgAccountId(accountId);
  let result;
  if (action === "remove") {
    const expectedRevision = managedAccountRevision(snapshotManagedAccountFiles(Object.values(ccgSetupPaths(environment, accountId)), ccgAccountDefinition(accountId), environment));
    const current = loadManagedModelProviderSettings(environment).find(entry => entry.provider === ccgProviderId(accountId));
    const confirmed = await prompts.confirm({
      message: `确认移除 CCG 账户 ${accountId} 的本地配置？将停止对应实例，该账户历史会话将不可用；保留共享模型目录、备份和历史统计。${current?.mode === "exclusive" ? "将恢复该账户接管的主配置字段，保留其他设置。" : ""}`,
      initialValue: false,
    });
    if (confirmed !== true) return { action: "back" };
    result = await removeCcgConfiguration({ accountId, confirmRemove: true, expectedRevision }, { environment });
  } else if (action === "default") {
    result = await setCcgDefaultAccount(accountId, { environment });
  } else if (["add", "reconfigure"].includes(action)) {
    const current = loadManagedModelProviderSettings(environment)
      .find((provider) => provider.provider === ccgProviderId(accountId));
    const expectedRevision = managedAccountRevision(snapshotManagedAccountFiles(Object.values(ccgSetupPaths(environment, accountId)), ccgAccountDefinition(accountId), environment));
    const edit = await promptManagedAccountEdit({ prompts, current, definition: ccgAccountDefinition(accountId), reconfigure: action === "reconfigure" });
    if (!edit) return { action: "back" };
    let catalog, templateBindings;
    const paths = ccgSetupPaths(environment, accountId);
    if (existsSync(paths.catalog)) {
      catalog = JSON.parse(readPrivateFileSync(paths.catalog, maximumCatalogBytes));
    } else {
      const downloaded = await downloadCatalog(fetchImpl);
      ({ catalog, templateBindings } = createCcgCatalogWithTemplateBindings(downloaded.catalog, environment));
    }
    const model = current?.model ?? await prompts.select({
      message: "选择 CCG 默认模型（来自目录文件）",
      options: catalog.models.map((entry) => ({ value: entry.slug, label: entry.display_name })),
      initialValue: current?.model,
    });
    if (prompts.isCancel(model)) return { action: "back" };
    const input = { accountId, ...edit, catalog, templateBindings, model, reconfigure: action === "reconfigure" };
    const preview = previewCcgConfiguration(input, { environment });
    assertManagedAccountRevision(expectedRevision, preview.revision);
    if (!await confirmManagedAccountEdit(preview, { prompts, output })) return { action: "back" };
    result = await applyCcgConfiguration({ ...input, confirmExclusiveConfigChange: preview.effects.writesMainConfig, expectedRevision: preview.revision }, { environment });
    output.write(result.action === "unchanged" ? "账户配置未变化，无需保存或重启。\n" : `CCG 账户 ${accountId} 配置已保存。\n`);
  } else {
    throw new Error("未知 CCG 账户操作");
  }
  writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
  return result;
}

async function readConfig(path, environment) {
  const content = await readOptionalProviderFile(path, environment);
  if (content === undefined) return {};
  try { return parse(content.toString("utf8")); } catch {
    throw new Error("CCG 配置无法安全解析");
  }
}

async function readInitialConfig(path, environment) {
  const content = await readOptionalProviderFile(path, environment);
  if (content === undefined) return undefined;
  try {
    const value = JSON.parse(content.toString("utf8"));
    if (!value?.config || typeof value.config !== "object" || Array.isArray(value.config)) {
      throw new Error("invalid backup");
    }
    return value;
  } catch {
    throw new Error("CCG 初始配置备份无效");
  }
}

export async function runCcgAccountCli(args, options = {}) {
  const usage = "用法：codexc provider ccg remove <id>";
  if (isCommandHelp(args, [[], ["account"], ["account", "remove"]], usage)) {
    (options.output ?? process.stdout).write(`${usage}\n`);
    return;
  }
  const [command, action, accountId, ...rest] = args;
  if (command !== "account" || action !== "remove" || accountId === undefined || rest.length !== 0) {
    throw new Error(usage);
  }
  return runCcgSetup({ ...options, action: "remove", accountId });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCcgAccountCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
