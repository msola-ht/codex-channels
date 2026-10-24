import { promptManagedAccountId, promptManagedAccountEdit, confirmManagedAccountEdit } from "./managed-provider-account-prompt.mjs";
import { isCommandHelp } from "./cli-help.mjs";
import { pathToFileURL } from "node:url";
import * as clackPrompts from "@clack/prompts";

import { loadDeepseekAccounts, deepseekProviderId, validateDeepseekAccountId } from "../runtime/deepseek-accounts.mjs";
import {
  applyDeepseekAccountConfiguration,
  previewDeepseekAccountConfiguration,
  removeDeepseekAccount, previewDeepseekAccountRemoval, setDeepseekDefaultAccount,
} from "./deepseek-account-management.mjs";
import { runProviderModelSetup } from "./provider-model-setup.mjs";
import { loadManagedModelProviderSettings } from "../runtime/model-provider-runtime.mjs";
import { deepseekAccountDefinition } from "../runtime/model-provider-definitions.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";

export async function runDeepseekSetup(options = {}) {
  while (true) {
    const result = await runDeepseekSetupOperation(options);
    if (result.action === "menu-back") return { action: "back" };
    if (result.action === "back" && options.action === undefined) continue;
    return result;
  }
}

async function runDeepseekSetupOperation({ environment = process.env, prompts = clackPrompts, output = process.stdout, action: requestedAction, accountId: requestedId } = {}) {
  const accounts = loadDeepseekAccounts(environment);
  const action = requestedAction ?? await prompts.select({
    message: "DeepSeek 官方",
    options: [
      { value: "add", label: "添加账户" },
      ...(accounts.length === 0 ? [] : [
        { value: "reconfigure", label: "编辑账户", hint: "API Key 与运行模式" },
        { value: "models", label: "模型管理", hint: "所有 DS 账户共用目录；默认模型按账户设置" },
        { value: "default", label: "设置默认账户", hint: "用于渠道默认选择，已有会话保持原账户" },
        { value: "remove", label: "移除本地账户配置" },
      ]),
      { value: "back", label: "返回" },
    ],
  });
  if (prompts.isCancel(action) || action === "back") return { action: "menu-back" };
  if (action === "models") return runProviderModelSetup({ environment, prompts, output, provider: "deepseek" });
  const accountId = requestedId ?? (action === "add"
    ? await promptManagedAccountId(prompts, accounts)
    : await prompts.select({ message: "选择 DS 账户", options: accounts.map((account) => ({ value: account.id, label: `${account.id}${account.default ? "（默认）" : ""}` })) }));
  if (prompts.isCancel(accountId)) return { action: "back" };
  validateDeepseekAccountId(accountId);
  let result;
  if (action === "remove") {
    const preview = await previewDeepseekAccountRemoval(accountId, { environment });
    if (await prompts.confirm({ message: `确认移除 DS 账户 ${accountId} 的本地配置？将停止对应实例，该账户历史会话将不可用；保留共享模型目录、备份和历史统计。${preview.effects.restoresInitialConfig ? "将恢复该账户接管的主配置字段，保留其他设置。" : ""}`, initialValue: false }) !== true) return { action: "back" };
    result = await removeDeepseekAccount({ accountId, confirmRemove: true, expectedRevision: preview.revision }, { environment });
  } else if (action === "default") {
    result = await setDeepseekDefaultAccount(accountId, { environment });
  } else if (["add", "reconfigure"].includes(action)) {
    const current = loadManagedModelProviderSettings(environment).find(entry => entry.provider === deepseekProviderId(accountId));
    const edit = await promptManagedAccountEdit({ prompts, current, definition: deepseekAccountDefinition(accountId), reconfigure: action === "reconfigure" });
    if (!edit) return { action: "back" };
    const input = { accountId, ...edit, reconfigure: action === "reconfigure" };
    const preview = previewDeepseekAccountConfiguration(input, { environment });
    if (!await confirmManagedAccountEdit(preview, { prompts, output })) return { action: "back" };
    result = await applyDeepseekAccountConfiguration({ ...input, confirmExclusiveConfigChange: preview.effects.writesMainConfig, expectedRevision: preview.revision }, { environment });
    output.write(result.action === "unchanged" ? "账户配置未变化，无需保存或重启。\n" : `DS 账户 ${accountId} 配置已保存。\n`);
  } else throw new Error("未知 DeepSeek 账户操作");
  writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
  return result;
}

export async function runDeepseekAccountCli(args, options = {}) {
  const [command, action, ...rest] = args;
  const usage = "用法：codexc provider deepseek <add|list|reconfigure|remove|default> [id]（list 支持 --json）";
  if (isCommandHelp(args, [[], ["account"], ["account", "add"], ["account", "list"], ["account", "reconfigure"], ["account", "remove"], ["account", "default"]], usage)) {
    (options.output ?? process.stdout).write(`${usage}\n`);
    return;
  }
  if (command !== "account" || !["add", "list", "reconfigure", "remove", "default"].includes(action)
    || (action === "list" ? !(rest.length === 0 || (rest.length === 1 && rest[0] === "--json")) : rest.length !== 1)) throw new Error(usage);
  if (action === "list") {
    const accounts = loadDeepseekAccounts(options.environment ?? process.env);
    (options.output ?? process.stdout).write(rest[0] === "--json" ? `${JSON.stringify(accounts)}\n` : `${accounts.map((account) => `${deepseekProviderId(account.id)}${account.default ? "（默认）" : ""}`).join("\n") || "尚未配置 DS 账户"}\n`);
    return;
  }
  return runDeepseekSetup({ ...options, action, accountId: rest[0] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDeepseekAccountCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
