import { projectProviderManagementState } from "./webui-management-providers.mjs";
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

export function isHighRiskManagementPath(path) {
  return path.startsWith("/provider-settings")
    || path.startsWith("/account-settings")
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
  const generation = cache.generation ?? 0;
  let pending;
  pending = loadProviderState({ environment })
    .then(projectProviderManagementState)
    .then((value) => {
      if ((cache.generation ?? 0) === generation) {
        cache.value = value;
        cache.expiresAtMs = Date.now() + PROVIDER_STATE_CACHE_TTL_MS;
      }
      return value;
    })
    .finally(() => {
      if (cache.pending === pending) cache.pending = null;
    });
  cache.pending = pending;
  return pending;
}

export function invalidateProviderManagementSummary(cache) {
  cache.generation = (cache.generation ?? 0) + 1;
  cache.value = null;
  cache.expiresAtMs = 0;
  cache.pending = null;
}
