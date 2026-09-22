import type { ManagedAccountRuntimeOptions } from "./managed-provider-account-runtime.mjs";
type Options = { environment?: NodeJS.ProcessEnv };
type Catalog = { models: Array<Record<string, unknown>> };
export function deepseekAccountPaths(environment: NodeJS.ProcessEnv, accountId: string): {
  config: string; profile: string; marker: string; backup: string; registry: string; catalog: string; manifest: string; role: string;
};
export function hasLegacyDeepseekConfiguration(environment?: NodeJS.ProcessEnv): boolean;
export interface DeepseekAccountConfigurationInput {
  accountId: string;
  mode?: "switching" | "exclusive";
  reconfigure?: boolean;
  apiKey: string;
  confirmExclusiveConfigChange?: boolean;
}
export function previewDeepseekAccountConfiguration(input: Omit<DeepseekAccountConfigurationInput, "apiKey">, options?: Options): {
  operation: "add" | "reconfigure";
  account: { id: string; provider: string; exists: boolean; default: boolean };
  mode: "switching" | "exclusive";
  effects: { writesMainConfig: boolean; writesIsolatedProfile: boolean; downloadsCatalog: boolean };
  confirmation: { required: boolean; field: string };
  activation: "restart-all";
};
export function applyDeepseekAccountConfiguration(input: DeepseekAccountConfigurationInput, options?: Options & {
  downloadCatalog?: (fetchImpl: typeof fetch) => Promise<{ catalog: Catalog }>;
  fetchImpl?: typeof fetch;
}): Promise<ReturnType<typeof previewDeepseekAccountConfiguration> & { action: "configured"; model: string }>;
export function previewLegacyDeepseekRemoval(options?: ManagedAccountRuntimeOptions): Promise<{
  operation: "legacy-remove"; account: { provider: "deepseek" }; mode: "switching" | "exclusive";
  files: string[]; effects: { stopsRunningAppServer: boolean; restoresInitialConfig: boolean; preservesPrivateBackup: true }; activation: "restart-all";
}>;
export function removeLegacyDeepseekAccount(input?: { confirmRemove?: boolean }, options?: ManagedAccountRuntimeOptions): Promise<{
  action: "legacy-removed"; runtime: "stopped" | "not-running"; activation: "restart-all";
}>;
export function setDeepseekDefaultAccount(accountId: string, options?: Options): Promise<{ action: "default-set"; accountId: string; activation: "restart-all" }>;
export function previewDeepseekAccountRemoval(accountId: string, options?: ManagedAccountRuntimeOptions): Promise<{
  operation: "remove"; account: { id: string; provider: string };
  effects: { stopsRunningAppServer: boolean; historyThreadsBecomeUnavailable: true; preservesPrivateBackup: true; restoresInitialConfig: boolean };
  activation: "restart-all";
}>;
export function removeDeepseekAccount(input: { accountId: string; confirmRemove?: boolean }, options?: ManagedAccountRuntimeOptions): Promise<{ action: "removed"; accountId: string; runtime: "stopped" | "not-running"; activation: "restart-all" }>;
