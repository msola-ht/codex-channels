export type ProviderWebSearchMode = "disabled" | "cached" | "indexed" | "live";
export interface ProviderWebSearchConfigTarget { path: string; source: "provider" | "global" }
export class ProviderWebSearchSettingsError extends Error {
  code: "unreadable" | "invalid-document" | "invalid-mode";
  constructor(code: ProviderWebSearchSettingsError["code"], message: string, options?: ErrorOptions);
}
export function isProviderWebSearchId(provider: unknown): provider is string;
export function resolveProviderWebSearchConfig(provider: string, environment?: NodeJS.ProcessEnv): ProviderWebSearchConfigTarget;
export function readProviderWebSearchConfig(provider: string, environment?: NodeJS.ProcessEnv): ProviderWebSearchConfigTarget & { mode: ProviderWebSearchMode | null };
/** Effective instance override, including an unset provider's explicit safe default. */
export function readProviderWebSearchOverride(provider: string, environment?: NodeJS.ProcessEnv): ProviderWebSearchMode | null;
export function readProviderWebSearchFingerprint(provider: string, environment?: NodeJS.ProcessEnv): string;
