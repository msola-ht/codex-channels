export function managedProviderAccountIdFromProvider(provider: string): string | undefined;
export function sharedProviderProxyKey(provider: string): string;
export function resolveDefaultManagedProvider(
  providers: readonly string[],
  environment?: NodeJS.ProcessEnv,
): string | undefined;
