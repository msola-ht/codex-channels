import type { ResponsesModelDefinition } from "../runtime/model-provider-responses-catalog.mjs";
import type { ManagedAccountRuntimeOptions } from "./managed-provider-account-runtime.mjs";
export interface ClinePassConfigurationInput {
  accountId: string;
  apiKey?: string;
  reconfigure?: boolean;
  mode?: "switching" | "exclusive";
  confirmExclusiveConfigChange?: boolean;
  expectedRevision?: string;
}
export interface ClinePassConfigurationOptions {
  environment?: NodeJS.ProcessEnv;
  loadTemplates?: typeof import("./responses-model-templates.mjs").loadResponsesModelTemplates;
  selectModels?: (selection: {
    models: Array<{ id: string; name: string; reasoningEffort: string }>;
    enabledModels: string[];
    requiredModels: string[];
    retainedModels: string[];
  }) => Promise<string[] | undefined>;
}
export function clinePassSetupPaths(environment: NodeJS.ProcessEnv, accountId: string): Record<"config" | "profile" | "marker" | "catalog" | "manifest" | "backup" | "registry", string>;
export function createClinePassCatalog(templates: ResponsesModelDefinition[], enabledModels?: string[]): ReturnType<typeof import("./provider-model-catalog.mjs").createClinePassCatalogWithTemplateBindings>;
export function previewClinePassConfiguration(input: ClinePassConfigurationInput, options?: ClinePassConfigurationOptions): { revision: string; operation: string; account: { id: string; provider: string; default: boolean }; mode: "switching" | "exclusive"; previousMode?: "switching" | "exclusive"; credentialAction: "preserve" | "replace"; willChange: boolean; effects: { writesMainConfig: boolean; writesIsolatedProfile: boolean }; activation: "none" | "restart-all" };
export function applyClinePassConfiguration(input: ClinePassConfigurationInput, options?: ClinePassConfigurationOptions): Promise<ReturnType<typeof previewClinePassConfiguration> & { action: string; excludedModels: Array<{ model: string; reason: string }> }>;
export function previewClinePassRemoval(accountId: string, options?: ManagedAccountRuntimeOptions): Promise<{ revision: string; operation: string; account: { id: string; provider: string }; effects: { stopsRunningAppServer: boolean; historyThreadsBecomeUnavailable: true; preservesPrivateBackup: true; restoresInitialConfig: boolean }; activation: string }>;
export function removeClinePassConfiguration(input: { accountId: string; confirmRemove?: boolean; expectedRevision?: string }, options?: ManagedAccountRuntimeOptions): Promise<{ action: string; activation: string }>;
export function previewClinePassDefaultAccount(accountId: string, options?: { environment?: NodeJS.ProcessEnv }): { revision: string; operation: string; account: { id: string; provider: string; default: boolean }; willChange: boolean; activation: "none" | "restart-all" };
export function setClinePassDefaultAccount(accountId: string, options?: { environment?: NodeJS.ProcessEnv; expectedRevision?: string }): Promise<ReturnType<typeof previewClinePassDefaultAccount> & { action: string }>;
