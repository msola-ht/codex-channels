export function clinePassSetupPaths(environment?: NodeJS.ProcessEnv): Record<"config" | "profile" | "marker" | "catalog" | "manifest" | "backup", string>;
export function createClinePassCatalog(contextWindow: number): { models: Array<Record<string, unknown>> };
export function applyClinePassConfiguration(input: { apiKey: string; contextWindow: number; mode?: "switching" | "exclusive"; confirmExclusiveConfigChange?: boolean }, options?: { environment?: NodeJS.ProcessEnv }): Promise<{ action: string; provider: string; mode: string; activation: string }>;
export function removeClinePassConfiguration(input?: { confirmRemove?: boolean }, options?: import("./managed-provider-account-runtime.mjs").ManagedAccountRuntimeOptions): Promise<{ action: string; activation: string }>;
export function runClinePassSetup(options?: { environment?: NodeJS.ProcessEnv; prompts?: unknown; output?: { write(value: string): unknown } }): Promise<unknown>;
