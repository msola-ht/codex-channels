export interface OpenCodeGoAccountPaths {
  codexHome: string;
  providerDirectory: string;
  accountDirectory: string;
  backupDirectory: string;
  configPath: string;
  profilePath: string;
  markerPath: string;
  catalogPath: string;
  manifestPath: string;
}

export function opencodeGoAccountPaths(
  environment: NodeJS.ProcessEnv,
  accountId: string,
): OpenCodeGoAccountPaths;
export function opencodeGoProfileFileName(accountId: string): string;
