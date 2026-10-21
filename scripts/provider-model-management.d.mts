import type { OpenAiModelCatalogEntry } from "../runtime/model-catalog-presentation.mjs";
import type { OpenAiModelPrompts } from "./webui-official-model-catalog.mjs";
import type { ModelDefinition } from "../runtime/model-catalog.mjs";
export type ProviderModelRemovalBlockedReason = "removal-not-supported" | "last-model-protected"
  | "account-default-protected" | "catalog-default-protected" | "gateway-default-protected";
export interface ProviderModelCatalogModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  removalBlockedReason: ProviderModelRemovalBlockedReason | null;
}
export interface ProviderModelCatalog {
  provider: string;
  displayName: string;
  providers: string[];
  models: ProviderModelCatalogModel[];
  canRemove: boolean;
  unavailableReason?: string;
}
export interface ProviderModelCatalogPresentation extends Omit<ProviderModelCatalog, "models"> {
  source: "managed" | "custom" | "official-shared";
  revision: string;
  models: Array<ProviderModelCatalogModel & { presentation: OpenAiModelCatalogEntry }>;
}
export function loadProviderModelCatalogPresentations(options?: { environment?: NodeJS.ProcessEnv }): Promise<{ catalogs: ProviderModelCatalogPresentation[] }>;
export function loadProviderModelPrompts(input: unknown, options?: { environment?: NodeJS.ProcessEnv }): Promise<OpenAiModelPrompts & Pick<ModelDefinition, "template" | "sampling">>;

export interface ProviderModelContextInput { provider: string; model: string; contextWindow: number; revision: string }
export interface ProviderModelRenameInput { provider: string; model: string; displayName: string; revision: string }
export interface ProviderModelRenamePreview {
  operation: "model.rename";
  provider: string;
  model: { id: string; displayName: string };
  displayName: string;
  providers: string[];
  revision: string;
  willChange: boolean;
  activation: "restart-app-server" | "none";
}
export function previewProviderModelRename(input: ProviderModelRenameInput, options?: { environment?: NodeJS.ProcessEnv }): Promise<ProviderModelRenamePreview>;
export function applyProviderModelRename(input: ProviderModelRenameInput, options: { environment?: NodeJS.ProcessEnv; preview: ProviderModelRenamePreview }): Promise<ProviderModelRenamePreview & { action: "updated" | "unchanged" }>;
export interface ProviderModelContextPreview {
  operation: "model.context";
  provider: string;
  model: { id: string; displayName: string; contextWindow: number | null; maxContextWindow: number };
  contextWindow: number;
  providers: string[];
  revision: string;
  willChange: boolean;
  activation: "restart-app-server" | "none";
}
export function previewProviderModelContextChange(input: ProviderModelContextInput, options?: { environment?: NodeJS.ProcessEnv }): Promise<ProviderModelContextPreview>;
export function applyProviderModelContextChange(input: ProviderModelContextInput, options: {
  environment?: NodeJS.ProcessEnv;
  preview: ProviderModelContextPreview;
}): Promise<ProviderModelContextPreview & { action: "updated" | "unchanged" }>;

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
