export interface ModelTemplateBinding {
  source: "official" | "deepseek" | "cline";
  model: string;
}
export function readModelTemplateBindings(manifest: unknown, modelIds: string[]): Record<string, ModelTemplateBinding>;
export function validateClinePassCatalogManifest(manifest: unknown, modelIds: string[], defaultModel: string): Record<string, ModelTemplateBinding>;
