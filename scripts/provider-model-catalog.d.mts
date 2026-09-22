export interface ProviderModelCatalog {
  models: Array<Record<string, unknown>>;
}
export function createOpencodeGoCatalog(source: ProviderModelCatalog): ProviderModelCatalog;
export function createCcgCatalog(source: ProviderModelCatalog): ProviderModelCatalog;
