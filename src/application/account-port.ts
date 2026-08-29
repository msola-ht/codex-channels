export type AccountMetric = bigint | number;
export type AccountPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "team"
  | "self_serve_business_prolite"
  | "self_serve_business_usage_based"
  | "business"
  | "ent26"
  | "enterprise_cbp_automation"
  | "enterprise_cbp_usage_based"
  | "enterprise"
  | "edu"
  | "edu_plus"
  | "edu_pro"
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

export interface AccountThreadUsageGroup {
  model: string | null;
  reasoningEffort: string | null;
  speed: string | null;
  estimatedUsageCreditsMicros: AccountMetric;
  netNewInputTokens: AccountMetric | null;
  cachedInputTokens: AccountMetric | null;
  inputTokens: AccountMetric | null;
  outputTokens: AccountMetric | null;
  totalTokens: AccountMetric | null;
}

export type AccountThreadUsage =
  | {
      kind: "available";
      threadId: string;
      estimatedUsageCreditsMicros: AccountMetric;
      estimatedUsageUsdMicros: AccountMetric | null;
      groups: AccountThreadUsageGroup[];
    }
  | { kind: "unavailable" }
  | { kind: "failed" };

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
  periodRequestCount?: number;
  periodInputTokens?: number;
  periodOutputTokens?: number;
  periodTotalTokens?: number;
  periodTotalCostNanos?: number | null;
  source?: "local" | "center";
  deviceCount?: number;
}

export interface AccountQueryPort {
  accountUsage(): Promise<AccountUsage>;
  accountRateLimits(): Promise<AccountRateLimits>;
  accountThreadUsage(threadId: string): Promise<AccountThreadUsage>;
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
  /** 窗口总额度（USD），如 OpenCode Go 5 小时 $12、7 天 $30、月度 $60。 */
  totalUsd?: number;
  localTokens?: number | null;
}

export interface ProviderModelUsageEstimate {
  model: string;
  /** 模型用量按官方口径拆分的峰谷档位 */
  bucket?: "off-peak" | "peak";
  includedUsageUsd: number;
  usedUsdNanos: number | null;
  usedPercent: number | null;
  remainingUsdNanos: number | null;
  windowStartAtMs: number | null;
  windowEndAtMs: number | null;
}

export type ProviderAccountUsage =
  | {
      kind: "token-usage";
      provider: "openai";
      usage: AccountUsage;
      threadUsage?: AccountThreadUsage;
    }
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
  accountThreadUsage?(threadId: string): Promise<AccountThreadUsage>;
  accountLimits?(): Promise<ProviderAccountLimits>;
}

export interface ProviderAccountQueryPort {
  accountUsage(modelProvider: string, threadId?: string): Promise<ProviderAccountUsage>;
  accountLimits(modelProvider: string): Promise<ProviderAccountLimits>;
}
