import { isCommandHelp } from "./cli-help.mjs";
import { pathToFileURL } from "node:url";
import * as clackPrompts from "@clack/prompts";

import { loadDeepseekAccounts, deepseekProviderId, validateDeepseekAccountId } from "../runtime/deepseek-accounts.mjs";
import {
  applyDeepseekAccountConfiguration, hasLegacyDeepseekConfiguration,
  previewLegacyDeepseekRemoval, removeLegacyDeepseekAccount, removeDeepseekAccount, setDeepseekDefaultAccount,
} from "./deepseek-account-management.mjs";
import { runModelProviderDefaultSetup } from "./model-provider-default-setup.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";

export async function runDeepseekSetup({ environment = process.env, prompts = clackPrompts, output = process.stdout, action: requestedAction, accountId: requestedId } = {}) {
  const accounts = loadDeepseekAccounts(environment);
  const legacy = hasLegacyDeepseekConfiguration(environment);
  const action = requestedAction ?? await prompts.select({
    message: "DeepSeek 账户管理",
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
    const preview = await previewLegacyDeepseekRemoval({ environment });
    output.write(`将移除或恢复以下旧账户文件：\n${preview.files.join("\n")}\n`);
    if (await prompts.confirm({ message: "移除旧 DS 账户配置和 Key？保留备份与历史统计；之后需重新添加账户。", initialValue: false }) !== true) return { action: "back" };
    const result = await removeLegacyDeepseekAccount({ confirmRemove: true }, { environment });
    writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
    return result;
  }
  const accountId = requestedId ?? (action === "add"
    ? await prompts.text({ message: "账户 ID", validate: (value) => { try { validateDeepseekAccountId(value); } catch (error) { return error.message; } } })
    : await prompts.select({ message: "选择 DS 账户", options: accounts.map((account) => ({ value: account.id, label: `${account.id}${account.default ? "（默认）" : ""}` })) }));
  if (prompts.isCancel(accountId)) return { action: "back" };
  validateDeepseekAccountId(accountId);
  let result;
  if (action === "remove") {
    if (await prompts.confirm({ message: `删除 DS 账户 ${accountId}？将停止对应 App Server，历史 Thread 将不可恢复；保留历史统计和安装前备份。`, initialValue: false }) !== true) return { action: "back" };
    result = await removeDeepseekAccount({ accountId, confirmRemove: true }, { environment });
  } else if (action === "default") {
    result = await setDeepseekDefaultAccount(accountId, { environment });
  } else if (action === "settings") {
    return runModelProviderDefaultSetup({ provider: deepseekProviderId(accountId), allowBack: true, environment, prompts, output });
  } else if (["add", "reconfigure"].includes(action)) {
    const mode = await prompts.select({ message: "运行模式", options: [{ value: "switching", label: "切换模式" }, { value: "exclusive", label: "固定主 Provider" }] });
    if (prompts.isCancel(mode)) return { action: "back" };
    if (mode === "exclusive" && await prompts.confirm({ message: "固定模式会修改 Codex 主配置，确认继续？", initialValue: false }) !== true) return { action: "back" };
    const apiKey = await prompts.password({ message: "DeepSeek API Key" });
    if (prompts.isCancel(apiKey)) return { action: "back" };
    result = await applyDeepseekAccountConfiguration({ accountId, apiKey, mode, reconfigure: action === "reconfigure", confirmExclusiveConfigChange: mode === "exclusive" }, { environment });
  } else throw new Error("未知 DeepSeek 账户操作");
  writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
  return result;
}

export async function runDeepseekAccountCli(args, options = {}) {
  const [command, action, ...rest] = args;
  const usage = "用法：codexc deepseek account <add|list|reconfigure|remove|default> [id]（list 支持 --json）\ncodexc deepseek legacy remove（确认后移除旧单账户）";
  if (isCommandHelp(args, [[], ["account"], ["legacy"], ["legacy", "remove"], ["account", "add"], ["account", "list"], ["account", "reconfigure"], ["account", "remove"], ["account", "default"]], usage)) {
    (options.output ?? process.stdout).write(`${usage}\n`);
    return;
  }
  if (command === "legacy" && action === "remove" && rest.length === 0) {
    return runDeepseekSetup({ ...options, action: "legacy-remove" });
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
