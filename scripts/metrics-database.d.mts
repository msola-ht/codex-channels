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

export interface MetricsReportDocument {
  format: "codex-connect-request-metrics-report";
  version: 1;
  generatedAt: string;
  range: { name: string; startAtMs: number; endAtMs: number };
  report: unknown;
  errors: unknown;
}

export interface MetricsExportDocument {
  format: "codex-connect-request-metrics-export";
  version: 1;
  generatedAt: string;
  range: { name: string; startAtMs: number; endAtMs: number };
  records: unknown[];
}

export interface MetricsRunDocument {
  format: "codex-connect-request-metrics-run";
  version: 1;
  generatedAt: string;
  threadId: string;
  latestTurn: unknown;
  threadAggregate: unknown;
  latestDirectApi: unknown;
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

export function readMetricsReport(
  environment?: NodeJS.ProcessEnv,
  options?: { range?: "24h" | "7d" | "30d"; group?: "global" | "providers" | "models"; nowMs?: number },
): MetricsReportDocument;

export function readMetricsExport(
  environment?: NodeJS.ProcessEnv,
  options?: { range?: "24h" | "7d" | "30d"; nowMs?: number; threadId?: string },
): MetricsExportDocument;

export function readMetricsRun(
  environment?: NodeJS.ProcessEnv,
  threadId?: string,
): MetricsRunDocument;
