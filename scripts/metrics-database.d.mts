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

export interface MetricsDatabaseUpgradeResult extends MetricsDatabaseResetResult {
  schemaVersion: number | null;
}

export interface MetricsCompactSummary {
  model: string | null;
  hasMixedModels: boolean;
  requestCount: number;
  unsuccessfulRequestCount: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  pricingCurrency: string | null;
  pricedRequestCount: number;
  totalCostNanos: number | null;
}

export interface MetricsReportDocument {
  format: "codex-connect-request-metrics-report";
  version: 2;
  generatedAt: string;
  range: { name: string; startAtMs: number; endAtMs: number };
  report: {
    dimension: unknown;
    startAtMs: number;
    endAtMs: number;
    aggregate: unknown;
    groups: unknown[];
    totalGroupCount: number;
  };
  errors: unknown;
  weeklyQuota: unknown;
}

export interface MetricsExportDocument {
  format: "codex-connect-request-metrics-export";
  version: 2;
  generatedAt: string;
  range: { name: string; startAtMs: number; endAtMs: number };
  records: unknown[];
  weeklyQuota: unknown;
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

export interface MetricsThreadsDocument {
  format: "codex-connect-request-metrics-threads";
  version: 1;
  generatedAt: string;
  threads: Array<{
    threadId: string;
    provider: string | null;
    model: string | null;
    reasoningEffort: string | null;
    turnCount: number;
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    pricingCurrency: string | null;
    pricedRequestCount: number;
    totalCostNanos: number | null;
    totalCostCnyNanos: number | null;
    compact: MetricsCompactSummary | null;
    lastRecordedAtMs: number;
  }>;
}

export interface MetricsTurnsDocument {
  format: "codex-connect-request-metrics-turns";
  version: 1;
  generatedAt: string;
  threadId: string;
  turns: Array<Record<string, unknown> & { recordedAtMs: number }>;
}

export function inspectMetricsDatabase(
  environment?: NodeJS.ProcessEnv,
): MetricsDatabaseStatus;

export function validateMetricsDatabaseStructure(
  environment?: NodeJS.ProcessEnv,
  options?: { allowUpgradeable?: boolean },
): MetricsDatabaseStatus;

export function metricsRange(
  name: string,
  nowMs: number,
): { name: string; startAtMs: number; endAtMs: number };

export function resetMetricsDatabase(
  environment?: NodeJS.ProcessEnv,
  options?: {
    gatewayRunning?: () => boolean;
    now?: () => Date;
  },
): MetricsDatabaseResetResult;

export function upgradeMetricsDatabase(
  environment?: NodeJS.ProcessEnv,
  options?: {
    gatewayRunning?: () => boolean;
    now?: () => Date;
  },
): MetricsDatabaseUpgradeResult;

export function upgradeMetricsDatabaseWithGatewayRestart(
  environment?: NodeJS.ProcessEnv,
  options?: {
    stopGateway?: () => void;
    startGateway?: () => void;
    upgrade?: () => MetricsDatabaseUpgradeResult;
  },
): MetricsDatabaseUpgradeResult;

export interface MetricsSyncResetResult {
  backupPath: string | null;
  changed: boolean;
  statePath: string;
  deviceId?: string;
}

export function resetMetricsSyncState(
  environment?: NodeJS.ProcessEnv,
  options?: {
    gatewayRunning?: () => boolean;
  },
): MetricsSyncResetResult;

export function resetMetricsSyncStateWithGatewayRestart(
  environment?: NodeJS.ProcessEnv,
  options?: {
    stopGateway?: () => void;
    startGateway?: () => void;
    reset?: () => MetricsSyncResetResult;
  },
): MetricsSyncResetResult;

export interface MetricsProviderPruneResult {
  provider: string;
  gatewayWasRunning: boolean;
  centerWasRunning: boolean;
  local: {
    databasePath: string;
    backupPath: string | null;
    deleted: number;
  };
  center: {
    skipped: boolean;
    databasePath?: string | null;
    backupPath?: string | null;
    deleted?: number;
  };
  warnings: string[];
}

export function pruneProviderMetrics(
  provider: string,
  environment?: NodeJS.ProcessEnv,
  options?: {
    localDatabasePath?: string;
    centerDatabasePath?: string | null;
    gatewayRunning?: boolean;
    centerRunning?: boolean;
    centerSettings?: {
      databasePath?: string;
    };
    stopGateway?: () => void;
    startGateway?: () => void;
    stopCenter?: () => void;
    startCenter?: () => void;
  },
): MetricsProviderPruneResult;

export interface MetricsCleanupResult {
  backupPath: string;
  databasePath: string;
  deleted: number;
  deletedByAge: number;
  deletedByLimit: number;
  keepDays: number;
  maxRows: number;
  remaining: number;
  vacuumed: boolean;
}

export function cleanupMetricsDatabase(
  environment?: NodeJS.ProcessEnv,
  options?: {
    before?: string;
    keepDays?: number;
    maxRows?: number;
    vacuum?: boolean;
    gatewayRunning?: () => boolean;
  },
): MetricsCleanupResult;

export function cleanupMetricsDatabaseWithGatewayRestart(
  environment?: NodeJS.ProcessEnv,
  options?: {
    before?: string;
    keepDays?: number;
    maxRows?: number;
    vacuum?: boolean;
    stopGateway?: () => void;
    startGateway?: () => void;
  },
): MetricsCleanupResult;

export function readMetricsReport(
  environment?: NodeJS.ProcessEnv,
  options?: { range?: string; from?: string; to?: string; group?: "global" | "providers" | "models"; nowMs?: number },
): MetricsReportDocument;

export function readMetricsExport(
  environment?: NodeJS.ProcessEnv,
  options?: { range?: string; from?: string; to?: string; nowMs?: number; threadId?: string },
): MetricsExportDocument;

export function readMetricsRun(
  environment?: NodeJS.ProcessEnv,
  threadId?: string,
): MetricsRunDocument;

export function readMetricsThreads(
  environment?: NodeJS.ProcessEnv,
): MetricsThreadsDocument;

export function readMetricsTurns(
  environment?: NodeJS.ProcessEnv,
  threadId?: string,
): MetricsTurnsDocument;
