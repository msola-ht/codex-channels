export type ProviderWebSearchMode = "disabled" | "cached" | "indexed" | "live";
export interface ProviderWebSearchSettingsDocument { version: 1; providers: Record<string, ProviderWebSearchMode> }
export class ProviderWebSearchSettingsError extends Error {
  code: "unreadable" | "invalid-document" | "invalid-mode";
  constructor(code: ProviderWebSearchSettingsError["code"], message: string, options?: ErrorOptions);
}
export function providerWebSearchSettingsPath(environment?: NodeJS.ProcessEnv): string;
export function isProviderWebSearchId(provider: unknown): provider is string;
export function decodeProviderWebSearchSettings(content: string | undefined): ProviderWebSearchSettingsDocument;
export function readProviderWebSearchOverride(provider: string, environment?: NodeJS.ProcessEnv): ProviderWebSearchMode | null;
export function readProviderWebSearchFingerprint(provider: string, environment?: NodeJS.ProcessEnv): string;
export function providerWebSearchArguments(provider: string, environment?: NodeJS.ProcessEnv): string[];
