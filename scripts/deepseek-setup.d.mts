export const deepseekSetupScriptUrl: string;
export { runDeepseekSetup } from "./deepseek-account-setup.mjs";
export { refreshDeepseekAccountsCatalog as refreshDeepseekCatalogForUpdate } from "./deepseek-account-management.mjs";
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
export function createManagedDeepseekCatalog(
  catalog: { models: Array<Record<string, unknown>> },
  previousModels?: Array<{
    model: string;
    reasoningEffort: string;
    windowPercent?: number;
  }>,
  windowPercent?: number | null,
): { models: Array<Record<string, unknown>> };
