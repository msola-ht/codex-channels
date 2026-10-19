import { contextWindowPresetTokens, contextWindowPresetLabel, customModelSamplingDefaults, validateModelDefinitions as validateResponsesModels, validateSamplingParameters } from "../runtime/model-catalog.mjs";
import { loadCustomModelDraftTemplates } from "./responses-model-templates.mjs";

const contextWindowPresets = contextWindowPresetTokens.map(tokens => ({
  value: String(tokens), label: `${contextWindowPresetLabel(tokens)}（${tokens} Token）`,
}));

const advancedSettingGroups = [
  { value: "description", label: "模型描述" },
  { value: "maximum-context", label: "最大上下文窗口" },
  { value: "image-detail", label: "图片原始精度" },
  { value: "text", label: "回答详细程度与思考摘要" },
  { value: "reasoning-descriptions", label: "思考等级说明" },
  { value: "instructions", label: "模型指令" },
  { value: "context-limits", label: "有效上下文比例与自动压缩阈值" },
  { value: "truncation", label: "工具输出截断" },
  { value: "sampling", label: "默认采样参数（temperature、top_p 等）" },
];

export async function promptResponsesModels(prompts, defaultModel, previous = [], output = process.stdout, upstreamWireApi = "responses", retainedModels = [], { loadDraftTemplates = loadCustomModelDraftTemplates } = {}) {
  if (!["responses", "chat_completions"].includes(upstreamWireApi)) throw new Error("自定义模型上游接口不受支持");
  if (upstreamWireApi === "chat_completions") output.write("Chat 上游仍可逐项声明所有模型能力；当前转换不传递 verbosity，并拒绝 original 图片精度和非 none 摘要参数，声明不会改变转换规则。\n");
  const ids = [...(defaultModel === undefined ? [] : [defaultModel]), ...previous.map((entry) => entry.id).filter((id) => id !== defaultModel)];
  if (ids.length === 0) ids.push(undefined);
  let selectedModels = [];
  if (previous.length > 0) {
    selectedModels = await prompts.multiselect({
      message: "选择要编辑的已有模型（可不选，直接添加模型或继续默认设置）",
      options: previous.map(model => ({ value: model.id, label: `${model.name}（${model.id}）` })),
      initialValues: [],
      required: false,
    });
    if (prompts.isCancel(selectedModels)) return undefined;
    if (!Array.isArray(selectedModels) || selectedModels.some(id => !previous.some(model => model.id === id)) || new Set(selectedModels).size !== selectedModels.length) throw new Error("待编辑模型选择无效");
  }
  const models = [];
  for (let index = 0; index < ids.length; index++) {
    let id = ids[index];
    const old = previous.find((entry) => entry.id === id);
    let model;
    if (old === undefined) {
      const templates = await loadDraftTemplates();
      if (templates.length === 0) throw new Error("没有可用的模型起点模板");
      const selected = await prompts.select({
        message: "选择新模型的起点模板（仅参考，不证明上游支持模板能力）",
        options: templates.map((entry, templateIndex) => ({ value: templateIndex, label: entry.displayName, hint: entry.source === "official" ? "固定 OpenAI 底座；推荐" : `DeepSeek 模板：${entry.model}` })),
        initialValue: 0,
      });
      if (prompts.isCancel(selected)) return undefined;
      const template = templates[selected];
      if (template === undefined) throw new Error("模型起点模板选择无效");
      model = structuredClone(template.draft);
      output.write(`默认采样参数：${JSON.stringify(model.sampling ?? {})}；保存后自动补齐请求中未指定的参数，可在高级设置修改或清空。\n`);
      const suggested = template.suggested;
      output.write(`已带入模板提示词及运行设置：有效上下文比例 ${model.effectiveContextWindowPercent ?? 95}%；自动压缩阈值 ${model.autoCompactTokenLimit ?? "Codex 默认"}；截断策略 ${model.truncationPolicy === undefined ? "项目默认" : `${model.truncationPolicy.mode} ${model.truncationPolicy.limit}`}。可在高级设置中修改。\n`);
      output.write(`模板参考：${template.displayName}；上下文 ${suggested.contextWindow} Token；思考 ${suggested.reasoningEfforts?.join("/") || "未声明"}；图片 ${capabilityLabel(suggested.supportsImages)}；apply_patch ${capabilityLabel(suggested.applyPatchToolType === undefined ? undefined : suggested.applyPatchToolType === "freeform")}；tool_search ${capabilityLabel(suggested.supportsSearchTool)}。请按上游平台说明逐项确认，未知暂不启用。\n`);
      const typedId = await prompts.text({
        message: "上游模型 ID（必填，使用平台提供的准确名称）", initialValue: id ?? "",
        validate: value => validModelId(String(value).trim(), [...previous, ...models]) ? undefined : "请输入 1-200 字符且不重复、无控制字符的模型 ID",
      });
      if (prompts.isCancel(typedId)) return undefined;
      id = String(typedId).trim();
      if (!validModelId(id, [...previous, ...models])) throw new Error("自定义模型 ID 无效或重复");
      ids[index] = id;
      model.id = id;
    } else {
      model = structuredClone(old);
    }
    let groups;
    if (old !== undefined) {
      groups = selectedModels.includes(id) ? await prompts.multiselect({
        message: `${id} 选择要编辑的设置（未选项保留原值）`,
        options: [
          { value: "name", label: "显示名称" },
          { value: "context", label: "当前上下文窗口" },
          { value: "reasoning", label: "思考能力、等级与默认值" },
          { value: "tools", label: "图片输入、apply_patch、tool_search 与原生网页搜索能力" },
          ...advancedSettingGroups,
        ],
        initialValues: [],
        required: false,
      }) : [];
      if (prompts.isCancel(groups)) return undefined;
      const allowed = new Set(["name", "context", "reasoning", "tools", ...advancedSettingGroups.map(group => group.value)]);
      if (!Array.isArray(groups) || groups.some(group => !allowed.has(group)) || new Set(groups).size !== groups.length) throw new Error("模型设置分组选择无效");
    }
    if (old === undefined || groups.includes("name")) {
      const name = await prompts.text({ message: `${id} 显示名称（必填）`, initialValue: old?.name ?? id, validate: value => String(value).trim() !== "" && String(value).length <= 120 && !/\p{Cc}/u.test(String(value)) ? undefined : "请输入 1-120 字符且无控制字符的名称" });
      if (prompts.isCancel(name)) return undefined;
      model.name = String(name).trim();
    }
    if (old === undefined || groups.includes("context")) {
      const context = await promptContextWindow(prompts, id, model.contextWindow, 100_000_000);
      if (context === undefined) return undefined;
      model.contextWindow = Number(context);
      if (model.maxContextWindow !== undefined && model.maxContextWindow < context) {
        output.write(`${id} 当前窗口 ${context} Token 超过已保存的最大窗口 ${model.maxContextWindow} Token；请按上游说明明确新的最大窗口。\n`);
        const maximum = await prompts.text({ message: `${id} 新最大上下文窗口（Token，必填）`, initialValue: String(context), validate: value => Number.isSafeInteger(Number(value)) && Number(value) >= context && Number(value) <= 100_000_000 ? undefined : `请输入 ${context}-100000000 的整数` });
        if (prompts.isCancel(maximum)) return undefined;
        model.maxContextWindow = Number(maximum);
      }
      if (model.autoCompactTokenLimit !== undefined && model.autoCompactTokenLimit > Math.floor(model.contextWindow * 9 / 10)) {
        output.write(`${id} 原自动压缩阈值 ${model.autoCompactTokenLimit} Token 超过新上下文窗口的 90%；请调整或留空使用 Codex 默认值。\n`);
        if (await promptAutoCompactTokenLimit(prompts, model) === undefined) return undefined;
      }
    }
    if (old === undefined || groups.includes("reasoning")) {
      const supportsReasoning = await promptCapability(prompts, `${id} 是否支持思考参数？`, model.reasoningEfforts === undefined ? undefined : model.reasoningEfforts.length > 0);
      if (supportsReasoning === undefined) return undefined;
      const reasoningEfforts = supportsReasoning === "yes" ? await prompts.multiselect({
        message: `${id} 支持的思考等级（空格勾选，回车确认；按平台说明选择）`,
        options: ["none", "minimal", "low", "medium", "high", "xhigh", "max"].map(value => ({value, label: value})),
        initialValues: model.reasoningEfforts ?? [],
        required: true,
      }) : [];
      if (prompts.isCancel(reasoningEfforts)) return undefined;
      const defaultReasoning = reasoningEfforts.length === 0 ? null : await prompts.select({ message: "默认思考等级", options: reasoningEfforts.map(value => ({ value, label: value })), initialValue: reasoningEfforts.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort : reasoningEfforts[0] });
      if (prompts.isCancel(defaultReasoning)) return undefined;
      Object.assign(model, {reasoningEfforts, defaultReasoningEffort: defaultReasoning});
      if (supportsReasoning === "unknown") delete model.reasoningEfforts;
      if (model.reasoningDescriptions !== undefined) {
        model.reasoningDescriptions = Object.fromEntries(Object.entries(model.reasoningDescriptions).filter(([effort]) => reasoningEfforts.includes(effort)));
        if (Object.keys(model.reasoningDescriptions).length === 0) delete model.reasoningDescriptions;
      }
    }
    if (old === undefined || groups.includes("tools")) {
      for (const [key, label] of [["supportsImages", "图片输入"], ["applyPatchToolType", "apply_patch"], ["supportsSearchTool", "tool_search"], ["supportsWebSearch", "原生网页搜索 web_search（上游服务端工具）"]]) {
        const current = key === "applyPatchToolType" ? model[key] === undefined ? undefined : model[key] === "freeform" : model[key];
        const value = await promptCapability(prompts, `${id} 是否支持 ${label}？`, current);
        if (value === undefined) return undefined;
        if (value === "unknown") delete model[key];
        else model[key] = key === "applyPatchToolType" ? value === "yes" ? "freeform" : null : value === "yes";
      }
      if (!model.supportsImages) delete model.supportsImageDetailOriginal;
    }
    if (await promptAdvancedCapabilities(prompts, model, groups) === undefined) return undefined;
    models.push(model);
    if (index === ids.length - 1 && ids.length < 64) {
      const add = await prompts.confirm({ message: "继续添加模型？", initialValue: false });
      if (prompts.isCancel(add)) return undefined;
      if (add) {
        ids.push(undefined);
      }
    }
  }
  // Existing models stay in the catalog; removal has its own protected flow.
  if (retainedModels.some(id => !models.some(model => model.id === id))) throw new Error("候选目录缺少已保存模型；请先使用模型管理处理缺失模型，原目录未修改");
  return validateResponsesModels(models, defaultModel ?? models[0]?.id);
}

function validModelId(id, models) {
  return id.length > 0 && id.length <= 200 && !/\p{Cc}/u.test(id) && !models.some(model => model.id === id);
}

function capabilityLabel(value) { return value === undefined ? "未知" : value ? "支持" : "不支持"; }

async function promptCapability(prompts, message, current) {
  const value = await prompts.select({ message, options: [{value: "yes", label: "支持（按平台说明手动声明）"}, {value: "no", label: "不支持"}, {value: "unknown", label: "未知（保存但暂不启用）"}], initialValue: current === undefined ? "unknown" : current ? "yes" : "no" });
  if (prompts.isCancel(value)) return undefined;
  if (!["yes", "no", "unknown"].includes(value)) throw new Error("模型能力选择无效");
  return value;
}

async function promptSamplingParameters(prompts, model) {
  const mode = await prompts.select({ message: `${model.id} 默认采样参数`, options: [
    { value: "edit", label: "编辑当前值" },
    { value: "template", label: "恢复固定采样模板后编辑" },
    { value: "upstream", label: "全部清空，使用上游默认值" },
  ], initialValue: "edit" });
  if (prompts.isCancel(mode)) return undefined;
  if (mode === "upstream") { delete model.sampling; return model; }
  if (!["edit", "template"].includes(mode)) throw new Error("采样设置选项无效");
  const initial = mode === "template" ? customModelSamplingDefaults : model.sampling;
  const sampling = {};
  for (const key of ["temperature", "top_p", "top_k", "min_p", "presence_penalty", "repetition_penalty"]) {
    const value = await prompts.text({
      message: `${model.id} ${key}（留空使用上游默认值）`,
      initialValue: initial?.[key] === undefined ? "" : String(initial[key]),
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
    for (const effort of model.reasoningEfforts ?? []) {
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


async function promptAdvancedCapabilities(prompts, model, selectedGroups) {
  const groups = selectedGroups ?? await prompts.multiselect({
    message: `${model.id} 选择高级设置（可不选，保留已带入的模板设置）`,
    options: advancedSettingGroups.filter(group => (group.value !== "image-detail" || model.supportsImages)
      && (group.value !== "reasoning-descriptions" || (model.reasoningEfforts?.length ?? 0) > 0)),
    initialValues: [],
    required: false,
  });
  if (prompts.isCancel(groups)) return undefined;
  if (selectedGroups === undefined) {
    const allowed = new Set(advancedSettingGroups.map(group => group.value));
    if (!Array.isArray(groups) || groups.some(group => !allowed.has(group)) || new Set(groups).size !== groups.length) throw new Error("模型设置分组选择无效");
  }
  if (groups.includes("description")) {
    const description = await prompts.text({ message: `${model.id} 模型描述（留空使用目录默认描述）`, initialValue: model.description ?? "", validate: value => String(value).length <= 4000 && !/\p{Cc}/u.test(String(value).replace(/[\t\n]/gu, "")) ? undefined : "描述不能超过 4000 字符或包含非法控制字符" });
    if (prompts.isCancel(description)) return undefined;
    if (String(description).trim() === "") delete model.description;
    else model.description = String(description).trim();
  }
  if (groups.includes("maximum-context")) {
    const maximumContext = await prompts.text({ message: `${model.id} 最大上下文窗口（Token；留空与当前窗口相同）`, initialValue: String(model.maxContextWindow ?? ""), validate: value => String(value).trim() === "" || Number.isSafeInteger(Number(value)) && Number(value) >= model.contextWindow && Number(value) <= 100_000_000 ? undefined : `请输入 ${model.contextWindow}-100000000 的整数，或留空` });
    if (prompts.isCancel(maximumContext)) return undefined;
    if (String(maximumContext).trim() === "") delete model.maxContextWindow;
    else model.maxContextWindow = Number(maximumContext);
  }
  if (groups.includes("image-detail") && model.supportsImages) {
    const original = await prompts.confirm({ message: `${model.id} 是否支持图片 detail=original？（新增默认 No；不知道就选 No）`, initialValue: model.supportsImageDetailOriginal ?? false });
    if (prompts.isCancel(original)) return undefined;
    model.supportsImageDetailOriginal = original;
  }
  if (groups.includes("text") && await promptResponsesTextCapabilities(prompts, model) === undefined) return undefined;
  if (groups.includes("reasoning-descriptions") && (model.reasoningEfforts?.length ?? 0) > 0 && await promptReasoningDescriptions(prompts, model) === undefined) return undefined;
  if (groups.includes("instructions")) {
    const instructions = await prompts.select({ message: `${model.id} 模型指令`, options: [{value: "keep", label: "保留现有指令"}, {value: "edit", label: "编辑模型指令"}, {value: "default", label: "恢复目录默认指令"}], initialValue: "keep" });
    if (prompts.isCancel(instructions)) return undefined;
    if (instructions === "default") delete model.instructions;
    if (instructions === "edit") {
      const value = await prompts.text({ message: `${model.id} 模型指令（最终预览会完整显示）`, initialValue: model.instructions ?? model.modelMessages?.instructions_template ?? "", validate: value => String(value).trim() !== "" && String(value).length <= 200_000 && !Array.from(String(value)).some(character => { const code = character.codePointAt(0); return (code < 32 && code !== 9 && code !== 10) || code === 127; }) ? undefined : "请输入非空、无非法控制字符且不超过 200000 字符的指令" });
      if (prompts.isCancel(value)) return undefined;
      model.instructions = String(value);
    }
  }
  if (groups.includes("context-limits")) {
    const effective = await prompts.text({ message: `${model.id} 有效上下文比例（1-100；留空使用默认 95）`, initialValue: String(model.effectiveContextWindowPercent ?? ""), validate: value => String(value).trim() === "" || Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 100 ? undefined : "请输入 1-100 的整数，或留空" });
    if (prompts.isCancel(effective)) return undefined;
    if (String(effective).trim() === "") delete model.effectiveContextWindowPercent;
    else model.effectiveContextWindowPercent = Number(effective);
    if (await promptAutoCompactTokenLimit(prompts, model) === undefined) return undefined;
  }
  if (groups.includes("truncation")) {
    const truncation = await prompts.select({ message: `${model.id} 工具输出截断策略`, options: [{value: "keep", label: "保留现有策略"}, {value: "default", label: "使用目录默认策略"}, {value: "tokens", label: "按 Token 截断"}, {value: "bytes", label: "按字节截断"}], initialValue: "keep" });
    if (prompts.isCancel(truncation)) return undefined;
    if (truncation === "default") delete model.truncationPolicy;
    if (truncation === "tokens" || truncation === "bytes") {
      const limit = await prompts.text({ message: `${model.id} 截断上限（${truncation}；留空保留现有策略）`, initialValue: model.truncationPolicy?.mode === truncation ? String(model.truncationPolicy.limit) : "", validate: value => String(value).trim() === "" || Number.isSafeInteger(Number(value)) && Number(value) > 0 ? undefined : "请输入正整数，或留空" });
      if (prompts.isCancel(limit)) return undefined;
      if (String(limit).trim() !== "") model.truncationPolicy = {mode: truncation, limit: Number(limit)};
    }
  }
  if (groups.includes("sampling") && await promptSamplingParameters(prompts, model) === undefined) return undefined;
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
