import type {
  ModelProviderFileMigrationResult,
  ModelProviderModelSettingsMigrationResult,
} from "./model-provider-file-layout.mjs";

export interface ProviderMigrationBackupCopy {
  source: string;
  target: string;
}

export interface ProviderMigrationMovedDirectory {
  provider: string;
  from: string;
  to: string;
}

export type ProviderMigrationResult =
  | {
    status: "already-migrated";
    backupDirectory: undefined;
    movedDirectories: [];
    layout: undefined;
    settings: undefined;
  }
  | {
    status: "dry-run";
    backupDirectory: string;
    legacyFiles: string[];
    currentFiles: string[];
    providerDirectories: string[];
    referenceFiles: string[];
  }
  | {
    status: "migrated";
    backupDirectory: string;
    movedDirectories: ProviderMigrationMovedDirectory[];
    layout: ModelProviderFileMigrationResult;
    settings: ModelProviderModelSettingsMigrationResult;
    copied: ProviderMigrationBackupCopy[];
  };

export function backupAndMigrateProviderFiles(
  environment?: NodeJS.ProcessEnv,
  options?: {
    apply?: boolean;
    backupDirectory?: string;
    now?: () => Date;
  },
): ProviderMigrationResult;

export function resolveBackupTarget(
  backupRoot: string,
  roots: {
    codexHome: string;
    connectHome: string;
  },
  path: string,
): string;
