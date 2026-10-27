export interface ProviderModelCatalog {
  models: Array<Record<string, unknown>>;
}
export function createOllamaCloudCatalogWithTemplateBindings(source: ProviderModelCatalog, environment?: NodeJS.ProcessEnv): {
  catalog: ProviderModelCatalog;
  templateBindings: Record<string, import("../runtime/model-template-bindings.mjs").ModelTemplateBinding>;
};
export function createDeepseekTemplateCatalog(source: ProviderModelCatalog, family: "deepseek" | "ccg" | "opencode-go", environment?: NodeJS.ProcessEnv): ProviderModelCatalog;
export function createOpencodeGoCatalogWithTemplateBindings(source: ProviderModelCatalog, environment?: NodeJS.ProcessEnv): {
  catalog: ProviderModelCatalog;
  templateBindings: Record<string, import("../runtime/model-template-bindings.mjs").ModelTemplateBinding>;
};
export function createCcgCatalogWithTemplateBindings(source: ProviderModelCatalog, environment?: NodeJS.ProcessEnv): {
  catalog: ProviderModelCatalog;
  templateBindings: Record<string, import("../runtime/model-template-bindings.mjs").ModelTemplateBinding>;
};
export function createClinePassCatalogWithTemplateBindings(source: ProviderModelCatalog, environment?: NodeJS.ProcessEnv): {
  catalog: ProviderModelCatalog;
  templateBindings: Record<string, import("../runtime/model-template-bindings.mjs").ModelTemplateBinding>;
};
