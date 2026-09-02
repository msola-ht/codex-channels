import {
  existsSync,
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
  applyOpencodeGoAccountRemoval,
  previewOpencodeGoAccountRemoval,
} from "./opencode-go-account-management.mjs";
import {
  applyOpencodeGoAccountConfiguration,
  previewOpencodeGoAccountConfiguration,
  readOpencodeGoDefaultModelMigration,
  readOpencodeGoOptionalJson,
} from "./opencode-go-account-provisioning.mjs";
import { opencodeGoProviderDefinition } from "../runtime/model-provider-definitions.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import {
  loadManagedModelProviderRole,
  loadManagedModelProviderSettings,
  managedModelProviderRoleConfigPath,
  managedProviderDirectory,
  writeManagedModelProviderRoleConfig,
} from "../runtime/model-provider-runtime.mjs";
import {
  isOpencodeGoProvider,
  loadOpencodeGoAccounts,
  migrateLegacyOpencodeGoAccount,
  opencodeGoAccountDirectory,
  opencodeGoAccountsFilePath,
  opencodeGoProviderId,
  opencodeGoAccountDisplayName,
  readOpencodeGoAccountMarker,
  validateOpencodeGoAccountId,
  validateOpencodeGoContact,
} from "../runtime/opencode-go-accounts.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import {
  readPrivateFileSync,
  writePrivateFileAtomic,
} from "../runtime/private-file.mjs";
import { configureThirdPartyRole } from "./agents.mjs";
import {
  opencodeGoAccountPaths,
  opencodeGoProfileFileName,
  readOptionalOpencodeGoFile,
  removeOptionalOpencodeGoFile,
  restoreOpencodeGoFileSnapshots,
  snapshotOpencodeGoFiles,
} from "./opencode-go-account-files.mjs";
import { runModelProviderDefaultSetup } from "./model-provider-default-setup.mjs";
import { deepseekSetupScriptUrl, downloadDeepseekCatalog } from "./deepseek-setup.mjs";
import {
  ManagedModelProviderSetupError,
  createManagedProviderCatalog,
  createManagedProviderRestorePreview,
} from "./managed-model-provider-setup.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";

const definition = opencodeGoProviderDefinition;
const defaultAutoCompactPercent = 60;
const maximumPrivateConfigBytes = 2_097_152;
const previousDefaultModel = "deepseek-v4-flash";

class OpenCodeGoSetupCancelled extends Error {}

export function previewOpencodeGoRestore({
  environment = process.env,
} = {}) {
  try {
    readOpencodeGoRestoreState(environment);
  } catch (error) {
    if (error instanceof ManagedModelProviderSetupError) throw error;
    throw managedSetupInvalid(
      "backup-unavailable",
      "restore",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  return createManagedProviderRestorePreview(definition, {
    removesManagedAccounts: true,
  });
}

export async function applyOpencodeGoRestore(
  input,
  options = {},
) {
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(
    environment,
    () => applyOpencodeGoRestoreUnlocked(input, options),
  );
}

async function applyOpencodeGoRestoreUnlocked(
  { confirmRestore = false },
  { environment = process.env } = {},
) {
  const preview = previewOpencodeGoRestore({ environment });
  if (confirmRestore !== true) {
    throw managedSetupInvalid(
      "confirmation-required",
      "confirmRestore",
      "恢复 OpenCode Go 初始配置前必须明确确认",
    );
  }
  try {
    await restoreOpencodeGoSetup(environment);
  } catch (error) {
    if (error instanceof ManagedModelProviderSetupError) throw error;
    throw managedSetupInvalid(
      "operation-failed",
      "restore",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  return { action: "restored", ...preview };
}

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
  const defaultAccount = accounts.find((account) => account.default);
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
      previewOpencodeGoRestore({ environment });
      if (!await prompt.confirm("确认恢复配置 OpenCode Go 前的文件？", false)) {
        output.write("已取消，未修改任何文件。\n");
        return undefined;
      }
      await applyOpencodeGoRestore({ confirmRestore: true }, { environment });
      output.write("已恢复配置 OpenCode Go 前的文件。\n");
      writeGatewayConfigActivationNotice(output, environment, configActivationResult("restart-all"));
      return {
        action: "restored",
        activation: "restart-all",
        activationResult: configActivationResult("restart-all"),
      };
    }
    if (action === "account-add") {
      const accountId = await prompt.accountId();
      const contact = await prompt.contact();
      return addOpencodeGoAccount(accountId, {
        contact,
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
      writeGatewayConfigActivationNotice(output, environment, configActivationResult("restart-all"));
      return {
        action: "default-set",
        activation: "restart-all",
        activationResult: configActivationResult("restart-all"),
      };
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
      const accountId = defaultAccount?.id
        ?? (typeof prompt.accountId === "function" ? await prompt.accountId() : undefined);
      if (accountId === undefined) return { action: "back" };
      const contact = defaultAccount?.email ?? defaultAccount?.phone
        ?? (typeof prompt.contact === "function" ? await prompt.contact() : undefined);
      return addOpencodeGoAccount(accountId, {
        mode: action,
        reconfigure: true,
        contact,
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
  email,
  phone,
  contact,
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
  let resolvedContact = contact;
  if (resolvedContact === undefined && email === undefined && phone === undefined) {
    if (prompter && typeof prompter.contact === "function") {
      resolvedContact = await prompter.contact();
    } else if (prompts && typeof prompts.text === "function") {
      resolvedContact = await contactPrompt(prompts);
    }
  }
  const preview = await previewOpencodeGoAccountConfiguration({
    accountId,
    email,
    phone,
    contact: resolvedContact,
    mode,
    reconfigure,
  }, { environment });
  if (mode === "exclusive") {
    const confirmed = prompter
      ? await prompter.confirm("固定模式会修改并备份 ~/.codex/config.toml，确认继续？", false)
      : await confirmPrompt(
          prompts,
          "固定模式会修改并备份 ~/.codex/config.toml，确认继续？",
          false,
        );
    if (!confirmed) {
      output.write("已取消，未修改任何文件。\n");
      return { action: "cancelled", accountId };
    }
  }
  const apiKey = prompter
    ? await prompter.secret("OpenCode Go API Key（以 sk- 开头）")
    : await secretPrompt(prompts);
  const result = await applyOpencodeGoAccountConfiguration({
    accountId: preview.account.id,
    email: preview.account.email,
    phone: preview.account.phone,
    mode,
    reconfigure,
    apiKey,
    confirmExclusiveConfigChange: true,
  }, { environment, fetchImpl, downloadCatalog, configureRole });
  const paths = result.paths;
  output.write(mode === "switching"
    ? `OpenCode Go 账户 Profile 已保存：${paths.profilePath}\n`
    : `OpenCode Go 账户固定配置已保存：${paths.configPath}\n`);
  output.write(`模型目录：${paths.catalogPath}\n`);
  if (preview.effects.updatesExternalAgent && !preview.account.exists) {
    output.write("共享第三方子代理（agents.external）已切换到默认账户。\n");
  }
  writeGatewayConfigActivationNotice(output, environment, configActivationResult("restart-all"));
  return {
    action: "configured",
    mode,
    accountId,
    ...paths,
    activation: "restart-all",
    activationResult: configActivationResult("restart-all"),
  };
}

export function printOpencodeGoAccounts(environment = process.env, output = process.stdout, { json = false } = {}) {
  const accounts = loadOpencodeGoAccounts(environment);
  if (json) {
    output.write(`${JSON.stringify({
      accounts: accounts.map((account) => {
        const marker = readOpencodeGoAccountMarker(environment, account.id);
        return {
          id: account.id,
          email: account.email,
          phone: account.phone,
          displayName: opencodeGoAccountDisplayName(account),
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
      `${opencodeGoAccountDisplayName(account)}${account.default ? "（默认）" : ""} · ${marker?.mode ?? "未配置"} · Provider ${opencodeGoProviderId(account.id)}\n`,
    );
  }
}

export async function removeOpencodeGoAccount(accountId, {
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  confirm = true,
} = {}) {
  const preview = await previewOpencodeGoAccountRemoval(accountId, { environment });
  if (confirm && !await confirmPrompt(prompts, `确认删除 OpenCode Go 账户 ${accountId}？历史 Thread 将不可恢复。`, false)) {
    output.write("已取消，未修改任何文件。\n");
    return { action: "cancelled" };
  }
  const result = await applyOpencodeGoAccountRemoval({
    accountId: preview.account.id,
    confirmHistoryLoss: true,
  }, {
    environment,
  });
  output.write(`OpenCode Go 账户已删除：${accountId}（备份保留在 ${result.backupDirectory}）。\n`);
  writeGatewayConfigActivationNotice(output, environment, configActivationResult("restart-all"));
  return {
    action: "removed",
    accountId,
    activation: "restart-all",
    activationResult: configActivationResult("restart-all"),
  };
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
  const managedCatalog = createManagedProviderCatalog(downloaded.catalog, definition, {
    previousModels: previousSettings[0]?.models,
    autoCompactPercent: defaultAutoCompactPercent,
  });
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
  const previousManifest = await readOpencodeGoOptionalJson(
    manifestPath,
    "OpenCode Go 模型目录清单",
  );
  const previousMigration = readOpencodeGoDefaultModelMigration(previousManifest);
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
    const paths = opencodeGoAccountPaths(environment, account.id);
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
  const snapshots = snapshotOpencodeGoFiles(transactionPaths);
  let guards = snapshots;
  try {
    await writePrivateFileAtomic(catalogPath, `${JSON.stringify(managedCatalog, null, 2)}\n`);
    guards = snapshotOpencodeGoFiles(transactionPaths);
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
    guards = snapshotOpencodeGoFiles(transactionPaths);
    for (const update of updates) {
      await writePrivateFileAtomic(update.path, update.content);
      guards = snapshotOpencodeGoFiles(transactionPaths);
    }
    if (migrateRole) {
      writeManagedModelProviderRoleConfig(environment, {
        provider: role.provider,
        model: definition.defaultModel,
      });
      guards = snapshotOpencodeGoFiles(transactionPaths);
    }
  } catch (error) {
    try {
      await restoreOpencodeGoFileSnapshots(snapshots, guards);
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
    writeGatewayConfigActivationNotice(
      output,
      options.environment ?? process.env,
      configActivationResult("restart-all"),
    );
    return result;
  }
  return stopOpencodeGoAccount(id, {
    environment: options.environment ?? process.env,
    output: options.output ?? process.stdout,
  });
}

async function restoreOpencodeGoSetup(environment) {
  const { accountId, legacyBackup, state } = readOpencodeGoRestoreState(environment);
  const codexHome = codexHomePath(environment);
  const accountPathsValue = opencodeGoAccountPaths(environment, accountId);
  await restoreBackup(
    accountPathsValue.configPath,
    join(legacyBackup, "config.toml"),
    state.config,
  );
  await restoreBackup(
    accountPathsValue.profilePath,
    join(legacyBackup, opencodeGoProfileFileName(accountId)),
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
  try {
    unlinkSync(opencodeGoAccountsFilePath(environment));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    rmSync(opencodeGoAccountDirectory(environment, accountId), {
      recursive: true,
      force: true,
    });
  } catch {
    // 账户目录清理失败不阻断恢复结果展示。
  }
  for (const file of [
    "sf-agent.config.toml",
    "config.toml",
    opencodeGoProfileFileName(accountId),
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

function readOpencodeGoRestoreState(environment) {
  const legacyBackup = join(
    managedProviderDirectory(environment, definition),
    definition.backupDirectoryName,
  );
  const legacyStatePath = join(legacyBackup, "state.json");
  if (!existsSync(legacyStatePath)) {
    throw managedSetupInvalid(
      "backup-not-found",
      "restore",
      "未找到可恢复的 OpenCode Go 初始配置",
    );
  }
  let state;
  try {
    state = JSON.parse(readPrivateFileSync(legacyStatePath));
  } catch (error) {
    throw managedSetupInvalid(
      "backup-invalid",
      "restore",
      "OpenCode Go 初始配置备份状态无效",
      error,
    );
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw managedSetupInvalid(
      "backup-invalid",
      "restore",
      "OpenCode Go 初始配置备份状态无效",
    );
  }
  if (state.version !== 2 || typeof state.accountId !== "string") {
    throw managedSetupInvalid(
      "backup-invalid",
      "restore",
      "OpenCode Go 初始配置备份不包含账户 ID，不能自动恢复为 main；请手工恢复或重新添加账户",
    );
  }
  try {
    validateOpencodeGoAccountId(state.accountId);
  } catch (error) {
    throw managedSetupInvalid(
      "backup-invalid",
      "restore",
      "OpenCode Go 初始配置备份中的账户 ID 无效",
      error,
    );
  }
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
    throw managedSetupInvalid(
      "backup-invalid",
      "restore",
      "OpenCode Go 初始配置备份状态无效",
    );
  }
  return { accountId: state.accountId, legacyBackup, state };
}

function backupKey(file) {
  if (file === "config.toml") return "config";
  if (file === "sf-agent.config.toml") return "roleConfig";
  if (file.startsWith("sf-ocg-")) return "profile";
  return file;
}

async function restoreBackup(target, backup, existed) {
  if (existed === true) {
    await writePrivateFileAtomic(
      target,
      readPrivateFileSync(backup, maximumPrivateConfigBytes),
    );
  } else if (existed === false) {
    await removeOptionalOpencodeGoFile(target);
  } else {
    throw new Error("OpenCode Go 初始配置备份状态无效");
  }
}

async function readTomlFile(path) {
  const content = await readOptionalOpencodeGoFile(path);
  if (content === undefined) return {};
  try {
    return parse(content.toString("utf8"));
  } catch {
    throw new Error("Codex config.toml 无法安全读取或解析");
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
          : "OpenAI + OpenCode Go 切换模式（先输入账户 ID）" },
        { value: "exclusive", label: hasAccounts
          ? "固定模式（配置默认账户为固定模式）"
          : "仅 OpenCode Go 固定模式（先输入账户 ID）" },
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
    contact: async () => {
      const value = await prompts.text({
        message: "OpenCode Go 账户邮箱或手机号码（用于展示和指标中心，二选一）",
        validate: (candidate) => {
          try {
            validateOpencodeGoContact(candidate);
            return undefined;
          } catch (error) {
            return error instanceof Error ? error.message : "邮箱无效";
          }
        },
      });
      if (prompts.isCancel(value)) throw new OpenCodeGoSetupCancelled();
      return value.trim();
    },
    selectAccount: async (accounts) => {
      const value = await prompts.select({
        message: "选择 OpenCode Go 账户",
        options: accounts.map((account) => ({
          value: account.id,
          label: `${opencodeGoAccountDisplayName(account)}${account.default ? "（默认）" : ""}`,
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

async function contactPrompt(prompts) {
  const value = await prompts.text({
    message: "OpenCode Go 账户邮箱或手机号码（用于展示和指标中心，二选一）",
    validate: (candidate) => {
      try {
        validateOpencodeGoContact(candidate);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : "邮箱或手机号码无效";
      }
    },
  });
  if (prompts.isCancel(value)) throw new OpenCodeGoSetupCancelled();
  return value.trim();
}

async function confirmPrompt(prompts, message, initialValue) {
  const value = await prompts.confirm({ message, initialValue });
  if (prompts.isCancel(value)) throw new OpenCodeGoSetupCancelled();
  return value;
}

function managedSetupInvalid(code, field, message, cause) {
  return new ManagedModelProviderSetupError(
    code,
    field,
    message,
    cause === undefined ? undefined : { cause },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateLegacyOpencodeGoAccount(process.env);
  await runOpencodeGoAccountCli(process.argv.slice(2)).catch((error) => {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
