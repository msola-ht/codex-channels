import { configActivationResult } from "./config-activation-result.mjs";
import {
  listApiProviders,
  validateApiProviderEndpoint,
  validateApiProviderId,
  validateApiProviderName,
} from "./api-provider-management.mjs";
import { apiProviderResourceStateFromList, projectProviderManagementState } from "./webui-management-providers.mjs";
import { managedSettingKinds } from "./webui-management-settings.mjs";

export class ManagementOperationError extends Error {
  constructor(code, message, field = undefined) {
    super(message);
    this.name = "ManagementOperationError";
    this.code = code;
    this.field = field;
  }
}

export function codexManagementError(error) {
  if (error instanceof ManagementOperationError) return error;
  const code = typeof error?.code === "string" ? error.code : "codex_settings_failed";
  return new ManagementOperationError(code, error instanceof Error ? error.message : "App Server 用户设置操作失败", error?.field);
}

export function normalizeApiProviderMutation(input, environment) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ManagementOperationError("invalid_json", "Provider 操作正文必须是对象");
  }
  if (input.operation === "delete") return { operation: "delete", id: input.id };
  const provider = input.provider ?? input;
  const requested = input.operation === "create" || input.operation === "update" ? input.operation : "save";
  const existing = listApiProviders(environment).providers.some(({ id }) => id === provider?.id);
  return {
    operation: "save",
    provider: {
      operation: requested === "save" ? (existing ? "update" : "create") : requested,
      id: provider?.id,
      name: provider?.name,
      endpoint: provider?.endpoint,
      ...(typeof provider?.apiKey === "string" ? { apiKey: provider.apiKey } : {}),
    },
  };
}

export function apiProviderResourceState(environment) {
  return apiProviderResourceStateFromList(listApiProviders(environment).providers);
}

export function previewApiProviderOperation(input, environment) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ManagementOperationError("invalid_json", "Provider 操作正文必须是对象");
  }
  if (input.operation === "delete") {
    const idError = validateApiProviderId(input.id);
    if (idError !== undefined) throw new ManagementOperationError("invalid_provider", idError);
    const current = listApiProviders(environment).providers.find((provider) => provider.id === input.id);
    if (current === undefined) throw new ManagementOperationError("provider_not_found", `找不到直接 API Provider：${input.id}`);
    return { operation: "delete", provider: { id: current.id, name: current.name }, activation: configActivationResult("restart-gateway") };
  }
  if (input.operation !== "save" && input.operation !== "create" && input.operation !== "update") {
    throw new ManagementOperationError("invalid_provider_operation", "Provider 操作必须是 create、update 或 delete");
  }
  const provider = input.provider ?? input;
  const idError = validateApiProviderId(provider?.id);
  const nameError = validateApiProviderName(provider?.name);
  const endpointError = validateApiProviderEndpoint(provider?.endpoint);
  if (idError !== undefined) throw new ManagementOperationError("invalid_provider", idError);
  if (nameError !== undefined) throw new ManagementOperationError("invalid_provider", nameError);
  if (endpointError !== undefined) throw new ManagementOperationError("invalid_provider", endpointError);
  const operation = input.operation === "save"
    ? (listApiProviders(environment).providers.some(({ id }) => id === provider.id) ? "update" : "create")
    : input.operation;
  return {
    operation,
    provider: {
      id: provider.id,
      name: provider.name,
      protocol: "responses",
      endpoint: provider.endpoint,
      apiKeyChange: typeof provider.apiKey === "string" && provider.apiKey.length > 0,
    },
    activation: configActivationResult("restart-gateway"),
  };
}

export function isHighRiskManagementPath(path) {
  return path.startsWith("/api-providers")
    || path.startsWith("/provider-settings")
    || path.startsWith("/tasks");
}

export function assertManagedSetting(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !managedSettingKinds.has(input.kind)) {
    throw new ManagementOperationError("setting_not_allowed", "该设置暂不支持 WebUI 修改");
  }
}

const PROVIDER_STATE_CACHE_TTL_MS = 5_000;

export function loadProviderManagementSummary(environment, cache, loadProviderState) {
  const now = Date.now();
  if (cache.value !== null && cache.expiresAtMs > now) return Promise.resolve(cache.value);
  if (cache.pending !== null) return cache.pending;
  cache.pending = loadProviderState({ environment })
    .then(projectProviderManagementState)
    .then((value) => {
      cache.value = value;
      cache.expiresAtMs = Date.now() + PROVIDER_STATE_CACHE_TTL_MS;
      return value;
    })
    .finally(() => {
      cache.pending = null;
    });
  return cache.pending;
}
