export interface CcgCatalog {
  models: Array<Record<string, unknown>>;
}

export function ccgSetupPaths(environment?: NodeJS.ProcessEnv): {
  config: string; profile: string; marker: string;
  catalog: string; manifest: string; backup: string;
};
export function applyCcgConfiguration(input: {
  apiKey: string;
  catalog: CcgCatalog;
  model: string;
  mode?: "switching" | "exclusive";
  confirmExclusiveConfigChange?: boolean;
}, options?: {
  environment?: NodeJS.ProcessEnv;
}): Promise<{
  action: "configured";
  mode: "switching" | "exclusive";
  model: string;
  activation: "restart-all";
}>;
export function removeCcgConfiguration(input?: { confirmRemove?: boolean }, options?: {
  environment?: NodeJS.ProcessEnv;
}): Promise<{ action: "removed"; activation: "restart-all" }>;
export function runCcgSetup(options?: {
  environment?: NodeJS.ProcessEnv;
  output?: { write(value: string): unknown };
  prompts?: unknown;
  fetchImpl?: typeof fetch;
  downloadCatalog?: (fetchImpl: typeof fetch) => Promise<{ catalog: CcgCatalog }>;
}): Promise<unknown>;
export function refreshCcgCatalogForUpdate(environment?: NodeJS.ProcessEnv, options?: {
  fetchImpl?: typeof fetch;
  downloadCatalog?: () => Promise<{ catalog: CcgCatalog }>;
}): Promise<{ status: "not-configured" } | { status: "updated"; provider: "ccg" }>;
