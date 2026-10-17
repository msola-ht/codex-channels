export type ModelTemplateSection = "prompts" | "capabilities";
export interface ModelTemplateUpdateInput { provider: string; model: string; sections: ModelTemplateSection[] }
export interface ModelTemplateTarget { model: string; displayName: string; source: "official" | "deepseek"; sourceModel: string }
export interface ModelTemplateUpdatePreview extends ModelTemplateUpdateInput {
  source: "official" | "deepseek";
  sourceModel: string;
  revision: string;
  changes: Array<{ field: string; before: unknown; after: unknown }>;
  willChange: boolean;
  activation: string;
}
export function loadProviderModelTemplateTargets(provider: string, options?: { environment?: NodeJS.ProcessEnv }): Promise<ModelTemplateTarget[]>;
export function previewProviderModelTemplateUpdate(input: ModelTemplateUpdateInput, options?: { environment?: NodeJS.ProcessEnv }): Promise<ModelTemplateUpdatePreview>;
export function applyProviderModelTemplateUpdate(input: ModelTemplateUpdateInput, options: { environment?: NodeJS.ProcessEnv; preview: ModelTemplateUpdatePreview }): Promise<{ action: "updated" | "unchanged"; activation: string }>;
