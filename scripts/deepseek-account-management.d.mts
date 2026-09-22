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
export function previewDeepseekAccountMigration(accountId: string, options?: Options): {
  operation: "migrate"; account: { id: string; provider: string }; confirmation: { required: true; field: string }; activation: "restart-all";
};
export function migrateDeepseekAccount(input: { accountId: string; confirmMigration?: boolean }, options?: Options): Promise<ReturnType<typeof previewDeepseekAccountMigration> & { action: "migrated" }>;
export function setDeepseekDefaultAccount(accountId: string, options?: Options): Promise<{ action: "default-set"; accountId: string; activation: "restart-all" }>;
export function removeDeepseekAccount(input: { accountId: string; confirmRemove?: boolean }, options?: Options): Promise<{ action: "removed"; accountId: string; activation: "restart-all" }>;
export function refreshDeepseekAccountsCatalog(environment?: NodeJS.ProcessEnv, options?: {
  downloadCatalog?: () => Promise<{ catalog: Catalog }>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<{ status: "not-configured" } | {
  status: "updated"; catalogPath: string; manifestPath: string; modelCount: number;
  modelMigrated: boolean; roleMigrated: boolean; migratedProviders: string[];
}>;
