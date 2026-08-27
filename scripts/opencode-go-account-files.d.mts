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
  roleConfigPath: string;
}

export interface OpenCodeGoFileSnapshot {
  path: string;
  content: Buffer | undefined;
}

export function opencodeGoAccountPaths(
  environment: NodeJS.ProcessEnv,
  accountId: string,
): OpenCodeGoAccountPaths;
export function opencodeGoProfileFileName(accountId: string): string;
export function readOptionalOpencodeGoFile(path: string): Promise<Buffer | undefined>;
export function replaceOptionalOpencodeGoFile(
  path: string,
  content: string | Uint8Array | undefined,
): Promise<void>;
export function removeOptionalOpencodeGoFile(path: string): Promise<void>;
export function snapshotOpencodeGoFiles(paths: string[]): OpenCodeGoFileSnapshot[];
export function assertOpencodeGoFileSnapshots(
  snapshots: OpenCodeGoFileSnapshot[],
): Promise<void>;
export function refreshOpencodeGoFileSnapshot(
  snapshots: OpenCodeGoFileSnapshot[],
  path: string,
): OpenCodeGoFileSnapshot[];
export function restoreOpencodeGoFileSnapshots(
  snapshots: OpenCodeGoFileSnapshot[],
  guards: OpenCodeGoFileSnapshot[],
): Promise<void>;
