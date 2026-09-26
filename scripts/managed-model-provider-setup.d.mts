import type { ModelProviderDefinition } from "../runtime/model-provider-definitions.mjs";
import type { ProviderFileSnapshot } from "./managed-provider-files.mjs";

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
    windowPercent?: number | null;
    modelWindowPercentByModel?: Record<string, number>;
  },
): { models: Array<Record<string, unknown>> };

export function createManagedProviderConfiguration(
  current: Record<string, unknown>,
  initial: Record<string, unknown>,
  definition: ModelProviderDefinition,
  options: {
    mode: "switching" | "exclusive";
    previousMode?: "switching" | "exclusive";
    apiKey: string;
    catalogPath: string;
    catalog: { models: Array<Record<string, unknown>> };
    model: string;
  },
): { config: Record<string, unknown>; profile: Record<string, unknown> | undefined };

export function resolveManagedCatalogModel(
  catalog: { models?: Array<Record<string, unknown>> },
  definition: ModelProviderDefinition,
  preferred?: string,
): string;

export function planManagedProviderAccountConfiguration(
  current: Record<string, unknown>,
  backup: { config: Record<string, unknown> } | undefined,
  definition: ModelProviderDefinition,
  options: Omit<Parameters<typeof createManagedProviderConfiguration>[3], "catalogPath"> & {
    paths: { config: string; profile: string; marker: string; backup: string; catalog: string };
  },
): {
  initial: { config: Record<string, unknown> };
  replacesInitial: boolean;
  updates: Map<string, string | Uint8Array | undefined>;
};

export function applyManagedProviderAccountConfiguration(
  updates: Map<string, string | Uint8Array | undefined>,
  snapshots: ProviderFileSnapshot[],
  paths: { profile: string; marker: string; registry: string; config: string },
): Promise<void>;

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
