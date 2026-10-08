import { opencodeGoReservedAccountIds } from "../runtime/managed-provider-account-options.mjs";
import { promptManagedAccountId } from "./managed-provider-account-prompt.mjs";
import { isCommandHelp } from "./cli-help.mjs";
import { pathToFileURL } from "node:url";

import * as clackPrompts from "@clack/prompts";

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
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import {
  loadManagedModelProviderSettings,
} from "../runtime/model-provider-runtime.mjs";
import {
  isOpencodeGoProvider,
  loadOpencodeGoAccounts,
  opencodeGoProviderId,
  opencodeGoAccountDisplayName,
  readOpencodeGoAccountMarker,
  validateOpencodeGoContact,
} from "../runtime/opencode-go-accounts.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { runModelProviderDefaultSetup } from "./model-provider-default-setup.mjs";
import { downloadDeepseekCatalog } from "./deepseek-setup.mjs";
import { runManagedProviderModelSetup } from "./managed-provider-model-management.mjs";

class OpenCodeGoSetupCancelled extends Error {}

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
  const hasModelSettings = loadManagedModelProviderSettings(environment)
    .some((candidate) => isOpencodeGoProvider(candidate.provider));
  const prompt = prompter ?? createPrompter(prompts, {
    allowBack,
    accounts,
    hasModelSettings,
    hasAccounts: accounts.length > 0,
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
    if (action === "catalog") return runManagedProviderModelSetup("ocg", { environment, prompts, output, downloadCatalog });
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

export async function runOpencodeGoAccountCli(args, options = {}) {
  const usage = "用法：codexc provider opencode-go <add|list|remove|default|release> [id]";
  if (isCommandHelp(args, [[], ["account"], ["account", "add"], ["account", "list"], ["account", "remove"], ["account", "default"], ["account", "stop"]], usage)) {
    (options.output ?? process.stdout).write(`${usage}\n`);
    return;
  }
  const [command, action, id, ...extra] = args;
  if (command !== "account" || !["add", "list", "remove", "default", "stop"].includes(action)) {
    throw new Error(
      usage,
    );
  }
  if (action === "list") {
    if (id !== undefined && id !== "--json" || extra.length > 0) {
      throw new Error("用法：codexc provider opencode-go list [--json]");
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
      `用法：codexc provider opencode-go ${action === "stop" ? "release" : action} <id>`,
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

function printAccounts(environment, output) {
  printOpencodeGoAccounts(environment, output);
}

function createPrompter(prompts, { accounts = [], allowBack, hasModelSettings, hasAccounts }) {
  return {
    select: async () => {
      const options = [];
      if (hasAccounts) {
        options.push(
          { value: "account-add", label: "添加账户" },
          { value: "list", label: "列出账户" },
          { value: "account-default", label: "设置默认账户" },
          { value: "account-stop", label: "释放账户 App Server 实例（可自动重新拉起）" },
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
        options.push({ value: "catalog", label: "管理共享模型（添加／启用／更新）" });
      }
      if (allowBack) options.push({ value: "back", label: "返回上一级" });
      const value = await prompts.select({ message: "OpenCode Go Provider", options });
      if (prompts.isCancel(value)) throw new OpenCodeGoSetupCancelled();
      return value;
    },
    accountId: async () => {
      const value = await promptManagedAccountId(prompts, accounts, opencodeGoReservedAccountIds);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runOpencodeGoAccountCli(process.argv.slice(2)).catch((error) => {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
