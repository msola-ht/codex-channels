import type { ManagedModelProviderId } from "./model-provider-definitions.mjs";

export interface ManagedModelProviderRuntime {
  provider: ManagedModelProviderId;
}

export function loadManagedModelProvider(
  environment?: NodeJS.ProcessEnv,
): ManagedModelProviderRuntime | undefined;
export function loadManagedModelProviders(
  environment?: NodeJS.ProcessEnv,
): ManagedModelProviderRuntime[];

export interface ManagedProviderAppServerRuntime {
  provider: ManagedModelProviderId;
  arguments: string[];
  childEnvironment: Record<string, string>;
}

export function loadManagedProviderAppServer(
  environment?: NodeJS.ProcessEnv,
): ManagedProviderAppServerRuntime | undefined;
export function loadManagedProviderAppServers(
  environment?: NodeJS.ProcessEnv,
): ManagedProviderAppServerRuntime[];

export function validateConfiguredModelProvider(
  environment?: NodeJS.ProcessEnv,
): { provider: ManagedModelProviderId; mode: "switching" | "exclusive" } | undefined;
export function validateConfiguredModelProviders(
  environment?: NodeJS.ProcessEnv,
): Array<{
  provider: ManagedModelProviderId;
  mode: "switching" | "exclusive";
}>;

export function validateCustomPrimaryModelProviderId(id: unknown): string | null;
export function listCustomPrimaryProviderCandidates(
  providers: Record<string, unknown> | undefined,
): string[];
export function validProviderBaseUrl(value: string, label: string): string;

export interface ManagedModelProviderSettings {
  provider: ManagedModelProviderId;
  displayName: string;
  model: string;
  reasoningEffort: string;
  mode: "switching" | "exclusive";
  models: Array<{
    model: string;
    displayName: string;
    contextWindow: number;
    reasoningEffort: string;
    reasoningEfforts: Array<{ effort: string; description: string }>;
    autoCompactLimit?: number;
    autoCompactPercent?: number;
  }>;
}

export function loadManagedModelProviderSettings(
  environment?: NodeJS.ProcessEnv,
): ManagedModelProviderSettings[];

export function managedProviderDirectory(
  environment: NodeJS.ProcessEnv | undefined,
  definition: import("./model-provider-definitions.mjs").ModelProviderDefinition,
): string;
export function managedProviderMarkerPath(
  environment: NodeJS.ProcessEnv,
  definition: import("./model-provider-definitions.mjs").ModelProviderDefinition,
): string;

export function writeManagedModelProviderProfileDefault(
  provider: ManagedModelProviderId,
  settings: {
    model: string;
    reasoningEffort: string;
    autoCompactLimit?: number;
  },
  environment?: NodeJS.ProcessEnv,
): {
  provider: ManagedModelProviderId;
  model: string;
  reasoningEffort: string;
  autoCompactLimit?: number;
  mode: "switching";
};

export function writeManagedModelProviderCatalogSettings(
  provider: ManagedModelProviderId,
  settings: {
    model: string;
    reasoningEffort: string;
    autoCompactLimit?: number;
  },
  environment?: NodeJS.ProcessEnv,
): {
  model: string;
  displayName: string;
  contextWindow: number;
  reasoningEffort: string;
  reasoningEfforts: Array<{ effort: string; description: string }>;
  autoCompactLimit?: number;
  autoCompactPercent?: number;
};

export function withManagedModelCatalogSettings(
  catalog: Record<string, unknown>,
  definition: import("./model-provider-definitions.mjs").ModelProviderDefinition,
  settings: {
    model: string;
    reasoningEffort: string;
    autoCompactLimit?: number;
  },
): Record<string, unknown>;

export function withPreservedManagedModelCatalogSettings(
  catalog: Record<string, unknown>,
  definition: import("./model-provider-definitions.mjs").ModelProviderDefinition,
  previousModels?: ManagedModelProviderSettings["models"],
): Record<string, unknown>;

export function loadDeepseekAccountCredential(
  environment?: NodeJS.ProcessEnv,
): string;

export function loadOpencodeGoAccountCredential(
  environment?: NodeJS.ProcessEnv,
): string;
export function loadOpencodeGoAccountCredentialFor(
  provider: string,
  environment?: NodeJS.ProcessEnv,
): string;

export function loadPrimaryModelProvider(
  environment?: NodeJS.ProcessEnv,
): "openai" | ManagedModelProviderId;

export interface ConfiguredCustomPrimaryModelProvider {
  id: string;
  baseUrl: string;
}

export function loadConfiguredCustomPrimaryModelProvider(
  environment?: NodeJS.ProcessEnv,
): ConfiguredCustomPrimaryModelProvider | undefined;

export function loadOpenAiBaseUrl(
  environment?: NodeJS.ProcessEnv,
): string | undefined;

export function providerAppServerSocketPath(
  primarySocketPath: string,
  provider: string,
): string;

export function providerMetricsSocketPath(
  primarySocketPath: string,
  provider: string,
): string;

export function withProviderBaseUrl(
  argumentsList: string[],
  provider: string,
  baseUrl: string,
): string[];
export function withOpenAiBaseUrl(argumentsList: string[], baseUrl: string): string[];

export function managedModelProviderRoleConfigPath(
  environment?: NodeJS.ProcessEnv,
): string;

export function writeManagedModelProviderRoleConfig(
  environment?: NodeJS.ProcessEnv,
  options?: { provider?: ManagedModelProviderId; model?: string; baseUrl?: string },
): { role: "external"; provider: ManagedModelProviderId; model: string };

export function loadManagedModelProviderRole(
  environment?: NodeJS.ProcessEnv,
): { role: "external"; provider: ManagedModelProviderId; model: string } | undefined;

export function loadConfiguredProviderCredential(
  provider: ManagedModelProviderId,
  environment?: NodeJS.ProcessEnv,
): { environmentKey: string; apiKey: string };

export function removeManagedModelProviderRoleConfig(
  environment?: NodeJS.ProcessEnv,
): void;
