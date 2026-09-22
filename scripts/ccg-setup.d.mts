import type { ManagedAccountRuntimeOptions } from "./managed-provider-account-runtime.mjs";
export interface CcgCatalog {
  models: Array<Record<string, unknown>>;
}

export function ccgSetupPaths(environment: NodeJS.ProcessEnv | undefined, accountId: string): {
  config: string; profile: string; marker: string;
  catalog: string; manifest: string; backup: string; registry: string; role: string;
};
export function applyCcgConfiguration(input: {
  accountId: string;
  apiKey: string;
  catalog: CcgCatalog;
  model: string;
  mode?: "switching" | "exclusive";
  reconfigure?: boolean;
  confirmExclusiveConfigChange?: boolean;
}, options?: {
  environment?: NodeJS.ProcessEnv;
}): Promise<{
  action: "configured";
  account: { id: string; provider: `ccg-${string}`; default: boolean };
  mode: "switching" | "exclusive";
  model: string;
  activation: "restart-all";
}>;
export function hasLegacyCcgConfiguration(environment?: NodeJS.ProcessEnv): boolean;
export function removeLegacyCcgAccount(input?: { confirmRemove?: boolean }, options?: ManagedAccountRuntimeOptions): Promise<{
  action: "legacy-removed";
  runtime: "stopped" | "not-running";
  activation: "restart-all";
}>;
export function setCcgDefaultAccount(accountId: string, options?: {
  environment?: NodeJS.ProcessEnv;
}): Promise<{ action: "default-set"; accountId: string; activation: "restart-all" }>;
export function removeCcgConfiguration(input: { accountId: string; confirmRemove?: boolean }, options?: ManagedAccountRuntimeOptions): Promise<{ action: "removed"; accountId: string; runtime: "stopped" | "not-running"; activation: "restart-all" }>;
export function runCcgSetup(options?: {
  environment?: NodeJS.ProcessEnv;
  output?: { write(value: string): unknown };
  prompts?: unknown;
  fetchImpl?: typeof fetch;
  downloadCatalog?: (fetchImpl: typeof fetch) => Promise<{ catalog: CcgCatalog }>;
  action?: "add" | "legacy-remove" | "reconfigure" | "settings" | "default" | "remove";
  accountId?: string;
}): Promise<unknown>;
export function refreshCcgCatalogForUpdate(environment?: NodeJS.ProcessEnv, options?: {
  fetchImpl?: typeof fetch;
  downloadCatalog?: () => Promise<{ catalog: CcgCatalog }>;
  now?: () => Date;
}): Promise<{ status: "not-configured" } | { status: "updated"; providers: string[] }>;
