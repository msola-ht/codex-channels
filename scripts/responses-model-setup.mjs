import { contextWindowPresetTokens, validateModelDefinitions as validateResponsesModels, validateSamplingParameters } from "../runtime/model-catalog.mjs";
import { thirdPartyCodingInstructions } from "../runtime/third-party-coding-instructions.mjs";
import { promptEnabledProviderModels } from "./provider-model-selection.mjs";

const contextWindowPresets = contextWindowPresetTokens.map(tokens => ({
  value: String(tokens), label: `${tokens === 1048576 ? "1M" : `${tokens / 1024}K`}（${tokens} Token）`,
}));

export async function promptResponsesModels(prompts, defaultModel, previous = [], importedIds = [], output = process.stdout, upstreamWireApi = "responses", retainedModels = []) {
  if (!["responses", "chat_completions"].includes(upstreamWireApi)) throw new Error("自定义模型上游接口不受支持");
  if (upstreamWireApi === "chat_completions") output.write("Chat 上游仍可逐项声明所有模型能力；当前转换不传递 verbosity，并拒绝 original 图片精度和非 none 摘要参数，声明不会改变转换规则。\n");
  const ids = [defaultModel, ...previous.map((entry) => entry.id).filter((id) => id !== defaultModel)];
  const models = [];
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index];
    const old = previous.find((entry) => entry.id === id);
    const template = old?.template === undefined ? undefined : { source: old.template.source, model: old.template.model };
    let configure = true;
    const model = withNewModelInstructions({...structuredClone(old), ...(template ? {template} : {})}, old === undefined || importedIds.includes(id));
    if (importedIds.includes(id)) {
      configure = await prompts.confirm({ message: `调整 ${id} 的模板名称、上下文或模型能力？`, initialValue: false });
      if (prompts.isCancel(configure)) return undefined;
    }
    if (configure) {
      const name = await prompts.text({ message: `${id} 显示名称`, initialValue: old?.name ?? id });
      if (prompts.isCancel(name)) return undefined;
      const description = await prompts.text({ message: `${id} 模型描述（留空使用目录默认描述）`, initialValue: old?.description ?? "", validate: value => String(value).length <= 4000 && !/\p{Cc}/u.test(String(value).replace(/[\t\n]/gu, "")) ? undefined : "描述不能超过 4000 字符或包含非法控制字符" });
      if (prompts.isCancel(description)) return undefined;
      const context = await promptContextWindow(prompts, id, old?.contextWindow, 100_000_000);
      if (context === undefined) return undefined;
      const maximumContext = await prompts.text({
        message: `${id} 最大上下文窗口（Token；留空与当前窗口相同）`,
        initialValue: String(old?.maxContextWindow ?? ""),
        validate: value => String(value).trim() === "" || Number.isSafeInteger(Number(value)) && Number(value) >= context && Number(value) <= 100_000_000 ? undefined : `请输入 ${context}-100000000 的整数，或留空与当前窗口相同`,
      });
      if (prompts.isCancel(maximumContext)) return undefined;
      Object.assign(model, {id, contextWindow: Number(context)});
      if (model.autoCompactTokenLimit !== undefined && model.autoCompactTokenLimit > Math.floor(model.contextWindow * 9 / 10)) {
        output.write(`${id} 原自动压缩阈值 ${model.autoCompactTokenLimit} Token 超过新上下文窗口的 90%；请调整或留空使用 Codex 默认值。\n`);
        if (await promptAutoCompactTokenLimit(prompts, model) === undefined) return undefined;
      }
      const supportsReasoning = await prompts.confirm({ message: `${id} 是否支持思考参数？`, initialValue: (old?.reasoningEfforts.length ?? 0) > 0 });
      if (prompts.isCancel(supportsReasoning)) return undefined;
      const reasoningEfforts = supportsReasoning ? await prompts.multiselect({
        message: `${id} 支持的思考等级（空格勾选，回车确认；按平台说明选择）`,
        options: ["none", "minimal", "low", "medium", "high", "xhigh", "max"].map(value => ({value, label: value})),
        initialValues: old?.reasoningEfforts.length > 0 ? old.reasoningEfforts : ["none", "medium"],
        required: true,
      }) : [];
      if (prompts.isCancel(reasoningEfforts)) return undefined;
      const defaultReasoning = reasoningEfforts.length === 0 ? null : await prompts.select({ message: "默认思考等级", options: reasoningEfforts.map(value => ({ value, label: value })), initialValue: reasoningEfforts.includes(old?.defaultReasoningEffort) ? old.defaultReasoningEffort : reasoningEfforts[0] });
      if (prompts.isCancel(defaultReasoning)) return undefined;
      Object.assign(model, {name: String(name), reasoningEfforts, defaultReasoningEffort: defaultReasoning});
      if (String(description).trim() === "") delete model.description;
      else model.description = String(description).trim();
      if (String(maximumContext).trim() === "") delete model.maxContextWindow;
      else model.maxContextWindow = Number(maximumContext);
      if (model.reasoningDescriptions !== undefined) {
        model.reasoningDescriptions = Object.fromEntries(Object.entries(model.reasoningDescriptions).filter(([effort]) => reasoningEfforts.includes(effort)));
        if (Object.keys(model.reasoningDescriptions).length === 0) delete model.reasoningDescriptions;
      }
      const images = await prompts.confirm({ message: `${id} 是否支持图片输入？`, initialValue: old?.supportsImages ?? false });
      if (prompts.isCancel(images)) return undefined;
      model.supportsImages = images;
      if (!images) delete model.supportsImageDetailOriginal;
      if (await promptAdvancedCapabilities(prompts, model) === undefined) return undefined;
    }
    if (await promptSamplingParameters(prompts, model) === undefined) return undefined;
    models.push(model);
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
  // after selection; removing saved models uses the independent removal flow.
  const validated = models.map(model => validateResponsesModels([model], model.id)[0]);
  const enabledModels = await promptEnabledProviderModels(prompts, output, {
    models: validated.map(model => ({id: model.id, name: model.name, reasoningEffort: model.defaultReasoningEffort ?? "none"})),
    enabledModels: validated.map(model => model.id),
    requiredModels: [defaultModel],
    retainedModels,
    label: "自定义提供商",
  });
  return enabledModels === undefined ? undefined : validateResponsesModels(validated.filter(model => enabledModels.includes(model.id)), defaultModel);
}

async function promptSamplingParameters(prompts, model) {
  const configure = await prompts.confirm({ message: `${model.id} 是否设置默认采样参数（No 保留已有设置；留空使用上游默认值）？`, initialValue: false });
  if (prompts.isCancel(configure)) return undefined;
  if (!configure) return model;
  const sampling = {};
  for (const [key, initial] of Object.entries({temperature: "1.0", top_p: "0.95", top_k: "20", min_p: "0.0", presence_penalty: "0.0", repetition_penalty: "1.0"})) {
    const value = await prompts.text({
      message: `${model.id} ${key}（留空使用上游默认值）`,
      initialValue: model.sampling?.[key] === undefined ? initial : String(model.sampling[key]),
      validate: value => {
        if (String(value).trim() === "") return undefined;
        try { validateSamplingParameters({[key]: Number(value)}); } catch (error) { return error.message; }
        return undefined;
      },
    });
    if (prompts.isCancel(value)) return undefined;
    if (String(value).trim() !== "") sampling[key] = Number(value);
  }
  const validated = validateSamplingParameters(sampling);
  if (validated === undefined) delete model.sampling;
  else model.sampling = validated;
  return model;
}

async function promptReasoningDescriptions(prompts, model) {
  const action = await prompts.select({
    message: `${model.id} 思考等级说明`,
    options: [{value: "keep", label: "保留现有说明；新等级使用默认说明"}, {value: "edit", label: "逐项编辑说明"}, {value: "default", label: "全部使用默认说明"}],
    initialValue: "keep",
  });
  if (prompts.isCancel(action)) return undefined;
  if (action === "default") delete model.reasoningDescriptions;
  if (action === "edit") {
    const descriptions = {};
    for (const effort of model.reasoningEfforts) {
      const description = await prompts.text({ message: `${model.id} ${effort} 说明（留空使用默认说明）`, initialValue: model.reasoningDescriptions?.[effort] ?? "", validate: value => String(value).length <= 2000 && !/\p{Cc}/u.test(String(value).replace(/[\t\n]/gu, "")) ? undefined : "说明不能超过 2000 字符或包含非法控制字符" });
      if (prompts.isCancel(description)) return undefined;
      if (String(description).trim() !== "") descriptions[effort] = String(description).trim();
    }
    if (Object.keys(descriptions).length === 0) delete model.reasoningDescriptions;
    else model.reasoningDescriptions = descriptions;
  }
  return model;
}

async function promptResponsesTextCapabilities(prompts, model) {
  const verbosity = await prompts.confirm({ message: `${model.id} 是否支持 text.verbosity（回答详细程度）？`, initialValue: model.supportsVerbosity ?? false });
  if (prompts.isCancel(verbosity)) return undefined;
  model.supportsVerbosity = verbosity;
  if (verbosity) {
    const value = await prompts.select({ message: `${model.id} 默认回答详细程度`, options: ["low", "medium", "high"].map(value => ({value, label: value})), initialValue: model.defaultVerbosity ?? "medium" });
    if (prompts.isCancel(value)) return undefined;
    model.defaultVerbosity = value;
  } else delete model.defaultVerbosity;
  const summary = await prompts.confirm({ message: `${model.id} 是否支持 reasoning.summary（思考摘要；与思考等级独立）？`, initialValue: model.supportsReasoningSummary ?? false });
  if (prompts.isCancel(summary)) return undefined;
  model.supportsReasoningSummary = summary;
  if (summary) {
    const value = await prompts.select({ message: `${model.id} 默认思考摘要`, options: ["auto", "concise", "detailed", "none"].map(value => ({value, label: value})), initialValue: model.defaultReasoningSummary ?? "auto" });
    if (prompts.isCancel(value)) return undefined;
    model.defaultReasoningSummary = value;
  } else delete model.defaultReasoningSummary;
  return model;
}


async function promptAdvancedCapabilities(prompts, model) {
  const advanced = await prompts.confirm({ message: `${model.id} 是否设置高级能力与参数（图片精度、详细程度、思考摘要、等级说明及指令等；No 保留已有设置，新模型使用默认值）？`, initialValue: false });
  if (prompts.isCancel(advanced)) return undefined;
  if (!advanced) return model;
  if (model.supportsImages) {
    const original = await prompts.confirm({ message: `${model.id} 是否支持图片 detail=original？（新增默认 No；不知道就选 No）`, initialValue: model.supportsImageDetailOriginal ?? false });
    if (prompts.isCancel(original)) return undefined;
    model.supportsImageDetailOriginal = original;
  }
  if (await promptResponsesTextCapabilities(prompts, model) === undefined) return undefined;
  if (model.reasoningEfforts.length > 0 && await promptReasoningDescriptions(prompts, model) === undefined) return undefined;
  const instructions = await prompts.select({ message: `${model.id} 模型指令`, options: [{value: "keep", label: "保留现有指令"}, {value: "edit", label: "编辑模型指令"}, {value: "default", label: "恢复目录默认指令"}], initialValue: "keep" });
  if (prompts.isCancel(instructions)) return undefined;
  if (instructions === "default") delete model.instructions;
  if (instructions === "edit") {
    const value = await prompts.text({ message: `${model.id} 模型指令（最终预览会完整显示）`, initialValue: model.instructions ?? "", validate: value => String(value).trim() !== "" && String(value).length <= 200_000 && !Array.from(String(value)).some(character => { const code = character.codePointAt(0); return (code < 32 && code !== 9 && code !== 10) || code === 127; }) ? undefined : "请输入非空、无非法控制字符且不超过 200000 字符的指令" });
    if (prompts.isCancel(value)) return undefined;
    model.instructions = String(value);
  }
  const effective = await prompts.text({ message: `${model.id} 有效上下文比例（1-100；留空使用默认 95）`, initialValue: String(model.effectiveContextWindowPercent ?? ""), validate: value => String(value).trim() === "" || Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 100 ? undefined : "请输入 1-100 的整数，或留空" });
  if (prompts.isCancel(effective)) return undefined;
  if (String(effective).trim() === "") delete model.effectiveContextWindowPercent;
  else model.effectiveContextWindowPercent = Number(effective);
  if (await promptAutoCompactTokenLimit(prompts, model) === undefined) return undefined;
  const truncation = await prompts.select({ message: `${model.id} 工具输出截断策略`, options: [{value: "keep", label: "保留现有策略"}, {value: "default", label: "使用目录默认策略"}, {value: "tokens", label: "按 Token 截断"}, {value: "bytes", label: "按字节截断"}], initialValue: "keep" });
  if (prompts.isCancel(truncation)) return undefined;
  if (truncation === "default") delete model.truncationPolicy;
  if (truncation === "tokens" || truncation === "bytes") {
    const limit = await prompts.text({ message: `${model.id} 截断上限（${truncation}；留空保留现有策略）`, initialValue: model.truncationPolicy?.mode === truncation ? String(model.truncationPolicy.limit) : "", validate: value => String(value).trim() === "" || Number.isSafeInteger(Number(value)) && Number(value) > 0 ? undefined : "请输入正整数，或留空" });
    if (prompts.isCancel(limit)) return undefined;
    if (String(limit).trim() !== "") model.truncationPolicy = {mode: truncation, limit: Number(limit)};
  }
  return model;
}

async function promptAutoCompactTokenLimit(prompts, model) {
  const compactMaximum = Math.floor(model.contextWindow * 9 / 10);
  const initialValue = model.autoCompactTokenLimit <= compactMaximum ? String(model.autoCompactTokenLimit) : "";
  const compact = await prompts.text({ message: `${model.id} 自动压缩阈值（Token；留空使用 Codex 默认）`, initialValue, validate: value => String(value).trim() === "" || Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= compactMaximum ? undefined : `请输入 1-${compactMaximum} 的整数，或留空` });
  if (prompts.isCancel(compact)) return undefined;
  if (String(compact).trim() === "") delete model.autoCompactTokenLimit;
  else model.autoCompactTokenLimit = Number(compact);
  return model;
}

function withNewModelInstructions(model, isNewDefinition) {
  if (isNewDefinition && model.template?.source !== "deepseek" && model.instructions === undefined) {
    return {...model, instructions: thirdPartyCodingInstructions};
  }
  return model;
}

export async function promptContextWindow(prompts, id, current, maximumContext, { includeMaximum = false } = {}) {
  const presets = contextWindowPresets.filter((preset) => Number(preset.value) <= maximumContext);
  const selected = await prompts.select({
    message: `${id} 当前上下文窗口`,
    options: [...presets.map(preset => includeMaximum && Number(preset.value) === maximumContext
      ? { ...preset, label: `${preset.label} · 最大窗口` } : preset),
      ...(includeMaximum && !presets.some((preset) => Number(preset.value) === maximumContext)
        ? [{ value: String(maximumContext), label: `使用最大窗口（${maximumContext} Token）` }] : []),
      { value: "custom", label: "自定义 Token 数" }],
    initialValue: presets.some((preset) => Number(preset.value) === current) || (includeMaximum && current === maximumContext) ? String(current) : "custom",
  });
  if (prompts.isCancel(selected)) return undefined;
  if (selected !== "custom") return Number(selected);
  const typed = await prompts.text({ message: `${id} 当前上下文窗口（Token，请按平台说明填写）`, initialValue: String(current ?? ""), validate: value => Number.isSafeInteger(Number(value)) && Number(value) >= 1024 && Number(value) <= maximumContext ? undefined : `请输入 1024-${maximumContext} 的整数` });
  if (prompts.isCancel(typed)) return undefined;
  return Number(typed);
}
