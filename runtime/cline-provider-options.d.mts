export interface ClineProviderOptionsError extends Error {
  code?: "invalid_provider_options";
}
export type ClineProviderOptions = Record<string, unknown>;
export function validateClinePassProviderOptions(value: unknown): ClineProviderOptions | undefined;
