export function inferNpmGlobalPrefix(packageDirectory: string): string | undefined;
export function readManagedNpmPrefixes(
  checkout: string,
  environment?: NodeJS.ProcessEnv,
): string[];
export function recordManagedSourceMetadata(
  checkout: string,
  prefixes: Array<string | undefined>,
  environment?: NodeJS.ProcessEnv,
): void;
export function currentNpmGlobalPrefix(environment?: NodeJS.ProcessEnv): string;
