import type { ModelProviderDefinition } from "./model-provider-definitions.mjs";

export function createManagedProviderProfile(
  definition: ModelProviderDefinition,
  options: {
    apiKey: string;
    catalogPath: string;
    model?: string;
  },
): Record<string, unknown>;

export function createModelProviderConfig(
  definition: ModelProviderDefinition,
  apiKey: string,
): Record<string, unknown>;

export function createManagedProviderMarker(
  definition: ModelProviderDefinition,
  mode?: "switching" | "exclusive",
): { version: 1; provider: string; mode: "switching" | "exclusive" };
