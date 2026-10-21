export interface ProviderModelCatalog {
  models: Array<Record<string, unknown>>;
}
export function createDeepseekTemplateCatalog(source: ProviderModelCatalog, family: "deepseek" | "ccg" | "opencode-go"): ProviderModelCatalog;
export function createOpencodeGoCatalogWithTemplateBindings(source: ProviderModelCatalog): {
  catalog: ProviderModelCatalog;
  templateBindings: Record<string, import("../runtime/model-template-bindings.mjs").ModelTemplateBinding>;
};
export function createCcgCatalogWithTemplateBindings(source: ProviderModelCatalog): {
  catalog: ProviderModelCatalog;
  templateBindings: Record<string, import("../runtime/model-template-bindings.mjs").ModelTemplateBinding>;
};
export function createClinePassCatalogWithTemplateBindings(source: ProviderModelCatalog): {
  catalog: ProviderModelCatalog;
  templateBindings: Record<string, import("../runtime/model-template-bindings.mjs").ModelTemplateBinding>;
};
