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

export function createManagedProviderCatalog(catalog, definition, {
  previousModels = [],
  autoCompactPercent = 60,
  modelCompressionPercentByModel = {},
} = {}) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const defaultEntry = selectCatalogDefaultModel(models, definition);
  const contextWindow = defaultEntry.context_window;
  const defaultsApplied = withManagedModelCatalogSettings(catalog, definition, {
    model: defaultEntry.slug,
    reasoningEffort: definition.defaultReasoningEffort,
    ...(autoCompactPercent === null
      ? {}
      : { autoCompactLimit: Math.round(contextWindow * autoCompactPercent / 100) }),
  });
  const preserved = withPreservedManagedModelCatalogSettings(
    defaultsApplied,
    definition,
    previousModels,
  );
  return applyModelCompressionByModel(
    preserved,
    definition,
    modelCompressionPercentByModel,
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

function applyModelCompressionByModel(catalog, definition, percents) {
  let next = catalog;
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  for (const candidate of models) {
    const slug = candidate?.slug;
    const percent = typeof slug === "string" ? percents[slug] : undefined;
    if (percent === undefined) continue;
    if (!Number.isInteger(percent) || percent < 10 || percent > 90) {
      throw new Error(`${definition.displayName} 模型自动压缩百分比无效：${slug}`);
    }
    const contextWindow = candidate?.context_window;
    const reasoningEffort = candidate?.default_reasoning_level;
    if (
      !Number.isSafeInteger(contextWindow)
      || contextWindow <= 0
      || typeof reasoningEffort !== "string"
    ) {
      throw new Error(`${definition.displayName} 模型目录缺少压缩所需字段：${slug}`);
    }
    next = withManagedModelCatalogSettings(next, definition, {
      model: slug,
      reasoningEffort,
      autoCompactLimit: Math.round(contextWindow * percent / 100),
    });
  }
  return next;
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
