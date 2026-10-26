import type { ModelDefinition } from "../runtime/model-catalog.mjs";
/** Managed catalogs do not persist custom sampling defaults or inferred bindings.
 * CLP accepts enabled reasoning but rejects original image detail and reasoning-summary controls.
 * OLC requires applyPatchToolType=null or freeform and supportsSearchTool=false; native web search is unavailable.
 * OLC discovery requires a separate explicitly confirmed per-model Responses verification before saving. */
export type ManagedManualModelDefinition = Omit<ModelDefinition, "sampling" | "template">
  | { id: string; name: string; inheritFrom: string };
export interface ProviderModelAdditionCandidate {
  model: string;
  displayName: string;
  fields: Record<string, unknown>;
  inheritedFrom?: string;
  ollamaVerification?: import("../runtime/model-template-bindings.mjs").OllamaCloudModelVerification;
  clineRequestProfile?: import("../runtime/chat-reasoning.mjs").ClinePassRequestProfile;
  clineProviderOptions?: import("../runtime/cline-provider-options.mjs").ClineProviderOptions;
  template?: { source: "deepseek" | "cline"; model: string };
}
export interface ProviderModelAdditionOptions {
  provider: string;
  sourceToken: string;
  revision: string;
  expiresAt: number;
  providers: string[];
  candidates: ProviderModelAdditionCandidate[];
  discovery?: OllamaCloudDiscoveryCandidate[];
}
export interface OllamaCloudDiscoveryCandidate {
  id: string;
  status: "candidate" | "unconfirmed" | "excluded";
  reason?: string;
  reasonCode?: "invalidId" | "missingTag" | "details" | "sourceChanged" | "capabilities" | "capabilityConflict" | "unsupported" | "context" | "thinking" | "defaultThinking";
  alreadySaved: boolean;
  proposedContextWindow?: number;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  imageCandidate?: boolean;
}
export interface ProviderModelAdditionVerificationInput {
  provider: string;
  sourceToken: string;
  revision: string;
  model: string;
  reasoningEfforts: string[];
  confirmPaid: true;
}
export interface ProviderModelAdditionVerificationResult {
  status: "verified" | "inconclusive";
  requests: number;
  reason?: string;
  options?: ProviderModelAdditionOptions;
  auditStatus?: "recorded" | "degraded";
}
export interface ProviderModelAdditionInput {
  provider: string;
  sourceToken: string;
  revision: string;
  models: string[];
}
export interface ProviderModelAdditionPreview {
  provider: string;
  providers: string[];
  additions: ProviderModelAdditionCandidate[];
  revision: string;
  willChange: boolean;
  activation: "restart-all" | "none";
}
export interface ProviderModelAdditionLoadOptions {
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  manualModel?: ManagedManualModelDefinition;
  downloadCatalog?: typeof import("./deepseek-setup.mjs").downloadDeepseekCatalog;
  fetchImpl?: typeof globalThis.fetch;
}
export function verifyProviderModelAddition(input: ProviderModelAdditionVerificationInput, options?: { environment?: NodeJS.ProcessEnv; signal?: AbortSignal; fetchImpl?: typeof globalThis.fetch }): Promise<ProviderModelAdditionVerificationResult>;
export function loadProviderModelAdditionOptions(provider: string, options?: ProviderModelAdditionLoadOptions): Promise<ProviderModelAdditionOptions>;
export function previewProviderModelAddition(input: ProviderModelAdditionInput, options?: { environment?: NodeJS.ProcessEnv }): Promise<ProviderModelAdditionPreview>;
export function applyProviderModelAddition(input: ProviderModelAdditionInput, options?: { environment?: NodeJS.ProcessEnv; preview?: ProviderModelAdditionPreview }): Promise<{ action: "unchanged" | "catalog-updated"; activation: "none" | "restart-all"; models: string[] }>;
