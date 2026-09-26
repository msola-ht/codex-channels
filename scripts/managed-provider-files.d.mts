export interface ProviderFileSnapshot {
  path: string;
  content: Buffer | undefined;
}

export function readOptionalProviderFile(path: string): Promise<Buffer | undefined>;
export function replaceOptionalProviderFile(path: string, content: string | Uint8Array | undefined): Promise<void>;
export function removeOptionalProviderFile(path: string): Promise<void>;
export function snapshotProviderFiles(paths: string[]): ProviderFileSnapshot[];
export function addProviderFileArchive(
  updates: Map<string, string | Uint8Array | undefined>,
  snapshots: ProviderFileSnapshot[],
  sourcePath: string,
  archivePath: string,
): void;
export function assertProviderFileSnapshots(snapshots: ProviderFileSnapshot[]): Promise<void>;
export function refreshProviderFileSnapshot(snapshots: ProviderFileSnapshot[], path: string): ProviderFileSnapshot[];
export function restoreProviderFileSnapshots(snapshots: ProviderFileSnapshot[], guards: ProviderFileSnapshot[]): Promise<void>;
export function applyProviderFileUpdates(
  updates: Map<string, string | Uint8Array | undefined>,
  snapshots: ProviderFileSnapshot[],
): Promise<void>;
