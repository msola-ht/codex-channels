import type { ManagedAccountRuntimeOptions } from "./managed-provider-account-runtime.mjs";
export interface OllamaCloudDiscoveredModelChoice {
  id: string;
  name: string;
  contextWindow: number;
  upstreamContextWindow: number;
  reasoningEfforts: string[];
  defaultReasoningEffort: string;
  reasoningMode: "toggle" | "levels";
  supportsImages: boolean;
}
export interface OllamaCloudConfigurationInput {
  accountId: string;
  apiKey?: string;
  reconfigure?: boolean;
  mode?: "switching" | "exclusive";
  model?: string;
  discoveryToken?: string;
  confirmExclusiveConfigChange?: boolean;
  expectedRevision?: string;
}
export interface OllamaCloudConfigurationOptions {
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Internal submit-time recomputation; apply always performs fresh authentication. */
  authentication?: "verify" | "defer-to-apply";
}
export function ollamaCloudSetupPaths(environment: NodeJS.ProcessEnv, accountId: string): Record<"config" | "profile" | "marker" | "catalog" | "manifest" | "backup" | "registry", string>;
export function loadOllamaCloudModelChoices(environment?: NodeJS.ProcessEnv): { catalogExists: boolean; models: Array<{ id: string; name: string }> };
export function discoverOllamaCloudAccountModels(input: { accountId: string; apiKey: string; refresh?: true }, options?: OllamaCloudConfigurationOptions): Promise<{
  catalogExists: false;
  discoveryToken: string;
  revision: string;
  expiresAt: number;
  models: OllamaCloudDiscoveredModelChoice[];
  cache: { hit: boolean; fetchedAt: string; expiresAt: string };
  unavailableModels: Array<{ id: string; status: "unconfirmed" | "excluded"; reason: string; reasonCode: NonNullable<import("./provider-model-additions.mjs").OllamaCloudDiscoveryCandidate["reasonCode"]> }>;
}>;
export function authenticateOllamaCloudKey(apiKey: string, options?: OllamaCloudConfigurationOptions): Promise<void>;
export function previewOllamaCloudConfiguration(input: OllamaCloudConfigurationInput, options?: OllamaCloudConfigurationOptions): Promise<{ revision: string; operation: string; account: { id: string; provider: string; default: boolean }; model: string; initialModels?: OllamaCloudDiscoveredModelChoice[]; mode: "switching" | "exclusive"; previousMode?: "switching" | "exclusive"; credentialAction: "preserve" | "replace"; willChange: boolean; effects: { writesMainConfig: boolean; writesIsolatedProfile: boolean; writesInitialCatalog: boolean; readsAccountAuthentication: boolean }; activation: "none" | "restart-all" }>;
export function applyOllamaCloudConfiguration(input: OllamaCloudConfigurationInput, options?: OllamaCloudConfigurationOptions): Promise<Awaited<ReturnType<typeof previewOllamaCloudConfiguration>> & { action: string }>;
export function previewOllamaCloudRemoval(accountId: string, options?: ManagedAccountRuntimeOptions): Promise<{ revision: string; operation: string; account: { id: string; provider: string }; effects: { stopsRunningAppServer: boolean; historyThreadsBecomeUnavailable: true; preservesPrivateBackup: true; restoresInitialConfig: boolean }; activation: string }>;
export function removeOllamaCloudConfiguration(input: { accountId: string; confirmRemove?: boolean; expectedRevision?: string }, options?: ManagedAccountRuntimeOptions & { signal?: AbortSignal }): Promise<{ action: string; activation: string }>;
export function previewOllamaCloudDefaultAccount(accountId: string, options?: { environment?: NodeJS.ProcessEnv }): { revision: string; operation: string; account: { id: string; provider: string; default: boolean }; willChange: boolean; activation: "none" | "restart-all" };
export function setOllamaCloudDefaultAccount(accountId: string, options?: { environment?: NodeJS.ProcessEnv; expectedRevision?: string; signal?: AbortSignal }): Promise<ReturnType<typeof previewOllamaCloudDefaultAccount> & { action: string }>;
