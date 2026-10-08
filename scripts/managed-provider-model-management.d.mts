import type { ModelProviderDefinition } from "../runtime/model-provider-definitions.mjs";
export interface ManagedEditableCatalog { models: Array<Record<string, unknown>>; [key: string]: unknown }
export type ManagedCatalogUpdateResult = { action: "back"; activation: "none" }
  | { action: "catalog-updated"; activation: "restart-all"; models: string[] };
export function updateManagedProviderModels(provider: "ccg" | "ocg", options: {
  environment?: NodeJS.ProcessEnv;
  editCatalog: (input: { catalog: ManagedEditableCatalog; requiredModels: string[]; definition: ModelProviderDefinition;
    previousModels: Parameters<typeof import("../runtime/model-provider-runtime.mjs").withPreservedManagedModelCatalogSettings>[2];
  }) => Promise<ManagedEditableCatalog | undefined>;
}): Promise<ManagedCatalogUpdateResult>;
export function runManagedProviderModelSetup(provider: "ccg" | "ocg", options?: {
  environment?: NodeJS.ProcessEnv;
  prompts?: {
    select(options: unknown): Promise<unknown>;
    text(options: unknown): Promise<unknown>;
    multiselect(options: unknown): Promise<unknown>;
    confirm(options: unknown): Promise<unknown>;
    isCancel(value: unknown): boolean;
  };
  output?: { write(value: string): unknown };
  downloadCatalog?: typeof import("./deepseek-setup.mjs").downloadDeepseekCatalog;
}): Promise<ManagedCatalogUpdateResult>;
