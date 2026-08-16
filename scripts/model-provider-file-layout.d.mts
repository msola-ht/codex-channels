export interface ModelProviderFileMigrationResult {
  changed: boolean;
  layoutVersion: 1;
  moved: Array<{ legacy: string; current: string }>;
}

export function migrateManagedModelProviderFiles(
  environment?: NodeJS.ProcessEnv,
): ModelProviderFileMigrationResult;
