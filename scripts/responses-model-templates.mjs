import { existsSync } from "node:fs";
import { join } from "node:path";
import { readOfficialModelCatalog } from "../runtime/model-provider-official-catalog.mjs";
import { deepseekProviderDefinition } from "../runtime/model-provider-definitions.mjs";
import { managedProviderDirectory } from "../runtime/model-provider-runtime.mjs";
import { readPrivateFileSync } from "../runtime/private-file.mjs";
import { validateResponsesModels } from "../runtime/model-provider-responses-catalog.mjs";
import { downloadDeepseekCatalog } from "./deepseek-setup.mjs";

export async function loadResponsesModelTemplates(source, environment = process.env) {
  let catalog;
  if (source === "official") catalog = readOfficialModelCatalog(environment);
  else if (source === "deepseek") {
    const path = join(managedProviderDirectory(environment, deepseekProviderDefinition), deepseekProviderDefinition.catalogFileName);
    if (existsSync(path)) {
      try { catalog = JSON.parse(readPrivateFileSync(path, 2 * 1024 * 1024)); } catch {
        throw new Error("本地 DeepSeek 模型目录无法安全读取，请先修复目录");
      }
    } else catalog = (await downloadDeepseekCatalog(globalThis.fetch)).catalog;
  } else throw new Error("模型模板来源无效");
  return responsesModelTemplatesFromCatalog(catalog);
}

export function responsesModelTemplatesFromCatalog(catalog) {
  if (!Array.isArray(catalog?.models)) throw new Error("模型模板目录缺少 models");
  const models = catalog.models.filter(model => model.visibility === "list" && model.supported_in_api === true).map(model => ({
    id: model.slug,
    name: model.display_name,
    contextWindow: model.context_window,
    reasoningEfforts: model.supported_reasoning_levels?.map(entry => entry.effort).filter(effort => effort !== "ultra" && effort !== "persistent"),
    defaultReasoningEffort: model.default_reasoning_level ?? null,
    supportsImages: model.input_modalities?.includes("image") === true,
  }));
  return validateResponsesModels(models, models[0]?.id);
}

export async function promptResponsesModelImport(prompts, previous = [], loadTemplates = loadResponsesModelTemplates) {
  const selected = [];
  for (const [source, label] of [["official", "官方 Codex"], ["deepseek", "DeepSeek"]]) {
    const enabled = await prompts.confirm({ message: `平台是否提供 ${label} 模型，是否从模板导入？${source === "official" ? "（只复制普通思考等级，不导入 Codex 专用 ultra/persistent 模式）" : ""}`, initialValue: false });
    if (prompts.isCancel(enabled)) return undefined;
    if (!enabled) continue;
    const templates = await loadTemplates(source);
    if (!prompts.multiselect) throw new Error("当前交互入口缺少模型多选能力");
    let ids;
    while (true) {
      ids = await prompts.multiselect({ message: `勾选平台支持的 ${label} 模型（空格勾选，回车确认）`, options: templates.map(model => ({ value: model.id, label: `${model.name}（${model.id}）` })), required: false });
      if (prompts.isCancel(ids)) return undefined;
      if (!Array.isArray(ids) || ids.some(id => !templates.some(model => model.id === id))) throw new Error("所选模型模板无效");
      if (ids.length > 0) break;
      const action = await prompts.select({
        message: `尚未勾选 ${label} 模板，本次没有导入模型参数`,
        options: [
          {value: "retry", label: "返回选择模板", hint: "空格勾选后按回车，复制上下文等参数"},
          {value: "skip", label: "跳过本类模板导入", hint: "未从模板导入的模型需手动填写上下文等参数"},
        ],
        initialValue: "retry",
      });
      if (prompts.isCancel(action)) return undefined;
      if (action === "skip") break;
      if (action !== "retry") throw new Error("模板空选操作无效");
    }
    for (const id of ids) {
      if (previous.length + selected.length >= 64) throw new Error("自定义模型目录最多包含 64 个模型");
      const template = templates.find(model => model.id === id);
      const used = new Set([...previous, ...selected].map(model => model.id));
      const validate = value => {
        try { validateResponsesModels([{...template, id: String(value).trim()}], String(value).trim()); } catch { return "请输入有效的平台模型 ID"; }
        return used.has(String(value).trim()) ? "平台模型 ID 已存在，请使用不同 ID" : undefined;
      };
      const target = await prompts.text({ message: `${id} → 平台模型 ID（请求实际使用的名称）`, initialValue: id, validate });
      if (prompts.isCancel(target)) return undefined;
      const error = validate(target);
      if (error) throw new Error(error);
      const followContext = source === "deepseek" ? await prompts.confirm({ message: "跟随 DeepSeek 模板上下文设置？（通过项目修改 DS 窗口时同步）", initialValue: false }) : false;
      if (prompts.isCancel(followContext)) return undefined;
      const model = {...template, id: String(target).trim(), template: {source, model: id, followContext: followContext === true}};
      const confirmed = await prompts.confirm({ message: `复制 ${id} → ${model.id}（${model.contextWindow} Token；图片${model.supportsImages ? "支持" : "不支持"}；思考等级 ${model.reasoningEfforts.join("/") || "none"}）？`, initialValue: true });
      if (prompts.isCancel(confirmed)) return undefined;
      if (confirmed) selected.push(model);
    }
  }
  return selected;
}
