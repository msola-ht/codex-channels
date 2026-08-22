import type {
  GetAccountRateLimitsResponse,
  GetAccountTokenUsageResponse,
  RateLimitSnapshot,
} from "../codex-protocol/index.js";
import type {
  AccountThreadUsage,
  AccountThreadUsageGroup,
  AccountMetric,
  AccountPlanType,
  AccountRateLimit,
  AccountRateLimitReachedType,
  AccountRateLimitWindow,
  AccountRateLimits,
  AccountUsage,
} from "../application/index.js";

const maximumThreadMetric = 9_223_372_036_854_775_807n;

export function toAccountUsage(response: GetAccountTokenUsageResponse): AccountUsage {
  const summary = response.summary;
  if (!summary || typeof summary !== "object") {
    throw new Error("Codex 响应缺少有效 account usage summary");
  }
  return {
    summary: {
      lifetimeTokens: optionalMetric(summary.lifetimeTokens, "lifetimeTokens"),
      peakDailyTokens: optionalMetric(summary.peakDailyTokens, "peakDailyTokens"),
      longestRunningTurnSec: optionalMetric(
        summary.longestRunningTurnSec,
        "longestRunningTurnSec",
      ),
      currentStreakDays: optionalMetric(summary.currentStreakDays, "currentStreakDays"),
      longestStreakDays: optionalMetric(summary.longestStreakDays, "longestStreakDays"),
    },
    daily: (response.dailyUsageBuckets ?? []).map((bucket) => {
      if (typeof bucket.startDate !== "string" || bucket.startDate.length === 0) {
        throw new Error("Codex 响应缺少有效 account usage startDate");
      }
      return {
        startDate: bucket.startDate,
        tokens: requiredMetric(bucket.tokens, "daily tokens"),
      };
    }),
  };
}

export function toAccountThreadUsage(
  response: GetAccountTokenUsageResponse,
  requestedThreadId: string,
): AccountThreadUsage {
  if (requestedThreadId.length === 0) {
    throw new Error("Codex Thread 用量查询缺少 threadId");
  }
  const threadUsage = response.threadUsage;
  if (threadUsage === undefined || threadUsage === null) {
    return { kind: "unavailable" };
  }
  if (typeof threadUsage !== "object" || threadUsage === null || Array.isArray(threadUsage)) {
    throw new Error("Codex 响应缺少有效 threadUsage");
  }
  if (threadUsage.threadId !== requestedThreadId) {
    throw new Error("Codex Thread 用量响应 threadId 与请求不一致");
  }
  if (!Array.isArray(threadUsage.groups)) {
    throw new Error("Codex 响应缺少有效 threadUsage groups");
  }
  return {
    kind: "available",
    threadId: requestedThreadId,
    estimatedUsageCreditsMicros: requiredThreadMetric(
      threadUsage.estimatedUsageCreditsMicros,
      "thread usage estimatedUsageCreditsMicros",
    ),
    estimatedUsageUsdMicros: optionalThreadMetric(
      threadUsage.estimatedUsageUsdMicros,
      "thread usage estimatedUsageUsdMicros",
    ),
    groups: threadUsage.groups.map((group, index) => toAccountThreadUsageGroup(group, index)),
  };
}

function toAccountThreadUsageGroup(
  group: unknown,
  index: number,
): AccountThreadUsageGroup {
  if (group === null || typeof group !== "object" || Array.isArray(group)) {
    throw new Error(`Codex 响应缺少有效 thread usage group ${index + 1}`);
  }
  const value = group as Record<string, unknown>;
  return {
    model: optionalBoundedString(value.model, `thread usage group ${index + 1} model`),
    reasoningEffort: optionalBoundedString(
      value.reasoningEffort,
      `thread usage group ${index + 1} reasoningEffort`,
    ),
    speed: optionalBoundedString(value.speed, `thread usage group ${index + 1} speed`),
    estimatedUsageCreditsMicros: requiredThreadMetric(
      value.estimatedUsageCreditsMicros,
      `thread usage group ${index + 1} estimatedUsageCreditsMicros`,
    ),
    netNewInputTokens: optionalThreadMetric(
      value.netNewInputTokens,
      `thread usage group ${index + 1} netNewInputTokens`,
    ),
    cachedInputTokens: optionalThreadMetric(
      value.cachedInputTokens,
      `thread usage group ${index + 1} cachedInputTokens`,
    ),
    inputTokens: optionalThreadMetric(
      value.inputTokens,
      `thread usage group ${index + 1} inputTokens`,
    ),
    outputTokens: optionalThreadMetric(
      value.outputTokens,
      `thread usage group ${index + 1} outputTokens`,
    ),
    totalTokens: optionalThreadMetric(
      value.totalTokens,
      `thread usage group ${index + 1} totalTokens`,
    ),
  };
}

export function toAccountRateLimits(
  response: GetAccountRateLimitsResponse,
): AccountRateLimits {
  const configured = response.rateLimitsByLimitId
    ? Object.entries(response.rateLimitsByLimitId).filter(
        (entry): entry is [string, RateLimitSnapshot] => entry[1] !== undefined,
      )
    : [];
  const entries = configured.length > 0
    ? configured
    : [[response.rateLimits.limitId ?? "codex", response.rateLimits] as const];
  return {
    limits: entries.map(([fallbackId, snapshot]) => toAccountRateLimit(snapshot, fallbackId)),
    resetCreditsAvailable: response.rateLimitResetCredits
      ? requiredMetric(
          response.rateLimitResetCredits.availableCount,
          "rate limit reset credits availableCount",
        )
      : null,
  };
}

function toAccountRateLimit(snapshot: RateLimitSnapshot, fallbackId: string): AccountRateLimit {
  const id = snapshot.limitId ?? fallbackId;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Codex 响应缺少有效 rate limit id");
  }
  return {
    limitId: id,
    limitName: optionalString(snapshot.limitName, "rate limit name"),
    primary: toWindow(snapshot.primary, "primary"),
    secondary: toWindow(snapshot.secondary, "secondary"),
    credits: snapshot.credits
      ? {
          hasCredits: requiredBoolean(snapshot.credits.hasCredits, "credits hasCredits"),
          unlimited: requiredBoolean(snapshot.credits.unlimited, "credits unlimited"),
          balance: optionalString(snapshot.credits.balance, "credits balance"),
        }
      : null,
    individualLimit: snapshot.individualLimit
      ? {
          limit: requiredString(snapshot.individualLimit.limit, "individual limit"),
          used: requiredString(snapshot.individualLimit.used, "individual used"),
          remainingPercent: requiredNumber(
            snapshot.individualLimit.remainingPercent,
            "individual remainingPercent",
          ),
          resetsAt: requiredNumber(snapshot.individualLimit.resetsAt, "individual resetsAt"),
        }
      : null,
    spendControlReached: optionalBoolean(
      snapshot.spendControlReached,
      "spendControlReached",
    ),
    planType: optionalEnum(snapshot.planType, accountPlanTypes, "planType"),
    rateLimitReachedType: optionalEnum(
      snapshot.rateLimitReachedType,
      accountRateLimitReachedTypes,
      "rateLimitReachedType",
    ),
  };
}

function toWindow(
  window: RateLimitSnapshot["primary"],
  name: string,
): AccountRateLimitWindow | null {
  if (!window) {
    return null;
  }
  return {
    usedPercent: requiredNumber(window.usedPercent, `${name} usedPercent`),
    windowDurationMins: optionalNumber(
      window.windowDurationMins,
      `${name} windowDurationMins`,
    ),
    resetsAt: optionalNumber(window.resetsAt, `${name} resetsAt`),
  };
}

function optionalMetric(value: unknown, field: string): AccountMetric | null {
  return value === null ? null : requiredMetric(value, field);
}

function optionalThreadMetric(value: unknown, field: string): AccountMetric | null {
  return value === null ? null : requiredThreadMetric(value, field);
}

function requiredThreadMetric(value: unknown, field: string): AccountMetric {
  if (typeof value === "bigint") {
    if (value < 0n || value > maximumThreadMetric) {
      throw new Error(`Codex 响应缺少有效 ${field}`);
    }
    return value;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Codex 响应缺少有效 ${field}`);
  }
  return value;
}

function optionalBoundedString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    typeof value !== "string"
    || normalized.length === 0
    || normalized.length > 256
    || containsControlCharacter(normalized)
  ) {
    throw new Error(`Codex 响应缺少有效 ${field}`);
  }
  return normalized;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function requiredMetric(value: unknown, field: string): AccountMetric {
  if (typeof value === "bigint") {
    return value;
  }
  return requiredNumber(value, field);
}

function optionalNumber(value: unknown, field: string): number | null {
  return value === null ? null : requiredNumber(value, field);
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Codex 响应缺少有效 ${field}`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  return value === null ? null : requiredString(value, field);
}

const accountPlanTypes = new Set<AccountPlanType>([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
]);

const accountRateLimitReachedTypes = new Set<AccountRateLimitReachedType>([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);

function optionalEnum<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  field: string,
): T | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !values.has(value as T)) {
    throw new Error(`Codex 响应缺少有效 ${field}`);
  }
  return value as T;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Codex 响应缺少有效 ${field}`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | null {
  return value === null ? null : requiredBoolean(value, field);
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Codex 响应缺少有效 ${field}`);
  }
  return value;
}
