import { validateResponsesModels } from "../runtime/model-provider-responses-catalog.mjs";

export async function promptResponsesModels(prompts, defaultModel, previous = [], importedIds = []) {
  const ids = [defaultModel, ...previous.map((entry) => entry.id).filter((id) => id !== defaultModel)];
  const models = [];
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index];
    const old = previous.find((entry) => entry.id === id);
    let keep = true;
    if (index > 0 && old) {
      keep = await prompts.confirm({ message: `保留模型 ${id}？`, initialValue: true });
      if (prompts.isCancel(keep)) return undefined;
    }
    let template = old?.template;
    if (keep && template?.source === "deepseek" && !importedIds.includes(id)) {
      const followContext = await prompts.confirm({message: `${id} 跟随 DS 模型 ${template.model} 的上下文？`, initialValue: template.followContext});
      if (prompts.isCancel(followContext)) return undefined;
      template = {...template, followContext: followContext === true};
    }
    let configure = keep;
    if (keep && importedIds.includes(id)) {
      configure = await prompts.confirm({ message: `调整 ${id} 的模板能力参数？`, initialValue: false });
      if (prompts.isCancel(configure)) return undefined;
      if (!configure) models.push({...structuredClone(old), ...(template ? {template} : {})});
    }
    if (configure) {
      const name = await prompts.text({ message: `${id} 显示名称`, initialValue: old?.name ?? id });
      if (prompts.isCancel(name)) return undefined;
      const maximumContext = template?.snapshot?.max_context_window ?? 100_000_000;
      const context = template?.followContext ? old.contextWindow : await prompts.text({ message: `${id} 上下文窗口（Token，请按平台说明填写）`, initialValue: String(old?.contextWindow ?? ""), validate: value => Number.isSafeInteger(Number(value)) && Number(value) >= 1024 && Number(value) <= maximumContext ? undefined : `请输入 1024-${maximumContext} 的整数` });
      if (prompts.isCancel(context)) return undefined;
      const reasoning = await prompts.text({ message: "支持的思考等级（逗号分隔；留空表示不支持，请求使用 none）", initialValue: old?.reasoningEfforts.join(",") ?? "" });
      if (prompts.isCancel(reasoning)) return undefined;
      const reasoningEfforts = String(reasoning).trim() === "" ? [] : String(reasoning).split(",").map(value => value.trim());
      const defaultReasoning = reasoningEfforts.length === 0 ? null : await prompts.select({ message: "默认思考等级", options: reasoningEfforts.map(value => ({ value, label: value })), initialValue: old?.defaultReasoningEffort ?? reasoningEfforts[0] });
      if (prompts.isCancel(defaultReasoning)) return undefined;
      const images = await prompts.confirm({ message: `${id} 是否支持图片输入？`, initialValue: old?.supportsImages ?? false });
      if (prompts.isCancel(images)) return undefined;
      models.push({ id, name: String(name), contextWindow: Number(context), reasoningEfforts, defaultReasoningEffort: defaultReasoning, supportsImages: images, ...(template ? {template} : {}) });
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
  return validateResponsesModels(models, defaultModel);
}
