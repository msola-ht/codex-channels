import { managedModelProviderDefinitions } from "./model-provider-definitions.mjs";

export function createManagedProviderProfile(definition, {
  apiKey,
  catalogPath,
  model = definition.defaultModel,
  reasoningEffort = definition.defaultReasoningEffort,
  autoCompactLimit,
  autoCompactScope = "total",
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
  return {
    model,
    model_provider: definition.id,
    model_reasoning_effort: reasoningEffort,
    service_tier: "default",
    model_catalog_json: catalogPath,
    ...(autoCompactLimit === undefined
      ? {}
      : {
          model_auto_compact_token_limit: autoCompactLimit,
          model_auto_compact_token_limit_scope: autoCompactScope,
        }),
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

export function createManagedProviderMarker(definition, mode = "switching") {
  assertDefinition(definition);
  if (mode !== "switching" && mode !== "exclusive") {
    throw new Error(`${definition.displayName} 管理模式无效`);
  }
  return { version: 1, provider: definition.id, mode };
}

function assertDefinition(definition) {
  if (!managedModelProviderDefinitions.includes(definition)) {
    throw new Error("模型 Provider 不在编译期注册表中");
  }
}
