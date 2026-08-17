export interface ModelProviderFileMigrationResult {
  changed: boolean;
  layoutVersion: 1;
  moved: Array<{ legacy: string; current: string }>;
}

export function migrateManagedModelProviderFiles(
  environment?: NodeJS.ProcessEnv,
): ModelProviderFileMigrationResult;

export interface ModelProviderModelSettingsMigrationResult {
  changed: boolean;
  layoutVersion: 2;
  updated: string[];
}

export function migrateManagedModelProviderModelSettings(
  environment?: NodeJS.ProcessEnv,
): ModelProviderModelSettingsMigrationResult;

export interface ModelProviderFileMigrationPath {
  legacy: string;
  current: string;
  definition?: import("../runtime/model-provider-definitions.mjs").ModelProviderDefinition;
}

export function migrationPaths(
  environment?: NodeJS.ProcessEnv,
): ModelProviderFileMigrationPath[];
