export interface ManagedModelProviderRuntime {
  provider: "deepseek";
}

export function loadManagedModelProvider(
  environment?: NodeJS.ProcessEnv,
): ManagedModelProviderRuntime | undefined;

export interface ManagedProviderAppServerRuntime {
  provider: "deepseek";
  arguments: string[];
  childEnvironment: Record<string, string>;
}

export function loadManagedProviderAppServer(
  environment?: NodeJS.ProcessEnv,
): ManagedProviderAppServerRuntime | undefined;

export function loadDeepseekAccountCredential(
  environment?: NodeJS.ProcessEnv,
): string;

export function loadPrimaryModelProvider(
  environment?: NodeJS.ProcessEnv,
): "openai" | "deepseek";

export function providerAppServerSocketPath(
  primarySocketPath: string,
  provider: string,
): string;
