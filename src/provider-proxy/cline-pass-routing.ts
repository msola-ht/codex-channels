import type { ClineProviderOptions } from "../../runtime/cline-provider-options.mjs";

/**
 * Apply the model's saved providerOptions overlay. Plain objects merge
 * recursively; arrays, scalars and null replace the client value. A client
 * providerOptions container that is not an object is replaced by the overlay
 * rather than rejected here; the upstream owns field semantics. No overlay
 * means the request is unchanged; no automatic routing is applied.
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
