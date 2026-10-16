export interface ProviderModelCatalog {
  provider: string;
  displayName: string;
  providers: string[];
  models: Array<{ id: string; displayName: string; isDefault: boolean }>;
  canRemove: boolean;
  unavailableReason?: string;
}

export interface ProviderModelRemovalInput { provider: string; model: string }
export interface ProviderModelRemovalPreview {
  operation: "model.remove";
  provider: { id: string; displayName: string };
  model: { id: string; displayName: string };
  providers: string[];
  revision: string;
  warnings: Array<{ code: "shared-relay-grants-retained" | "clp-relay-independent" | "historical-references" | "provider-relay-inflight" }>;
  activation: "restart-all";
}
export class ProviderModelManagementError extends Error {
  readonly code: string;
  readonly field: string;
  constructor(code: string, field: string, message: string, options?: ErrorOptions);
}
export function loadProviderModelCatalogs(options?: { environment?: NodeJS.ProcessEnv }): Promise<{ catalogs: ProviderModelCatalog[] }>;
export function previewProviderModelRemoval(input: ProviderModelRemovalInput, options?: { environment?: NodeJS.ProcessEnv }): Promise<ProviderModelRemovalPreview>;
export function applyProviderModelRemoval(input: ProviderModelRemovalInput, options: {
  environment?: NodeJS.ProcessEnv;
  preview: ProviderModelRemovalPreview;
}): Promise<ProviderModelRemovalPreview & { action: "model-removed" }>;
