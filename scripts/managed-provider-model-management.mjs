import * as clackPrompts from "@clack/prompts";
import { loadManagedModelProviderDefinitions, isManagedProviderModelValid, managedProviderAccountFamilyForDefinition } from "../runtime/model-provider-definitions.mjs";
import { loadProviderModelCatalogs } from "./provider-model-management.mjs";
import { loadProviderModelAdditionOptions, previewProviderModelAddition, applyProviderModelAddition } from "./provider-model-additions.mjs";
import { downloadDeepseekCatalog } from "./deepseek-setup.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { promptContextWindow } from "./responses-model-setup.mjs";

function definitionFor(provider, environment) {
  const definition = loadManagedModelProviderDefinitions(environment).find(entry => entry.id === provider);
  if (definition && ["ccg", "opencode-go", "clp"].includes(definition.storageId)) return definition;
  throw new Error("此模型新增入口必须明确选择 CCG、OCG 或 CLP 账户");
}

/** All interaction and source acquisition precede the short write transaction. */
export async function runManagedProviderModelSetup(provider, { environment = process.env, prompts = clackPrompts, output = process.stdout, downloadCatalog = downloadDeepseekCatalog, signal } = {}) {
  if (provider === "ccg" || provider === "ocg") {
    const storageId = provider === "ccg" ? "ccg" : "opencode-go";
    const accounts = loadManagedModelProviderDefinitions(environment).filter(entry => entry.storageId === storageId);
    if (!accounts.length) throw new Error("请先配置账户");
    provider = accounts[0].id;
  }
  const definition = definitionFor(provider, environment);
  const displayName = managedProviderAccountFamilyForDefinition(definition).definition.displayName;
  const { catalogs } = await loadProviderModelCatalogs({ environment });
  const current = catalogs.find(catalog => catalog.providers.includes(provider));
  if (!current) throw new Error("请先完成账户配置");
  const action = await prompts.select({ message: `${displayName} 模型目录`, options: [
    { value: "select", label: "查看启用模型", hint: "移除请使用统一模型管理入口" },
    { value: "add", label: "添加第三方 Responses 模型", hint: "按上游说明填写准确 ID 和能力" },
    { value: "templates", label: "发现／导入 DS 新模型", hint: "只添加选中的新模型，已有模型使用统一模板更新" },
    { value: "back", label: "返回" },
  ] });
  if (prompts.isCancel(action) || action === "back") return { action: "back", activation: "none" };
  if (action === "select") {
    output.write(`${current.models.map(model => `  ${model.id}${model.isDefault ? "（账户默认）" : ""}`).join("\n")}\n移除请使用统一模型管理入口。\n`);
    return { action: "back", activation: "none" };
  }
  let manualModel;
  if (action === "add") {
    manualModel = await promptAdditionalModel(prompts, definition, current.models.map(model => model.id));
    if (!manualModel) return { action: "back", activation: "none" };
  } else if (action !== "templates") throw new Error("未知模型目录操作");
  return runProviderModelAdditionSetup(provider, { environment, prompts, output, downloadCatalog, signal, ...(manualModel ? { manualModel } : {}) });
}

/** Shared CLI discovery, full-field preview and explicit confirmation for CLP/CCG/OCG. */
export async function runProviderModelAdditionSetup(provider, {
  environment = process.env, prompts = clackPrompts, output = process.stdout, manualModel, signal,
  downloadCatalog = downloadDeepseekCatalog, downloadClineCatalog, loadTemplates,
} = {}) {
  definitionFor(provider, environment);
  const options = await loadProviderModelAdditionOptions(provider, { environment, manualModel, downloadCatalog, downloadClineCatalog, loadTemplates, signal });
  let models;
  if (!options.candidates.length) models = [];
  else if (manualModel) models = options.candidates.map(candidate => candidate.model);
  else {
    models = await prompts.multiselect({ message: "选择要新增的模型（已有模型保持当前内容）", required: false,
      initialValues: [], options: options.candidates.map(candidate => ({ value: candidate.model, label: `${candidate.displayName}（${candidate.model}）` })) });
    if (prompts.isCancel(models)) return { action: "back", activation: "none" };
  }
  signal?.throwIfAborted();
  const input = { provider, sourceToken: options.sourceToken, revision: options.revision, models };
  const preview = await previewProviderModelAddition(input, { environment });
  signal?.throwIfAborted();
  if (preview.willChange) {
    output.write(`影响账户：${preview.providers.join("、")}。\n`);
    for (const candidate of preview.additions) output.write(`新增模型 ${candidate.model}：\n${JSON.stringify({ fields: candidate.fields, ...(candidate.template ? { template: candidate.template } : {}) }, null, 2)}\n`);
    output.write("保存前备份原目录及来源；保存不会自动重启服务。\n");
    if (await prompts.confirm({ message: "确认按上述完整内容新增模型？", initialValue: false }) !== true) return { action: "back", activation: "none" };
  }
  // Cancellation before committing must not become a confirmed write. Once
  // apply starts, the existing transaction owns completion and recovery.
  signal?.throwIfAborted();
  const result = await applyProviderModelAddition(input, { environment, preview });
  output.write(result.action === "unchanged" ? "模型目录没有变化，无需保存或重启。\n" : `模型目录已保存并回读，现有 ${result.models.length} 个模型。\n`);
  if (result.action === "catalog-updated") writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
  return result;
}

async function promptAdditionalModel(prompts, definition, existing) {
  if (!["ccg", "opencode-go"].includes(definition.storageId)) throw new Error("此提供商不支持手动新增模型");
  const confirmed = await prompts.confirm({ message: "已确认此提供商以 Responses 接口支持该模型及工具调用？", initialValue: false });
  if (confirmed !== true) return undefined;
  const id = await prompts.text({ message: "上游模型 ID（准确名称）", validate: value => isManagedProviderModelValid(definition, value) && !existing.includes(value) ? undefined : "请输入有效且未加入目录的模型 ID" });
  if (prompts.isCancel(id)) return undefined;
  const name = await prompts.text({ message: "显示名称", initialValue: id });
  if (prompts.isCancel(name)) return undefined;
  const window = await promptContextWindow(prompts, id, undefined, 100_000_000);
  if (window === undefined) return undefined;
  const efforts = await prompts.multiselect({ message: "支持的思考等级（不支持思考时仅选 none）", options: ["none", "minimal", "low", "medium", "high", "xhigh", "max"].map(value => ({ value, label: value })), required: true });
  if (prompts.isCancel(efforts)) return undefined;
  if (!Array.isArray(efforts) || !efforts.length) throw new Error("至少选择一个思考等级");
  const effort = await prompts.select({ message: "默认思考等级", options: efforts.map(value => ({ value, label: value })) });
  if (prompts.isCancel(effort)) return undefined;
  const images = await prompts.confirm({ message: "支持图片输入？", initialValue: false });
  if (prompts.isCancel(images)) return undefined;
  const patch = await prompts.confirm({ message: "支持 Codex 自由格式 apply_patch 工具？", initialValue: false });
  if (prompts.isCancel(patch)) return undefined;
  const search = await prompts.confirm({ message: "支持 Codex 客户端 tool_search 工具？", initialValue: false });
  if (prompts.isCancel(search)) return undefined;
  const webSearch = await prompts.select({ message: "原生网页搜索 web_search（上游服务端工具）能力", options: [
    { value: "unknown", label: "未知（不写声明）" }, { value: "yes", label: "支持（按平台说明手动声明）" }, { value: "no", label: "不支持" },
  ], initialValue: "unknown" });
  if (prompts.isCancel(webSearch)) return undefined;
  if (!["yes", "no", "unknown"].includes(webSearch)) throw new Error("网页搜索能力选择无效");
  return { id, name, contextWindow: Number(window), reasoningEfforts: efforts, defaultReasoningEffort: effort,
    supportsImages: images, applyPatchToolType: patch ? "freeform" : null, supportsSearchTool: search,
    ...(webSearch === "unknown" ? {} : { supportsWebSearch: webSearch === "yes" }) };
}
