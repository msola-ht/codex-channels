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
  refreshClinePassCatalog,
} from "./cline-pass-account-management.mjs";

export async function runClinePassSetup({ environment = process.env, prompts = clackPrompts, output = process.stdout } = {}) {
  const accounts = loadClinePassAccounts(environment);
  const action = await prompts.select({ message: "Cline Pass 官方", options: [
    { value: "configure", label: "添加账户" },
    ...(accounts.length ? [{ value: "reconfigure", label: "重新配置账户" }, { value: "catalog", label: "选择启用模型／更新共享目录" }, { value: "default", label: "设置默认账户" }, { value: "remove", label: "移除账户" }] : []),
    { value: "back", label: "返回" },
  ] });
  if (prompts.isCancel(action) || action === "back") return { action: "back" };
  if (action === "catalog") {
    const result = await refreshClinePassCatalog({ environment, selectModels: selection => promptEnabledModels(prompts, output, selection) });
    if (result.action === "back") return result;
    output.write(`CLP 共享模型目录已更新：${result.models.length} 个模型，来源 ${result.commit}。\n`);
    writeCatalogExclusions(output, result.excludedModels);
    writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
    return result;
  }
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
    result = await applyClinePassConfiguration({ accountId, apiKey, mode, reconfigure: action === "reconfigure", confirmExclusiveConfigChange: mode === "exclusive" }, { environment, selectModels: selection => promptEnabledModels(prompts, output, selection) });
    if (result.action === "back") return result;
  }
  writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
  writeCatalogExclusions(output, result.excludedModels ?? []);
  return result;
}

function writeCatalogExclusions(output, excludedModels) {
  for (const entry of excludedModels) output.write(`未加入 Codex 目录：${entry.model}（${entry.reason}）。\n`);
}

async function promptEnabledModels(prompts, output, { models, enabledModels, requiredModels }) {
  if (requiredModels.some(id => !models.some(model => model.id === id))) throw new Error("官方目录已不支持账户当前默认模型；请先调整默认模型，原目录未修改");
  let initialValues = enabledModels.filter(id => models.some(model => model.id === id));
  while (true) {
    const selected = await prompts.multiselect({
      message: "选择启用的 CLP 模型（空格勾选，回车确认；全部 CLP 账户及聚合共用）",
      options: models.map(model => ({ value: model.id, label: `${model.name}（${model.id}）`, hint: `${requiredModels.includes(model.id) ? "账户默认，须保留；" : ""}默认思考 ${model.reasoningEffort}${model.reasoningEffort === "none" ? "（关闭）" : ""}` })),
      initialValues, required: true,
    });
    if (prompts.isCancel(selected)) return undefined;
    if (!Array.isArray(selected) || selected.length === 0) { output.write("至少需要启用一个模型。\n"); continue; }
    if (selected.length > 64) { output.write("最多启用 64 个模型，请减少勾选项。\n"); initialValues = selected; continue; }
    if (requiredModels.some(id => !selected.includes(id))) {
      output.write("不能停用账户当前默认模型；请先修改默认模型。已为你重新勾选必需项。\n");
      initialValues = [...new Set([...selected, ...requiredModels])];
      continue;
    }
    output.write(`将启用 ${selected.length} 个模型：\n${selected.map(id => `  ${id}`).join("\n")}\n未勾选的模型不会出现在 CLP 或聚合目录中；更新时会保留原目录备份。\n`);
    if (requiredModels.length === 0) {
      const defaultModel = selected.includes(definition.defaultModel) ? definition.defaultModel : models.find(model => selected.includes(model.id)).id;
      output.write(`新账户默认模型：${defaultModel}。\n`);
    }
    const confirmed = await prompts.confirm({ message: "保存这些模型？", initialValue: true });
    return confirmed === true ? selected : undefined;
  }
}
