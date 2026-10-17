export interface ProviderSettingsSnapshot {
  ok: true;
  visibleProviders: string[];
  fingerprints: [string, string][];
  aggregateRestartRequired: boolean;
}
export class ProviderSettingsSnapshotReader {
  constructor(environment: NodeJS.ProcessEnv, aggregateMembers?: readonly string[]);
  read(): Promise<ProviderSettingsSnapshot>;
  readFresh(): Promise<ProviderSettingsSnapshot>;
  close(): Promise<void>;
}
