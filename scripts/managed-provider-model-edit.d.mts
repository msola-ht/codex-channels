import type { ModelDefinition } from "../runtime/model-catalog.mjs";

export interface ManagedProviderModelEdit {
  provider: string;
  model: string;
  providers: string[];
  revision: string;
  definition: ModelDefinition;
}
export interface ManagedProviderModelEditInput {
  provider: string;
  model: string;
  revision: string;
  definition: ModelDefinition;
}
export type ManagedProviderModelEditField = { present: false } | { present: true; value: unknown };
export interface ManagedProviderModelEditPreview {
  provider: string;
  model: string;
  providers: string[];
  revision: string;
  changes: Array<{ field: string; before: ManagedProviderModelEditField; after: ManagedProviderModelEditField }>;
  willChange: boolean;
  activation: "restart-app-server" | "none";
}
export function loadManagedProviderModelEdit(provider: string, model: string, options?: { environment?: NodeJS.ProcessEnv }): Promise<ManagedProviderModelEdit>;
export function previewManagedProviderModelEdit(input: ManagedProviderModelEditInput, options?: { environment?: NodeJS.ProcessEnv }): Promise<ManagedProviderModelEditPreview>;
export function applyManagedProviderModelEdit(input: ManagedProviderModelEditInput, options: { environment?: NodeJS.ProcessEnv; preview: ManagedProviderModelEditPreview }): Promise<{ action: "updated" | "unchanged"; activation: "restart-app-server" | "none" }>;
