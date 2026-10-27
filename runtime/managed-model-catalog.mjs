import { isManagedProviderModelValid } from "./model-provider-definitions.mjs";

export function catalogSlugSet(catalog, definition) {
  if (definition.storageId === "ollama-cloud") {
    const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    if (!Array.isArray(catalog?.models) || !catalog.models.length || catalog.models.length > 64
      || new Set(catalog.models.map(model => model?.slug)).size !== catalog.models.length
      || catalog.models.some(model => !model || !Number.isSafeInteger(model.context_window) || model.context_window <= 0
        || model.max_context_window != null && (!Number.isSafeInteger(model.max_context_window) || model.max_context_window < model.context_window)
        || !Array.isArray(model.supported_reasoning_levels) || !model.supported_reasoning_levels.length
        || new Set(model.supported_reasoning_levels.map(level => level?.effort)).size !== model.supported_reasoning_levels.length
        || model.supported_reasoning_levels.some(level => !efforts.has(level?.effort) || typeof level.description !== "string")
        || !model.supported_reasoning_levels.some(level => level.effort === model.default_reasoning_level)
        || !Array.isArray(model.input_modalities) || !model.input_modalities.includes("text")
        || model.input_modalities.some(modality => !["text", "image"].includes(modality))
        || ![null, "freeform"].includes(model.apply_patch_tool_type) || typeof model.supports_search_tool !== "boolean"
        || model.supports_web_search !== undefined && model.supports_web_search !== false
        || model.web_search_tool_type !== undefined
        || model.experimental_supported_tools !== undefined && (!Array.isArray(model.experimental_supported_tools)
          || model.experimental_supported_tools.some(tool => typeof tool !== "string" || !tool.trim() || ["apply_patch", "tool_search", "web_search"].includes(tool))))) {
      throw new Error("Ollama Cloud 模型须明确声明有效窗口、文本、思考等级、freeform 与客户端工具搜索能力；原生网页搜索尚未开放");
    }
  }
  if (Array.isArray(catalog?.models)
    && catalog.models.some((entry) =>
      !isManagedProviderModelValid(definition, record(entry).slug))) {
    throw new Error(`Codex ${definition.displayName} 模型目录包含无效模型名`);
  }
  return new Set(
    Array.isArray(catalog?.models)
      ? catalog.models.flatMap((entry) => {
          const slug = record(entry).slug;
          return typeof slug === "string" ? [slug] : [];
        })
      : [],
  );
}

export function modelCatalogSetting(content, definition, model) {
  let catalog;
  try {
    catalog = JSON.parse(content);
  } catch {
    throw new Error(`Codex ${definition.displayName} 模型目录无法安全读取`);
  }
  if (definition.storageId === "ollama-cloud") catalogSlugSet(catalog, definition);
  const candidate = Array.isArray(catalog?.models)
    ? catalog.models.find((entry) => record(entry).slug === model)
    : undefined;
  const document = record(candidate);
  const contextWindow = document.context_window;
  const maxContextWindow = document.max_context_window;
  const compactThreshold = document.auto_compact_token_limit;
  const levels = Array.isArray(document.supported_reasoning_levels)
    ? document.supported_reasoning_levels
    : [];
  const reasoningEfforts = levels.flatMap((entry) => {
    const level = record(entry);
    return typeof level.effort === "string" && typeof level.description === "string"
      ? [{ effort: level.effort, description: level.description }]
      : [];
  });
  const reasoningEffort = document.default_reasoning_level;
  if (
    !Number.isSafeInteger(contextWindow)
    || contextWindow <= 0
    || reasoningEfforts.length === 0
    || typeof reasoningEffort !== "string"
    || !reasoningEfforts.some(({ effort }) => effort === reasoningEffort)
    || (maxContextWindow !== null && maxContextWindow !== undefined
      && (!Number.isSafeInteger(maxContextWindow) || maxContextWindow <= 0))
    || (compactThreshold !== null && compactThreshold !== undefined
      && (!Number.isSafeInteger(compactThreshold) || compactThreshold <= 0))
  ) {
    throw new Error(`Codex ${definition.displayName} 模型目录无效`);
  }
  const windowBase = maxContextWindow === null || maxContextWindow === undefined
    ? contextWindow
    : maxContextWindow;
  return {
    model,
    inputModalities: Array.isArray(document.input_modalities) ? document.input_modalities : [],
    displayName: typeof document.display_name === "string" ? document.display_name : model,
    contextWindow,
    maxContextWindow: windowBase,
    reasoningEffort,
    reasoningEfforts,
    windowPercent: contextWindow * 100 / windowBase,
  };
}

export function updateModelCatalogSettings(content, definition, settings) {
  let catalog;
  try {
    catalog = JSON.parse(content);
  } catch {
    throw new Error(`Codex ${definition.displayName} 模型目录无法安全读取`);
  }
  const models = Array.isArray(catalog?.models) ? [...catalog.models] : [];
  const index = models.findIndex((entry) => record(entry).slug === settings.model);
  if (index < 0) throw new Error(`Codex ${definition.displayName} 模型目录无效`);
  const current = modelCatalogSetting(content, definition, settings.model);
  if (!current.reasoningEfforts.some(({ effort }) => effort === settings.reasoningEffort)) {
    throw new Error(`${definition.displayName} 模型不支持思考等级：${settings.reasoningEffort}`);
  }
  if (
    settings.contextWindow !== undefined
    && (!Number.isSafeInteger(settings.contextWindow)
      || settings.contextWindow <= 0
      || settings.contextWindow > current.maxContextWindow)
  ) {
    throw new Error(`${definition.displayName} 模型上下文窗口无效`);
  }
  const entry = record(models[index]);
  if (settings.contextWindow !== undefined
    && entry.auto_compact_token_limit > Math.floor(settings.contextWindow * 9 / 10)) {
    throw new Error(`${definition.displayName} 模型自动压缩阈值不能超过当前上下文窗口的 90%；请先调整阈值`);
  }
  models[index] = {
    ...entry,
    default_reasoning_level: settings.reasoningEffort,
    // 只有明确请求窗口变更时才写 context_window；其余情况下目录条目保持原样。
    ...(settings.contextWindow === undefined
      ? {}
      : {
          context_window: settings.contextWindow,
          // 最大窗口是可选字段；首次修改时保存基准，避免后续按缩小后的窗口计算。
          max_context_window: current.maxContextWindow,
        }),
  };
  return `${JSON.stringify({ ...catalog, models }, null, 2)}\n`;
}

export function validateManagedModelSettings(definition, settings) {
  if (
    !settings
    || typeof settings.model !== "string"
    || typeof settings.reasoningEffort !== "string"
  ) {
    throw new Error(`${definition.displayName} 模型设置无效`);
  }
}

export function withManagedModelCatalogSettings(catalog, definition, settings) {
  validateManagedModelSettings(definition, settings);
  const content = JSON.stringify(catalog);
  return JSON.parse(updateModelCatalogSettings(content, definition, settings));
}

export function withPreservedManagedModelCatalogSettings(
  catalog,
  definition,
  previousModels = [],
) {
  const presentModels = catalogSlugSet(catalog, definition);
  let next = catalog;
  for (const previous of previousModels) {
    if (!presentModels.has(previous.model)) continue;
    const current = modelCatalogSetting(JSON.stringify(next), definition, previous.model);
    if (!current.reasoningEfforts.some(
      ({ effort }) => effort === previous.reasoningEffort,
    )) throw new Error(`${definition.displayName} 模型 ${previous.model} 的原思考等级 ${previous.reasoningEffort} 不受新目录支持；请先调整本地设置，未更新目录`);
    const contextWindow = previous.contextWindow;
    next = withManagedModelCatalogSettings(next, definition, {
      model: previous.model,
      reasoningEffort: previous.reasoningEffort,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    });
  }
  return next;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
