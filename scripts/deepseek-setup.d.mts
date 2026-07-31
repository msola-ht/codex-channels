export const deepseekSetupScriptUrl: string;

export interface DeepseekSetupResult {
  mode: "switching" | "exclusive" | "restored";
  configPath: string;
  catalogPath: string;
  backupPath: string;
}

export function runDeepseekSetup(options?: Record<string, unknown>): Promise<DeepseekSetupResult | undefined>;
export function extractDeepseekCatalog(script: string): { models: Array<Record<string, unknown>> };
