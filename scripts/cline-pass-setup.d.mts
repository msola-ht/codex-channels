import type { ResponsesModelDefinition } from "../runtime/model-provider-responses-catalog.mjs";
import type { ManagedAccountRuntimeOptions } from "./managed-provider-account-runtime.mjs";
export interface ClinePassConfigurationInput {
  accountId: string;
  apiKey: string;
  reconfigure?: boolean;
  mode?: "switching" | "exclusive";
  confirmExclusiveConfigChange?: boolean;
}
export interface ClinePassConfigurationOptions {
  environment?: NodeJS.ProcessEnv;
  downloadCatalog?: typeof import("./deepseek-setup.mjs").downloadDeepseekCatalog;
  loadTemplates?: typeof import("./responses-model-templates.mjs").loadResponsesModelTemplates;
}
export function clinePassSetupPaths(environment: NodeJS.ProcessEnv, accountId: string): Record<"config" | "profile" | "marker" | "catalog" | "manifest" | "backup" | "registry", string>;
export function createClinePassCatalog(templates: ResponsesModelDefinition[]): { models: Array<Record<string, unknown>> };
export function previewClinePassConfiguration(input: ClinePassConfigurationInput, options?: ClinePassConfigurationOptions): { operation: string; account: { id: string; provider: string; default: boolean }; mode: string; activation: string };
export function applyClinePassConfiguration(input: ClinePassConfigurationInput, options?: ClinePassConfigurationOptions): Promise<ReturnType<typeof previewClinePassConfiguration> & { action: string }>;
export function previewClinePassRemoval(accountId: string, options?: ManagedAccountRuntimeOptions): Promise<{ operation: string; account: { id: string; provider: string }; activation: string }>;
export function removeClinePassConfiguration(input: { accountId: string; confirmRemove?: boolean }, options?: ManagedAccountRuntimeOptions): Promise<{ action: string; activation: string }>;
export function previewClinePassDefaultAccount(accountId: string, options?: { environment?: NodeJS.ProcessEnv }): { operation: string; account: { id: string; provider: string; default: boolean }; activation: string };
export function setClinePassDefaultAccount(accountId: string, options?: { environment?: NodeJS.ProcessEnv }): Promise<ReturnType<typeof previewClinePassDefaultAccount> & { action: string }>;
export function runClinePassSetup(options?: { environment?: NodeJS.ProcessEnv; prompts?: unknown; output?: { write(value: string): unknown } }): Promise<unknown>;
