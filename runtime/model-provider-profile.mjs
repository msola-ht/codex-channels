export function createManagedProviderProfile(definition, {
  apiKey,
  catalogPath,
  model = definition.defaultModel,
  reasoningEffort = definition.defaultReasoningEffort,
} = {}) {
  assertDefinition(definition);
  if (!definition.models.some((candidate) => candidate.available && candidate.slug === model)) {
    throw new Error(`模型不在 ${definition.displayName} 受控目录中：${String(model)}`);
  }
  if (typeof apiKey !== "string" || !/^sk-[^\s"]+$/u.test(apiKey) || apiKey.length > 4_096) {
    throw new Error(`${definition.displayName} API Key 无效`);
  }
  if (typeof catalogPath !== "string" || catalogPath.length === 0) {
    throw new Error(`${definition.displayName} 模型目录路径无效`);
  }
  if (typeof reasoningEffort !== "string" || reasoningEffort.length === 0) {
    throw new Error(`${definition.displayName} 默认思考等级无效`);
  }
  return {
    model,
    model_provider: definition.id,
    model_reasoning_effort: reasoningEffort,
    service_tier: "default",
    model_catalog_json: catalogPath,
    model_providers: {
      [definition.id]: createModelProviderConfig(definition, apiKey),
    },
  };
}

export function createModelProviderConfig(definition, apiKey) {
  assertDefinition(definition);
  return {
    name: definition.id,
    base_url: definition.baseUrl,
    wire_api: definition.wireApi,
    requires_openai_auth: false,
    ...(definition.supportsWebsockets === undefined
      ? {}
      : { supports_websockets: definition.supportsWebsockets }),
    experimental_bearer_token: apiKey,
  };
}

export function createCustomPrimaryProviderConfig({
  name,
  baseUrl,
  auth,
  envKey,
  bearerToken,
  supportsWebsockets,
}) {
  return {
    name,
    base_url: baseUrl,
    wire_api: "responses",
    requires_openai_auth: auth !== "none" && auth !== "bearer_token",
    supports_websockets: supportsWebsockets,
    ...(auth === "env_key" ? { env_key: envKey } : {}),
    ...(auth === "bearer_token" ? { experimental_bearer_token: bearerToken } : {}),
  };
}

export function modelProviderBlockEdits(id, provider) {
  return [
    { keyPath: `model_providers.${id}.name`, value: provider.name ?? id },
    { keyPath: `model_providers.${id}.base_url`, value: provider.base_url },
    { keyPath: `model_providers.${id}.wire_api`, value: provider.wire_api ?? "responses" },
    { keyPath: `model_providers.${id}.requires_openai_auth`, value: provider.requires_openai_auth === true },
    { keyPath: `model_providers.${id}.supports_websockets`, value: provider.supports_websockets === true },
    ...(typeof provider.env_key === "string"
      ? [{ keyPath: `model_providers.${id}.env_key`, value: provider.env_key }]
      : [{ keyPath: `model_providers.${id}.env_key`, value: null }]),
    ...(typeof provider.experimental_bearer_token === "string"
      ? [{
          keyPath: `model_providers.${id}.experimental_bearer_token`,
          value: provider.experimental_bearer_token,
        }]
      : [{ keyPath: `model_providers.${id}.experimental_bearer_token`, value: null }]),
  ];
}

export function createManagedProviderMarker(definition, mode = "switching") {
  assertDefinition(definition);
  if (mode !== "switching" && mode !== "exclusive") {
    throw new Error(`${definition.displayName} 管理模式无效`);
  }
  return { version: 1, provider: definition.id, mode };
}

function assertDefinition(definition) {
  if (
    !definition
    || typeof definition !== "object"
    || Array.isArray(definition)
    || typeof definition.id !== "string"
    || typeof definition.displayName !== "string"
    || typeof definition.profileFileName !== "string"
    || typeof definition.catalogFileName !== "string"
    || typeof definition.catalogManifestFileName !== "string"
    || typeof definition.managedMarkerFileName !== "string"
    || typeof definition.backupDirectoryName !== "string"
    || typeof definition.baseUrl !== "string"
    || typeof definition.wireApi !== "string"
    || typeof definition.apiKeyEnvironmentKey !== "string"
    || typeof definition.defaultModel !== "string"
    || typeof definition.defaultReasoningEffort !== "string"
    || !Array.isArray(definition.models)
  ) {
    throw new Error("模型 Provider 定义无效");
  }
}
