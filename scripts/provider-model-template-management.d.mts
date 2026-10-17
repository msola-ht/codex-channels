export type ModelTemplateSection = "prompts" | "capabilities";
export type ModelTemplateSource = "official" | "deepseek" | "cline";
export interface ModelTemplateReference { source: ModelTemplateSource; model: string }
export interface ModelTemplateUpdateInput {
  provider: string;
  model: string;
  sections: ModelTemplateSection[];
  revision: string;
  sourceToken: string;
  template: ModelTemplateReference;
}
export interface ModelTemplateTarget { model: string; displayName: string; template: ModelTemplateReference | null }
export interface ModelTemplateOption extends ModelTemplateReference { displayName: string }
export interface ModelTemplateOptions {
  provider: string;
  revision: string;
  sourceToken: string;
  /** Unix epoch milliseconds; process exit or cache eviction can also expire a snapshot. */
  expiresAt: number;
  targets: ModelTemplateTarget[];
  templates: ModelTemplateOption[];
}
export type ModelTemplateFieldValue = { present: false } | { present: true; value: unknown };
export interface ModelTemplateUpdatePreview {
  provider: string;
  model: string;
  source: ModelTemplateSource;
  sourceModel: string;
  sections: ModelTemplateSection[];
  revision: string;
  changes: Array<{ field: string; before: ModelTemplateFieldValue; after: ModelTemplateFieldValue }>;
  willChange: boolean;
  activation: string;
}
export function loadProviderModelTemplateOptions(provider: string, options?: { environment?: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<ModelTemplateOptions>;
export function previewProviderModelTemplateUpdate(input: ModelTemplateUpdateInput, options?: { environment?: NodeJS.ProcessEnv }): Promise<ModelTemplateUpdatePreview>;
export function applyProviderModelTemplateUpdate(input: ModelTemplateUpdateInput, options: { environment?: NodeJS.ProcessEnv; preview: ModelTemplateUpdatePreview }): Promise<{ action: "updated" | "unchanged"; activation: string }>;
