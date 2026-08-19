export interface MetricsRange {
  name: string;
  startAtMs: number;
  endAtMs: number;
}

export interface MetricsRangeOptions {
  range?: string;
  from?: string;
  to?: string;
}

export interface MetricsCleanupOptions {
  before?: string;
  keepDays?: number;
  maxRows?: number;
  vacuum?: boolean;
}

export type MetricsOutputFormat = "markdown" | "json" | "csv";

export const metricsProviderIds: readonly string[];
export const metricsProviderUsage: string;

export const metricsCommandUsage: Readonly<Record<
  "run" | "turns" | "threads" | "report" | "export",
  string
>>;

export function metricsRange(name: string, nowMs: number): MetricsRange;

export function metricsRangeOptions(
  options: MetricsRangeOptions,
  nowMs: number,
): MetricsRange;

export function metricsDimension(
  value: string,
): "global" | "provider" | "model";

export function parseMetricsOptions(
  args: string[],
  allowed: Set<string>,
): Record<string, string>;

export function validateMetricsCommandArgs(
  subcommand: string,
  args: string[],
  environment?: NodeJS.ProcessEnv,
): void;

export function parseCleanupOptions(args: string[]): MetricsCleanupOptions;

export function parseMetricsRunArgs(
  args: string[],
): { threadId: string; format: MetricsOutputFormat };

export function parseMetricsTurnsArgs(
  args: string[],
): { threadId: string; format: MetricsOutputFormat };

export function parseMetricsThreadsArgs(
  args: string[],
): { format: MetricsOutputFormat };

export function assertExportFormat(
  value: string,
  allowed: string[],
): void;

export function positiveInteger(value: number, label: string): number;

export function parseLocalDate(value: string): number;
