import type { ProviderModelAdditionLoadOptions } from "./provider-model-additions.mjs";
export type ManagedCatalogUpdateResult = { action: "back"; activation: "none" }
  | { action: "unchanged" | "catalog-updated"; activation: "none" | "restart-all"; models: string[] };
export interface ManagedProviderModelSetupOptions extends ProviderModelAdditionLoadOptions {
  prompts?: {
    select(options: unknown): Promise<unknown>;
    text(options: unknown): Promise<unknown>;
    multiselect(options: unknown): Promise<unknown>;
    confirm(options: unknown): Promise<unknown>;
    isCancel(value: unknown): boolean;
  };
  output?: { write(value: string): unknown };
}
export function runManagedProviderModelSetup(provider: string, options?: ManagedProviderModelSetupOptions): Promise<ManagedCatalogUpdateResult>;
export function runProviderModelAdditionSetup(provider: string, options?: ManagedProviderModelSetupOptions): Promise<ManagedCatalogUpdateResult>;
