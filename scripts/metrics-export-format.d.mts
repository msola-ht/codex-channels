export function formatTokenCount(value: number): string;

export function isRecord(value: unknown): value is Record<string, unknown>;

export interface MetricsDisplayContext {
  priceCurrency: "cny" | "usd";
  exchangeRate: {
    usdToCny: number;
    effectiveAtMs: number;
    source: "open-er-api" | "ecb" | "cache";
  } | null;
}

export function loadDisplayContext(
  environment?: NodeJS.ProcessEnv,
): MetricsDisplayContext;

export function loadExchangeRate(
  directory: string,
): MetricsDisplayContext["exchangeRate"];

export function convertCostToCny(
  nanos: number | null | undefined,
  currency: string | null | undefined,
  provider: string | null | undefined,
  display: MetricsDisplayContext | null | undefined,
): number | null;

export function enrichCosts<T extends Record<string, unknown>>(
  value: T | null | undefined,
  display: MetricsDisplayContext | null | undefined,
  providerOverride?: string | null,
): T & {
  totalCostCnyNanos: number | null;
  inputCostCnyNanos: number | null;
  cachedInputCostCnyNanos: number | null;
  outputCostCnyNanos: number | null;
} | null | undefined;

export function formatCost(
  aggregate: {
    provider?: string | null;
    pricingCurrency?: string | null;
    totalCostNanos?: number | null;
  },
  display?: MetricsDisplayContext | null,
): string;

export function exchangeRateLine(
  display: MetricsDisplayContext | null | undefined,
): string | null;

export function formatLocalTime(ms: number): string;

export function formatCurrencyNanos(
  value: number,
  currency: string,
  display?: MetricsDisplayContext | null,
  provider?: string | null,
): string;

export function formatDuration(value: number | null): string;

export function markdownCell(value: unknown): string;

export function csvCell(value: unknown): string;
