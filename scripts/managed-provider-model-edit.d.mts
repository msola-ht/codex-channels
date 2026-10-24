import type { ModelDefinition } from "../runtime/model-catalog.mjs";
import type { ClinePassRequestProfile } from "../runtime/chat-reasoning.mjs";
import type { ClineProviderOptions } from "../runtime/cline-provider-options.mjs";

export interface ManagedProviderModelEdit {
  provider: string;
  model: string;
  providers: string[];
  revision: string;
  definition: ModelDefinition;
  requestProfile: ClinePassRequestProfile;
  providerOptions: ClineProviderOptions;
}
export interface ManagedProviderModelEditInput {
  provider: string;
  model: string;
  revision: string;
  definition: ModelDefinition;
  providerOptions?: ClineProviderOptions;
}
export interface ManagedProviderModelRequestOptions {
  provider: string;
  model: string;
  providers: string[];
  revision: string;
  requestProfile: ClinePassRequestProfile;
  providerOptions: ClineProviderOptions;
}
export interface ManagedProviderModelRequestOptionsInput {
  provider: string;
  model: string;
  revision: string;
  providerOptions: ClineProviderOptions;
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
export interface ManagedProviderModelRequestOptionsPreview extends ManagedProviderModelEditPreview {
  requestProfile: ClinePassRequestProfile;
  providerOptions: ClineProviderOptions;
}
export function loadManagedProviderModelEdit(provider: string, model: string, options?: { environment?: NodeJS.ProcessEnv }): Promise<ManagedProviderModelEdit>;
export function loadManagedProviderModelRequestOptions(provider: string, model: string, options?: { environment?: NodeJS.ProcessEnv }): Promise<ManagedProviderModelRequestOptions>;
export function previewManagedProviderModelEdit(input: ManagedProviderModelEditInput, options?: { environment?: NodeJS.ProcessEnv }): Promise<ManagedProviderModelEditPreview>;
export function applyManagedProviderModelEdit(input: ManagedProviderModelEditInput, options: { environment?: NodeJS.ProcessEnv; preview: ManagedProviderModelEditPreview }): Promise<{ action: "updated" | "unchanged"; activation: "restart-app-server" | "none" }>;
export function previewManagedProviderModelRequestOptions(input: ManagedProviderModelRequestOptionsInput, options?: { environment?: NodeJS.ProcessEnv }): Promise<ManagedProviderModelRequestOptionsPreview>;
export function applyManagedProviderModelRequestOptions(input: ManagedProviderModelRequestOptionsInput, options: { environment?: NodeJS.ProcessEnv; preview: ManagedProviderModelEditPreview }): Promise<{ action: "updated" | "unchanged"; activation: "restart-app-server" | "none" }>;
