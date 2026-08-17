export type AccountMetric = bigint | number;
export type AccountPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "team"
  | "self_serve_business_usage_based"
  | "business"
  | "ent26"
  | "enterprise_cbp_usage_based"
  | "enterprise"
  | "edu"
  | "unknown";
export type AccountRateLimitReachedType =
  | "rate_limit_reached"
  | "workspace_owner_credits_depleted"
  | "workspace_member_credits_depleted"
  | "workspace_owner_usage_limit_reached"
  | "workspace_member_usage_limit_reached";

export interface AccountUsage {
  summary: {
    lifetimeTokens: AccountMetric | null;
    peakDailyTokens: AccountMetric | null;
    longestRunningTurnSec: AccountMetric | null;
    currentStreakDays: AccountMetric | null;
    longestStreakDays: AccountMetric | null;
  };
  daily: Array<{
    startDate: string;
    tokens: AccountMetric;
  }>;
}

export interface AccountRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface AccountRateLimit {
  limitId: string;
  limitName: string | null;
  primary: AccountRateLimitWindow | null;
  secondary: AccountRateLimitWindow | null;
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  individualLimit: {
    limit: string;
    used: string;
    remainingPercent: number;
    resetsAt: number;
  } | null;
  spendControlReached: boolean | null;
  planType: AccountPlanType | null;
  rateLimitReachedType: AccountRateLimitReachedType | null;
}

export interface AccountRateLimits {
  limits: AccountRateLimit[];
  resetCreditsAvailable: AccountMetric | null;
}

export interface AccountWeeklyLimitEstimate {
  limitId: string;
  startAtMs: number;
  endAtMs: number;
  usedPercent: number;
  remainingPercent: number;
  observedDeltaPercent: number;
  intervalCount: number;
  requestCount: number;
  unsuccessfulRequestCount: number;
  pricedRequestCount: number;
  inputTokensPerPercent: number;
  outputTokensPerPercent: number;
  totalTokensPerPercent: number;
  remainingTokens: number;
  pricingCurrency: string | null;
  costPerPercentNanos: number | null;
  remainingCostNanos: number | null;
}

export interface AccountQueryPort {
  accountUsage(): Promise<AccountUsage>;
  accountRateLimits(): Promise<AccountRateLimits>;
}

export interface ProviderBalance {
  currency: "CNY" | "USD";
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export interface ProviderQuotaWindow {
  windowId: string;
  label: string;
  usedPercent: number;
  resetsAt: number | null;
  status: string | null;
}

export interface ProviderModelUsageEstimate {
  model: string;
  includedUsageUsd: number;
  usedUsdNanos: number | null;
  usedPercent: number | null;
  remainingUsdNanos: number | null;
  windowStartAtMs: number | null;
  windowEndAtMs: number | null;
}

export type ProviderAccountUsage =
  | { kind: "token-usage"; provider: "openai"; usage: AccountUsage }
  | { kind: "balance"; provider: string; available: boolean; balances: ProviderBalance[] }
  | {
      kind: "quota-windows";
      provider: string;
      available: boolean;
      windows: ProviderQuotaWindow[];
      modelUsage?: ProviderModelUsageEstimate[];
    }
  | { kind: "unsupported"; provider: string };

export type ProviderAccountLimits =
  | {
      kind: "rate-limits";
      provider: "openai";
      limits: AccountRateLimits;
      weeklyEstimates?: AccountWeeklyLimitEstimate[];
    }
  | { kind: "unsupported"; provider: string };

export interface ProviderAccountAdapter {
  provider: string;
  accountUsage(): Promise<ProviderAccountUsage>;
  accountLimits?(): Promise<ProviderAccountLimits>;
}

export interface ProviderAccountQueryPort {
  accountUsage(modelProvider: string): Promise<ProviderAccountUsage>;
  accountLimits(modelProvider: string): Promise<ProviderAccountLimits>;
}
