import * as clackPrompts from "@clack/prompts";
import { createHash } from "node:crypto";
import { loadProviderModelCatalogs, previewProviderModelRemoval, applyProviderModelRemoval } from "./provider-model-management.mjs";
import { loadProviderModelTemplateOptions, previewProviderModelTemplateUpdate, applyProviderModelTemplateUpdate } from "./provider-model-template-management.mjs";
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

function templateDifferenceValue(value, full = false) {
  if (!value.present) return "未设置";
  const json = JSON.stringify(value.value);
  if (full || json.length <= 2048) return json;
  return JSON.stringify({ jsonLength: json.length, sha256: createHash("sha256").update(json).digest("hex"), content: "长内容摘要，可在确认前展开完整差异" });
}

async function runProviderModelTemplateSetup(provider, { environment, prompts, output }) {
  const options = await loadProviderModelTemplateOptions(provider, { environment });
  if (!options.targets.length) {
    output.write("此账户没有可更新模板的模型。\n");
    return { action: "back" };
  }
  const model = await prompts.select({ message: "选择要对比模板的模型", options: options.targets.map(target => ({
    value: target.model, label: `${target.displayName}（${target.model}）`,
    hint: target.template ? `${target.template.source} → ${target.template.model}` : "尚未关联模板，请明确选择来源",
  })) });
  if (prompts.isCancel(model)) return { action: "back" };
  const target = options.targets.find(entry => entry.model === model);
  const templates = options.templates.filter(entry => !provider.startsWith("ds-") && !provider.startsWith("clp-") || entry.model === model);
  if (!templates.length) { output.write("来源中没有可用于此模型的模板。\n"); return { action: "back" }; }
  const initialTemplate = target?.template ? templates.findIndex(entry => entry.source === target.template.source && entry.model === target.template.model) : -1;
  const selected = await prompts.select({ message: "明确选择模板来源及模型", options: templates.map((entry, index) => ({
    value: index, label: `${entry.source} · ${entry.displayName}（${entry.model}）`,
  })), ...(initialTemplate < 0 ? {} : { initialValue: initialTemplate }) });
  if (prompts.isCancel(selected)) return { action: "back" };
  const template = templates[selected];
  if (!template) throw new Error("模板选项已变化，请重新打开模型管理");
  const sections = await prompts.multiselect({ message: "选择本次更新内容（空格勾选，回车确认）", options: [
    { value: "prompts", label: "提示词" },
    { value: "capabilities", label: "能力参数", hint: "请确认平台支持模板中的参数" },
  ], initialValues: ["prompts"], required: true });
  if (prompts.isCancel(sections)) return { action: "back" };
  const input = { provider, model, sections, revision: options.revision, sourceToken: options.sourceToken, template: { source: template.source, model: template.model } };
  const preview = await previewProviderModelTemplateUpdate(input, { environment });
  output.write(`模板对比：${JSON.stringify(preview.provider)} / ${JSON.stringify(preview.model)}\n来源：${JSON.stringify(preview.source)} / ${JSON.stringify(preview.sourceModel)}\n修订：${JSON.stringify(preview.revision)}\n`);
  output.write("保留本地模型 ID、显示名称、当前上下文、默认思考等级、工具支持、采样及压缩/截断设置；能力更新可改变最大上下文。\n");
  for (const change of preview.changes) {
    output.write(`${JSON.stringify(change.field)}\n  更新前：${templateDifferenceValue(change.before)}\n  更新后：${templateDifferenceValue(change.after)}\n`);
  }
  if (!preview.willChange) {
    output.write("所选模板内容与当前模型一致，无需保存。\n");
    return { action: "unchanged", activation: "none" };
  }
  const longChanges = preview.changes.filter(change => [change.before, change.after].some(value => value.present && JSON.stringify(value.value).length > 2048));
  if (longChanges.length) {
    const expand = await prompts.confirm({ message: "展开长内容的完整前后差异？", initialValue: false });
    if (prompts.isCancel(expand)) return { action: "back" };
    if (expand) for (const change of longChanges) output.write(`${JSON.stringify(change.field)}\n  更新前：${templateDifferenceValue(change.before, true)}\n  更新后：${templateDifferenceValue(change.after, true)}\n`);
  }
  output.write("保存前备份原目录，不自动重启服务。\n");
  if (await prompts.confirm({ message: "确认按上述差异更新所选模板内容？", initialValue: false }) !== true) return { action: "back" };
  const result = await applyProviderModelTemplateUpdate(input, { environment, preview });
  output.write(result.action === "updated" ? "模型模板已更新并回读。\n" : "模型模板无需更新。\n");
  if (result.action === "updated") writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
  return result;
}

export async function runProviderModelSetup({ environment = process.env, prompts = clackPrompts, output = process.stdout, provider } = {}) {
  const { catalogs } = await loadProviderModelCatalogs({ environment });
  if (!catalogs.length) { output.write("尚未配置第三方模型，请先完成提供商接入。\n"); return { action: "back" }; }
  const requestedFamily = managedProviderAccountFamilies.find(entry => entry.proxyKey === provider);
  const choices = requestedFamily ? catalogs.filter(entry => requestedFamily.matches(entry.provider)) : catalogs;
  const selected = provider !== undefined && !requestedFamily ? provider : await prompts.select({ message: "选择模型目录所属提供商", options: [
    ...choices.map(entry => ({ value: entry.provider, label: entry.displayName, hint: entry.providers.join("、") })),
    { value: "back", label: "返回" },
  ] });
  if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
  const catalog = catalogs.find(entry => entry.providers.includes(selected));
  if (!catalog) throw new Error("提供商目录已变化，请重新打开模型管理");
  output.write(`${catalog.displayName}：${catalog.providers.join("、")}\n${catalog.models.map(entry => `  ${entry.id}${entry.isDefault ? "（账户默认）" : ""}`).join("\n")}\n`);
  const custom = catalog.provider.startsWith("cp-");
  const family = managedProviderAccountFamilies.find(entry => entry.matches(catalog.provider))?.proxyKey;
  if (family) output.write("同一受管提供商的账户共用这份模型目录；修改当前模型会对这些账户生效。\n");
  if (!catalog.canRemove) output.write(catalog.unavailableReason === "deepseek-template-source"
    ? "DeepSeek 暂不支持单模型移除。\n"
    : "官方共享目录不支持按接入裁剪；默认设置使用既有提供商设置入口。\n");
  const action = await prompts.select({ message: "模型操作", options: [
    ...(catalog.canRemove ? [{ value: "remove", label: "本地移除模型", hint: "不联网、不改账户和凭据" }] : []),
    ...(custom && catalog.canRemove ? [{ value: "edit", label: "添加／编辑模型与默认值" }] : []),
    ...(family && catalog.providers.length ? [{ value: "default", label: "设置账户默认模型" }] : []),
    ...(family === "ccg" || family === "ocg" ? [{ value: "manage", label: "选择启用／添加／导入模板" }] : []),
    ...(family === "clp" ? [{ value: "refresh", label: "联网发现模型并选择启用", hint: "不更新已启用模型的模板内容" }] : []),
    ...(catalog.source !== "official-shared" && (custom || family) ? [{ value: "template-update", label: "对比并更新模型模板", hint: family === "clp" ? "读取远程模板后预览差异" : "选择来源和更新内容，预览差异后保存" }] : []),
    { value: "back", label: "返回" },
  ] });
  if (prompts.isCancel(action) || action === "back") return { action: "back" };
  if (action === "template-update") return runProviderModelTemplateSetup(catalog.provider, { environment, prompts, output });
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
    const models = await promptResponsesModels(prompts, model, previous.definitions, output, readCustomProviderUpstreamWireApi(environment, catalog.provider), previous.definitions.map(entry => entry.id));
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
    if (action === "refresh" && result.action === "unchanged") {
      output.write("启用模型目录未变化；已有模型的模板更新请使用对比并更新模型模板。\n");
      return result;
    }
    output.write(action === "edit" || action === "remove" ? "模型目录已保存并回读。\n" : "模型目录已保存。\n");
    writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
  }
  return result;
}
