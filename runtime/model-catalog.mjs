// Pure model-definition validation, Codex field generation and source adaptation.
// Provider files and credentials belong to the runtime persistence owners.
import { completeModelMessages } from "./model-template-prompts.mjs";
export const contextWindowPresetTokens = Object.freeze([131072, 262144, 393216, 524288, 1048576]);
export const openAiContextWindowPresetTokens = Object.freeze([272000, 372000, 500000]);
export function contextWindowPresetLabel(tokens) {
  return tokens === 1048576 ? "1M" : `${tokens / 1024}K`;
}
const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const verbosityLevels = new Set(["low", "medium", "high"]);
const reasoningSummaries = new Set(["auto", "concise", "detailed", "none"]);
const controlFree = (text) => !Array.from(text).some((character) => { const code = character.codePointAt(0); return (code < 32 && code !== 9 && code !== 10) || code === 127; });
const descriptionControlFree = (text) => !/\p{Cc}/u.test(text.replace(/[\t\n]/gu, ""));
const instructions = "You are a coding assistant. Follow the user's instructions, inspect the workspace before making changes, use the available tools when needed, and report results accurately. Respect tool permissions and do not claim actions succeeded without evidence.";

// Project-owned starting values, independent of upstream model templates.
export const customModelSamplingDefaults = Object.freeze({
  temperature: 1, top_p: 0.95, top_k: 20, min_p: 0,
  presence_penalty: 0, repetition_penalty: 1,
});

export function validateSamplingParameters(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["temperature", "top_p", "top_k", "min_p", "presence_penalty", "repetition_penalty"].includes(key))) {
    throw new Error("默认采样参数包含不受支持的字段或格式");
  }
  const sampling = {};
  for (const [key, number] of Object.entries(value)) {
    if (typeof number !== "number" || !Number.isFinite(number)) throw new Error(`默认采样参数 ${key} 必须为有限数字`);
    if (key === "temperature" && (number < 0 || number > 2)) throw new Error("默认采样参数 temperature 必须为 0-2");
    if ((key === "top_p" || key === "min_p") && (number < 0 || number > 1)) throw new Error(`默认采样参数 ${key} 必须为 0-1`);
    if (key === "top_k" && (!Number.isSafeInteger(number) || number < 0)) throw new Error("默认采样参数 top_k 必须为非负安全整数");
    if (key === "presence_penalty" && (number < -2 || number > 2)) throw new Error("默认采样参数 presence_penalty 必须为 -2 至 2");
    if (key === "repetition_penalty" && number <= 0) throw new Error("默认采样参数 repetition_penalty 必须大于 0");
    sampling[key] = number;
  }
  return Object.keys(sampling).length === 0 ? undefined : sampling;
}

export function validateModelDefinitions(values, defaultModel, { allowReasoningToggle = false } = {}) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 64) {
    throw new Error("自定义模型目录必须包含 1-64 个模型");
  }
  const seen = new Set();
  const models = values.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !["id", "name", "contextWindow", "maxContextWindow", "reasoningEfforts", "defaultReasoningEffort", "supportsImages", "applyPatchToolType", "instructions", "modelMessages", "experimentalSupportedTools", "supportsSearchTool", "supportsWebSearch", "template", "description", "reasoningDescriptions", "supportsImageDetailOriginal", "supportsVerbosity", "defaultVerbosity", "supportsReasoningSummary", "defaultReasoningSummary", "effectiveContextWindowPercent", "autoCompactTokenLimit", "truncationPolicy", "sampling"].includes(key))) {
      throw new Error("自定义模型包含不受支持的字段");
    }
    const { id, name, contextWindow, maxContextWindow, reasoningEfforts, defaultReasoningEffort, supportsImages, applyPatchToolType, instructions: prompt, supportsSearchTool } = value;
    if (typeof id !== "string" || id.trim() !== id || id.length < 1 || id.length > 200 || /\p{Cc}/u.test(id) || seen.has(id)) {
      throw new Error("自定义模型 ID 无效或重复");
    }
    if (typeof name !== "string" || name.trim() === "" || name.length > 120 || /\p{Cc}/u.test(name)) throw new Error("自定义模型显示名称无效");
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024 || contextWindow > 100_000_000) throw new Error("模型上下文窗口必须为 1024-100000000 的整数");
    if (reasoningEfforts !== undefined && (!Array.isArray(reasoningEfforts) || reasoningEfforts.some((effort) => !efforts.has(effort) && !(allowReasoningToggle && effort === "enabled")) || new Set(reasoningEfforts).size !== reasoningEfforts.length)) throw new Error("模型思考等级无效或重复");
    if ((reasoningEfforts?.length ?? 0) === 0 ? defaultReasoningEffort !== null : !reasoningEfforts.includes(defaultReasoningEffort)) throw new Error("默认思考等级必须属于模型声明的等级；未知或不支持时必须为 null");
    if (supportsImages !== undefined && typeof supportsImages !== "boolean") throw new Error("模型图片能力必须为布尔值");
    if (applyPatchToolType !== undefined && applyPatchToolType !== null && applyPatchToolType !== "freeform") throw new Error("模型 apply_patch 工具类型无效");
    if (prompt !== undefined && (typeof prompt !== "string" || prompt.trim() === "" || prompt.length > 200_000 || !controlFree(prompt))) throw new Error("模型提示词无效");
    if (supportsSearchTool !== undefined && typeof supportsSearchTool !== "boolean") throw new Error("模型检索工具能力必须为布尔值");
    if (value.supportsWebSearch !== undefined && typeof value.supportsWebSearch !== "boolean") throw new Error("历史模型原生网页搜索元数据必须为布尔值，未知时省略字段");
    const { description, reasoningDescriptions, supportsImageDetailOriginal, supportsVerbosity, defaultVerbosity, supportsReasoningSummary, defaultReasoningSummary, effectiveContextWindowPercent, autoCompactTokenLimit, truncationPolicy } = value;
    if (description !== undefined && (typeof description !== "string" || description.trim() === "" || description.length > 4000 || !descriptionControlFree(description))) throw new Error("模型描述必须为非空、无非法控制字符且不超过 4000 字符的文本");
    if (reasoningDescriptions !== undefined && (!reasoningDescriptions || typeof reasoningDescriptions !== "object" || Array.isArray(reasoningDescriptions)
      || Object.entries(reasoningDescriptions).some(([effort, text]) => !reasoningEfforts?.includes(effort) || typeof text !== "string" || text.trim() === "" || text.length > 2000 || !descriptionControlFree(text)))) throw new Error("思考等级描述必须仅包含已声明等级，文本须非空、无非法控制字符且不超过 2000 字符");
    if (supportsImageDetailOriginal !== undefined && typeof supportsImageDetailOriginal !== "boolean") throw new Error("模型原图细节能力必须为布尔值");
    if (supportsImageDetailOriginal === true && !supportsImages) throw new Error("支持原图细节的模型必须支持图片输入");
    if (supportsVerbosity !== undefined && typeof supportsVerbosity !== "boolean") throw new Error("模型详细程度能力必须为布尔值");
    if (defaultVerbosity !== undefined && defaultVerbosity !== null && !verbosityLevels.has(defaultVerbosity)) throw new Error("默认详细程度必须为 low、medium、high 或 null");
    if (supportsVerbosity === true ? !verbosityLevels.has(defaultVerbosity) : defaultVerbosity != null) throw new Error("支持详细程度时必须指定有效默认值；未声明支持时默认值只能为 null 或省略");
    if (supportsReasoningSummary !== undefined && typeof supportsReasoningSummary !== "boolean") throw new Error("模型思考摘要能力必须为布尔值");
    if (defaultReasoningSummary !== undefined && !reasoningSummaries.has(defaultReasoningSummary)) throw new Error("默认思考摘要必须为 auto、concise、detailed 或 none");
    if (supportsReasoningSummary !== true && defaultReasoningSummary !== undefined && defaultReasoningSummary !== "none") throw new Error("未声明支持思考摘要时默认摘要只能为 none 或省略");
    if (effectiveContextWindowPercent !== undefined && (!Number.isSafeInteger(effectiveContextWindowPercent) || effectiveContextWindowPercent < 1 || effectiveContextWindowPercent > 100)) throw new Error("有效上下文百分比必须为 1-100 的整数");
    if (autoCompactTokenLimit !== undefined && (!Number.isSafeInteger(autoCompactTokenLimit) || autoCompactTokenLimit < 1 || autoCompactTokenLimit > Math.floor(contextWindow * 9 / 10))) throw Object.assign(new Error("自动压缩阈值必须为正整数且不能超过当前上下文窗口的 90%"), { code: "invalid-auto-compact-limit", field: "catalog" });
    if (truncationPolicy !== undefined && (!truncationPolicy || typeof truncationPolicy !== "object" || Array.isArray(truncationPolicy)
      || Object.keys(truncationPolicy).some(key => !["mode", "limit"].includes(key)) || !["tokens", "bytes"].includes(truncationPolicy.mode)
      || !Number.isSafeInteger(truncationPolicy.limit) || truncationPolicy.limit < 1)) throw new Error("截断策略必须使用 tokens 或 bytes，limit 必须为正安全整数");
    const template = value.template;
    if (template !== undefined && (!template || typeof template !== "object" || Array.isArray(template)
      || Object.keys(template).some(key => !["source", "model", "followContext"].includes(key)) || !["official", "deepseek"].includes(template.source)
      || typeof template.model !== "string" || template.model.trim() !== template.model || template.model.length < 1 || template.model.length > 200 || /\p{Cc}/u.test(template.model)
      || (template.followContext !== undefined && typeof template.followContext !== "boolean"))) {
      throw new Error("模型模板来源无效");
    }
    if (maxContextWindow !== undefined && (!Number.isSafeInteger(maxContextWindow) || maxContextWindow < contextWindow || maxContextWindow > 100_000_000)) throw new Error("模型最大上下文必须为不小于当前窗口且不超过 100000000 的整数");
    const sampling = validateSamplingParameters(value.sampling);
    const tools = value.experimentalSupportedTools;
    if (tools !== undefined && (!Array.isArray(tools) || tools.some(tool => typeof tool !== "string" || !tool.trim() || tool.trim() !== tool || /\p{Cc}/u.test(tool)) || new Set(tools).size !== tools.length)) {
      throw new Error("模型本地工具声明必须为不重复的非空工具名数组");
    }
    const modelMessages = value.modelMessages === undefined ? undefined : completeModelMessages(value.modelMessages, {});
    if (modelMessages !== undefined && new TextEncoder().encode(JSON.stringify(modelMessages)).length > 200_000) throw new Error("模型提示词对象超过大小限制");
    seen.add(id);
    return { id, name: name.trim(), contextWindow, ...(maxContextWindow === undefined ? {} : {maxContextWindow}), ...(reasoningEfforts === undefined ? {} : {reasoningEfforts: [...reasoningEfforts]}), defaultReasoningEffort, ...(supportsImages === undefined ? {} : {supportsImages}), ...(applyPatchToolType === undefined ? {} : {applyPatchToolType}), ...(prompt === undefined ? {} : {instructions: prompt}), ...(supportsSearchTool === undefined ? {} : {supportsSearchTool}), ...(template === undefined ? {} : {template: {source: template.source, model: template.model, ...(template.followContext === undefined ? {} : {followContext: template.followContext})}}),
      ...(description === undefined ? {} : {description}),
      ...(value.supportsWebSearch === undefined ? {} : {supportsWebSearch: value.supportsWebSearch}),
      ...(reasoningDescriptions === undefined ? {} : {reasoningDescriptions: Object.fromEntries(Object.entries(reasoningDescriptions))}),
      ...(supportsImageDetailOriginal === undefined ? {} : {supportsImageDetailOriginal}),
      ...(supportsVerbosity === undefined ? {} : {supportsVerbosity}),
      ...(defaultVerbosity === undefined ? {} : {defaultVerbosity}),
      ...(supportsReasoningSummary === undefined ? {} : {supportsReasoningSummary}),
      ...(defaultReasoningSummary === undefined ? {} : {defaultReasoningSummary}),
      ...(effectiveContextWindowPercent === undefined ? {} : {effectiveContextWindowPercent}),
      ...(autoCompactTokenLimit === undefined ? {} : {autoCompactTokenLimit}),
      ...(truncationPolicy === undefined ? {} : {truncationPolicy: {mode: truncationPolicy.mode, limit: truncationPolicy.limit}}),
      ...(sampling === undefined ? {} : {sampling}),
      ...(modelMessages === undefined ? {} : {modelMessages}),
      ...(tools === undefined ? {} : {experimentalSupportedTools: [...tools]}),
    };
  });
  if (!seen.has(defaultModel)) throw new Error("默认模型必须存在于自定义模型目录");
  return models;
}

/** CLP alone opts into its model-defined toggle; persisted Responses catalogs stay strict. */
export function compileModelDefinitions(definitions, defaultModel, { allowReasoningToggle = false } = {}) {
  const validated = validateModelDefinitions(definitions, defaultModel, { allowReasoningToggle });
  const catalog = {
    definitions: validated,
    models: validated.map((model, index) => ({
      slug: model.id, display_name: model.name, description: model.description ?? "User-configured Responses model",
      default_reasoning_level: model.defaultReasoningEffort,
      supported_reasoning_levels: (model.reasoningEfforts ?? []).map((effort) => ({ effort,
        description: model.reasoningDescriptions?.[effort] ?? (model.reasoningEfforts.includes("enabled") && effort === "none" ? "关闭思考"
          : effort === "enabled" ? "开启思考，使用模型默认强度" : effort) })),
      shell_type: "unified_exec", visibility: "list", supported_in_api: true,
      priority: model.id === defaultModel ? 0 : index + 1,
      availability_nux: null, upgrade: null,
      model_messages: { ...model.modelMessages, instructions_template: model.instructions ?? model.modelMessages?.instructions_template ?? instructions },
      include_apps_usage_instructions: false,
      supports_reasoning_summary_parameter: model.supportsReasoningSummary ?? false,
      ...(model.defaultReasoningSummary === undefined ? {} : {default_reasoning_summary: model.defaultReasoningSummary}),
      support_verbosity: model.supportsVerbosity ?? false, default_verbosity: model.defaultVerbosity ?? null, apply_patch_tool_type: model.applyPatchToolType ?? null,
      ...(model.supportsSearchTool === undefined ? {} : {supports_search_tool: model.supportsSearchTool}),
      // Preserve the v5 saved snapshot; search policy never reads this metadata.
      ...(model.supportsWebSearch === undefined ? {} : {supports_web_search: model.supportsWebSearch}),
      truncation_policy: model.truncationPolicy ?? { mode: "tokens", limit: Math.min(10_000, Math.floor(model.contextWindow / 4)) },
      context_window: model.contextWindow, max_context_window: model.maxContextWindow ?? model.contextWindow,
      ...(model.autoCompactTokenLimit === undefined ? {} : {auto_compact_token_limit: model.autoCompactTokenLimit}),
      effective_context_window_percent: model.effectiveContextWindowPercent ?? 95, experimental_supported_tools: [...(model.experimentalSupportedTools ?? [])],
      input_modalities: model.supportsImages ? ["text", "image"] : ["text"],
      ...(model.supportsImageDetailOriginal === undefined ? {} : {supports_image_detail_original: model.supportsImageDetailOriginal}),
      multi_agent_version: "v2",
    })),
  };
  return catalog;
}

export function modelDefinitionsFromCatalog(catalog, source = "official") {
  if (!["official", "deepseek"].includes(source)) throw new Error("模型模板来源无效");
  if (!Array.isArray(catalog?.models)) throw new Error("模型模板目录缺少 models");
  const normalized = source === "deepseek" ? normalizeDeepseekCatalogCapabilities(catalog) : catalog;
  const models = normalized.models.filter(model => model.visibility === "list" && model.supported_in_api === true).map(model => ({
    id: model.slug,
    name: model.display_name,
    ...(model.description == null ? {} : {description: model.description}),
    contextWindow: model.context_window,
    ...(model.max_context_window == null ? {} : {maxContextWindow: model.max_context_window}),
    reasoningEfforts: model.supported_reasoning_levels?.map(entry => entry.effort).filter(effort => effort !== "ultra" && effort !== "persistent"),
    ...(model.supported_reasoning_levels?.some(entry => entry.effort !== "ultra" && entry.effort !== "persistent" && entry.description != null)
      ? {reasoningDescriptions: Object.fromEntries(model.supported_reasoning_levels.filter(entry => entry.effort !== "ultra" && entry.effort !== "persistent" && entry.description != null).map(entry => [entry.effort, entry.description]))} : {}),
    defaultReasoningEffort: model.default_reasoning_level ?? null,
    ...(model.input_modalities === undefined ? {} : {supportsImages: model.input_modalities.includes("image")}),
    ...(model.apply_patch_tool_type === undefined ? {} : {applyPatchToolType: model.apply_patch_tool_type}),
    ...(model.supports_search_tool === undefined ? {} : {supportsSearchTool: model.supports_search_tool}),
    ...(model.supports_image_detail_original === undefined ? {} : {supportsImageDetailOriginal: model.supports_image_detail_original}),
    ...(model.support_verbosity === undefined ? {} : {supportsVerbosity: model.support_verbosity}),
    ...(model.default_verbosity === undefined ? {} : {defaultVerbosity: model.default_verbosity}),
    // ModelInfo serializes an omitted summary capability as its default true.
    ...(model.supports_reasoning_summary_parameter === undefined && model.default_reasoning_summary === undefined ? {} : {supportsReasoningSummary: model.supports_reasoning_summary_parameter === undefined ? true : model.supports_reasoning_summary_parameter}),
    ...(model.default_reasoning_summary === undefined ? {} : {defaultReasoningSummary: model.default_reasoning_summary}),
    ...(model.effective_context_window_percent === undefined ? {} : {effectiveContextWindowPercent: model.effective_context_window_percent}),
    ...(model.auto_compact_token_limit == null ? {} : {autoCompactTokenLimit: model.auto_compact_token_limit}),
    ...(model.truncation_policy === undefined ? {} : {truncationPolicy: model.truncation_policy}),
    ...(source === "deepseek" && typeof model.model_messages?.instructions_template === "string" && model.model_messages.instructions_template.length > 0 ? {instructions: model.model_messages.instructions_template} : {}),
    ...(model.model_messages == null ? {} : {modelMessages: model.model_messages}),
    ...(model.experimental_supported_tools === undefined ? {} : {experimentalSupportedTools: model.experimental_supported_tools}),
    template: {source, model: model.slug},
  }));
  return validateModelDefinitions(models, models[0]?.id);
}

// DS Responses accepts these controls but does not implement them. Keep the
// downloaded model/tool metadata intact while narrowing these two declarations.
export function normalizeDeepseekCatalogCapabilities(catalog) {
  if (!catalog || !Array.isArray(catalog.models)) throw new Error("DeepSeek 官方模型目录缺少 models");
  return {
    ...catalog,
    models: catalog.models.map((model) => {
      const result = { ...model,
        support_verbosity: false,
        default_verbosity: null,
        supports_reasoning_summary_parameter: false,
        default_reasoning_summary: "none",
      };
      // The locked Codex uses supports_reasoning_summary_parameter instead.
      delete result.supports_reasoning_summaries;
      return result;
    }),
  };
}
