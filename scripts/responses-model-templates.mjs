import { readFileSync } from "node:fs";
import { readOfficialModelCatalog } from "../runtime/model-provider-official-catalog.mjs";
import { validateModelDefinitions as validateResponsesModels, modelDefinitionsFromCatalog as responsesModelTemplatesFromCatalog } from "../runtime/model-catalog.mjs";
export { modelDefinitionsFromCatalog as responsesModelTemplatesFromCatalog } from "../runtime/model-catalog.mjs";

export async function loadResponsesModelTemplates(source, environment = process.env) {
  let catalog;
  if (source === "official") catalog = readOfficialModelCatalog(environment);
  else if (source === "deepseek") {
    catalog = JSON.parse(readFileSync(new URL("../runtime/model-catalog-deepseek.json", import.meta.url), "utf8"));
  } else throw new Error("模型模板来源无效");
  return responsesModelTemplatesFromCatalog(catalog, source);
}

export async function promptResponsesModelImport(prompts, previous = [], loadTemplates = loadResponsesModelTemplates) {
  const previousIds = new Set(previous.map(model => model.id));
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
      const template = templates.find(model => model.id === id);
      const used = new Set(selected.map(model => model.id));
      const validate = value => {
        try { validateResponsesModels([{...template, id: String(value).trim()}], String(value).trim()); } catch { return "请输入有效的平台模型 ID"; }
        const targetId = String(value).trim();
        if (previousIds.has(targetId)) return "该平台模型 ID 已存在；模板更新请使用模型管理中的“对比并更新模型模板”，或使用其他 ID 新增";
        if (used.has(targetId)) return "本次导入已使用该平台模型 ID，请使用不同 ID";
        if (previousIds.size + selected.length >= 64) return "自定义模型目录最多包含 64 个模型";
        return undefined;
      };
      const target = await prompts.text({ message: `${id} → 新增平台模型 ID（请求实际使用的名称）`, initialValue: id, validate });
      if (prompts.isCancel(target)) return undefined;
      const error = validate(target);
      if (error) throw new Error(error);
      const model = {...template, id: String(target).trim(), template: {source, model: id}};
      const confirmed = await prompts.confirm({ message: `复制 ${id} → ${model.id}（${model.contextWindow} Token；图片${model.supportsImages ? "支持" : "不支持"}；思考等级 ${model.reasoningEfforts.join("/") || "none"}）？复制模板已提供的描述、等级说明、图片细节、详细程度、思考摘要及有效上下文、压缩和截断元数据；请确认平台支持这些参数。`, initialValue: true });
      if (prompts.isCancel(confirmed)) return undefined;
      if (confirmed) selected.push(model);
    }
  }
  return selected;
}
