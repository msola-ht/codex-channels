export const packageDir: string;

export interface RuntimeConfigLocation {
  configPath: string;
  dataDir: string;
}

export interface InitializedUserData extends RuntimeConfigLocation {
  created: boolean;
  workspace: string;
}

export function userDataDir(environment?: NodeJS.ProcessEnv): string;

export function runtimeConfig(
  environment?: NodeJS.ProcessEnv,
): RuntimeConfigLocation;

export function initializeUserData(options?: {
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
}): InitializedUserData;

export function requireUserConfig(
  environment?: NodeJS.ProcessEnv,
): RuntimeConfigLocation;

export function locateUserConfig(
  environment?: NodeJS.ProcessEnv,
): RuntimeConfigLocation;

export function locateOptionalUserConfig(
  environment?: NodeJS.ProcessEnv,
): RuntimeConfigLocation | undefined;

export function resolveConfiguredPath(
  value: string,
  baseDirectory: string,
  fallback?: string,
): string;
export function resolveConfiguredPath(
  value: string | undefined,
  baseDirectory: string,
  fallback: string,
): string;
