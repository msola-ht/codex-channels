import { isManagedProviderModelValid } from "./model-provider-definitions.mjs";

export function catalogSlugSet(catalog, definition) {
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
    windowPercent: Math.round(contextWindow * 100 / windowBase),
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
    const reasoningEffort = current.reasoningEfforts.some(
      ({ effort }) => effort === previous.reasoningEffort,
    )
      ? previous.reasoningEffort
      : current.reasoningEffort;
    const contextWindow = previous.windowPercent === undefined
      ? undefined
      : Math.round(current.maxContextWindow * previous.windowPercent / 100);
    next = withManagedModelCatalogSettings(next, definition, {
      model: previous.model,
      reasoningEffort,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    });
  }
  return next;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
