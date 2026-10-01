import * as clackPrompts from "@clack/prompts";
import { loadClinePassAccounts } from "../runtime/cline-pass-accounts.mjs";
import { clinePassProviderDefinition as definition, isManagedProviderApiKeyValid } from "../runtime/model-provider-definitions.mjs";
import { promptManagedAccountId } from "./managed-provider-account-prompt.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import {
  applyClinePassConfiguration,
  previewClinePassRemoval,
  removeClinePassConfiguration,
  setClinePassDefaultAccount,
} from "./cline-pass-account-management.mjs";

export async function runClinePassSetup({ environment = process.env, prompts = clackPrompts, output = process.stdout } = {}) {
  const accounts = loadClinePassAccounts(environment);
  const action = await prompts.select({ message: "Cline Pass 官方", options: [
    { value: "configure", label: "添加账户" },
    ...(accounts.length ? [{ value: "reconfigure", label: "重新配置账户" }, { value: "default", label: "设置默认账户" }, { value: "remove", label: "移除账户" }] : []),
    { value: "back", label: "返回" },
  ] });
  if (prompts.isCancel(action) || action === "back") return { action: "back" };
  const accountId = action === "configure"
    ? await promptManagedAccountId(prompts, accounts)
    : await prompts.select({ message: "选择账户", options: accounts.map(account => ({ value: account.id, label: `${account.id}${account.default ? "（默认）" : ""}` })) });
  if (prompts.isCancel(accountId)) return { action: "back" };
  let result;
  if (action === "remove") {
    await previewClinePassRemoval(accountId, { environment });
    if (await prompts.confirm({ message: "移除账户配置与 Key 后，该账户历史会话将不可用；保留备份和历史统计，是否继续？", initialValue: false }) !== true) return { action: "back" };
    result = await removeClinePassConfiguration({ accountId, confirmRemove: true }, { environment });
  } else if (action === "default") {
    result = await setClinePassDefaultAccount(accountId, { environment });
  } else {
    const apiKey = await prompts.password({ message: "Cline Pass API Key", validate: value => isManagedProviderApiKeyValid(definition, value) ? undefined : "请输入有效 API Key" });
    if (prompts.isCancel(apiKey)) return { action: "back" };
    const mode = await prompts.select({ message: "运行模式", options: [{ value: "switching", label: "切换模式" }, { value: "exclusive", label: "固定模式" }] });
    if (prompts.isCancel(mode)) return { action: "back" };
    if (mode === "exclusive" && await prompts.confirm({ message: "固定模式会修改 Codex 主配置，是否继续？", initialValue: false }) !== true) return { action: "back" };
    result = await applyClinePassConfiguration({ accountId, apiKey, mode, reconfigure: action === "reconfigure", confirmExclusiveConfigChange: mode === "exclusive" }, { environment });
  }
  writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
  return result;
}
