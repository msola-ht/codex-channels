import * as clackPrompts from "@clack/prompts";
import { loadProviderModelCatalogs, previewProviderModelRemoval, applyProviderModelRemoval } from "./provider-model-management.mjs";
import { readResponsesModelCatalog } from "../runtime/model-provider-responses-catalog.mjs";
import { readCustomProviderUpstreamWireApi } from "../runtime/model-provider-upstream-metadata.mjs";
import { previewCustomProviderModelsSave, applyCustomProviderModelsSave } from "./custom-primary-provider-management.mjs";
import { promptResponsesModels } from "./responses-model-setup.mjs";
import { runManagedProviderModelSetup } from "./managed-provider-model-management.mjs";
import { runModelProviderDefaultSetup } from "./model-provider-default-setup.mjs";
import { refreshClinePassCatalog } from "./cline-pass-account-management.mjs";
import { promptEnabledProviderModels } from "./provider-model-selection.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { managedProviderAccountFamilies } from "../runtime/model-provider-definitions.mjs";

const warningMessages = {
  "shared-relay-grants-retained": "Relay Key 授权保留；共用目录移除后调用受限，重新加入可能恢复旧授权。永久撤销请使用 Key 管理。",
  "clp-relay-independent": "CLP Relay 使用独立目录，本次移除不限制其调用。",
  "historical-references": "旧会话和计划任务保留，引用此模型时可能失败；不会自动换模型。聚合旧快照需刷新。",
  "provider-relay-inflight": "目录变更可能撤销该提供商的其他 Relay 在途请求。",
};

export async function runProviderModelSetup({ environment = process.env, prompts = clackPrompts, output = process.stdout, provider } = {}) {
  const { catalogs } = await loadProviderModelCatalogs({ environment });
  if (!catalogs.length) { output.write("尚未配置第三方模型，请先完成提供商接入。\n"); return { action: "back" }; }
  const requestedFamily = managedProviderAccountFamilies.find(entry => entry.proxyKey === provider);
  const choices = requestedFamily ? catalogs.filter(entry => requestedFamily.matches(entry.provider)) : catalogs;
  const selected = provider !== undefined && !requestedFamily ? provider : await prompts.select({ message: "选择模型目录所属提供商账户", options: [
    ...choices.map(entry => ({ value: entry.provider, label: entry.displayName, hint: entry.providers.join("、") })),
    { value: "back", label: "返回" },
  ] });
  if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
  const catalog = catalogs.find(entry => entry.provider === selected);
  if (!catalog) throw new Error("提供商目录已变化，请重新打开模型管理");
  output.write(`${catalog.displayName}：${catalog.providers.join("、")}\n${catalog.models.map(entry => `  ${entry.id}${entry.isDefault ? "（账户默认）" : ""}`).join("\n")}\n`);
  const custom = catalog.provider.startsWith("cp-");
  const family = managedProviderAccountFamilies.find(entry => entry.matches(catalog.provider))?.proxyKey;
  if (!catalog.canRemove) output.write(catalog.unavailableReason === "deepseek-template-source"
    ? "DeepSeek 暂不支持单模型移除。\n"
    : "官方共享目录不支持按接入裁剪；默认设置使用既有提供商设置入口。\n");
  const action = await prompts.select({ message: "模型操作", options: [
    ...(catalog.canRemove ? [{ value: "remove", label: "本地移除模型", hint: "不联网、不改账户和凭据" }] : []),
    ...(custom && catalog.canRemove ? [{ value: "edit", label: "添加／编辑模型与默认值" }] : []),
    ...(family && catalog.providers.length ? [{ value: "default", label: "设置账户默认模型" }] : []),
    ...(family === "ccg" || family === "ocg" ? [{ value: "manage", label: "选择启用／添加／导入模板" }] : []),
    ...(family === "clp" ? [{ value: "refresh", label: "联网更新并选择启用模型" }] : []),
    { value: "back", label: "返回" },
  ] });
  if (prompts.isCancel(action) || action === "back") return { action: "back" };
  if (action === "manage") return runManagedProviderModelSetup(catalog.provider, { environment, prompts, output });
  if (action === "default") {
    const account = catalog.providers.length === 1 ? catalog.providers[0] : await prompts.select({ message: "选择默认设置所属账户", options: catalog.providers.map(id => ({ value: id, label: id })) });
    if (prompts.isCancel(account)) return { action: "back" };
    return runModelProviderDefaultSetup({ environment, prompts, output, provider: account });
  }
  let result;
  if (action === "refresh") {
    result = await refreshClinePassCatalog({ provider: catalog.provider, environment, selectModels: selection => promptEnabledProviderModels(prompts, output, { ...selection, label: catalog.displayName }) });
  } else if (action === "edit") {
    const previous = readResponsesModelCatalog(environment, catalog.provider);
    const model = await prompts.select({ message: "默认模型（添加新默认模型前请先添加并保存）", options: previous.definitions.map(entry => ({ value: entry.id, label: entry.name })), initialValue: previous.defaultModel });
    if (prompts.isCancel(model)) return { action: "back" };
    output.write("此入口添加和编辑模型；移除已有模型请返回选择本地移除。\n");
    const models = await promptResponsesModels(prompts, model, previous.definitions, [], output, readCustomProviderUpstreamWireApi(environment, catalog.provider), previous.definitions.map(entry => entry.id));
    if (!models) return { action: "back" };
    const input = { provider: catalog.provider, model, models };
    const preview = await previewCustomProviderModelsSave(input, { environment, expectedCatalogContent: previous.content });
    output.write(`${JSON.stringify(preview.provider.models, null, 2)}\n默认模型：${model}；连接与凭据保持当前值。\n`);
    if (await prompts.confirm({ message: "备份并保存模型设置？", initialValue: false }) !== true) return { action: "back" };
    result = await applyCustomProviderModelsSave(input, { environment, expectedCatalogContent: previous.content, preview });
  } else if (action === "remove") {
    const candidates = catalog.models.filter(entry => !entry.isDefault);
    if (!candidates.length || catalog.models.length < 2) throw new Error("没有可移除的模型；请先调整账户默认模型，并保留至少一个模型");
    const model = await prompts.select({ message: "选择要移除的精确模型 ID", options: candidates.map(entry => ({ value: entry.id, label: entry.id })) });
    if (prompts.isCancel(model)) return { action: "back" };
    const input = { provider: catalog.provider, model };
    const preview = await previewProviderModelRemoval(input, { environment });
    output.write(`移除 ${preview.model.id}；影响：${preview.providers.join("、")}。\n`);
    for (const warning of preview.warnings) output.write(`${warningMessages[warning.code] ?? warning.code}\n`);
    output.write("保存前备份原目录；恢复需显式重新添加或核对备份。保存不会自动重启 App Server。\n");
    if (await prompts.confirm({ message: "确认本地移除？", initialValue: false }) !== true) return { action: "back" };
    result = await applyProviderModelRemoval(input, { environment, preview });
  } else throw new Error("不支持的模型操作");
  if (result.action !== "back") {
    output.write(action === "edit" || action === "remove" ? "模型目录已保存并回读。\n" : "模型目录已保存。\n");
    writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
  }
  return result;
}
