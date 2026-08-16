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

export interface ManagedModelProviderSettings {
  provider: ManagedModelProviderId;
  displayName: string;
  model: string;
  mode: "switching" | "exclusive";
  models: string[];
}

export function loadManagedModelProviderSettings(
  environment?: NodeJS.ProcessEnv,
): ManagedModelProviderSettings[];

export function writeManagedModelProviderProfileDefault(
  provider: ManagedModelProviderId,
  model: string,
  environment?: NodeJS.ProcessEnv,
): { provider: ManagedModelProviderId; model: string; mode: "switching" };

export function loadDeepseekAccountCredential(
  environment?: NodeJS.ProcessEnv,
): string;

export function loadPrimaryModelProvider(
  environment?: NodeJS.ProcessEnv,
): "openai" | ManagedModelProviderId;

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
