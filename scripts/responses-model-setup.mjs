import { validateResponsesModels } from "../runtime/model-provider-responses-catalog.mjs";
import { thirdPartyCodingInstructions } from "../runtime/third-party-coding-instructions.mjs";
import { promptEnabledProviderModels } from "./provider-model-selection.mjs";

export async function promptResponsesModels(prompts, defaultModel, previous = [], importedIds = [], output = process.stdout) {
  const ids = [defaultModel, ...previous.map((entry) => entry.id).filter((id) => id !== defaultModel)];
  const models = [];
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index];
    const old = previous.find((entry) => entry.id === id);
    let template = old?.template;
    if (template?.source === "deepseek" && !importedIds.includes(id)) {
      const followContext = await prompts.confirm({message: `${id} 跟随 DS 模型 ${template.model} 的上下文？`, initialValue: template.followContext});
      if (prompts.isCancel(followContext)) return undefined;
      template = {...template, followContext: followContext === true};
    }
    let configure = true;
    if (importedIds.includes(id)) {
      configure = await prompts.confirm({ message: `调整 ${id} 的模板能力参数？`, initialValue: false });
      if (prompts.isCancel(configure)) return undefined;
      if (!configure) models.push(withNewModelInstructions({...structuredClone(old), ...(template ? {template} : {})}, true));
    }
    if (configure) {
      const name = await prompts.text({ message: `${id} 显示名称`, initialValue: old?.name ?? id });
      if (prompts.isCancel(name)) return undefined;
      const maximumContext = old?.maxContextWindow ?? 100_000_000;
      const context = template?.followContext ? old.contextWindow : await prompts.text({ message: `${id} 上下文窗口（Token，请按平台说明填写）`, initialValue: String(old?.contextWindow ?? ""), validate: value => Number.isSafeInteger(Number(value)) && Number(value) >= 1024 && Number(value) <= maximumContext ? undefined : `请输入 1024-${maximumContext} 的整数` });
      if (prompts.isCancel(context)) return undefined;
      const reasoning = await prompts.text({ message: "支持的思考等级（逗号分隔；留空表示不支持，请求使用 none）", initialValue: old?.reasoningEfforts.join(",") ?? "" });
      if (prompts.isCancel(reasoning)) return undefined;
      const reasoningEfforts = String(reasoning).trim() === "" ? [] : String(reasoning).split(",").map(value => value.trim());
      const defaultReasoning = reasoningEfforts.length === 0 ? null : await prompts.select({ message: "默认思考等级", options: reasoningEfforts.map(value => ({ value, label: value })), initialValue: old?.defaultReasoningEffort ?? reasoningEfforts[0] });
      if (prompts.isCancel(defaultReasoning)) return undefined;
      const images = await prompts.confirm({ message: `${id} 是否支持图片输入？`, initialValue: old?.supportsImages ?? false });
      if (prompts.isCancel(images)) return undefined;
      models.push(withNewModelInstructions({ ...structuredClone(old), id, name: String(name), contextWindow: Number(context), reasoningEfforts, defaultReasoningEffort: defaultReasoning, supportsImages: images, ...(template ? {template} : {}) }, old === undefined || importedIds.includes(id)));
    }
    if (index === ids.length - 1 && ids.length < 64) {
      const add = await prompts.confirm({ message: "继续添加模型？", initialValue: false });
      if (prompts.isCancel(add)) return undefined;
      if (add) {
        const next = await prompts.text({ message: "下一个模型 ID" });
        if (prompts.isCancel(next)) return undefined;
        ids.push(String(next).trim());
      }
    }
  }
  // Validate candidate capabilities individually; the 64-model limit applies
  // after selection, so a full catalogue can replace an old model in one edit.
  const validated = models.map(model => validateResponsesModels([model], model.id)[0]);
  const enabledModels = await promptEnabledProviderModels(prompts, output, {
    models: validated.map(model => ({id: model.id, name: model.name, reasoningEffort: model.defaultReasoningEffort ?? "none"})),
    enabledModels: validated.map(model => model.id),
    requiredModels: [defaultModel],
    label: "自定义 Responses",
  });
  return enabledModels === undefined ? undefined : validateResponsesModels(validated.filter(model => enabledModels.includes(model.id)), defaultModel);
}

function withNewModelInstructions(model, isNewDefinition) {
  if (isNewDefinition && model.template?.source !== "deepseek" && model.instructions === undefined) {
    return {...model, instructions: thirdPartyCodingInstructions};
  }
  return model;
}
