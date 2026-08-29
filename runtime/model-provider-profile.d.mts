import type { ModelProviderDefinition } from "./model-provider-definitions.mjs";

export const thirdPartyProviderRequestMaxRetries: 1;
export const thirdPartyProviderStreamMaxRetries: 0;

export function createManagedProviderProfile(
  definition: ModelProviderDefinition,
  options: {
    apiKey: string;
    catalogPath: string;
    model?: string;
    reasoningEffort?: string;
  },
): Record<string, unknown>;

export function createModelProviderConfig(
  definition: ModelProviderDefinition,
  apiKey: string,
): Record<string, unknown>;

export function createCustomPrimaryProviderConfig(options: {
  name: string;
  baseUrl: string;
  auth: "apikey" | "env_key" | "none" | "bearer_token";
  envKey?: string;
  bearerToken?: string;
  supportsWebsockets: boolean;
}): Record<string, unknown>;

export function modelProviderBlockEdits(
  id: string,
  provider: Record<string, unknown>,
): Array<{ keyPath: string; value: unknown }>;

export function createManagedProviderMarker(
  definition: ModelProviderDefinition,
  mode?: "switching" | "exclusive",
): { version: 1; provider: string; mode: "switching" | "exclusive" };
