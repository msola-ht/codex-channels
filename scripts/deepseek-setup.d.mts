export const deepseekSetupScriptUrl: string;

export interface DeepseekSetupResult {
  mode: "switching" | "exclusive" | "restored";
  configPath: string;
  profilePath: string;
  gatewayProfilePath: string;
  catalogPath: string;
  backupPath: string;
}

export interface DeepseekSetupBackResult {
  action: "back";
  mode?: never;
}

export interface DeepseekSetupAutoCompactResult {
  action: "auto-compact";
  autoCompactPercent: number | undefined;
  mode?: never;
}

export function runDeepseekSetup(options?: Record<string, unknown>): Promise<
  | DeepseekSetupResult
  | DeepseekSetupBackResult
  | DeepseekSetupAutoCompactResult
  | undefined
>;
export function downloadDeepseekCatalog(
  fetchImplementation: typeof fetch,
  options?: {
    attempts?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    timeoutMs?: number;
  },
): Promise<{
  catalog: { models: Array<Record<string, unknown>> };
  sha256: string;
}>;
export function extractDeepseekCatalog(script: string): { models: Array<Record<string, unknown>> };
