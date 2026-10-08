import type { ManagedAccountRuntimeOptions } from "./managed-provider-account-runtime.mjs";
export interface CcgCatalog {
  models: Array<Record<string, unknown>>;
}

export function ccgSetupPaths(environment: NodeJS.ProcessEnv | undefined, accountId: string): {
  config: string; profile: string; marker: string;
  catalog: string; manifest: string; backup: string; registry: string;
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
  action?: "add" | "reconfigure" | "settings" | "catalog" | "default" | "remove";
  accountId?: string;
}): Promise<unknown>;
export function runCcgAccountCli(args: string[], options?: Parameters<typeof runCcgSetup>[0]): Promise<unknown>;
