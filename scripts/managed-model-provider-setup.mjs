import {
  createManagedProviderProfile,
  createModelProviderConfig,
} from "../runtime/model-provider-profile.mjs";

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

export function createSwitchingProviderProfile(definition, {
  apiKey,
  catalogPath,
  model,
}) {
  return createManagedProviderProfile(definition, {
    apiKey,
    catalogPath,
    ...(model === undefined ? {} : { model }),
  });
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
