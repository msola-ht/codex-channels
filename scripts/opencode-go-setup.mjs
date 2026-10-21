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
  loadOpencodeGoAccounts,
  opencodeGoProviderId,
  opencodeGoAccountDisplayName,
  readOpencodeGoAccountMarker,
} from "../runtime/opencode-go-accounts.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { isManagedProviderApiKeyValid, opencodeGoProviderDefinition } from "../runtime/model-provider-definitions.mjs";
import { downloadDeepseekCatalog } from "./deepseek-setup.mjs";
import { runProviderModelSetup } from "./provider-model-setup.mjs";

class OpenCodeGoSetupCancelled extends Error {}

export async function runOpenCodeGoSetup(options = {}) {
  while (true) {
    const result = await runOpenCodeGoSetupOperation(options);
    if (result.action === "menu-back") return { action: "back" };
    if (result.action === "back" || result.action === "cancelled") continue;
    return result;
  }
}

async function runOpenCodeGoSetupOperation({
  allowBack = false,
  environment = process.env,
  output = process.stdout,
  fetchImpl = globalThis.fetch,
  downloadCatalog = downloadDeepseekCatalog,
  prompts = clackPrompts,
} = {}) {
  const accounts = loadOpencodeGoAccounts(environment);
  try {
    const action = await prompts.select({ message: "OpenCode Go 官方", options: [
      { value: "account-add", label: "添加账户" },
      ...(accounts.length ? [
        { value: "account-edit", label: "编辑账户", hint: "API Key 与运行模式" },
        { value: "models", label: "模型管理", hint: "所有 OCG 账户共用目录；默认模型按账户设置" },
        { value: "account-default", label: "设置默认账户", hint: "用于渠道默认选择，已有会话保持原账户" },
        { value: "account-remove", label: "移除本地账户配置" },
      ] : []),
      ...(allowBack ? [{ value: "back", label: "返回" }] : []),
    ] });
    if (prompts.isCancel(action) || action === "back") return { action: "menu-back" };
    if (action === "models") return runProviderModelSetup({ environment, prompts, output, provider: "ocg" });
    if (!["account-add", "account-edit", "account-default", "account-remove"].includes(action)) throw new Error("未知 OpenCode Go 账户操作");
    const accountId = action === "account-add"
      ? await promptManagedAccountId(prompts, accounts, opencodeGoReservedAccountIds)
      : await prompts.select({ message: "选择 OCG 账户", options: accounts.map(account => ({
        value: account.id, label: `${account.id}${account.default ? "（默认）" : ""}`,
      })) });
    if (prompts.isCancel(accountId)) return { action: "back" };
    if (action === "account-default") {
      const result = await setOpencodeGoDefaultAccount(accountId, { environment });
      output.write(result.action === "unchanged" ? `默认 OpenCode Go 账户仍为 ${accountId}，无需修改。\n` : `默认 OpenCode Go 账户已设置为 ${accountId}。\n`);
      writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
      return { ...result, activationResult: configActivationResult(result.activation) };
    }
    if (action === "account-remove") {
      return await removeOpencodeGoAccount(accountId, {
        environment,
        output,
        prompts,
      });
    }
    return await addOpencodeGoAccount(accountId, {
      reconfigure: action === "account-edit", environment, output, fetchImpl, downloadCatalog, prompts,
    });
  } catch (error) {
    if (allowBack && error instanceof OpenCodeGoSetupCancelled) return { action: "back" };
    throw error;
  }
}

export async function addOpencodeGoAccount(accountId, {
  email,
  phone,
  contact,
  mode,
  reconfigure = false,
  environment = process.env,
  output = process.stdout,
  fetchImpl = globalThis.fetch,
  downloadCatalog = downloadDeepseekCatalog,
  prompts = clackPrompts,
} = {}) {
  const current = loadManagedModelProviderSettings(environment).find(provider => provider.provider === opencodeGoProviderId(accountId));
  const selectedMode = mode ?? await prompts.select({ message: "运行模式", initialValue: current?.mode ?? "switching", options: [
    { value: "switching", label: "切换模式", hint: "保留 OpenAI 主实例，使用独立实例" },
    { value: "exclusive", label: "固定模式", hint: "修改主实例配置，使用此账户" },
  ] });
  if (prompts.isCancel(selectedMode)) return { action: "back" };
  const key = await prompts.password({
    message: reconfigure ? "OpenCode Go API Key（留空保留当前 Key）" : "OpenCode Go API Key",
    validate: (value = "") => reconfigure && value === "" || isManagedProviderApiKeyValid(opencodeGoProviderDefinition, value)
      ? undefined : "请输入有效 API Key",
  });
  if (prompts.isCancel(key)) return { action: "back" };
  const input = { accountId, email, phone, contact, mode: selectedMode, reconfigure, ...(reconfigure && (key === undefined || key === "") ? {} : { apiKey: key }) };
  const preview = await previewOpencodeGoAccountConfiguration(input, { environment });
  if (preview.willChange) {
    const modeLabel = value => value === "exclusive" ? "固定模式" : "切换模式";
    output.write(`账户：${accountId}\n运行模式：${preview.previousMode === undefined ? "未配置" : modeLabel(preview.previousMode)} → ${modeLabel(preview.mode)}\nAPI Key：${preview.credentialAction === "preserve" ? "保留当前 Key" : "写入新 Key"}\n`);
    if (preview.effects.writesMainConfig) output.write("此操作会修改或恢复该账户接管的 Codex 主配置字段。\n");
    if (await prompts.confirm({ message: "确认保存上述账户配置？", initialValue: false }) !== true) return { action: "back" };
  }
  const result = await applyOpencodeGoAccountConfiguration({ ...input, confirmExclusiveConfigChange: preview.effects.writesMainConfig, expectedRevision: preview.revision }, { environment, fetchImpl, downloadCatalog });
  if (result.action === "unchanged") {
    output.write("账户配置未变化，无需保存或重启。\n");
    return result;
  }
  const paths = result.paths;
  output.write(selectedMode === "switching"
    ? `OpenCode Go 账户 Profile 已保存：${paths.profilePath}\n`
    : `OpenCode Go 账户固定配置已保存：${paths.configPath}\n`);
  output.write(`模型目录：${paths.catalogPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, configActivationResult("restart-all"));
  return {
    action: "configured",
    mode: selectedMode,
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
  const confirmationMessage = `确认移除 OpenCode Go 账户 ${accountId} 的本地配置？将停止对应实例，该账户历史会话将不可用；保留共享模型目录、备份和历史统计。${preview.effects?.restoresInitialConfig === true ? "将恢复该账户接管的主配置字段，保留其他设置。" : ""}`;
  if (confirm && !await confirmPrompt(prompts, confirmationMessage, false)) {
    output.write("已取消，未修改任何文件。\n");
    return { action: "cancelled" };
  }
  const result = await applyOpencodeGoAccountRemoval({
    accountId: preview.account.id,
    confirmHistoryLoss: true,
    expectedRevision: preview.revision,
  }, {
    environment,
  });
  const cleanupSummary = removesLastAccount
    ? result.effects?.restoresInitialConfig === true
      ? "，该账户接管的主配置字段已恢复，其他设置已保留"
      : "，账户配置已清理，共享模型目录已保留"
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
  return { action: result.action, accountId, activation: result.activation };
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
  const usage = "用法：codexc provider opencode-go <add|list|reconfigure|remove|default|release> [id]";
  if (isCommandHelp(args, [[], ["account"], ["account", "add"], ["account", "list"], ["account", "reconfigure"], ["account", "remove"], ["account", "default"], ["account", "stop"]], usage)) {
    (options.output ?? process.stdout).write(`${usage}\n`);
    return;
  }
  const [command, action, id, ...extra] = args;
  if (command !== "account" || !["add", "list", "reconfigure", "remove", "default", "stop"].includes(action)) {
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
  if (id === undefined || extra.length > 0 || (["add", "reconfigure"].includes(action) && !options.prompts && !process.stdin.isTTY)) {
    throw new Error(
      `用法：codexc provider opencode-go ${action === "stop" ? "release" : action} <id>`,
    );
  }
  if (action === "add" || action === "reconfigure") {
    const result = await addOpencodeGoAccount(id, {
      ...options,
      environment: options.environment ?? process.env,
      output: options.output ?? process.stdout,
      reconfigure: action === "reconfigure",
    });
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
    output.write(result.action === "unchanged" ? `默认 OpenCode Go 账户仍为 ${id}，无需修改。\n` : `默认 OpenCode Go 账户已设置为 ${id}。\n`);
    writeGatewayConfigActivationNotice(
      output,
      options.environment ?? process.env,
      configActivationResult(result.activation),
    );
    return result;
  }
  return stopOpencodeGoAccount(id, {
    environment: options.environment ?? process.env,
    output: options.output ?? process.stdout,
  });
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
