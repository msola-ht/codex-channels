export function validateEnabledModelSelection(selected, { models, requiredModels = [] }) {
  const available = new Set(models.map(model => model.id));
  if (requiredModels.some(id => !available.has(id))) {
    throw new Error("模型目录已不包含当前默认模型；请先调整默认模型，原目录未修改");
  }
  if (!Array.isArray(selected) || selected.length < 1 || selected.length > 64) {
    throw new Error("必须启用 1-64 个模型");
  }
  if (selected.some(id => typeof id !== "string" || !available.has(id)) || new Set(selected).size !== selected.length) {
    throw new Error("启用模型 ID 必须存在于模型目录且不能重复");
  }
  if (requiredModels.some(id => !selected.includes(id))) {
    throw new Error("不能停用当前默认模型；请先修改默认模型");
  }
  return [...selected];
}

export async function promptEnabledProviderModels(prompts, output, {
  models, enabledModels, requiredModels = [], label, defaultModelWhenUnrequired,
}) {
  if (typeof prompts.multiselect !== "function") throw new Error("当前交互入口缺少模型多选能力");
  if (requiredModels.some(id => !models.some(model => model.id === id))) {
    throw new Error("模型目录已不包含当前默认模型；请先调整默认模型，原目录未修改");
  }
  let initialValues = [...new Set([...enabledModels.filter(id => models.some(model => model.id === id)), ...requiredModels])];
  while (true) {
    const selected = await prompts.multiselect({
      message: `选择启用的 ${label} 模型（空格勾选，回车确认）`,
      options: models.map(model => ({
        value: model.id,
        label: `${model.name}（${model.id}）`,
        hint: [
          ...(requiredModels.includes(model.id) ? ["当前默认，须保留"] : []),
          ...(model.reasoningEffort === undefined ? [] : [`默认思考 ${model.reasoningEffort}${model.reasoningEffort === "none" ? "（关闭）" : ""}`]),
        ].join("；"),
      })),
      initialValues,
      required: true,
    });
    if (prompts.isCancel(selected)) return undefined;
    let validated;
    try {
      validated = validateEnabledModelSelection(selected, { models, requiredModels });
    } catch (error) {
      output.write(`${error.message}。\n`);
      if (Array.isArray(selected)) {
        initialValues = [...new Set([...selected.filter(id => models.some(model => model.id === id)), ...requiredModels])];
      }
      continue;
    }
    output.write(`将启用 ${validated.length} 个 ${label} 模型：\n${validated.map(id => `  ${id}`).join("\n")}\n未勾选的模型不会出现在该 Provider 或聚合模型目录中。\n`);
    if (requiredModels.length === 0 && defaultModelWhenUnrequired !== undefined) {
      const defaultModel = validated.includes(defaultModelWhenUnrequired)
        ? defaultModelWhenUnrequired
        : models.find(model => validated.includes(model.id)).id;
      output.write(`新账户默认模型：${defaultModel}。\n`);
    }
    const confirmed = await prompts.confirm({ message: "保存这些模型？", initialValue: true });
    return confirmed === true ? validated : undefined;
  }
}
