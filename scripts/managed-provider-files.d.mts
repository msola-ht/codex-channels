export interface ProviderFileSnapshot {
  path: string;
  content: Buffer | undefined;
  readCurrent: () => Buffer | undefined;
  writeCurrent: (content: string | Uint8Array | undefined) => Promise<void>;
}

export function stageManagedPrimaryCredential(credential: { environmentKey: string; content: string } | undefined,
  definition: import("../runtime/model-provider-definitions.mjs").ModelProviderDefinition,
  environment: NodeJS.ProcessEnv, snapshots: ProviderFileSnapshot[], updates: Map<string, string | Uint8Array | undefined>): void;

export function readOptionalProviderFile(path: string, environment: Record<string, string | undefined>): Promise<Buffer | undefined>;
export function replaceOptionalProviderFile(path: string, content: string | Uint8Array | undefined, environment: Record<string, string | undefined>): Promise<void>;
export function removeOptionalProviderFile(path: string): Promise<void>;
export function snapshotProviderFiles(paths: string[], environment: Record<string, string | undefined>): ProviderFileSnapshot[];
export function assertProviderFileSnapshots(snapshots: ProviderFileSnapshot[]): Promise<void>;
export function refreshProviderFileSnapshot(snapshots: ProviderFileSnapshot[], path: string): ProviderFileSnapshot[];
export function restoreProviderFileSnapshots(snapshots: ProviderFileSnapshot[], guards: ProviderFileSnapshot[]): Promise<void>;
export function applyProviderFileUpdates(
  updates: Map<string, string | Uint8Array | undefined>,
  snapshots: ProviderFileSnapshot[],
): Promise<void>;
