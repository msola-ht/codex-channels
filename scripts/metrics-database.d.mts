export interface MetricsDatabaseStatus {
  compatible: boolean;
  count: number | null;
  databasePath: string;
  exists: boolean;
  schemaVersion: number | null;
}

export interface MetricsDatabaseResetResult {
  backupPath: string | null;
  changed: boolean;
  databasePath: string;
  previousSchemaVersion: number | null;
}

export function inspectMetricsDatabase(
  environment?: NodeJS.ProcessEnv,
): MetricsDatabaseStatus;

export function resetMetricsDatabase(
  environment?: NodeJS.ProcessEnv,
  options?: {
    gatewayRunning?: () => boolean;
    now?: () => Date;
  },
): MetricsDatabaseResetResult;
