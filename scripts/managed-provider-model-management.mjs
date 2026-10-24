import * as clackPrompts from "@clack/prompts";
import { loadManagedModelProviderDefinitions, isManagedProviderModelValid, managedProviderAccountFamilyForDefinition } from "../runtime/model-provider-definitions.mjs";
import { loadProviderModelCatalogs } from "./provider-model-management.mjs";
import { loadProviderModelAdditionOptions, previewProviderModelAddition, applyProviderModelAddition } from "./provider-model-additions.mjs";
import { downloadDeepseekCatalog } from "./deepseek-setup.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { promptContextWindow } from "./responses-model-setup.mjs";
import { defaultModelDisplayName, isValidCustomModelId } from "../runtime/model-catalog.mjs";
import { readCustomProviderUpstreamWireApi } from "../runtime/model-provider-upstream-metadata.mjs";

function definitionFor(provider, environment) {
  if (/^cp-[A-Za-z0-9_-]{1,61}$/u.test(provider)) return { id: provider, storageId: "custom", displayName: "自定义提供商", upstreamWireApi: readCustomProviderUpstreamWireApi(environment, provider) };
  const definition = loadManagedModelProviderDefinitions(environment).find(entry => entry.id === provider);
  if (definition && ["ccg", "opencode-go", "clp"].includes(definition.storageId)) return definition;
  throw new Error("此模型新增入口必须明确选择 CCG、OCG 或 CLP 账户");
}

/** All interaction and source acquisition precede the short write transaction. */
export async function runManagedProviderModelSetup(provider, { environment = process.env, prompts = clackPrompts, output = process.stdout, downloadCatalog = downloadDeepseekCatalog, signal } = {}) {
  while (true) {
    const result = await runManagedProviderModelOperation(provider, { environment, prompts, output, downloadCatalog, signal });
    if (result.action === "menu-back") return { action: "back", activation: "none" };
    if (result.action === "back") continue;
    return result;
  }
}

async function runManagedProviderModelOperation(provider, { environment, prompts, output, downloadCatalog, signal }) {
  if (["ccg", "ocg", "clp"].includes(provider)) {
    const storageId = provider === "ocg" ? "opencode-go" : provider;
    const accounts = loadManagedModelProviderDefinitions(environment).filter(entry => entry.storageId === storageId);
    if (!accounts.length) throw new Error("请先配置账户");
    provider = accounts[0].id;
  }
  const definition = definitionFor(provider, environment);
  const displayName = definition.storageId === "custom" ? definition.displayName : managedProviderAccountFamilyForDefinition(definition).definition.displayName;
  const { catalogs } = await loadProviderModelCatalogs({ environment });
  const current = catalogs.find(catalog => catalog.providers.includes(provider));
  if (!current) throw new Error("请先完成账户配置");
  const action = await prompts.select({ message: `${displayName} 模型目录`, options: [
    { value: "select", label: "查看启用模型", hint: "移除请使用统一模型管理入口" },
    { value: "add", label: "按 ID 添加模型", hint: "独立填写能力或继承当前目录中的已有模型" },
    ...(definition.storageId === "custom" ? [] : [{ value: "templates", label: "添加内置 DS 模型", hint: "只添加明确选择的固定 DS 模型，已有模型保持不变" }]),
    { value: "back", label: "返回" },
  ] });
  if (prompts.isCancel(action) || action === "back") return { action: "menu-back", activation: "none" };
  if (action === "select") {
    output.write(`${current.models.map(model => `  ${model.id}${model.isDefault ? "（账户默认）" : ""}`).join("\n")}\n移除请使用统一模型管理入口。\n`);
    return { action: "back", activation: "none" };
  }
  let manualModel;
  if (action === "add") {
    manualModel = await promptAdditionalModel(prompts, definition, current.models);
    if (!manualModel) return { action: "back", activation: "none" };
  } else if (action !== "templates") throw new Error("未知模型目录操作");
  return runProviderModelAdditionSetup(provider, { environment, prompts, output, downloadCatalog, signal, ...(manualModel ? { manualModel } : {}) });
}

/** Shared CLI discovery, full-field preview and explicit confirmation for CLP/CCG/OCG. */
export async function runProviderModelAdditionSetup(provider, {
  environment = process.env, prompts = clackPrompts, output = process.stdout, manualModel, signal,
  downloadCatalog = downloadDeepseekCatalog,
} = {}) {
  definitionFor(provider, environment);
  const options = await loadProviderModelAdditionOptions(provider, { environment, manualModel, downloadCatalog, signal });
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
    for (const candidate of preview.additions) {
      if (candidate.inheritedFrom) output.write(`继承来源：${candidate.inheritedFrom}（一次性复制，后续独立修改）。发送模型 ID 仍为 ${candidate.model}。\n`);
      if (candidate.clineRequestProfile) output.write(`请求处理：${candidate.clineRequestProfile === "deepseek-flash" ? "Flash 思考参数格式；未显式设置 gateway.only 时补 DeepSeek 默认路由" : "通用 Cline 思考参数格式；由 Cline 选择上游"}。\n`);
      if (candidate.clineProviderOptions) output.write(`请求改写：${JSON.stringify(candidate.clineProviderOptions)}\n`);
      output.write(`新增模型 ${candidate.model}：\n${JSON.stringify({ fields: candidate.fields, ...(candidate.template ? { template: candidate.template } : {}) }, null, 2)}\n`);
    }
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
  if (!["ccg", "opencode-go", "clp", "custom"].includes(definition.storageId)) throw new Error("此提供商不支持手动新增模型");
  const clinePass = definition.storageId === "clp";
  const confirmed = await prompts.confirm({ message: clinePass || definition.upstreamWireApi === "chat_completions" ? "已确认此提供商以 Chat Completions 接口支持该模型的文本及工具调用？" : "已确认此提供商以 Responses 接口支持该模型及工具调用？", initialValue: false });
  if (confirmed !== true) return undefined;
  const id = await prompts.text({ message: "上游模型 ID（准确名称）", validate: value => (definition.storageId === "custom" ? isValidCustomModelId(value) : isManagedProviderModelValid(definition, value)) && !existing.some(model => model.id === value) ? undefined : "请输入有效且未加入目录的模型 ID" });
  if (prompts.isCancel(id)) return undefined;
  const name = await prompts.text({ message: "显示名称", initialValue: defaultModelDisplayName(id),
    validate: value => typeof value === "string" && value.trim().length > 0 && value.length <= 120 && !/\p{Cc}/u.test(value) ? undefined : "请输入 1-120 字符且无控制字符的名称" });
  if (prompts.isCancel(name)) return undefined;
  {
    const mode = await prompts.select({ message: "模型配置方式", options: [
      { value: "manual", label: "独立填写能力" },
      { value: "inherit", label: "继承已有模型", hint: "一次性复制当前保存的模型参数；后续独立修改" },
    ] });
    if (prompts.isCancel(mode)) return undefined;
    if (mode === "inherit") {
      const inheritFrom = await prompts.select({ message: "选择当前目录中的继承来源", options: existing.map(model => ({ value: model.id, label: `${model.displayName}（${model.id}）` })) });
      if (prompts.isCancel(inheritFrom)) return undefined;
      return { id, name, inheritFrom };
    }
    if (mode !== "manual") throw new Error("未知模型配置方式");
  }
  const window = await promptContextWindow(prompts, id, undefined, 100_000_000);
  if (window === undefined) return undefined;
  const efforts = await prompts.multiselect({ message: "支持的思考等级（不支持思考时仅选 none）", options: ["none", ...(clinePass ? ["enabled"] : []), "minimal", "low", "medium", "high", "xhigh", "max"].map(value => ({ value, label: value })), required: true });
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
  return { id, name, contextWindow: Number(window), reasoningEfforts: efforts, defaultReasoningEffort: effort,
    supportsImages: images, applyPatchToolType: patch ? "freeform" : null, supportsSearchTool: search };
}
