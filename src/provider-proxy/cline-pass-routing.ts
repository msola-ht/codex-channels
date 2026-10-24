import { resolveClinePassRequestProfile, type ClinePassRequestProfile } from "../../runtime/chat-reasoning.mjs";
import type { ClineProviderOptions } from "../../runtime/cline-provider-options.mjs";

/**
 * CLP-only outbound policy; never mutate the caller's request or fall back to
 * other providers. An explicit gateway.only value is respected. The DeepSeek
 * default applies only when the request does not already set it.
 */
export function pinClinePassRouting<T extends object>(request: T, profile?: ClinePassRequestProfile): T {
  const model = (request as Record<string, unknown>).model;
  if (resolveClinePassRequestProfile(typeof model === "string" ? model : "", profile) !== "deepseek-flash") return request;
  const current = (request as Record<string, unknown>).providerOptions;
  if (current !== undefined && !isPlainRecord(current)) return request;
  const options: Record<string, unknown> = current ?? {};
  const gateway = options.gateway;
  if (gateway === undefined) return { ...request, providerOptions: { ...options, gateway: { only: ["deepseek"] } } };
  if (!isPlainRecord(gateway)) return request;
  if (Object.hasOwn(gateway, "only")) return request;
  return { ...request, providerOptions: { ...options, gateway: { ...gateway, only: ["deepseek"] } } };
}

/**
 * Apply the model's saved providerOptions overlay. Plain objects merge
 * recursively; arrays, scalars and null replace the client value. A client
 * providerOptions container that is not an object is replaced by the overlay
 * rather than rejected here; the upstream owns field semantics.
 */
export function applyClinePassProviderOptions<T extends object>(request: T, options?: ClineProviderOptions): T {
  if (options === undefined || Object.keys(options).length === 0) return request;
  const value = (request as Record<string, unknown>).providerOptions;
  const current: Record<string, unknown> = isPlainRecord(value) ? value : {};
  return { ...request, providerOptions: mergeProviderOptions(current, options) };
}

function mergeProviderOptions(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = result[key];
    result[key] = isPlainRecord(current) && isPlainRecord(value)
      ? mergeProviderOptions(current, value)
      : cloneJson(value);
  }
  return result;
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isPlainRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJson(entry)]));
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
