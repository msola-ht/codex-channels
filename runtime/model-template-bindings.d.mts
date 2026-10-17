export interface ModelTemplateBinding {
  source: "official" | "deepseek" | "cline";
  model: string;
}
export function readModelTemplateBindings(manifest: unknown, modelIds: string[]): Record<string, ModelTemplateBinding>;
