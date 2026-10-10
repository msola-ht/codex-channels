import type {
  MessagePhase,
  PlanType,
  RateLimitReachedType,
  RateLimitSnapshot,
  ThreadTokenUsage,
  TurnErrorCode,
  TurnStatus,
} from "../conversation-core/index.js";
import type { CodexErrorInfo } from "../codex-protocol/index.js";
import { sanitizeOperationText } from "./operation-adapter.js";
import { finiteNumber } from "./value-primitives.js";

export function parseTurnStatus(value: unknown): TurnStatus | undefined {
  return value === "completed"
    || value === "interrupted"
    || value === "failed"
    || value === "inProgress"
    ? value
    : undefined;
}

export function parseThreadStatus(value: unknown): string | undefined {
  return value === "notLoaded"
    || value === "idle"
    || value === "systemError"
    || value === "active"
    ? value
    : undefined;
}

export function parseMessagePhase(value: unknown): MessagePhase | null {
  return value === "commentary" || value === "final_answer" ? value : null;
}

export function parsePlanType(
  value: unknown,
): { valid: true; value: PlanType | null } | { valid: false } {
  if (value === null) {
    return { valid: true, value: null };
  }
  return value === "free"
    || value === "go"
    || value === "plus"
    || value === "pro"
    || value === "prolite"
    || value === "promax"
    || value === "team"
    || value === "self_serve_business_prolite"
    || value === "self_serve_business_usage_based"
    || value === "business"
    || value === "ent26"
    || value === "enterprise_cbp_automation"
    || value === "enterprise_cbp_usage_based"
    || value === "enterprise"
    || value === "edu"
    || value === "edu_plus"
    || value === "edu_pro"
    || value === "unknown"
    ? { valid: true, value }
    : { valid: false };
}

export function parseRateLimitSnapshot(value: unknown): RateLimitSnapshot | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const primary = parseRateLimitWindow(record.primary);
  const secondary = parseRateLimitWindow(record.secondary);
  const credits = parseCredits(record.credits);
  const individualLimit = parseIndividualLimit(record.individualLimit);
  const spendControlReached = nullableBoolean(record.spendControlReached);
  const planType = parsePlanType(record.planType ?? null);
  const rateLimitReachedType = parseRateLimitReachedType(record.rateLimitReachedType);
  if (
    primary === undefined
    || secondary === undefined
    || credits === undefined
    || individualLimit === undefined
    || spendControlReached === undefined
    || !planType.valid
    || rateLimitReachedType === undefined
  ) {
    return undefined;
  }
  return {
    limitId: nullableString(record.limitId),
    limitName: nullableString(record.limitName),
    primary,
    secondary,
    credits,
    individualLimit,
    spendControlReached,
    planType: planType.value,
    rateLimitReachedType,
  };
}

function parseRateLimitWindow(
  value: unknown,
): RateLimitSnapshot["primary"] | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  const record = asRecord(value);
  const usedPercent = finiteNumber(record?.usedPercent);
  const windowDurationMins = nullableNumber(record?.windowDurationMins);
  const resetsAt = nullableNumber(record?.resetsAt);
  return record
    && usedPercent !== undefined
    && windowDurationMins !== undefined
    && resetsAt !== undefined
    ? { usedPercent, windowDurationMins, resetsAt }
    : undefined;
}

function parseCredits(value: unknown): RateLimitSnapshot["credits"] | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  const record = asRecord(value);
  const hasCredits = record?.hasCredits;
  const unlimited = record?.unlimited;
  if (!record || typeof hasCredits !== "boolean" || typeof unlimited !== "boolean") {
    return undefined;
  }
  return {
    hasCredits,
    unlimited,
    balance: nullableString(record.balance),
  };
}

function parseIndividualLimit(
  value: unknown,
): RateLimitSnapshot["individualLimit"] | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  const record = asRecord(value);
  const limit = nonEmptyString(record?.limit);
  const used = nonEmptyString(record?.used);
  const remainingPercent = finiteNumber(record?.remainingPercent);
  const resetsAt = finiteNumber(record?.resetsAt);
  return record
    && limit
    && used
    && remainingPercent !== undefined
    && resetsAt !== undefined
    ? { limit, used, remainingPercent, resetsAt }
    : undefined;
}

function parseRateLimitReachedType(
  value: unknown,
): RateLimitReachedType | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  return value === "rate_limit_reached"
    || value === "workspace_owner_credits_depleted"
    || value === "workspace_member_credits_depleted"
    || value === "workspace_owner_usage_limit_reached"
    || value === "workspace_member_usage_limit_reached"
    ? value
    : undefined;
}

export function parseThreadTokenUsage(
  record: Record<string, unknown> | undefined,
): ThreadTokenUsage | undefined {
  const total = parseTokenUsageBreakdown(asRecord(record?.total));
  const last = parseTokenUsageBreakdown(asRecord(record?.last));
  const context = record?.modelContextWindow;
  if (
    !total
    || !last
    || (context !== null && (typeof context !== "number" || !Number.isFinite(context)))
  ) {
    return undefined;
  }
  return { total, last, modelContextWindow: context };
}

function parseTokenUsageBreakdown(
  record: Record<string, unknown> | undefined,
): ThreadTokenUsage["total"] | undefined {
  const totalTokens = finiteNumber(record?.totalTokens);
  const inputTokens = finiteNumber(record?.inputTokens);
  const cachedInputTokens = finiteNumber(record?.cachedInputTokens);
  const cacheWriteInputTokens = finiteNumber(record?.cacheWriteInputTokens);
  const outputTokens = finiteNumber(record?.outputTokens);
  const reasoningOutputTokens = finiteNumber(record?.reasoningOutputTokens);
  if (
    totalTokens === undefined
    || inputTokens === undefined
    || cachedInputTokens === undefined
    || cacheWriteInputTokens === undefined
    || outputTokens === undefined
    || reasoningOutputTokens === undefined
  ) {
    return undefined;
  }
  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
  };
}

export function parseTurnError(
  value: unknown,
): { valid: true; value: string | null; errorCode?: TurnErrorCode } | { valid: false } {
  if (value === null) {
    return { valid: true, value: null };
  }
  const error = asRecord(value);
  const message = nonEmptyString(error?.message);
  if (!message) {
    return { valid: false };
  }
  const additionalDetails = nonEmptyString(error?.additionalDetails);
  const errorCode = parseTurnErrorCode(error?.codexErrorInfo);
  const combined = additionalDetails && additionalDetails !== message
    ? `${message}\n${additionalDetails}`
    : message;
  return {
    valid: true,
    value: sanitizeTurnErrorText(combined),
    ...(errorCode ? { errorCode } : {}),
  };
}

function sanitizeTurnErrorText(value: string): string {
  if (value.includes("provider_proxy_upstream_error")) {
    return "模型 Provider 上游暂时不可用或响应超时，有限重试后仍未恢复";
  }
  return sanitizeOperationText(value);
}

function parseTurnErrorCode(value: unknown): TurnErrorCode | undefined {
  if (value === ("misalignmentPolicyViolation" satisfies CodexErrorInfo)) {
    return "misalignmentPolicyViolation";
  }
  if (value === ("usageLimitExceeded" satisfies CodexErrorInfo)) {
    return "usageLimitExceeded";
  }
  return value === ("unauthorized" satisfies CodexErrorInfo) ? "unauthorized" : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function strictNullableString(
  value: unknown,
): { valid: true; value: string | null } | { valid: false } {
  return typeof value === "string" || value === null
    ? { valid: true, value }
    : { valid: false };
}

export function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function optionalDurationMs(
  value: unknown,
): { valid: true; value?: number } | { valid: false } {
  if (value === null || value === undefined) {
    return { valid: true };
  }
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? { valid: true, value }
    : { valid: false };
}

function nullableNumber(value: unknown): number | null | undefined {
  return value === null || value === undefined
    ? null
    : finiteNumber(value);
}

function nullableBoolean(value: unknown): boolean | null | undefined {
  return value === null || value === undefined
    ? null
    : typeof value === "boolean" ? value : undefined;
}
