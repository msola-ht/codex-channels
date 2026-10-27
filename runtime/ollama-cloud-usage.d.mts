/** Shared serializable cloud report; never part of the persisted account schema. */
export interface CloudUsageQuery {
  range: "24h" | "7d" | "30d";
  refresh?: boolean;
  /** Read the Gateway snapshot only; never submit an upstream request. */
  cacheOnly?: boolean;
  expectedProvider?: string;
}

export interface CloudUsageMetrics {
  requestCount: number;
  usageUsd: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
}

export interface CloudUsageReport {
  kind: "cloud-usage";
  provider: string;
  query: CloudUsageQuery;
  from: string;
  until: string;
  totals: CloudUsageMetrics;
  groups: Array<CloudUsageMetrics & { model: string }>;
  remainder: CloudUsageMetrics | null;
  balanceUsd: string | null;
  allowanceUsd: string | null;
  includedBalanceUsd: string | null;
  purchasedBalanceUsd: string | null;
  plan: string | null;
  planObservedAtMs: number | null;
  planStale: boolean;
  usdCny: { rate: number; date: string } | null;
  observedAtMs: number;
  balanceObservedAtMs: number | null;
  stale: boolean;
  balanceStale: boolean;
}

export interface CloudUsageEstimates {
  priceUsd: string | null;
  priceCny: string | null;
  allowanceTokens: number | null;
  remainingTokens: number | null;
  proMonthly: boolean;
  priceTokens: number;
}

export interface CloudUsageView {
  report: CloudUsageReport;
  estimates: CloudUsageEstimates;
}
