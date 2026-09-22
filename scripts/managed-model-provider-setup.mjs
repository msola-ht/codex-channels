import {
  createManagedProviderProfile,
  createModelProviderConfig,
} from "../runtime/model-provider-profile.mjs";
import {
  withManagedModelCatalogSettings,
  withPreservedManagedModelCatalogSettings,
} from "../runtime/model-provider-runtime.mjs";

const managedRootKeys = Object.freeze([
  "model",
  "model_provider",
  "model_reasoning_effort",
  "model_catalog_json",
  "model_context_window",
  "model_auto_compact_token_limit",
  "model_auto_compact_token_limit_scope",
  "profile",
  "preferred_auth_method",
  "forced_login_method",
]);

export class ManagedModelProviderSetupError extends Error {
  constructor(code, field, message, options) {
    super(message, options);
    this.name = "ManagedModelProviderSetupError";
    this.code = code;
    this.field = field;
  }
}

export function createManagedProviderRestorePreview(definition, {
  removesManagedAccounts = false,
} = {}) {
  return {
    operation: "restore",
    provider: { id: definition.id, name: definition.displayName },
    effects: {
      restoresInitialConfig: true,
      removesManagedCatalog: true,
      restoresExternalAgentConfig: true,
      removesManagedAccounts,
    },
    confirmation: { required: true, field: "confirmRestore" },
    activation: "restart-all",
  };
}

export function createSwitchingProviderProfile(definition, {
  apiKey,
  catalogPath,
  model,
  reasoningEffort,
}) {
  return createManagedProviderProfile(definition, {
    apiKey,
    catalogPath,
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  });
}

export function createManagedProviderConfiguration(current, initial, definition, {
  mode,
  previousMode,
  apiKey,
  catalogPath,
  catalog,
  model,
}) {
  if (mode === "exclusive") {
    return {
      config: applyExclusiveProviderConfig(current, definition, { apiKey, catalogPath, model }),
      profile: undefined,
    };
  }
  const config = previousMode === "exclusive"
    ? restoreProviderBaseConfig(current, initial, definition)
    : current;
  if (hasProviderBaseConfig(config, definition)) {
    throw new Error(
      `安装前的 Codex config.toml 已占用 ${definition.id} Provider 或 Profile；请先手工移除或改名`,
    );
  }
  const reasoningEffort = catalog.models.find((entry) => entry.slug === model)
    ?.default_reasoning_level;
  if (typeof reasoningEffort !== "string") {
    throw new Error(`${definition.displayName} 模型目录缺少默认思考等级`);
  }
  return {
    config,
    profile: createSwitchingProviderProfile(definition, {
      apiKey, catalogPath, model, reasoningEffort,
    }),
  };
}

export function createManagedProviderCatalog(catalog, definition, {
  previousModels = [],
  windowPercent = null,
  modelWindowPercentByModel = {},
} = {}) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const defaultEntry = selectCatalogDefaultModel(models, definition);
  const defaultsApplied = withManagedModelCatalogSettings(catalog, definition, {
    model: defaultEntry.slug,
    reasoningEffort: definition.defaultReasoningEffort,
  });
  const preserved = withPreservedManagedModelCatalogSettings(
    defaultsApplied,
    definition,
    previousModels,
  );
  return applyModelWindowByModel(
    preserved,
    definition,
    {
      ...modelWindowPercentByModel,
      ...(windowPercent === null ? {} : { [defaultEntry.slug]: windowPercent }),
    },
  );
}

function selectCatalogDefaultModel(models, definition) {
  const candidates = models.filter((model) =>
    typeof model?.slug === "string"
    && Number.isSafeInteger(model.context_window)
    && model.context_window > 0);
  const selected = candidates.find((model) => model.slug === definition.defaultModel)
    ?? candidates[0];
  if (!selected) {
    throw new Error(`${definition.displayName} 模型目录缺少可用模型`);
  }
  return selected;
}

export function resolveManagedCatalogModel(catalog, definition, preferred) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  if (typeof preferred === "string"
    && models.some((model) => model?.slug === preferred)) {
    return preferred;
  }
  return selectCatalogDefaultModel(models, definition).slug;
}

function applyModelWindowByModel(catalog, definition, percents) {
  let next = catalog;
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  for (const candidate of models) {
    const slug = candidate?.slug;
    const percent = typeof slug === "string" ? percents[slug] : undefined;
    if (percent === undefined) continue;
    if (!Number.isInteger(percent) || percent < 10 || percent > 100) {
      throw new Error(`${definition.displayName} 模型上下文窗口百分比无效：${slug}`);
    }
    const windowBase = managedCatalogWindowBase(candidate);
    const reasoningEffort = candidate?.default_reasoning_level;
    if (
      !Number.isSafeInteger(windowBase)
      || windowBase <= 0
      || typeof reasoningEffort !== "string"
    ) {
      throw new Error(`${definition.displayName} 模型目录缺少窗口所需字段：${slug}`);
    }
    next = withManagedModelCatalogSettings(next, definition, {
      model: slug,
      reasoningEffort,
      contextWindow: Math.round(windowBase * percent / 100),
    });
  }
  return next;
}

function managedCatalogWindowBase(entry) {
  const maxContextWindow = record(entry).max_context_window;
  return Number.isSafeInteger(maxContextWindow) && maxContextWindow > 0
    ? maxContextWindow
    : record(entry).context_window;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function applyExclusiveProviderConfig(current, definition, {
  apiKey,
  catalogPath,
  model = definition.defaultModel,
}) {
  const document = { ...current };
  const modelProviders = { ...table(document.model_providers) };
  modelProviders[definition.id] = createModelProviderConfig(definition, apiKey);
  document.model_providers = modelProviders;
  if (document.profile === definition.id) delete document.profile;
  const profiles = { ...table(document.profiles) };
  delete profiles[definition.id];
  if (Object.keys(profiles).length === 0) {
    delete document.profiles;
  } else {
    document.profiles = profiles;
  }
  Object.assign(document, {
    model,
    model_provider: definition.id,
    model_catalog_json: catalogPath,
  });
  delete document.model_reasoning_effort;
  delete document.model_context_window;
  delete document.model_auto_compact_token_limit;
  delete document.model_auto_compact_token_limit_scope;
  delete document.preferred_auth_method;
  delete document.forced_login_method;
  return document;
}

export function restoreProviderBaseConfig(current, initial, definition) {
  const restored = { ...current };
  for (const key of managedRootKeys) restoreProperty(restored, initial, key);
  restoreTableEntry(restored, initial, "model_providers", definition.id);
  restoreTableEntry(restored, initial, "profiles", definition.id);
  return restored;
}

export function hasProviderBaseConfig(document, definition) {
  return document.profile === definition.id
    || table(document.profiles)[definition.id] !== undefined
    || table(document.model_providers)[definition.id] !== undefined;
}

function restoreProperty(target, source, key) {
  if (Object.hasOwn(source, key)) {
    target[key] = source[key];
  } else {
    delete target[key];
  }
}

function restoreTableEntry(target, source, tableName, key) {
  const targetTable = { ...table(target[tableName]) };
  const sourceTable = table(source[tableName]);
  if (Object.hasOwn(sourceTable, key)) {
    targetTable[key] = sourceTable[key];
  } else {
    delete targetTable[key];
  }
  if (Object.keys(targetTable).length === 0) {
    delete target[tableName];
  } else {
    target[tableName] = targetTable;
  }
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
