import {
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import * as clackPrompts from "@clack/prompts";
import { parse, stringify } from "smol-toml";

import { codexHomePath } from "../runtime/codex-home.mjs";
import {
  applyOpencodeGoAccountStop,
  applyOpencodeGoDefaultAccountChange,
} from "./opencode-go-account-management.mjs";
import {
  opencodeGoAccountDefinition,
  opencodeGoProviderDefinition,
} from "../runtime/model-provider-definitions.mjs";
import {
  loadManagedModelProviderRole,
  loadManagedModelProviderSettings,
  loadPrimaryModelProvider,
  managedModelProviderRoleConfigPath,
  managedProviderDirectory,
  withManagedModelCatalogSettings,
  withPreservedManagedModelCatalogSettings,
  writeManagedModelProviderRoleConfig,
} from "../runtime/model-provider-runtime.mjs";
import {
  isOpencodeGoProvider,
  loadOpencodeGoAccounts,
  migrateLegacyOpencodeGoAccount,
  opencodeGoDefaultAccountId,
  opencodeGoAccountBackupDirectory,
  opencodeGoAccountDirectory,
  opencodeGoAccountMarkerPath,
  opencodeGoAccountsFilePath,
  opencodeGoProviderId,
  readOpencodeGoAccountMarker,
  validateOpencodeGoAccountId,
  writeOpencodeGoAccountMarker,
  writeOpencodeGoAccounts,
} from "../runtime/opencode-go-accounts.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import {
  readPrivateFileSync,
  writePrivateFileAtomic,
} from "../runtime/private-file.mjs";
import { configureThirdPartyRole } from "./agents.mjs";
import { runModelProviderDefaultSetup } from "./model-provider-default-setup.mjs";
import { deepseekSetupScriptUrl, downloadDeepseekCatalog } from "./deepseek-setup.mjs";
import {
  applyExclusiveProviderConfig,
  createSwitchingProviderProfile,
  hasProviderBaseConfig,
  restoreProviderBaseConfig,
} from "./managed-model-provider-setup.mjs";

const definition = opencodeGoProviderDefinition;
const defaultAutoCompactPercent = 60;
const defaultAccountId = opencodeGoDefaultAccountId;
const maximumPrivateConfigBytes = 2_097_152;
const previousDefaultModel = "deepseek-v4-flash";

class OpenCodeGoSetupCancelled extends Error {}

export async function runOpenCodeGoSetup({
  allowBack = false,
  environment = process.env,
  output = process.stdout,
  fetchImpl = globalThis.fetch,
  downloadCatalog = downloadDeepseekCatalog,
  prompts = clackPrompts,
  prompter,
  configureRole = configureThirdPartyRole,
} = {}) {
  const accounts = loadOpencodeGoAccounts(environment);
  const defaultAccount = accounts.find((account) => account.default) ?? accounts[0];
  const hasModelSettings = loadManagedModelProviderSettings(environment)
    .some((candidate) => isOpencodeGoProvider(candidate.provider));
  const prompt = prompter ?? createPrompter(prompts, {
    allowBack,
    hasModelSettings,
    hasAccounts: accounts.length > 0,
    legacyBackup: hasLegacyBackup(environment),
  });
  try {
    const action = await prompt.select();
    if (action === "back") return { action: "back" };
    if (action === "model-settings") {
      if (!defaultAccount) return { action: "back" };
      return runModelProviderDefaultSetup({
        allowBack: true,
        provider: opencodeGoProviderId(defaultAccount.id),
        environment,
        output,
        prompts,
      });
    }
    if (action === "restore") {
      if (!await prompt.confirm("确认恢复配置 OpenCode Go 前的文件？", false)) {
        output.write("已取消，未修改任何文件。\n");
        return undefined;
      }
      await restoreOpencodeGoSetup(environment);
      output.write("已恢复配置 OpenCode Go 前的文件。\n");
      output.write("请重启 Gateway 与 App Server：codexc service restart all\n");
      return { action: "restored" };
    }
    if (action === "account-add") {
      const accountId = await prompt.accountId();
      return addOpencodeGoAccount(accountId, {
        environment,
        output,
        fetchImpl,
        downloadCatalog,
        prompts,
        prompter: prompt,
        configureRole,
      });
    }
    if (action === "account-default") {
      const accountId = await prompt.selectAccount(accounts);
      if (accountId === undefined) return { action: "back" };
      await setOpencodeGoDefaultAccount(accountId, { environment, configureRole });
      output.write(`默认 OpenCode Go 账户已设置为 ${accountId}。\n`);
      output.write("请重启 Gateway 与 App Server：codexc service restart all\n");
      return { action: "default-set" };
    }
    if (action === "account-stop") {
      const accountId = await prompt.selectAccount(accounts);
      if (accountId === undefined) return { action: "back" };
      return stopOpencodeGoAccount(accountId, { environment, output });
    }
    if (action === "list") {
      printAccounts(environment, output);
      return { action: "listed" };
    }
    if (action === "switching" || action === "exclusive") {
      const accountId = defaultAccount?.id ?? defaultAccountId;
      return addOpencodeGoAccount(accountId, {
        mode: action,
        reconfigure: true,
        environment,
        output,
        fetchImpl,
        downloadCatalog,
        prompts,
        prompter: prompt,
        configureRole,
      });
    }
    return { action: "back" };
  } catch (error) {
    if (allowBack && error instanceof OpenCodeGoSetupCancelled) return { action: "back" };
    throw error;
  }
}

export async function addOpencodeGoAccount(accountId, {
  mode = "switching",
  reconfigure = false,
  environment = process.env,
  output = process.stdout,
  fetchImpl = globalThis.fetch,
  downloadCatalog = downloadDeepseekCatalog,
  prompts = clackPrompts,
  prompter,
  configureRole = configureThirdPartyRole,
} = {}) {
  validateOpencodeGoAccountId(accountId);
  const accounts = loadOpencodeGoAccounts(environment);
    const existingAccount = accounts.some((account) => account.id === accountId);
    if (existingAccount && !reconfigure) {
      throw new Error(`OpenCode Go 账户已存在：${accountId}`);
  }
  if (!["switching", "exclusive"].includes(mode)) {
    throw new Error("OpenCode Go 账户管理模式无效");
  }
    if (mode === "exclusive") {
    const primary = loadPrimaryModelProvider(environment);
    if (primary !== "openai" && primary !== opencodeGoProviderId(accountId)) {
      throw new Error(`请先恢复当前固定 Provider：${primary}`);
    }
    if (accounts.length > 1) {
      throw new Error("固定模式只允许一个 OpenCode Go 账户，其余账户必须使用切换模式");
    }
  }
  const paths = accountPaths(environment, accountId);
  await assertProfileOwnership(paths, accountId, environment);
  if (mode === "exclusive" && prompter) {
    if (!await prompter.confirm("固定模式会修改并备份 ~/.codex/config.toml，确认继续？", false)) {
      output.write("已取消，未修改任何文件。\n");
      return { action: "cancelled", accountId };
    }
  }
  const apiKey = prompter
    ? await prompter.secret("OpenCode Go API Key（以 sk- 开头）")
    : await secretPrompt(prompts);
  if (!/^sk-[^\s"]+$/u.test(apiKey) || apiKey.length > 4_096) {
    throw new Error("OpenCode Go API Key 无效");
  }
  const previous = loadManagedModelProviderSettings(environment).find(
    (candidate) => candidate.provider === opencodeGoProviderId(accountId),
  );
  const selectedModel = previous?.model ?? definition.defaultModel;
  let managedCatalog;
  let manifest;
  if (existingAccount || !existsSync(paths.catalogPath)) {
    const downloaded = await downloadCatalog(fetchImpl);
    const model = downloaded.catalog.models.find(
      (candidate) => candidate?.slug === definition.defaultModel,
    );
    const contextWindow = model?.context_window;
    if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
      throw new Error("OpenCode Go 模型目录缺少上下文窗口");
    }
    const autoCompactLimit = Math.round(contextWindow * defaultAutoCompactPercent / 100);
    managedCatalog = withManagedModelCatalogSettings(
      downloaded.catalog,
      definition,
      {
        model: definition.defaultModel,
        reasoningEffort: definition.defaultReasoningEffort,
        autoCompactLimit,
      },
    );
    const previousManifest = await readOptionalJson(
      paths.manifestPath,
      "OpenCode Go 模型目录清单",
    );
    const defaultModelMigration = readDefaultModelMigration(previousManifest);
    manifest = {
      source: deepseekSetupScriptUrl,
      sha256: downloaded.sha256,
      downloadedAt: new Date().toISOString(),
      ...(defaultModelMigration === undefined ? {} : { defaultModelMigration }),
    };
  } else {
    managedCatalog = JSON.parse(readPrivateFileSync(
      paths.catalogPath,
      maximumPrivateConfigBytes,
    ));
    manifest = existsSync(paths.manifestPath)
      ? JSON.parse(readPrivateFileSync(paths.manifestPath, maximumPrivateConfigBytes))
      : undefined;
  }
  const managedCatalogWithPreserved = withPreservedManagedModelCatalogSettings(
    managedCatalog,
    definition,
    previous?.models,
  );
  const transactionPaths = [
    paths.configPath,
    paths.profilePath,
    paths.markerPath,
    paths.roleConfigPath,
    paths.catalogPath,
    paths.manifestPath,
    opencodeGoAccountsFilePath(environment),
  ];
  const snapshots = snapshotFiles(transactionPaths);
  let guards;
  try {
    mkdirSync(paths.accountDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(paths.backupDirectory, { recursive: true, mode: 0o700 });
    if (accounts.length === 0) {
      await preserveInitialFiles(paths);
    }
    const currentConfig = await readTomlFile(paths.configPath);
    const initialConfig = await readBackupToml(paths);
    let nextConfig = currentConfig;
    let profileContent;
    if (mode === "switching") {
      if (currentMode(environment, accountId) === "exclusive") {
        nextConfig = restoreProviderBaseConfig(
          currentConfig,
          initialConfig,
          opencodeGoAccountDefinition(accountId),
        );
      }
      if (hasProviderBaseConfig(nextConfig, opencodeGoAccountDefinition(accountId))) {
        throw new Error(
          `安装前的 Codex config.toml 已占用 ${opencodeGoProviderId(accountId)} Provider 或 Profile；请先手工移除或改名`,
        );
      }
      const selectedModelEntry = managedCatalogWithPreserved.models?.find(
        (entry) => entry?.slug === selectedModel,
      );
      const selectedModelReasoningEffort = selectedModelEntry?.default_reasoning_level;
      if (typeof selectedModelReasoningEffort !== "string") {
        throw new Error("OpenCode Go 模型目录缺少默认思考等级");
      }
      const accountDefinition = opencodeGoAccountDefinition(accountId);
      profileContent = stringify(createSwitchingProviderProfile(accountDefinition, {
        apiKey,
        catalogPath: paths.catalogPath,
        model: selectedModel,
        reasoningEffort: selectedModelReasoningEffort,
      }));
    } else {
      const accountDefinition = opencodeGoAccountDefinition(accountId);
      nextConfig = applyExclusiveProviderConfig(currentConfig, accountDefinition, {
        apiKey,
        catalogPath: paths.catalogPath,
        model: selectedModel,
      });
    }
    await writePrivateFileAtomic(
      paths.catalogPath,
      `${JSON.stringify(managedCatalogWithPreserved, null, 2)}\n`,
    );
    guards = snapshotFiles(transactionPaths);
    await writePrivateFileAtomic(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    guards = snapshotFiles(transactionPaths);
    await replaceOptionalFile(
      paths.configPath,
      Object.keys(nextConfig).length === 0 ? undefined : stringify(nextConfig),
    );
    guards = snapshotFiles(transactionPaths);
    await replaceOptionalFile(paths.profilePath, profileContent);
    guards = snapshotFiles(transactionPaths);
    writeOpencodeGoAccountMarker(environment, accountId, mode);
    guards = snapshotFiles(transactionPaths);
    const nextAccounts = accounts.some((account) => account.id === accountId)
      ? accounts.map((account) => account.id === accountId
          ? { id: accountId, default: account.default }
          : account)
      : [
          ...accounts,
          { id: accountId, default: accounts.length === 0 },
        ];
    writeOpencodeGoAccounts(environment, nextAccounts);
    guards = snapshotFiles(transactionPaths);
    if (accounts.length === 0 || accounts.find((account) => account.id === accountId)?.default) {
      await configureRole(opencodeGoProviderId(accountId), selectedModel, environment);
    }
  } catch (error) {
    if (guards === undefined) throw error;
    await restoreSnapshots(snapshots, guards).catch((rollbackError) => {
      throw new AggregateError(
        [error, rollbackError],
        "OpenCode Go 账户配置失败，且未能完整恢复操作前文件",
      );
    });
    throw error;
  }
  output.write(mode === "switching"
    ? `OpenCode Go 账户 Profile 已保存：${paths.profilePath}\n`
    : `OpenCode Go 账户固定配置已保存：${paths.configPath}\n`);
  output.write(`模型目录：${paths.catalogPath}\n`);
  if (accounts.length === 0) {
    output.write("共享第三方子代理（agents.external）已切换到默认账户。\n");
  }
  output.write("请重启 Gateway 与 App Server：codexc service restart all\n");
  return { action: "configured", mode, accountId, ...publicPaths(paths) };
}

export function printOpencodeGoAccounts(environment = process.env, output = process.stdout, { json = false } = {}) {
  const accounts = loadOpencodeGoAccounts(environment);
  if (json) {
    output.write(`${JSON.stringify({
      accounts: accounts.map((account) => {
        const marker = readOpencodeGoAccountMarker(environment, account.id);
        return {
          id: account.id,
          default: account.default,
          provider: opencodeGoProviderId(account.id),
          mode: marker?.mode ?? "unconfigured",
        };
      }),
    })}\n`);
    return;
  }
  if (accounts.length === 0) {
    output.write("尚未配置 OpenCode Go 账户。\n");
    return;
  }
  for (const account of accounts) {
    const marker = readOpencodeGoAccountMarker(environment, account.id);
    output.write(
      `${account.id}${account.default ? "（默认）" : ""} · ${marker?.mode ?? "未配置"} · Provider ${opencodeGoProviderId(account.id)}\n`,
    );
  }
}

export async function removeOpencodeGoAccount(accountId, {
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  confirm = true,
} = {}) {
  validateOpencodeGoAccountId(accountId);
  const accounts = loadOpencodeGoAccounts(environment);
  const account = accounts.find((candidate) => candidate.id === accountId);
  if (!account) throw new Error(`OpenCode Go 账户不存在：${accountId}`);
  if (accounts.length === 1) {
    throw new Error("不能删除最后一个 OpenCode Go 账户；请在 Setup 中选择恢复配置");
  }
  const role = loadManagedModelProviderRole(environment);
  if (role?.provider === opencodeGoProviderId(accountId)) {
    throw new Error(
      `OpenCode Go 账户 ${accountId} 是 agents.external 当前账户；请先运行 codexc opencode-go account default <其他账户> 或 codexc agents disable`,
    );
  }
  if (confirm && !await confirmPrompt(prompts, `确认删除 OpenCode Go 账户 ${accountId}？历史 Thread 将不可恢复。`, false)) {
    output.write("已取消，未修改任何文件。\n");
    return { action: "cancelled" };
  }
  const paths = accountPaths(environment, accountId);
  const stopResult = await stopOpencodeGoAccount(accountId, {
    environment,
    output,
    silent: true,
  });
  if (stopResult.action === "in-use") {
    throw new Error(
      `OpenCode Go 账户 ${accountId} 正在被 Remote TUI 使用；请退出对应 TUI 后再删除`,
    );
  }
  mkdirSync(paths.backupDirectory, { recursive: true, mode: 0o700 });
  const profile = await readOptionalFile(paths.profilePath);
  if (profile !== undefined) {
    await writePrivateFileAtomic(
      join(paths.backupDirectory, opencodeGoProfileFileName(accountId)),
      profile,
    );
  }
  const marker = await readOptionalFile(paths.markerPath);
  if (marker !== undefined) {
    await writePrivateFileAtomic(
      join(paths.backupDirectory, "managed.toml"),
      marker,
    );
  }
  const remaining = accounts.filter((candidate) => candidate.id !== accountId);
  if (account.default && remaining.length > 0) {
    remaining[0] = { ...remaining[0], default: true };
  }
  const transactionPaths = [
    opencodeGoAccountsFilePath(environment),
    paths.profilePath,
    paths.markerPath,
  ];
  const snapshots = snapshotFiles(transactionPaths);
  let guards;
  try {
    writeOpencodeGoAccounts(environment, remaining);
    guards = snapshotFiles(transactionPaths);
    if (existsSync(paths.profilePath)) unlinkSync(paths.profilePath);
    guards = snapshotFiles(transactionPaths);
    if (existsSync(paths.markerPath)) unlinkSync(paths.markerPath);
  } catch (error) {
    if (guards === undefined) throw error;
    await restoreSnapshots(snapshots, guards).catch((rollbackError) => {
      throw new AggregateError(
        [error, rollbackError],
        "OpenCode Go 账户删除失败，且未能完整恢复操作前文件",
      );
    });
    throw error;
  }
  output.write(`OpenCode Go 账户已删除：${accountId}（备份保留在 ${paths.backupDirectory}）。\n`);
  output.write("请重启 Gateway 与 App Server：codexc service restart all\n");
  return { action: "removed", accountId };
}

export async function setOpencodeGoDefaultAccount(accountId, {
  environment = process.env,
  configureRole = configureThirdPartyRole,
} = {}) {
  const result = await applyOpencodeGoDefaultAccountChange(
    accountId,
    { environment, configureRole },
  );
  return { action: result.action, accountId };
}

export async function refreshOpencodeGoCatalogForUpdate(
  environment = process.env,
  options = {},
) {
  const accounts = loadOpencodeGoAccounts(environment);
  const previousSettings = loadManagedModelProviderSettings(environment)
    .filter(({ provider }) => isOpencodeGoProvider(provider));
  if (accounts.length === 0 || previousSettings.length === 0) {
    return { status: "not-configured" };
  }
  const downloaded = await (options.downloadCatalog
    ? options.downloadCatalog()
    : downloadDeepseekCatalog(options.fetchImpl ?? globalThis.fetch));
  const models = Array.isArray(downloaded.catalog?.models)
    ? downloaded.catalog.models
    : [];
  for (const { slug, available } of definition.models) {
    if (available && !models.some((model) => model?.slug === slug)) {
      throw new Error(`OpenCode Go 官方模型目录缺少 ${slug}`);
    }
  }
  const defaultEntry = models.find((model) => model?.slug === definition.defaultModel);
  const contextWindow = defaultEntry?.context_window;
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error("OpenCode Go 模型目录缺少默认模型上下文窗口");
  }
  const managedCatalog = withPreservedManagedModelCatalogSettings(
    withManagedModelCatalogSettings(downloaded.catalog, definition, {
      model: definition.defaultModel,
      reasoningEffort: definition.defaultReasoningEffort,
      autoCompactLimit: Math.round(contextWindow * defaultAutoCompactPercent / 100),
    }),
    definition,
    previousSettings[0]?.models,
  );
  const managedDefault = managedCatalog.models.find(
    (model) => model?.slug === definition.defaultModel,
  );
  const reasoningEffort = managedDefault?.default_reasoning_level;
  if (typeof reasoningEffort !== "string") {
    throw new Error("OpenCode Go 模型目录缺少默认思考等级");
  }
  const providerDirectory = managedProviderDirectory(environment, definition);
  const catalogPath = join(providerDirectory, definition.catalogFileName);
  const manifestPath = join(providerDirectory, definition.catalogManifestFileName);
  const previousManifest = await readOptionalJson(manifestPath, "OpenCode Go 模型目录清单");
  const previousMigration = readDefaultModelMigration(previousManifest);
  const migrationAlreadyApplied = previousMigration !== undefined;
  const settingsByProvider = new Map(
    previousSettings.map((settings) => [settings.provider, settings]),
  );
  const updates = [];
  const migratedProviders = [];
  for (const account of accounts) {
    const provider = opencodeGoProviderId(account.id);
    const settings = settingsByProvider.get(provider);
    if (migrationAlreadyApplied || !settings || settings.model !== previousDefaultModel) continue;
    const paths = accountPaths(environment, account.id);
    const documentPath = settings.mode === "switching" ? paths.profilePath : paths.configPath;
    const document = await readTomlFile(documentPath);
    if (document.model !== previousDefaultModel || document.model_provider !== provider) {
      throw new Error(`OpenCode Go 账户 ${account.id} 默认模型配置不一致`);
    }
    document.model = definition.defaultModel;
    if (settings.mode === "switching") {
      document.model_reasoning_effort = reasoningEffort;
    } else {
      delete document.model_reasoning_effort;
      delete document.model_context_window;
      delete document.model_auto_compact_token_limit;
      delete document.model_auto_compact_token_limit_scope;
    }
    updates.push({ path: documentPath, content: stringify(document) });
    migratedProviders.push(provider);
  }
  const role = loadManagedModelProviderRole(environment);
  const migrateRole = !migrationAlreadyApplied
    && role !== undefined
    && isOpencodeGoProvider(role.provider)
    && role.model === previousDefaultModel;
  const roleConfigPath = managedModelProviderRoleConfigPath(environment);
  const transactionPaths = [
    catalogPath,
    manifestPath,
    ...updates.map(({ path }) => path),
    ...(migrateRole ? [roleConfigPath] : []),
  ];
  const snapshots = snapshotFiles(transactionPaths);
  let guards = snapshots;
  try {
    await writePrivateFileAtomic(catalogPath, `${JSON.stringify(managedCatalog, null, 2)}\n`);
    guards = snapshotFiles(transactionPaths);
    const updatedAt = (options.now ?? (() => new Date()))().toISOString();
    await writePrivateFileAtomic(manifestPath, `${JSON.stringify({
      source: deepseekSetupScriptUrl,
      sha256: downloaded.sha256,
      downloadedAt: updatedAt,
      defaultModelMigration: migrationAlreadyApplied
        ? previousMigration
        : {
            from: previousDefaultModel,
            to: definition.defaultModel,
            appliedAt: updatedAt,
          },
    }, null, 2)}\n`);
    guards = snapshotFiles(transactionPaths);
    for (const update of updates) {
      await writePrivateFileAtomic(update.path, update.content);
      guards = snapshotFiles(transactionPaths);
    }
    if (migrateRole) {
      writeManagedModelProviderRoleConfig(environment, {
        provider: role.provider,
        model: definition.defaultModel,
      });
      guards = snapshotFiles(transactionPaths);
    }
  } catch (error) {
    try {
      await restoreSnapshots(snapshots, guards);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "OpenCode Go 模型目录更新失败，且未能完整恢复更新前文件",
        { cause: rollbackError },
      );
    }
    throw error;
  }
  return {
    status: "updated",
    catalogPath,
    manifestPath,
    modelCount: managedCatalog.models.length,
    migratedProviders,
    roleMigrated: migrateRole,
    defaultModelMigrationApplied: !migrationAlreadyApplied,
  };
}

export async function stopOpencodeGoAccount(accountId, {
  environment = process.env,
  output = process.stdout,
  silent = false,
} = {}) {
  const result = await applyOpencodeGoAccountStop(accountId, { environment });
  if (result.action === "not-running") {
    if (!silent) output.write(`OpenCode Go 账户 ${accountId} 的 App Server 当前未运行。\n`);
    return { action: result.action, accountId };
  }
  if (result.action === "in-use") {
    if (!silent) {
      output.write(
        `OpenCode Go 账户 ${accountId} 正在被 Remote TUI 使用，未停止。请退出对应 TUI 后重试。\n`,
      );
    }
    return { action: result.action, accountId };
  }
  if (!silent) {
    output.write(`OpenCode Go 账户 ${accountId} 的 App Server 已停止；再次使用时会自动启动。\n`);
  }
  return { action: result.action, accountId };
}

export async function runOpencodeGoAccountCli(args, options = {}) {
  const [command, action, id, ...extra] = args;
  if (command !== "account" || !["add", "list", "remove", "default", "stop"].includes(action)) {
    throw new Error(
      "用法：codexc opencode-go account <add|list|remove|default|stop> [id]",
    );
  }
  if (action === "list") {
    if (id !== undefined && id !== "--json" || extra.length > 0) {
      throw new Error("用法：codexc opencode-go account list [--json]");
    }
    printOpencodeGoAccounts(
      options.environment ?? process.env,
      options.output ?? process.stdout,
      { json: id === "--json" },
    );
    return;
  }
  if (id === undefined || (action === "add" && !options.prompter && !process.stdin.isTTY)) {
    throw new Error(
      `用法：codexc opencode-go account ${action} <id>`,
    );
  }
  if (action === "add") {
    const result = await addOpencodeGoAccount(id, {
      ...options,
      environment: options.environment ?? process.env,
      output: options.output ?? process.stdout,
      prompter: options.prompter ?? createPrompter(options.prompts ?? clackPrompts, {
        allowBack: false,
        hasModelSettings: false,
        hasAccounts: true,
        legacyBackup: false,
      }),
    });
    writeCliMessage("success", `OpenCode Go 账户 ${id} 已添加。`);
    return result;
  }
  if (action === "remove") {
    return removeOpencodeGoAccount(id, {
      ...options,
      environment: options.environment ?? process.env,
      output: options.output ?? process.stdout,
    });
  }
  if (action === "default") {
    const result = await setOpencodeGoDefaultAccount(id, {
      environment: options.environment ?? process.env,
    });
    const output = options.output ?? process.stdout;
    output.write(`默认 OpenCode Go 账户已设置为 ${id}。\n`);
    output.write("请重启 Gateway 与 App Server：codexc service restart all\n");
    return result;
  }
  return stopOpencodeGoAccount(id, {
    environment: options.environment ?? process.env,
    output: options.output ?? process.stdout,
  });
}

function accountPaths(environment, accountId) {
  const codexHome = codexHomePath(environment);
  const accountDefinition = opencodeGoAccountDefinition(accountId);
  const providerDirectory = managedProviderDirectory(environment, accountDefinition);
  const accountDirectory = opencodeGoAccountDirectory(environment, accountId);
  const backupDirectory = opencodeGoAccountBackupDirectory(environment, accountId);
  return {
    codexHome,
    providerDirectory,
    accountDirectory,
    backupDirectory,
    configPath: join(codexHome, "config.toml"),
    profilePath: join(codexHome, accountDefinition.profileFileName),
    markerPath: opencodeGoAccountMarkerPath(environment, accountId),
    catalogPath: join(providerDirectory, accountDefinition.catalogFileName),
    manifestPath: join(providerDirectory, accountDefinition.catalogManifestFileName),
    roleConfigPath: managedModelProviderRoleConfigPath(environment),
  };
}

function opencodeGoProfileFileName(accountId) {
  return opencodeGoAccountDefinition(accountId).profileFileName;
}

function publicPaths(paths) {
  return {
    configPath: paths.configPath,
    profilePath: paths.profilePath,
    markerPath: paths.markerPath,
    catalogPath: paths.catalogPath,
  };
}

async function restoreOpencodeGoSetup(environment) {
  const legacyBackup = join(
    managedProviderDirectory(environment, definition),
    definition.backupDirectoryName,
  );
  const legacyStatePath = join(legacyBackup, "state.json");
  if (!existsSync(legacyStatePath)) {
    throw new Error("未找到可恢复的 OpenCode Go 初始配置");
  }
  const state = JSON.parse(readPrivateFileSync(legacyStatePath));
  const legacyCatalogState = state.catalog === undefined && state.manifest === undefined;
  const restoredState = {
    config: state.config,
    profile: state.profile,
    marker: state.marker,
    roleConfig: state.roleConfig,
    catalog: legacyCatalogState ? false : state.catalog,
    manifest: legacyCatalogState ? false : state.manifest,
  };
  if (Object.values(restoredState).some((value) => typeof value !== "boolean")) {
    throw new Error("OpenCode Go 初始配置备份状态无效");
  }
  const codexHome = codexHomePath(environment);
  const accountPathsValue = accountPaths(environment, defaultAccountId);
  await restoreBackup(
    accountPathsValue.configPath,
    join(legacyBackup, "config.toml"),
    state.config,
  );
  await restoreBackup(
    accountPathsValue.profilePath,
    join(legacyBackup, opencodeGoProfileFileName(defaultAccountId)),
    state.profile,
  );
  await restoreBackup(
    accountPathsValue.markerPath,
    join(legacyBackup, "managed.toml"),
    state.marker,
  );
  await restoreBackup(
    accountPathsValue.roleConfigPath,
    join(legacyBackup, "sf-agent.config.toml"),
    state.roleConfig,
  );
  await restoreBackup(
    accountPathsValue.catalogPath,
    join(legacyBackup, definition.catalogFileName),
    state.catalog === undefined ? false : state.catalog,
  );
  await restoreBackup(
    accountPathsValue.manifestPath,
    join(legacyBackup, definition.catalogManifestFileName),
    state.manifest === undefined ? false : state.manifest,
  );
  if (existsSync(accountPathsValue.markerPath)) {
    const marker = parse(readPrivateFileSync(accountPathsValue.markerPath));
    if (marker.provider === "opencode-go") {
      writePrivateFileAtomic(accountPathsValue.markerPath, stringify({
        version: 1,
        provider: opencodeGoProviderId(defaultAccountId),
        mode: marker.mode,
      }));
    }
  }
  try {
    unlinkSync(opencodeGoAccountsFilePath(environment));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    rmSync(opencodeGoAccountDirectory(environment, defaultAccountId), {
      recursive: true,
      force: true,
    });
  } catch {
    // 账户目录清理失败不阻断恢复结果展示。
  }
  for (const file of [
    "sf-agent.config.toml",
    "config.toml",
    opencodeGoProfileFileName(defaultAccountId),
  ]) {
    const target = join(codexHome, file);
    if (existsSync(target) && state[backupKey(file)] === false) {
      try {
        unlinkSync(target);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
}

function backupKey(file) {
  if (file === "config.toml") return "config";
  if (file === "sf-agent.config.toml") return "roleConfig";
  if (file.startsWith("sf-opencode-go")) return "profile";
  return file;
}

async function restoreBackup(target, backup, existed) {
  if (existed === true) {
    await writePrivateFileAtomic(
      target,
      readPrivateFileSync(backup, maximumPrivateConfigBytes),
    );
  } else if (existed === false) {
    await removeOptionalFile(target);
  } else {
    throw new Error("OpenCode Go 初始配置备份状态无效");
  }
}

async function readBackupToml(paths) {
  const legacyStatePath = join(paths.providerDirectory, definition.backupDirectoryName, "state.json");
  if (!existsSync(legacyStatePath)) return {};
  const state = JSON.parse(readPrivateFileSync(legacyStatePath));
  return state.config
    ? readTomlFile(join(paths.providerDirectory, definition.backupDirectoryName, "config.toml"))
    : {};
}

async function preserveInitialFiles(paths) {
  const legacyBackup = join(paths.providerDirectory, definition.backupDirectoryName);
  const statePath = join(legacyBackup, "state.json");
  if (existsSync(statePath)) return;
  mkdirSync(legacyBackup, { recursive: true, mode: 0o700 });
  const state = {
    config: await backupOptional(paths.configPath, join(legacyBackup, "config.toml")),
    profile: await backupOptional(
      paths.profilePath,
      join(legacyBackup, opencodeGoProfileFileName(defaultAccountId)),
    ),
    marker: await backupOptional(paths.markerPath, join(legacyBackup, "managed.toml")),
    roleConfig: await backupOptional(
      paths.roleConfigPath,
      join(legacyBackup, "sf-agent.config.toml"),
    ),
    catalog: await backupOptional(
      paths.catalogPath,
      join(legacyBackup, definition.catalogFileName),
    ),
    manifest: await backupOptional(
      paths.manifestPath,
      join(legacyBackup, definition.catalogManifestFileName),
    ),
  };
  await writePrivateFileAtomic(statePath, `${JSON.stringify(state)}\n`);
}

async function backupOptional(source, target) {
  const content = await readOptionalFile(source);
  if (content === undefined) return false;
  await writePrivateFileAtomic(target, content);
  return true;
}

async function readTomlFile(path) {
  const content = await readOptionalFile(path);
  if (content === undefined) return {};
  try {
    return parse(content.toString("utf8"));
  } catch {
    throw new Error("Codex config.toml 无法安全读取或解析");
  }
}

function currentMode(environment, accountId) {
  return readOpencodeGoAccountMarker(environment, accountId)?.mode;
}

async function assertProfileOwnership(paths, accountId, environment) {
  const profile = await readOptionalFile(paths.profilePath);
  const marker = readOpencodeGoAccountMarker(environment, accountId);
  if (profile === undefined && marker === undefined) return;
  if (marker === undefined) {
    throw new Error(
      `OpenCode Go 账户管理标记不存在，拒绝覆盖现有 Profile：${paths.profilePath}`,
    );
  }
}

function hasLegacyBackup(environment) {
  return existsSync(join(
    managedProviderDirectory(environment, definition),
    definition.backupDirectoryName,
    "state.json",
  ));
}

function printAccounts(environment, output) {
  printOpencodeGoAccounts(environment, output);
}

function createPrompter(prompts, { allowBack, hasModelSettings, hasAccounts, legacyBackup }) {
  return {
    select: async () => {
      const options = [];
      if (hasAccounts) {
        options.push(
          { value: "account-add", label: "添加账户" },
          { value: "list", label: "列出账户" },
          { value: "account-default", label: "设置默认账户" },
          { value: "account-stop", label: "停止账户 App Server" },
        );
      }
      options.push(
        { value: "switching", label: hasAccounts
          ? "切换模式（配置默认账户为切换模式）"
          : `OpenAI + OpenCode Go 切换模式（创建默认账户 ${defaultAccountId}）` },
        { value: "exclusive", label: hasAccounts
          ? "固定模式（配置默认账户为固定模式）"
          : `仅 OpenCode Go 固定模式（创建默认账户 ${defaultAccountId}）` },
      );
      if (hasModelSettings) {
        options.push({ value: "model-settings", label: "修改模型设置（思考等级、自动压缩）" });
      }
      if (legacyBackup) {
        options.push({ value: "restore", label: "恢复配置前状态" });
      }
      if (allowBack) options.push({ value: "back", label: "返回上一级" });
      const value = await prompts.select({ message: "OpenCode Go Provider", options });
      if (prompts.isCancel(value)) throw new OpenCodeGoSetupCancelled();
      return value;
    },
    accountId: async () => {
      const value = await prompts.text({
        message: "新账户 id（小写字母/数字/`-`/`_`，1-32 位）",
        validate: (candidate) => {
          try {
            validateOpencodeGoAccountId(candidate);
            return undefined;
          } catch (error) {
            return error instanceof Error ? error.message : "账户 id 无效";
          }
        },
      });
      if (prompts.isCancel(value)) throw new OpenCodeGoSetupCancelled();
      return value;
    },
    selectAccount: async (accounts) => {
      const value = await prompts.select({
        message: "选择 OpenCode Go 账户",
        options: accounts.map((account) => ({
          value: account.id,
          label: `${account.id}${account.default ? "（默认）" : ""}`,
        })),
      });
      if (prompts.isCancel(value)) throw new OpenCodeGoSetupCancelled();
      return value;
    },
    secret: async (message) => {
      const value = await prompts.password({ message });
      if (prompts.isCancel(value)) throw new OpenCodeGoSetupCancelled();
      return value;
    },
    confirm: async (message, initialValue) => {
      const value = await prompts.confirm({ message, initialValue });
      if (prompts.isCancel(value)) throw new OpenCodeGoSetupCancelled();
      return value;
    },
  };
}

async function secretPrompt(prompts) {
  const value = await prompts.password({ message: "OpenCode Go API Key（以 sk- 开头）" });
  if (prompts.isCancel(value)) throw new OpenCodeGoSetupCancelled();
  return value;
}

async function confirmPrompt(prompts, message, initialValue) {
  const value = await prompts.confirm({ message, initialValue });
  if (prompts.isCancel(value)) throw new OpenCodeGoSetupCancelled();
  return value;
}

async function readOptionalFile(path) {
  try {
    return Buffer.from(readPrivateFileSync(path, maximumPrivateConfigBytes));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readOptionalJson(path, label) {
  const content = await readOptionalFile(path);
  if (content === undefined) return undefined;
  try {
    const value = JSON.parse(content.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error(`${label}无法安全读取或解析`);
  }
}

function readDefaultModelMigration(manifest) {
  const migration = manifest?.defaultModelMigration;
  if (migration === undefined) return undefined;
  if (!migration
    || typeof migration !== "object"
    || Array.isArray(migration)
    || migration.from !== previousDefaultModel
    || migration.to !== definition.defaultModel
    || typeof migration.appliedAt !== "string"
    || !Number.isFinite(Date.parse(migration.appliedAt))) {
    throw new Error("OpenCode Go 默认模型迁移标记无效");
  }
  return migration;
}

async function replaceOptionalFile(path, content) {
  if (content === undefined) return removeOptionalFile(path);
  await writePrivateFileAtomic(path, content);
}

async function removeOptionalFile(path) {
  try {
    await unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function snapshotFiles(paths) {
  return [...new Set(paths)].map((path) => ({
    path,
    content: existsSync(path)
      ? Buffer.from(readPrivateFileSync(path, maximumPrivateConfigBytes))
      : undefined,
  }));
}

async function restoreSnapshots(snapshots, guards) {
  for (const guard of guards) {
    const current = await readOptionalFile(guard.path);
    if (!sameOptionalContent(current, guard.content)) {
      throw new Error(`OpenCode Go 配置文件在事务期间发生变化：${guard.path}`);
    }
  }
  for (const snapshot of snapshots) {
    await replaceOptionalFile(snapshot.path, snapshot.content);
  }
}

function sameOptionalContent(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return left.equals(right);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateLegacyOpencodeGoAccount(process.env);
  await runOpencodeGoAccountCli(process.argv.slice(2)).catch((error) => {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
