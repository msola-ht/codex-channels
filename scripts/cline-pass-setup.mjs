import * as clackPrompts from "@clack/prompts";
import { runProviderModelSetup } from "./provider-model-setup.mjs";
import { loadClinePassAccounts, clinePassProviderId } from "../runtime/cline-pass-accounts.mjs";
import { loadManagedModelProviderSettings } from "../runtime/model-provider-runtime.mjs";
import { clinePassProviderDefinition as definition } from "../runtime/model-provider-definitions.mjs";
import { promptManagedAccountId, promptManagedAccountEdit, confirmManagedAccountEdit } from "./managed-provider-account-prompt.mjs";
import { promptEnabledProviderModels } from "./provider-model-selection.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import {
  applyClinePassConfiguration,
  previewClinePassConfiguration,
  previewClinePassRemoval,
  removeClinePassConfiguration,
  setClinePassDefaultAccount,
} from "./cline-pass-account-management.mjs";

export async function runClinePassSetup(options = {}) {
  while (true) {
    const result = await runClinePassSetupOperation(options);
    if (result.action === "menu-back") return { action: "back" };
    if (result.action === "back") continue;
    return result;
  }
}

async function runClinePassSetupOperation({ environment = process.env, prompts = clackPrompts, output = process.stdout } = {}) {
  const accounts = loadClinePassAccounts(environment);
  const action = await prompts.select({ message: "Cline Pass 官方", options: [
    { value: "configure", label: "添加账户" },
    ...(accounts.length ? [
      { value: "reconfigure", label: "编辑账户", hint: "API Key 与运行模式" },
      { value: "models", label: "模型管理", hint: "所有 CLP 账户共用目录；默认模型按账户设置" },
      { value: "default", label: "设置默认账户", hint: "用于渠道默认选择，已有会话保持原账户" },
      { value: "remove", label: "移除本地账户配置" },
    ] : []),
    { value: "back", label: "返回" },
  ] });
  if (prompts.isCancel(action) || action === "back") return { action: "menu-back" };
  if (action === "models") return runProviderModelSetup({ environment, prompts, output, provider: "clp" });
  const accountId = action === "configure"
    ? await promptManagedAccountId(prompts, accounts)
    : await prompts.select({ message: "选择账户", options: accounts.map(account => ({ value: account.id, label: `${account.id}${account.default ? "（默认）" : ""}` })) });
  if (prompts.isCancel(accountId)) return { action: "back" };
  let result;
  if (action === "remove") {
    const preview = await previewClinePassRemoval(accountId, { environment });
    if (await prompts.confirm({ message: `确认移除 CLP 账户 ${accountId} 的本地配置？将停止对应实例，该账户历史会话将不可用；保留共享模型目录、备份和历史统计。${preview.effects.restoresInitialConfig ? "将恢复该账户接管的主配置字段，保留其他设置。" : ""}`, initialValue: false }) !== true) return { action: "back" };
    result = await removeClinePassConfiguration({ accountId, confirmRemove: true, expectedRevision: preview.revision }, { environment });
  } else if (action === "default") {
    result = await setClinePassDefaultAccount(accountId, { environment });
  } else {
    const current = loadManagedModelProviderSettings(environment).find(entry => entry.provider === clinePassProviderId(accountId));
    const edit = await promptManagedAccountEdit({ prompts, current, definition, reconfigure: action === "reconfigure" });
    if (!edit) return { action: "back" };
    const input = { accountId, ...edit, reconfigure: action === "reconfigure" };
    const preview = previewClinePassConfiguration(input, { environment });
    if (!await confirmManagedAccountEdit(preview, { prompts, output })) return { action: "back" };
    result = await applyClinePassConfiguration({ ...input, confirmExclusiveConfigChange: preview.effects.writesMainConfig, expectedRevision: preview.revision }, { environment, selectModels: selection => promptEnabledModels(prompts, output, selection) });
    if (result.action === "back") return result;
    output.write(result.action === "unchanged" ? "账户配置未变化，无需保存或重启。\n" : `CLP 账户 ${accountId} 配置已保存。\n`);
  }
  writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
  writeCatalogExclusions(output, result.excludedModels ?? []);
  return result;
}

function writeCatalogExclusions(output, excludedModels) {
  for (const entry of excludedModels) output.write(`未加入 Codex 目录：${entry.model}（${entry.reason}）。\n`);
}

async function promptEnabledModels(prompts, output, { models, enabledModels, requiredModels, retainedModels }) {
  return promptEnabledProviderModels(prompts, output, {
    models, enabledModels, requiredModels, retainedModels, label: "CLP 当前账户",
    defaultModelWhenUnrequired: definition.defaultModel,
  });
}
