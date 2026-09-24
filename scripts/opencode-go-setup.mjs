import { isCommandHelp } from "./cli-help.mjs";
import { hasLegacyOpencodeGoConfiguration, previewLegacyOpencodeGoRemoval, removeLegacyOpencodeGoAccount } from "./opencode-go-account-management.mjs";
import {
  existsSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import * as clackPrompts from "@clack/prompts";

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
} from "./opencode-go-account-provisioning.mjs";
import { opencodeGoProviderDefinition } from "../runtime/model-provider-definitions.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import {
  loadManagedModelProviderSettings,
  managedProviderDirectory,
} from "../runtime/model-provider-runtime.mjs";
import {
  isOpencodeGoProvider,
  loadOpencodeGoAccounts,
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
import {
  opencodeGoAccountPaths,
  opencodeGoProfileFileName,
} from "./opencode-go-account-files.mjs";
import {
  removeOptionalProviderFile,
} from "./managed-provider-files.mjs";
import { runModelProviderDefaultSetup } from "./model-provider-default-setup.mjs";
import { downloadDeepseekCatalog } from "./deepseek-setup.mjs";
import {
  ManagedModelProviderSetupError,
  createManagedProviderRestorePreview,
} from "./managed-model-provider-setup.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";

const definition = opencodeGoProviderDefinition;
const maximumPrivateConfigBytes = 2_097_152;

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
} = {}) {
  const accounts = loadOpencodeGoAccounts(environment);
  const defaultAccount = accounts.find((account) => account.default);
  const legacy = hasLegacyOpencodeGoConfiguration(environment);
  const hasOldAccounts = accounts.some((account) => hasLegacyOpencodeGoConfiguration(environment, account.id));
  const hasModelSettings = !legacy && !hasOldAccounts && loadManagedModelProviderSettings(environment)
    .some((candidate) => isOpencodeGoProvider(candidate.provider));
  const prompt = prompter ?? createPrompter(prompts, {
    allowBack,
    hasModelSettings,
    hasAccounts: accounts.length > 0,
    legacyBackup: hasLegacyBackup(environment),
    legacy,
  });
  try {
    const action = await prompt.select();
    if (action === "back") return { action: "back" };
    if (action === "legacy-remove") return runLegacyOpencodeGoRemoval(undefined, { environment, output, prompts });
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
      });
    }
    if (action === "account-default") {
      const accountId = await prompt.selectAccount(accounts);
      if (accountId === undefined) return { action: "back" };
      await setOpencodeGoDefaultAccount(accountId, { environment });
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
    if (action === "account-remove") {
      const accountId = await prompt.selectAccount(accounts);
      if (accountId === undefined) return { action: "back" };
      return removeOpencodeGoAccount(accountId, {
        environment,
        output,
        prompts,
      });
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
        reconfigure: defaultAccount !== undefined,
        contact,
        environment,
        output,
        fetchImpl,
        downloadCatalog,
        prompts,
        prompter: prompt,
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
  }, { environment, fetchImpl, downloadCatalog });
  const paths = result.paths;
  output.write(mode === "switching"
    ? `OpenCode Go 账户 Profile 已保存：${paths.profilePath}\n`
    : `OpenCode Go 账户固定配置已保存：${paths.configPath}\n`);
  output.write(`模型目录：${paths.catalogPath}\n`);
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
  if (hasLegacyOpencodeGoConfiguration(environment, accountId)) {
    return runLegacyOpencodeGoRemoval(accountId, { environment, output, prompts, confirm });
  }
  const preview = await previewOpencodeGoAccountRemoval(accountId, { environment });
  const removesLastAccount = preview.effects?.removesLastAccount === true;
  const confirmationMessage = removesLastAccount
    ? preview.effects?.restoresInitialConfig === true
      ? `确认删除最后一个 OpenCode Go 账户 ${accountId}？将恢复安装前 Codex 主配置，历史 Thread 将不可恢复。`
      : `确认删除最后一个 OpenCode Go 账户 ${accountId}？将删除 OpenCode Go 全部配置与共享模型目录，历史 Thread 将不可恢复。`
    : `确认删除 OpenCode Go 账户 ${accountId}？历史 Thread 将不可恢复。`;
  if (confirm && !await confirmPrompt(prompts, confirmationMessage, false)) {
    output.write("已取消，未修改任何文件。\n");
    return { action: "cancelled" };
  }
  const result = await applyOpencodeGoAccountRemoval({
    accountId: preview.account.id,
    confirmHistoryLoss: true,
  }, {
    environment,
  });
  const cleanupSummary = removesLastAccount
    ? result.effects?.restoresInitialConfig === true
      ? "，主配置已恢复为安装前状态"
      : "，OpenCode Go 配置与共享模型目录已清理"
    : "";
  output.write(
    `OpenCode Go 账户已删除：${accountId}${cleanupSummary}（备份保留在 ${result.backupDirectory}）。\n`,
  );
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
} = {}) {
  const result = await applyOpencodeGoDefaultAccountChange(
    accountId,
    { environment },
  );
  return { action: result.action, accountId };
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

async function runLegacyOpencodeGoRemoval(accountId, {
  environment = process.env, output = process.stdout, prompts = clackPrompts, confirm = true,
} = {}) {
  const preview = await previewLegacyOpencodeGoRemoval(accountId, { environment });
  output.write(`将移除或恢复以下旧账户文件：\n${preview.files.join("\n")}\n`);
  if (confirm && !await confirmPrompt(prompts, "移除旧 OCG 账户配置和 Key？保留备份与历史统计；之后需重新添加账户。", false)) {
    return { action: "cancelled" };
  }
  const result = await removeLegacyOpencodeGoAccount({ accountId, confirmRemove: true }, { environment });
  writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
  return result;
}

export async function runOpencodeGoAccountCli(args, options = {}) {
  const usage = "用法：codexc opencode-go account <add|list|remove|default|stop> [id]\ncodexc opencode-go legacy remove（确认后移除旧单账户）";
  if (isCommandHelp(args, [[], ["account"], ["legacy"], ["legacy", "remove"], ["account", "add"], ["account", "list"], ["account", "remove"], ["account", "default"], ["account", "stop"]], usage)) {
    (options.output ?? process.stdout).write(`${usage}\n`);
    return;
  }
  const [command, action, id, ...extra] = args;
  if (command === "legacy" && action === "remove" && id === undefined) {
    return runLegacyOpencodeGoRemoval(undefined, options);
  }
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
  if (id === undefined || extra.length > 0 || (action === "add" && !options.prompter && !process.stdin.isTTY)) {
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
    accountPathsValue.catalogPath,
    join(legacyBackup, definition.catalogFileName),
    state.catalog,
  );
  await restoreBackup(
    accountPathsValue.manifestPath,
    join(legacyBackup, definition.catalogManifestFileName),
    state.manifest,
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
  const restoredState = {
    config: state.config,
    profile: state.profile,
    marker: state.marker,
    catalog: state.catalog,
    manifest: state.manifest,
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
    await removeOptionalProviderFile(target);
  } else {
    throw new Error("OpenCode Go 初始配置备份状态无效");
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

function createPrompter(prompts, { allowBack, hasModelSettings, hasAccounts, legacyBackup, legacy = false }) {
  return {
    select: async () => {
      const options = [];
      if (legacy) options.push({ value: "legacy-remove", label: "移除旧单账户，然后重新添加" });
      if (hasAccounts) {
        options.push(
          { value: "account-add", label: "添加账户" },
          { value: "list", label: "列出账户" },
          { value: "account-default", label: "设置默认账户" },
          { value: "account-stop", label: "停止账户 App Server" },
          { value: "account-remove", label: "删除账户" },
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
        options.push({ value: "model-settings", label: "修改模型设置（思考等级）" });
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
        message: "OpenCode Go 账户邮箱或手机号码（仅用于本机展示，二选一）",
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
    message: "OpenCode Go 账户邮箱或手机号码（仅用于本机展示，二选一）",
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
  await runOpencodeGoAccountCli(process.argv.slice(2)).catch((error) => {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
