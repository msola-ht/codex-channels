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
export interface InstalledSourceMetadata {
  version: 1;
  checkout: string;
  managed: boolean;
}
export function readInstalledSourceMetadata(packageDirectory: string): InstalledSourceMetadata | undefined;
export function hasManagedSourceMarker(checkout: string, environment?: NodeJS.ProcessEnv): boolean;
export function recordInstalledSourceMetadata(
  checkout: string,
  prefix: string,
  environment?: NodeJS.ProcessEnv,
): void;
