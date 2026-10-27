import * as clackPrompts from "@clack/prompts";
import { previewProviderModelRename, applyProviderModelRename } from "./provider-model-management.mjs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { loadProviderModelCatalogs, loadProviderModelCatalogPresentations, ProviderModelManagementError, previewProviderModelRemoval, applyProviderModelRemoval } from "./provider-model-management.mjs";
import { loadProviderModelTemplateOptions, previewProviderModelTemplateUpdate, applyProviderModelTemplateUpdate } from "./provider-model-template-management.mjs";
import { readResponsesModelCatalog } from "../runtime/model-provider-responses-catalog.mjs";
import { readCustomProviderUpstreamWireApi } from "../runtime/model-provider-upstream-metadata.mjs";
import { previewCustomProviderModelsSave, applyCustomProviderModelsSave } from "./custom-primary-provider-management.mjs";
import { promptResponsesModels } from "./responses-model-setup.mjs";
import { runManagedProviderModelSetup } from "./managed-provider-model-management.mjs";
import { runManagedProviderModelEditSetup } from "./managed-provider-model-edit-setup.mjs";
import { runClinePassRequestOptionsSetup } from "./cline-pass-request-options-setup.mjs";
import { runModelProviderDefaultSetup } from "./model-provider-default-setup.mjs";
import { runModelWindowSetup } from "./model-window-setup.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { managedProviderAccountFamilies } from "../runtime/model-provider-definitions.mjs";
import { loadOpenAiModelCatalog, OfficialModelCatalogError } from "./webui-official-model-catalog.mjs";
import { probeConfiguredProviderWebSearch, ProviderWebSearchProbeError } from "./provider-web-search-probe.mjs";
import { withCliProgress } from "./cli-operation-progress.mjs";
import { promptCustomModelCapabilities } from "./custom-model-capability-setup.mjs";
import { loadConfiguredRelayProviderMaterial } from "../runtime/model-provider-runtime.mjs";

const warningMessages = {
  "shared-relay-grants-retained": "Relay Key 授权保留；共用目录移除后调用受限，重新加入可能恢复旧授权。永久撤销请使用 Key 管理。",
  "historical-references": "旧会话和计划任务保留，引用此模型时可能失败；不会自动换模型。聚合旧快照需刷新。",
  "provider-relay-inflight": "目录变更可能撤销该提供商的其他 Relay 在途请求。",
};

/** Diagnostics use one selected account and never change model declarations or search policy. */
export async function runProviderWebSearchSetup({ environment = process.env, prompts = clackPrompts, output = process.stdout, provider } = {}) {
  try {
    let catalogs = [];
    if (provider !== "openai") {
      try { catalogs = (await loadProviderModelCatalogPresentations({ environment })).catalogs; }
      catch (error) {
        if (provider !== undefined) throw error;
        output.write("第三方模型目录暂不可读取，请检查配置后重试；仍可选择 OpenAI 官方检测。\n");
      }
    }
    let selected = provider;
    if (selected === undefined) {
      selected = await prompts.select({ message: "选择原生网页搜索检测的提供商", options: [
        { value: "openai", label: "OpenAI 官方", hint: "使用当前官方登录凭据与本地模型缓存" },
        ...catalogs.map(entry => ({ value: entry.provider, label: entry.displayName, hint: entry.providers.join("、") })),
        { value: "back", label: "返回" },
      ] });
      if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
    }
    let revision;
    let models;
    if (selected === "openai") {
      const catalog = await loadOpenAiModelCatalog(environment);
      revision = catalog.revision;
      models = catalog.models.map(entry => ({ id: entry.model, displayName: entry.displayName }));
    } else {
      const catalog = catalogs.find(entry => entry.providers.includes(selected));
      if (!catalog) throw new Error("所选提供商不在当前模型目录中，请重新打开检测");
      selected = await prompts.select({ message: "选择本次检测的单一账户", options: catalog.providers.map(id => ({ value: id, label: id })), initialValue: selected });
      if (prompts.isCancel(selected)) return { action: "back" };
      if (!catalog.providers.includes(selected)) throw new Error("检测账户选择无效");
      revision = catalog.revision;
      models = catalog.models;
    }
    if (!models.length) { output.write("此提供商没有可检测的已配置模型，请先获取模型目录。\n"); return { action: "back" }; }
    const model = await prompts.select({ message: "选择原生网页搜索检测的模型", options: models.map(entry => ({ value: entry.id, label: `${entry.displayName}（${entry.id}）` })) });
    if (prompts.isCancel(model)) return { action: "back" };
    if (!models.some(entry => entry.id === model)) throw new Error("检测模型选择无效");
    output.write(`检测目标：${JSON.stringify(selected)} / ${JSON.stringify(model)}。\n仅向所选账户发送 1 次请求，最长 45 秒；上游可能实际搜索并产生模型及搜索费用。\n结果仅供诊断，不修改模型能力声明或搜索启用策略。\n`);
    if (await prompts.confirm({ message: "确认向上述账户发送一次可能计费的原生网页搜索请求？", initialValue: false }) !== true) return { action: "back" };
    output.write("正在检测；Ctrl+C 取消。\n");
    let result;
    try {
      result = await withCliProgress("检测原生网页搜索", progress =>
        probeConfiguredProviderWebSearch({ provider: selected, model, revision }, { environment, signal: progress.signal }),
      { output, delayMs: 150 });
    } catch (error) {
      if (error?.name === "AbortError" || error?.exitCode === 130 || error?.exitCode === 143) return { action: "back" };
      throw error;
    }
    if (result.status === "cancelled") { output.write("原生网页搜索检测已取消。\n"); return { action: "back" }; }
    if (result.provider !== selected || result.model !== model || result.capability !== "webSearch" || result.check.capability !== "webSearch") {
      throw new Error("原生网页搜索检测结果与所选账户或模型不匹配");
    }
    const statuses = { supported: "通过", unsupported: "未通过", inconclusive: "无法确认" };
    output.write(`原生网页搜索：${statuses[result.check.status]}；${result.check.reason}${result.check.httpStatus === undefined ? "" : `（HTTP ${result.check.httpStatus}）`}\n`);
    return { action: "web-search-diagnosed", activation: "none" };
  } catch (error) {
    const message = error instanceof ProviderWebSearchProbeError || error instanceof OfficialModelCatalogError || error instanceof ProviderModelManagementError
      ? error.message : "原生网页搜索检测未完成，请重新读取模型目录并检查账户、连接与凭据";
    output.write(`${message}。\n`);
    return { action: "back" };
  }
}

function templateDifferenceValue(value, full = false) {
  if (!value.present) return "未设置";
  const json = JSON.stringify(value.value);
  if (full || json.length <= 2048) return json;
  return JSON.stringify({ jsonLength: json.length, sha256: createHash("sha256").update(json).digest("hex"), content: "长内容摘要，可在确认前展开完整差异" });
}

async function runProviderModelTemplateSetup(provider, { environment, prompts, output }) {
  const options = provider.startsWith("clp-")
    ? await withCliProgress("读取 CLP 本地 DS 模板", progress => loadProviderModelTemplateOptions(provider, { environment, signal: progress.signal }), { output, delayMs: 150 })
    : await loadProviderModelTemplateOptions(provider, { environment });
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
  const templates = options.templates.filter(entry => !provider.startsWith("ds-") || entry.model === model);
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
    { value: "capabilities", label: provider.startsWith("cp-") ? "本地工具" : "能力参数", hint: provider.startsWith("cp-") ? "同步异步提问与时钟声明，保留其他工具和模型能力" : "含基座异步提问与时钟声明；请确认平台支持模板中的参数" },
    { value: "settings", label: "上下文与压缩设置", hint: "仅有效上下文比例、自动压缩阈值、截断策略；主动勾选才覆盖本地值" },
  ].filter(entry => template.availableSections.includes(entry.value)), initialValues: ["prompts"], required: true });
  if (prompts.isCancel(sections)) return { action: "back" };
  const input = { provider, model, sections, revision: options.revision, sourceToken: options.sourceToken, template: { source: template.source, model: template.model } };
  const preview = await previewProviderModelTemplateUpdate(input, { environment });
  output.write(`模板对比：${JSON.stringify(preview.provider)} / ${JSON.stringify(preview.model)}\n来源：${JSON.stringify(preview.source)} / ${JSON.stringify(preview.sourceModel)}\n修订：${JSON.stringify(preview.revision)}\n`);
  output.write(provider.startsWith("cp-")
    ? "自定义模型按勾选范围更新提示词、本地工具或上下文与压缩设置，并记录来源关联；模型自身能力、其他工具声明及采样保留本地值。\n"
    : provider.startsWith("olc-") ? "OLC 模板仅更新提示词与上下文／压缩设置；远端上下文上限、思考、视觉和工具能力保持模型自身值。未选字段保持原值。\n"
      : "保留本地模型 ID、显示名称、当前上下文、默认思考等级和采样；能力更新可改变最大上下文，并补入基座异步提问与时钟声明，保留其他已有工具声明。\n");
  output.write("有效上下文比例、自动压缩阈值和截断策略默认保留本地值；仅主动选择「上下文与压缩设置」并确认差异后覆盖。\n");
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
  const requestedFamily = managedProviderAccountFamilies.find(entry => entry.proxyKey === provider);
  let selected = provider !== undefined && !requestedFamily ? provider : undefined;
  while (true) {
    const { catalogs } = await loadProviderModelCatalogs({ environment });
    const choices = requestedFamily ? catalogs.filter(entry => requestedFamily.matches(entry.provider)) : catalogs;
    if (!choices.length) { output.write("尚未配置可管理的第三方模型，请先完成提供商接入。\n"); return { action: "back" }; }
    if (selected === undefined) {
      selected = await prompts.select({ message: "选择模型目录所属提供商", options: [
        ...choices.map(entry => ({ value: entry.provider, label: entry.displayName, hint: entry.providers.join("、") })),
        { value: "back", label: "返回上一级" },
      ] });
      if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
    }
    const result = await runProviderModelOperation({ environment, prompts, output, provider: selected,
      backLabel: provider !== undefined && !requestedFamily ? "返回上一级" : "返回提供商列表" });
    if (result.action === "select-provider") {
      if (provider !== undefined && !requestedFamily) return { action: "back" };
      selected = undefined;
      continue;
    }
    if (result.action === "back") continue;
    return result;
  }
}

async function runProviderModelOperation({ environment, prompts, output, provider: selected, backLabel }) {
  const { catalogs } = await loadProviderModelCatalogs({ environment });
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
    ...(["ccg", "ocg", "clp", "olc"].includes(family) || custom && catalog.canRemove ? [{ value: "manage", label: "查看／添加新模型", hint: family === "olc" ? "从远端列表选择，自动获取能力；已有模型保持不变" : "按 ID 独立填写或继承已有模型；已有模型保持不变" }] : []),
    ...(custom && catalog.canRemove ? [{ value: "edit", label: "编辑模型与默认值" }] : []),
    ...(custom || family ? [{ value: "rename", label: "编辑模型显示名称", hint: "模型 ID 保持不变" }] : []),
    ...(family === "clp" ? [{ value: "local-edit", label: "本地编辑已有模型", hint: "无需下载模板；保留模型 ID 和请求格式" }] : []),
    ...(family === "clp" ? [{ value: "request-options", label: "编辑请求改写", hint: "providerOptions JSON；字段原样透传" }] : []),
    ...(family && catalog.providers.length ? [{ value: "default", label: "账户默认模型与共享思考等级", hint: "默认模型仅影响所选账户；模型思考等级由同族账户共用" }] : []),
    ...(family ? [{ value: "window", label: "模型上下文窗口", hint: "按模型设置，同族账户共享" }] : []),
    ...(catalog.source !== "official-shared" && (custom || family) ? [{ value: "template-update", label: "对比并更新模型模板", hint: "选择本地来源和更新内容，预览差异后保存" }] : []),
    { value: "web-search", label: "检测原生网页搜索", hint: "选择单一账户；1 次可能计费请求；仅诊断" },
    ...(custom && catalog.canRemove ? [{ value: "tools", label: "探测单个模型的工具能力", hint: "apply_patch、tool_search；明确选择才发请求，可能计费" }] : []),
    ...(catalog.canRemove ? [{ value: "remove", label: "本地移除模型", hint: "不联网、不改账户和凭据" }] : []),
    { value: "back", label: backLabel },
  ] });
  if (prompts.isCancel(action) || action === "back") return { action: "select-provider" };
  if (action === "rename") {
    const current = (await loadProviderModelCatalogPresentations({ environment })).catalogs.find(entry => entry.provider === catalog.provider);
    if (!current) throw new Error("模型目录已变化，请重新打开模型管理");
    const model = await prompts.select({ message: "选择模型", options: current.models.map(entry => ({ value: entry.id, label: `${entry.displayName}（${entry.id}）` })) });
    if (prompts.isCancel(model)) return { action: "back" };
    const selectedModel = current.models.find(entry => entry.id === model);
    if (!selectedModel) throw new Error("模型选择无效");
    const name = await prompts.text({ message: "显示名称", initialValue: selectedModel.displayName });
    if (prompts.isCancel(name)) return { action: "back" };
    const input = { provider: current.provider, model, displayName: name.trim(), revision: current.revision };
    const preview = await previewProviderModelRename(input, { environment });
    if (!preview.willChange) { output.write("显示名称未变化。\n"); return { action: "unchanged", activation: "none" }; }
    output.write(`模型 ID：${JSON.stringify(model)}（保持不变）\n显示名称：${JSON.stringify(preview.model.displayName)} → ${JSON.stringify(preview.displayName)}\n影响账户：${preview.providers.join("、")}\n`);
    if (await prompts.confirm({ message: "确认保存显示名称？", initialValue: false }) !== true) return { action: "back" };
    const result = await applyProviderModelRename(input, { environment, preview });
    output.write("模型显示名称已保存并回读。\n");
    writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
    return result;
  }
  if (action === "web-search") return runProviderWebSearchSetup({ environment, prompts, output, provider: selected });
  if (action === "local-edit") return runManagedProviderModelEditSetup(selected, { environment, prompts, output });
  if (action === "request-options") return runClinePassRequestOptionsSetup(selected, { environment, prompts, output });
  if (action === "template-update") return runProviderModelTemplateSetup(catalog.provider, { environment, prompts, output });
  if (action === "manage") return runManagedProviderModelSetup(catalog.provider, { environment, prompts, output });
  if (action === "window") return runModelWindowSetup({ environment, prompts, output, provider: selected, allowBack: true });
  if (action === "default") {
    const account = catalog.providers.length === 1 ? catalog.providers[0] : await prompts.select({ message: "选择默认设置所属账户", options: catalog.providers.map(id => ({ value: id, label: id })) });
    if (prompts.isCancel(account)) return { action: "back" };
    return runModelProviderDefaultSetup({ environment, prompts, output, provider: account, allowBack: true });
  }
  let result;
  if (action === "edit" || action === "tools") {
    const previous = readResponsesModelCatalog(environment, catalog.provider);
    let models;
    let model = previous.defaultModel;
    let probeConnections;
    if (action === "tools") {
      const target = await prompts.select({ message: "选择工具能力探测的模型", options: previous.definitions.map(entry => ({ value: entry.id, label: `${entry.name}（${entry.id}）` })) });
      if (prompts.isCancel(target)) return { action: "back" };
      const definition = previous.definitions.find(entry => entry.id === target);
      if (!definition) throw new Error("探测模型选择无效");
      const material = loadConfiguredRelayProviderMaterial(catalog.provider, environment);
      const selected = await promptCustomModelCapabilities(prompts, {
        baseUrl: material.baseUrl, apiKey: material.apiKey, models: [definition],
        upstreamWireApi: readCustomProviderUpstreamWireApi(environment, catalog.provider), environment,
      }, { output });
      if (!selected) return { action: "back" };
      if (loadConfiguredRelayProviderMaterial(catalog.provider, environment).revision !== material.revision) {
        throw new Error("探测期间模型或连接配置已变化，请重新打开模型管理");
      }
      models = previous.definitions.map(entry => entry.id === target ? selected.models[0] : entry);
      probeConnections = selected.probeConnections;
    } else {
      output.write("此入口编辑已有模型；添加和移除请使用各自的模型操作。\n");
      models = await promptResponsesModels(prompts, previous.defaultModel, previous.definitions, output, readCustomProviderUpstreamWireApi(environment, catalog.provider), previous.definitions.map(entry => entry.id), { allowAdd: false });
      if (!models) return { action: "back" };
      model = await prompts.select({ message: "选择默认模型", options: models.map(entry => ({ value: entry.id, label: `${entry.name}（${entry.id}）` })), initialValue: previous.defaultModel });
      if (prompts.isCancel(model)) return { action: "back" };
    }
    const input = { provider: catalog.provider, model, models, ...(probeConnections?.length ? { probeConnections } : {}) };
    const saveOptions = { environment, expectedCatalogContent: previous.content, preserveDefaults: action === "tools" };
    const preview = await previewCustomProviderModelsSave(input, saveOptions);
    for (const entry of preview.provider.models) {
      const old = previous.definitions.find(candidate => candidate.id === entry.id);
      if (!old) {
        output.write(`新增模型：${JSON.stringify(entry, null, 2)}\n`);
        continue;
      }
      const changes = [...new Set([...Object.keys(old), ...Object.keys(entry)])]
        .filter(key => !isDeepStrictEqual(old[key], entry[key]))
        .map(key => `  ${key}：${JSON.stringify(old[key]) ?? "未设置"} → ${JSON.stringify(entry[key]) ?? "未设置"}`);
      if (changes.length) output.write(`修改模型 ${entry.id}：\n${changes.join("\n")}\n`);
    }
    const defaults = preview.modelDefaults;
    output.write(`目录默认模型：${JSON.stringify(defaults.catalog.before)} → ${JSON.stringify(defaults.catalog.after)}\n`);
    output.write(`提供商实际默认模型：${JSON.stringify(defaults.selection.before.model)} → ${JSON.stringify(defaults.selection.after.model)}\n`);
    output.write(`提供商实际默认思考等级：${JSON.stringify(defaults.selection.before.reasoningEffort)} → ${JSON.stringify(defaults.selection.after.reasoningEffort)}\n`);
    output.write(action === "tools" ? "仅保存所选工具能力。\n" : "保存以上目录及提供商默认设置；未列出的模型字段、连接与凭据保持当前值。\n");
    if (!preview.willChange) { output.write("模型目录及默认设置未变化，无需保存。\n"); return { action: "unchanged", activation: "none" }; }
    if (await prompts.confirm({ message: "备份并保存模型设置？", initialValue: false }) !== true) return { action: "back" };
    result = await applyCustomProviderModelsSave(input, { ...saveOptions, preview });
  } else if (action === "remove") {
    const candidates = catalog.models.filter(entry => entry.removalBlockedReason === null);
    if (!candidates.length) throw new Error("没有可移除的模型；请核对账户、目录和 Gateway 显式默认值，并保留至少一个模型");
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
  if (result.action === "unchanged") {
    output.write("模型目录及默认设置未变化，无需保存。\n");
  } else if (result.action !== "back") {
    output.write(["edit", "tools", "remove"].includes(action) ? "模型目录已保存并回读。\n" : "模型目录已保存。\n");
    writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
  }
  return result;
}
