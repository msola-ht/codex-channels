import type {
  AuthMode,
  ConversationInputEvent,
  McpServerStartupFailureReason,
  McpServerStartupState,
} from "../conversation-core/index.js";
import { sanitizeOperationText } from "./operation-adapter.js";
import {
  asRecord,
  nonEmptyString,
  parsePlanType,
  parseRateLimitSnapshot,
  strictNullableString,
} from "./notification-parse-helpers.js";

export function toAccountUpdatedEvent(
  value: unknown,
  modelProvider?: string,
): ConversationInputEvent | undefined {
  const params = asRecord(value);
  const authMode = parseAuthMode(params?.authMode);
  const planType = parsePlanType(params?.planType);
  return authMode.valid && planType.valid
    ? {
        type: "account.updated",
        authMode: authMode.value,
        planType: planType.value,
        ...(modelProvider ? { modelProvider } : {}),
      }
    : undefined;
}

export function toRateLimitsUpdatedEvent(
  value: unknown,
  modelProvider?: string,
): ConversationInputEvent | undefined {
  const rateLimits = parseRateLimitSnapshot(asRecord(value)?.rateLimits);
  return rateLimits
    ? {
        type: "account.rateLimits.updated",
        rateLimits,
        ...(modelProvider ? { modelProvider } : {}),
      }
    : undefined;
}

export function toMcpStatusEvent(
  value: unknown,
  modelProvider?: string,
): ConversationInputEvent | undefined {
  const params = asRecord(value);
  const threadId = strictNullableString(params?.threadId);
  const name = nonEmptyString(params?.name);
  const status = parseMcpStartupState(params?.status);
  const error = strictNullableString(params?.error);
  const failureReason = parseMcpFailureReason(params?.failureReason);
  if (
    !threadId.valid
    || !name
    || !status
    || !error.valid
    || !failureReason.valid
  ) {
    return undefined;
  }
  return {
    type: "mcp.status.updated",
    threadId: threadId.value,
    name,
    status,
    error: error.value === null ? null : sanitizeOperationText(error.value),
    failureReason: failureReason.value,
    ...(modelProvider ? { modelProvider } : {}),
  };
}

export function toMcpOAuthCompletedEvent(
  value: unknown,
  modelProvider?: string,
): ConversationInputEvent | undefined {
  const params = asRecord(value);
  const threadId = strictNullableString(params?.threadId);
  const name = nonEmptyString(params?.name);
  const success = params?.success;
  const rawError = params?.error;
  if (
    !threadId.valid
    || !name
    || typeof success !== "boolean"
    || (rawError !== undefined && typeof rawError !== "string")
  ) {
    return undefined;
  }
  return {
    type: "mcp.oauth.completed",
    threadId: threadId.value,
    name,
    success,
    error: typeof rawError === "string"
      ? sanitizeOperationText(rawError)
      : null,
    ...(modelProvider ? { modelProvider } : {}),
  };
}

export function toWarningEvent(
  value: unknown,
  modelProvider?: string,
): ConversationInputEvent | undefined {
  const params = asRecord(value);
  const threadId = strictNullableString(params?.threadId);
  const message = nonEmptyString(params?.message);
  return threadId.valid && message
    ? {
        type: "warning",
        threadId: threadId.value,
        message: sanitizeOperationText(message),
        ...(modelProvider ? { modelProvider } : {}),
      }
    : undefined;
}

function parseAuthMode(
  value: unknown,
): { valid: true; value: AuthMode | null } | { valid: false } {
  if (value === null) {
    return { valid: true, value: null };
  }
  return value === "apikey"
    || value === "chatgpt"
    || value === "chatgptAuthTokens"
    || value === "headers"
    || value === "agentIdentity"
    || value === "personalAccessToken"
    || value === "bedrockApiKey"
    || value === "bedrockAccessKeys"
    ? { valid: true, value }
    : { valid: false };
}

function parseMcpStartupState(value: unknown): McpServerStartupState | undefined {
  return value === "starting"
    || value === "ready"
    || value === "failed"
    || value === "cancelled"
    ? value
    : undefined;
}

function parseMcpFailureReason(
  value: unknown,
): {
  valid: true;
  value: McpServerStartupFailureReason | null;
} | { valid: false } {
  return value === null
    ? { valid: true, value: null }
    : value === "reauthenticationRequired"
      ? { valid: true, value }
      : { valid: false };
}
