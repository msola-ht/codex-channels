export interface CcgCatalog {
  models: Array<Record<string, unknown>>;
}

export function readCcgCatalog(path: string): Promise<CcgCatalog>;
export function ccgSetupPaths(environment?: NodeJS.ProcessEnv): {
  config: string; profile: string; marker: string;
  catalog: string; manifest: string; backup: string;
};
export function applyCcgConfiguration(input: {
  apiKey: string;
  catalogPath: string;
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
}): Promise<unknown>;
