import type { ProviderWebSearchMode } from "../runtime/provider-web-search.mjs";
import type { ModelProviderManagementState } from "./model-provider-management.mjs";
export interface ProviderWebSearchChangeInput { provider: string; mode: ProviderWebSearchMode | null; resourceRevision: string }
export interface ProviderWebSearchChangePreview {
  operation: "provider.web-search";
  provider: string;
  before: { mode: ProviderWebSearchMode | null };
  mode: ProviderWebSearchMode | null;
  revision: string;
  willChange: boolean;
  activation: "restart-app-server";
}
export class ProviderWebSearchManagementError extends Error { code: string; field: string; constructor(code: string, field: string, message: string, options?: ErrorOptions) }
interface Options { environment?: NodeJS.ProcessEnv; loadProviderState?: (options: { environment: NodeJS.ProcessEnv }) => Promise<ModelProviderManagementState> }
export function previewProviderWebSearchChange(input: ProviderWebSearchChangeInput, options?: Options): Promise<ProviderWebSearchChangePreview>;
export function applyProviderWebSearchChange(input: ProviderWebSearchChangeInput, options: Options & { preview: ProviderWebSearchChangePreview }): Promise<ProviderWebSearchChangePreview & { action: "updated" | "unchanged" }>;
