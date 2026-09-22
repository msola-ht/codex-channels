import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { effectiveCodexBinary, resolveExecutableInvocation } from "../runtime/executable.mjs";
import {
  ccgAccountDefinition,
  commandCodeProviderDefinition as baseDefinition,
  isManagedProviderApiKeyValid,
  isManagedProviderModelValid,
} from "../runtime/model-provider-definitions.mjs";
import { createManagedProviderMarker } from "../runtime/model-provider-profile.mjs";
import {
  loadManagedModelProviderSettings,
  loadPrimaryModelProvider,
  managedProviderDirectory,
  withManagedModelCatalogSettings,
  withPreservedManagedModelCatalogSettings,
} from "../runtime/model-provider-runtime.mjs";
import { readPrivateFileSync, writePrivateFileAtomic } from "../runtime/private-file.mjs";
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
  readOptionalProviderFile,
  snapshotProviderFiles,
} from "./managed-provider-files.mjs";
import { runModelProviderDefaultSetup } from "./model-provider-default-setup.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { inspectManagedAccountRuntime, stopManagedAccountForRemoval } from "./managed-provider-account-runtime.mjs";
import { createCcgCatalog } from "./provider-model-catalog.mjs";

const maximumCatalogBytes = 2 * 1024 * 1024;

async function validateCcgCatalog(catalog, environment) {
  checkCcgCatalog(catalog);
  const content = `${JSON.stringify(catalog, null, 2)}\n`;
  if (Buffer.byteLength(content) > maximumCatalogBytes) {
    throw new Error("CCG 模型目录不能超过 2 MiB");
  }
  const directory = await mkdtemp(join(tmpdir(), "codexc-ccg-catalog-"));
  try {
    const path = join(directory, "models.json");
    await writePrivateFileAtomic(path, content);
    const validationEnvironment = { ...environment, CODEX_HOME: directory };
    const invocation = resolveExecutableInvocation(
      effectiveCodexBinary("codex", environment),
      ["-c", `model_catalog_json=${JSON.stringify(path)}`, "debug", "models"],
      validationEnvironment,
    );
    const result = spawnSync(invocation.file, invocation.args, {
      cwd: directory, env: validationEnvironment,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      timeout: 30_000, maxBuffer: 8 * maximumCatalogBytes,
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (result.error || result.status !== 0) {
      throw new Error("CCG 模型目录未通过当前 Codex CLI 校验；请检查完整模型能力字段及 CLI 是否可运行");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

function legacyCcgPaths(environment) {
  const directory = managedProviderDirectory(environment, baseDefinition);
  return {
    profile: join(codexHomePath(environment), baseDefinition.profileFileName),
    marker: join(directory, baseDefinition.managedMarkerFileName),
    backup: join(directory, baseDefinition.backupDirectoryName, "config.json"),
  };
}

export function hasLegacyCcgConfiguration(environment = process.env) {
  const paths = legacyCcgPaths(environment);
  return existsSync(paths.marker) || existsSync(paths.profile);
}

export async function applyCcgConfiguration({
  accountId,
  apiKey,
  catalog: source,
  model,
  mode = "switching",
  reconfigure = false,
  confirmExclusiveConfigChange = false,
}, {
  environment = process.env,
} = {}) {
  validateCcgAccountId(accountId);
  if (hasLegacyCcgConfiguration(environment)) throw new Error("请先通过 CCG Setup 移除旧单账户，再重新添加账户");
  if (!["switching", "exclusive"].includes(mode)) throw new Error("CCG 模式无效");
  const definition = ccgAccountDefinition(accountId);
  if (!isManagedProviderApiKeyValid(definition, apiKey)) throw new Error("CCG API Key 无效");
  if (mode === "exclusive" && confirmExclusiveConfigChange !== true) {
    throw new Error("固定模式会修改 Codex 主配置，必须先明确确认");
  }
  return withModelProviderManagementTransaction(environment, async () => {
    const accounts = loadCcgAccounts(environment);
    const existing = accounts.find((account) => account.id === accountId);
    if (Boolean(existing) !== (reconfigure === true)) {
      throw new Error(existing ? "CCG 账户已存在，请选择重新配置" : "CCG 账户不存在");
    }
    const paths = ccgSetupPaths(environment, accountId);
    const snapshots = snapshotProviderFiles(Object.values(paths));
    const primary = loadPrimaryModelProvider(environment);
    if (mode === "exclusive" && !["openai", definition.id].includes(primary)) {
      throw new Error(`请先恢复当前固定 Provider：${primary}`);
    }
    const previous = loadManagedModelProviderSettings(environment)
      .find((item) => item.provider === definition.id);
    if (existing && previous === undefined) throw new Error("CCG 账户配置不完整，请先恢复缺失文件");
    const current = await readConfig(paths.config);
    if (!previous && (hasProviderBaseConfig(current, definition)
      || await readOptionalProviderFile(paths.profile) !== undefined
      || await readOptionalProviderFile(paths.marker) !== undefined)) {
      throw new Error("CCG 账户配置路径已被占用，请先处理现有配置");
    }
    const backup = await readInitialConfig(paths.backup);
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
    const { config: nextConfig, profile } = createManagedProviderConfiguration(
      current, initial.config, definition, {
        mode, previousMode: previous?.mode,
        apiKey, catalogPath: paths.catalog, catalog, model: selectedModel,
      },
    );
    const updates = new Map();
    if ((!previous || entersExclusiveMode) && backup) {
      const archive = join(dirname(paths.backup), `config-${randomUUID()}.json`);
      const [snapshot] = snapshotProviderFiles([archive]);
      if (snapshot.content !== undefined) throw new Error("CCG 备份归档路径已被占用");
      snapshots.push(snapshot);
      updates.set(archive, snapshots.find((item) => item.path === paths.backup).content);
    }
    updates.set(paths.backup, `${JSON.stringify(initial)}\n`);
    if (writesCatalog) {
      updates.set(paths.catalog, `${JSON.stringify(catalog, null, 2)}\n`);
      updates.set(paths.manifest, `${JSON.stringify({
        source: deepseekSetupScriptUrl,
        downloadedAt: new Date().toISOString(),
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
    await applyProviderFileUpdates(updates, snapshots);
    return {
      action: "configured",
      account: { id: accountId, provider: definition.id, default: existing?.default ?? accounts.length === 0 },
      mode,
      model: selectedModel,
      activation: "restart-all",
    };
  });
}

async function legacyCcgRemovalPlan(environment) {
  const legacy = legacyCcgPaths(environment);
  const marker = await readConfig(legacy.marker);
  if (marker.version !== 1 || marker.provider !== "ccg"
    || !["switching", "exclusive"].includes(marker.mode)) {
    throw new Error("旧 CCG 管理标记无效");
  }
  const configPath = join(codexHomePath(environment), "config.toml");
  const current = await readConfig(configPath);
  const updates = new Map([[legacy.marker, undefined], [legacy.profile, undefined]]);
  if (marker.mode === "exclusive") {
    if (current.model_provider !== "ccg") throw new Error("旧 CCG 配置与管理标记不一致");
    const initial = await readInitialConfig(legacy.backup);
    if (!initial) throw new Error("旧 CCG 初始配置备份缺失");
    updates.set(configPath, stringify(restoreProviderBaseConfig(current, initial.config, baseDefinition)));
  } else if (current.model_provider === "ccg") {
    throw new Error("旧 CCG 配置与管理标记不一致");
  }
  if (loadCcgAccounts(environment).length === 0) {
    const directory = managedProviderDirectory(environment, baseDefinition);
    updates.set(join(directory, baseDefinition.catalogFileName), undefined);
    updates.set(join(directory, baseDefinition.catalogManifestFileName), undefined);
  }
  const snapshots = snapshotProviderFiles([...updates.keys()]);
  return { updates, snapshots, mode: marker.mode };
}

export async function previewLegacyCcgRemoval(options = {}) {
  const plan = await legacyCcgRemovalPlan(options.environment ?? process.env);
  const runtime = await inspectManagedAccountRuntime("ccg", options);
  return { operation: "legacy-remove", account: { provider: "ccg" }, files: [...plan.updates.keys()],
    effects: { stopsRunningAppServer: runtime.running, restoresInitialConfig: plan.mode === "exclusive",
      preservesPrivateBackup: true, historyThreadsBecomeUnavailable: true }, activation: "restart-all" };
}

export async function removeLegacyCcgAccount({ confirmRemove = false } = {}, options = {}) {
  const environment = options.environment ?? process.env;
  if (confirmRemove !== true) throw new Error("移除旧 CCG 账户必须明确确认");
  return withModelProviderManagementTransaction(environment, async () => {
    const plan = await legacyCcgRemovalPlan(environment);
    const runtime = await stopManagedAccountForRemoval("ccg", options);
    await applyProviderFileUpdates(plan.updates, plan.snapshots);
    return { action: "legacy-removed", runtime, activation: "restart-all" };
  });
}

export async function refreshCcgCatalogForUpdate(environment = process.env, options = {}) {
  return withModelProviderManagementTransaction(environment, async () => {
    if (hasLegacyCcgConfiguration(environment)) throw new Error("请先通过 CCG Setup 移除旧单账户，再重新添加账户");
    const accounts = loadCcgAccounts(environment);
    if (accounts.length === 0) return { status: "not-configured" };
    const providers = loadManagedModelProviderSettings(environment)
      .filter((provider) => accounts.some((account) => ccgProviderId(account.id) === provider.provider));
    if (providers.length !== accounts.length) {
      throw new Error("CCG 账户配置不完整，请先恢复缺失文件");
    }
    const paths = ccgSetupPaths(environment, accounts[0].id);
    const accountPaths = accounts.map((account) => ccgSetupPaths(environment, account.id));
    const snapshots = snapshotProviderFiles(accountPaths.flatMap((entry) => Object.values(entry)));
    const downloaded = options.downloadCatalog
      ? await options.downloadCatalog()
      : await downloadDeepseekCatalog(options.fetchImpl ?? globalThis.fetch);
    const catalog = withPreservedManagedModelCatalogSettings(
      createCcgCatalog(downloaded.catalog), baseDefinition, providers[0]?.models ?? [],
    );
    await validateCcgCatalog(catalog, environment);
    const updates = new Map([
      [paths.catalog, `${JSON.stringify(catalog, null, 2)}\n`],
      [paths.manifest, `${JSON.stringify({
        source: deepseekSetupScriptUrl,
        downloadedAt: (options.now?.() ?? new Date()).toISOString(),
      }, null, 2)}\n`],
    ]);
    for (const provider of providers) {
      const account = accounts.find((candidate) => ccgProviderId(candidate.id) === provider.provider);
      const selected = catalog.models.find((entry) => entry.slug === provider.model);
      if (selected === undefined) {
        throw new Error(`新 CCG 目录不支持账户 ${account.id} 当前默认模型，请先选择受支持的模型`);
      }
      if (provider.mode === "switching") {
        const accountPathsForProvider = ccgSetupPaths(environment, account.id);
        const profile = await readConfig(accountPathsForProvider.profile);
        profile.model_reasoning_effort = selected.default_reasoning_level;
        updates.set(accountPathsForProvider.profile, stringify(profile));
      }
    }
    await applyProviderFileUpdates(updates, snapshots);
    return { status: "updated", providers: providers.map((provider) => provider.provider) };
  });
}

export async function setCcgDefaultAccount(accountId, { environment = process.env } = {}) {
  validateCcgAccountId(accountId);
  return withModelProviderManagementTransaction(environment, async () => {
    const accounts = loadCcgAccounts(environment);
    if (!accounts.some((account) => account.id === accountId)) throw new Error("CCG 账户不存在");
    const path = ccgAccountsFilePath(environment);
    const updates = new Map([[path, `${JSON.stringify(
      accounts.map((account) => ({ ...account, default: account.id === accountId })), null, 2,
    )}\n`]]);
    await applyProviderFileUpdates(updates, snapshotProviderFiles([path]));
    return { action: "default-set", accountId, activation: "restart-all" };
  });
}

export async function removeCcgConfiguration({ accountId, confirmRemove = false } = {}, options = {}) {
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
    const initial = await readInitialConfig(paths.backup);
    if (!initial) throw new Error("CCG 账户初始配置备份缺失");
    const snapshots = snapshotProviderFiles(Object.values(paths));
    const updates = new Map([
      [paths.profile, undefined],
      [paths.marker, undefined],
      [paths.registry, remaining.length === 0 ? undefined : `${JSON.stringify(remaining, null, 2)}\n`],
    ]);
    if (remaining.length === 0) {
      updates.set(paths.catalog, undefined);
      updates.set(paths.manifest, undefined);
    }
    if (current.mode === "exclusive") {
      updates.set(paths.config, stringify(restoreProviderBaseConfig(
        await readConfig(paths.config), initial.config, definition,
      )));
    }
    const runtime = await stopManagedAccountForRemoval(definition.id, options);
    await applyProviderFileUpdates(updates, snapshots);
    return { action: "removed", accountId, runtime, activation: "restart-all" };
  });
}

export async function runCcgSetup({
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  downloadCatalog = downloadDeepseekCatalog,
  fetchImpl = globalThis.fetch,
  action: requestedAction,
  accountId: requestedAccountId,
} = {}) {
  const accounts = loadCcgAccounts(environment);
  const legacy = hasLegacyCcgConfiguration(environment);
  const action = requestedAction ?? await prompts.select({
    message: "CCG（CommandCode）账户管理",
    options: [
      ...(legacy ? [{ value: "legacy-remove", label: "移除旧单账户，然后重新添加" }] : [{ value: "add", label: "新增账户" }]),
      ...(accounts.length === 0 ? [] : [
        { value: "reconfigure", label: "重新配置账户" },
        { value: "settings", label: "修改默认模型与思考等级" },
        { value: "default", label: "设置默认账户" },
        { value: "remove", label: "删除账户" },
      ]),
      { value: "back", label: "返回" },
    ],
  });
  if (prompts.isCancel(action) || action === "back") return { action: "back" };
  if (action === "legacy-remove") {
    const preview = await previewLegacyCcgRemoval({ environment });
    output.write(`将移除或恢复以下旧账户文件：\n${preview.files.join("\n")}\n`);
    const confirmed = await prompts.confirm({
      message: "移除旧 CCG 账户的 Key 与运行配置？保留备份和历史统计，之后需重新添加。",
      initialValue: false,
    });
    if (confirmed !== true) return { action: "back" };
    const result = await removeLegacyCcgAccount({ confirmRemove: true }, { environment });
    writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
    return result;
  }
  const accountId = requestedAccountId ?? (action === "add"
    ? await prompts.text({
        message: "账户 ID",
        validate: (value) => {
          try { validateCcgAccountId(value); } catch (error) { return error.message; }
        },
      })
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
    const confirmed = await prompts.confirm({
      message: `删除 CCG 账户 ${accountId}？将停止对应 App Server，历史 Thread 将不可恢复；保留历史统计和安装前备份。`,
      initialValue: false,
    });
    if (confirmed !== true) return { action: "back" };
    result = await removeCcgConfiguration({ accountId, confirmRemove: true }, { environment });
  } else if (action === "default") {
    result = await setCcgDefaultAccount(accountId, { environment });
  } else if (action === "settings") {
    return runModelProviderDefaultSetup({
      allowBack: true, provider: ccgProviderId(accountId), environment, output, prompts,
    });
  } else if (["add", "reconfigure"].includes(action)) {
    const mode = await prompts.select({
      message: "运行模式",
      options: [
        { value: "switching", label: "切换模式" },
        { value: "exclusive", label: "固定主 Provider" },
      ],
    });
    if (prompts.isCancel(mode)) return { action: "back" };
    if (mode === "exclusive") {
      const confirmed = await prompts.confirm({
        message: "固定模式会备份并修改 Codex 主配置，确认继续？",
        initialValue: false,
      });
      if (confirmed !== true) return { action: "back" };
    }
    const apiKey = await prompts.password({
      message: "CommandCode API Key（保存到本机 0600 私有配置）",
      validate: (value) => isManagedProviderApiKeyValid(ccgAccountDefinition(accountId), value)
        ? undefined : "CCG API Key 无效",
    });
    if (prompts.isCancel(apiKey)) return { action: "back" };
    let catalog;
    const paths = ccgSetupPaths(environment, accountId);
    if (existsSync(paths.catalog)) {
      catalog = JSON.parse(readPrivateFileSync(paths.catalog, maximumCatalogBytes));
    } else {
      const downloaded = await downloadCatalog(fetchImpl);
      catalog = createCcgCatalog(downloaded.catalog);
    }
    const current = loadManagedModelProviderSettings(environment)
      .find((provider) => provider.provider === ccgProviderId(accountId));
    const model = await prompts.select({
      message: "选择 CCG 默认模型（来自目录文件）",
      options: catalog.models.map((entry) => ({ value: entry.slug, label: entry.display_name })),
      initialValue: current?.model,
    });
    if (prompts.isCancel(model)) return { action: "back" };
    result = await applyCcgConfiguration({
      accountId, apiKey, catalog, model, mode,
      reconfigure: action === "reconfigure",
      confirmExclusiveConfigChange: mode === "exclusive",
    }, { environment });
    output.write(`CCG 账户 ${accountId} 已配置；切换模式可使用 codexc remote --profile sf-ccg-${accountId}。\n`);
  } else {
    throw new Error("未知 CCG 账户操作");
  }
  writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
  return result;
}

async function readConfig(path) {
  const content = await readOptionalProviderFile(path);
  if (content === undefined) return {};
  try { return parse(content.toString("utf8")); } catch {
    throw new Error("CCG 配置无法安全解析");
  }
}

async function readInitialConfig(path) {
  const content = await readOptionalProviderFile(path);
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
  const usage = "用法：codexc ccg account remove <id>\ncodexc ccg legacy remove（确认后移除旧单账户）";
  if (args.includes("--help") || args.includes("-h")) {
    (options.output ?? process.stdout).write(`${usage}\n`);
    return;
  }
  const [command, action, accountId, ...rest] = args;
  if (command === "legacy" && action === "remove" && accountId === undefined) {
    return runCcgSetup({ ...options, action: "legacy-remove" });
  }
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
