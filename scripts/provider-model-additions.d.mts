import type { ModelDefinition } from "../runtime/model-catalog.mjs";
export interface ProviderModelAdditionCandidate {
  model: string;
  displayName: string;
  fields: Record<string, unknown>;
  template?: { source: "deepseek" | "cline"; model: string };
}
export interface ProviderModelAdditionOptions {
  provider: string;
  sourceToken: string;
  revision: string;
  expiresAt: number;
  providers: string[];
  candidates: ProviderModelAdditionCandidate[];
}
export interface ProviderModelAdditionInput {
  provider: string;
  sourceToken: string;
  revision: string;
  models: string[];
}
export interface ProviderModelAdditionPreview {
  provider: string;
  providers: string[];
  additions: ProviderModelAdditionCandidate[];
  revision: string;
  willChange: boolean;
  activation: "restart-all" | "none";
}
export interface ProviderModelAdditionLoadOptions {
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  manualModel?: ModelDefinition;
  downloadCatalog?: typeof import("./deepseek-setup.mjs").downloadDeepseekCatalog;
  downloadClineCatalog?: typeof import("../runtime/cline-relay-catalog-update.mjs").downloadClineRelayCatalog;
  loadTemplates?: typeof import("./responses-model-templates.mjs").loadResponsesModelTemplates;
}
export function loadProviderModelAdditionOptions(provider: string, options?: ProviderModelAdditionLoadOptions): Promise<ProviderModelAdditionOptions>;
export function previewProviderModelAddition(input: ProviderModelAdditionInput, options?: { environment?: NodeJS.ProcessEnv }): Promise<ProviderModelAdditionPreview>;
export function applyProviderModelAddition(input: ProviderModelAdditionInput, options?: { environment?: NodeJS.ProcessEnv; preview?: ProviderModelAdditionPreview }): Promise<{ action: "unchanged" | "catalog-updated"; activation: "none" | "restart-all"; models: string[] }>;
