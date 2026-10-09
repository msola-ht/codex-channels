import type { ModelProviderDefinition } from "../runtime/model-provider-definitions.mjs";

export class ManagedModelProviderSetupError extends Error {
  code: string;
  field: string;
}

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
): { config: Record<string, unknown>; profile: Record<string, unknown> | undefined; credential?: { environmentKey: string; content: string } };

export function resolveManagedCatalogModel(
  catalog: { models?: Array<Record<string, unknown>> },
  definition: ModelProviderDefinition,
  preferred?: string,
): string;

export function applyExclusiveProviderConfig(
  current: Record<string, unknown>,
  definition: ModelProviderDefinition,
  options: {
    environmentKey: string;
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
