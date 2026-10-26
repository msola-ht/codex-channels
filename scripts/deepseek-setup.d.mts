export const deepseekSetupScriptUrl: string;
export function downloadDeepseekCatalog(
  fetchImplementation: typeof fetch,
  options?: {
    attempts?: number;
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<{
  catalog: { models: Array<Record<string, unknown>> };
  sha256: string;
}>;
export function extractDeepseekCatalog(script: string): { models: Array<Record<string, unknown>> };
export function createManagedDeepseekCatalog(
  catalog: { models: Array<Record<string, unknown>> },
  previousModels?: Array<{
    model: string;
    reasoningEffort: string;
    windowPercent?: number;
  }>,
  windowPercent?: number | null,
  environment?: NodeJS.ProcessEnv,
): { models: Array<Record<string, unknown>> };
