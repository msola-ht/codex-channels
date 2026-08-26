import type { ModelProviderDefinition } from "../runtime/model-provider-definitions.mjs";

export class ManagedModelProviderSetupError extends Error {
  code: string;
  field: string;
}

export interface ManagedModelProviderRestorePreview {
  operation: "restore";
  provider: { id: string; name: string };
  effects: {
    restoresInitialConfig: true;
    removesManagedCatalog: true;
    restoresExternalAgentConfig: true;
    removesManagedAccounts: boolean;
  };
  confirmation: { required: true; field: "confirmRestore" };
  activation: "restart-all";
}

export function createManagedProviderRestorePreview(
  definition: ModelProviderDefinition,
  options?: { removesManagedAccounts?: boolean },
): ManagedModelProviderRestorePreview;

export function createSwitchingProviderProfile(
  definition: ModelProviderDefinition,
  options: {
    apiKey: string;
    catalogPath: string;
    model?: string;
    reasoningEffort?: string;
  },
): Record<string, unknown>;

export function createManagedProviderCatalog(
  catalog: { models?: Array<Record<string, unknown>> },
  definition: ModelProviderDefinition,
  options?: {
    previousModels?: Array<Record<string, unknown>>;
    autoCompactPercent?: number | null;
  },
): { models: Array<Record<string, unknown>> };

export function applyExclusiveProviderConfig(
  current: Record<string, unknown>,
  definition: ModelProviderDefinition,
  options: {
    apiKey: string;
    catalogPath: string;
    model?: string;
  },
): Record<string, unknown>;

export function restoreProviderBaseConfig(
  current: Record<string, unknown>,
  initial: Record<string, unknown>,
  definition: ModelProviderDefinition,
): Record<string, unknown>;

export function hasProviderBaseConfig(
  document: Record<string, unknown>,
  definition: ModelProviderDefinition,
): boolean;
