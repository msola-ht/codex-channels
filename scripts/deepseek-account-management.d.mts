import type { ManagedAccountRuntimeOptions } from "./managed-provider-account-runtime.mjs";
type Options = { environment?: NodeJS.ProcessEnv };
type Catalog = { models: Array<Record<string, unknown>> };
export function deepseekAccountPaths(environment: NodeJS.ProcessEnv, accountId: string): {
  config: string; profile: string; marker: string; backup: string; registry: string; catalog: string; manifest: string; role: string;
};
export interface DeepseekAccountConfigurationInput {
  accountId: string;
  mode?: "switching" | "exclusive";
  reconfigure?: boolean;
  apiKey: string;
  confirmExclusiveConfigChange?: boolean;
  expectedRevision?: string;
}
export function previewDeepseekAccountConfiguration(input: Omit<DeepseekAccountConfigurationInput, "apiKey">, options?: Options): {
  revision: string;
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
export function previewDeepseekDefaultAccount(accountId: string, options?: Options): {
  revision: string; operation: "default"; account: { id: string; provider: string; default: boolean };
  willChange: boolean; activation: "none" | "restart-all";
};
export function setDeepseekDefaultAccount(accountId: string, options?: Options & { expectedRevision?: string }): Promise<{ action: "default-set"; accountId: string; activation: "restart-all" } | { action: "unchanged"; accountId: string; activation: "none" }>;
export function previewDeepseekAccountRemoval(accountId: string, options?: ManagedAccountRuntimeOptions): Promise<{
  revision: string;
  operation: "remove"; account: { id: string; provider: string };
  effects: { stopsRunningAppServer: boolean; historyThreadsBecomeUnavailable: true; preservesPrivateBackup: true; restoresInitialConfig: boolean };
  activation: "restart-all";
}>;
export function removeDeepseekAccount(input: { accountId: string; confirmRemove?: boolean; expectedRevision?: string }, options?: ManagedAccountRuntimeOptions): Promise<{ action: "removed"; accountId: string; runtime: "stopped" | "not-running"; activation: "restart-all" }>;
