import type {
  AuthMode,
  ConversationInputEvent,
  McpServerStartupFailureReason,
  McpServerStartupState,
  MessagePhase,
  PlanType,
  RateLimitReachedType,
  RateLimitSnapshot,
  ThreadTokenUsage,
  TurnErrorCode,
  TurnPlanStep,
  TurnStatus,
} from "../conversation-core/index.js";
import type {
  ServerNotification,
  ThreadQueueChangedNotification,
  ThreadGoal as ProtocolThreadGoal,
  ThreadRevertedNotification,
  CodexErrorInfo,
} from "../codex-protocol/index.js";
import type { ThreadStateEvent } from "../session-routing/index.js";
import type { RpcNotification } from "./json-rpc.js";
import {
  sanitizeOperationText,
  toOperationUpdate,
} from "./operation-adapter.js";
import { toThreadGoal } from "./turn-adapter.js";

type RoutingNotification = Extract<
  ServerNotification,
  {
    method:
      | "thread/settings/updated"
      | "thread/name/updated"
      | "thread/archived"
      | "thread/deleted"
      | "thread/closed";
  }
>;

type CoreNotification = Extract<
  ServerNotification,
  {
    method:
      | "turn/started"
      | "thread/goal/updated"
      | "thread/goal/cleared"
      | "thread/reverted"
      | "thread/tokenUsage/updated"
      | "turn/diff/updated"
      | "turn/plan/updated"
      | "item/agentMessage/delta"
      | "item/reasoning/summaryTextDelta"
      | "item/reasoning/summaryPartAdded"
      | "item/reasoning/textDelta"
      | "item/started"
      | "item/completed"
      | "error"
      | "turn/completed"
      | "thread/status/changed"
      | "thread/name/updated"
      | "thread/closed"
      | "thread/archived"
      | "thread/deleted"
      | "account/updated"
      | "account/rateLimits/updated"
      | "mcpServer/oauthLogin/completed"
      | "mcpServer/startupStatus/updated"
      | "warning";
  }
>;

const routingMethods = {
  settingsUpdated: "thread/settings/updated",
  nameUpdated: "thread/name/updated",
  archived: "thread/archived",
  deleted: "thread/deleted",
  closed: "thread/closed",
} as const satisfies Record<string, RoutingNotification["method"]>;

const coreMethods = {
  turnStarted: "turn/started",
  goalUpdated: "thread/goal/updated",
  goalCleared: "thread/goal/cleared",
  tokenUsageUpdated: "thread/tokenUsage/updated",
  turnDiffUpdated: "turn/diff/updated",
  turnPlanUpdated: "turn/plan/updated",
  agentMessageDelta: "item/agentMessage/delta",
  reasoningSummaryTextDelta: "item/reasoning/summaryTextDelta",
  reasoningSummaryPartAdded: "item/reasoning/summaryPartAdded",
  reasoningTextDelta: "item/reasoning/textDelta",
  itemStarted: "item/started",
  itemCompleted: "item/completed",
  error: "error",
  turnCompleted: "turn/completed",
  threadStatusChanged: "thread/status/changed",
  threadNameUpdated: "thread/name/updated",
  threadClosed: "thread/closed",
  threadArchived: "thread/archived",
  threadDeleted: "thread/deleted",
  accountUpdated: "account/updated",
  accountRateLimitsUpdated: "account/rateLimits/updated",
  mcpOAuthCompleted: "mcpServer/oauthLogin/completed",
  mcpStatusUpdated: "mcpServer/startupStatus/updated",
  warning: "warning",
  reverted: "thread/reverted",
} as const satisfies Record<string, CoreNotification["method"]>;

export function toThreadStateEvent(
  notification: RpcNotification,
): ThreadStateEvent | undefined {
  switch (notification.method) {
    case routingMethods.settingsUpdated:
      return toThreadSettingsUpdatedEvent(notification.params);
    case routingMethods.nameUpdated:
      return toThreadNameUpdatedStateEvent(notification.params);
    case routingMethods.archived:
      return toThreadLifecycleEvent("thread.archived", notification.params);
    case routingMethods.deleted:
      return toThreadLifecycleEvent("thread.deleted", notification.params);
    case routingMethods.closed:
      return toThreadLifecycleEvent("thread.closed", notification.params);
    default:
      return undefined;
  }
}

function toThreadNameUpdatedStateEvent(value: unknown): ThreadStateEvent | undefined {
  const params = asRecord(value);
  const threadId = nonEmptyString(params?.threadId);
  if (!threadId) return undefined;
  const name = params?.threadName;
  return {
    type: "thread.name.updated",
    threadId,
    name: typeof name === "string" && name.trim() ? name : null,
  };
}

/** Queue changes only invalidate the local selector snapshot; they never trigger a read. */
export function toThreadQueueChangedEvent(
  notification: RpcNotification,
): { threadId: string } | undefined {
  if (notification.method !== "thread/queue/changed") return undefined;
  const params = asRecord(notification.params) as Partial<ThreadQueueChangedNotification> | undefined;
  const threadId = nonEmptyString(params?.threadId);
  return threadId ? { threadId } : undefined;
}

export function toConversationInputEvent(
  notification: RpcNotification,
): ConversationInputEvent | undefined {
  switch (notification.method) {
    case coreMethods.turnStarted:
      return toTurnStartedEvent(notification.params, notification.receivedAtMs);
    case coreMethods.goalUpdated:
      return toGoalUpdatedEvent(notification.params);
    case coreMethods.goalCleared:
      return toGoalClearedEvent(notification.params);
    case coreMethods.reverted:
      return toThreadRevertedEvent(notification.params);
    case coreMethods.tokenUsageUpdated:
      return toTokenUsageEvent(notification.params);
    case coreMethods.turnDiffUpdated:
      return toTurnDiffEvent(notification.params);
    case coreMethods.turnPlanUpdated:
      return toTurnPlanEvent(notification.params);
    case coreMethods.agentMessageDelta:
      return toAgentMessageDeltaEvent(notification.params, notification.receivedAtMs);
    case coreMethods.reasoningSummaryTextDelta:
    case coreMethods.reasoningSummaryPartAdded:
    case coreMethods.reasoningTextDelta:
      return toReasoningHeartbeatEvent(notification.params);
    case coreMethods.itemStarted:
      return toItemEvent(notification.params, "started");
    case coreMethods.itemCompleted:
      return toItemEvent(notification.params, "completed");
    case coreMethods.error:
      return toTurnErrorEvent(notification.params);
    case coreMethods.turnCompleted:
      return toTurnCompletedEvent(notification.params);
    case coreMethods.threadStatusChanged:
      return toThreadStatusEvent(notification.params);
    case coreMethods.threadNameUpdated:
      return toThreadNameUpdatedEvent(notification.params);
    case coreMethods.threadClosed:
      return toCoreThreadLifecycleEvent("thread.closed", notification.params);
    case coreMethods.threadArchived:
      return toCoreThreadLifecycleEvent("thread.archived", notification.params);
    case coreMethods.threadDeleted:
      return toCoreThreadLifecycleEvent("thread.deleted", notification.params);
    case coreMethods.accountUpdated:
      return toAccountUpdatedEvent(notification.params, notification.provider);
    case coreMethods.accountRateLimitsUpdated:
      return toRateLimitsUpdatedEvent(notification.params, notification.provider);
    case coreMethods.mcpOAuthCompleted:
      return toMcpOAuthCompletedEvent(notification.params, notification.provider);
    case coreMethods.mcpStatusUpdated:
      return toMcpStatusEvent(notification.params, notification.provider);
    case coreMethods.warning:
      return toWarningEvent(notification.params, notification.provider);
    default:
      return undefined;
  }
}

function toThreadNameUpdatedEvent(value: unknown): ConversationInputEvent | undefined {
  const params = asRecord(value);
  const threadId = nonEmptyString(params?.threadId);
  if (!threadId) return undefined;
  const name = params?.threadName;
  return { type: "thread.name.updated", threadId, name: typeof name === "string" && name.trim() ? name : null };
}

function toThreadRevertedEvent(value: unknown): ConversationInputEvent | undefined {
  const params = asRecord(value) as Partial<ThreadRevertedNotification> | undefined;
  const threadId = nonEmptyString(params?.threadId);
  return threadId ? { type: "thread.reverted", threadId } : undefined;
}

function toGoalUpdatedEvent(value: unknown): ConversationInputEvent | undefined {
  const params = asRecord(value);
  const threadId = nonEmptyString(params?.threadId);
  const goal = asRecord(params?.goal);
  if (!threadId || !goal || goal.threadId !== threadId) {
    return undefined;
  }
  try {
    return {
      type: "thread.goal.updated",
      threadId,
      goal: toThreadGoal(goal as ProtocolThreadGoal),
    };
  } catch {
    return undefined;
  }
}

function toGoalClearedEvent(value: unknown): ConversationInputEvent | undefined {
  const threadId = nonEmptyString(asRecord(value)?.threadId);
  return threadId ? { type: "thread.goal.cleared", threadId } : undefined;
}

function toThreadSettingsUpdatedEvent(
  value: unknown,
): ThreadStateEvent | undefined {
  const params = asRecord(value);
  const settings = asRecord(params?.threadSettings);
  const threadId = nonEmptyString(params?.threadId);
  const model = nonEmptyString(settings?.model);
  const effort = strictNullableString(settings?.effort);
  const serviceTier = strictNullableString(settings?.serviceTier);
  const collaborationMode = parseCollaborationMode(settings?.collaborationMode);
  if (
    !threadId
    || !model
    || !effort.valid
    || !serviceTier.valid
    || !collaborationMode
  ) {
    return undefined;
  }
  return {
    type: "thread.settings.updated",
    threadId,
    settings: {
      model,
      effort: effort.value,
      serviceTier: serviceTier.value,
      collaborationMode,
    },
  };
}

function parseCollaborationMode(value: unknown): "default" | "plan" | undefined {
  const mode = nonEmptyString(asRecord(value)?.mode);
  return mode === "default" || mode === "plan" ? mode : undefined;
}

function toThreadLifecycleEvent(
  type: "thread.archived" | "thread.deleted" | "thread.closed",
  value: unknown,
): ThreadStateEvent | undefined {
  const threadId = nonEmptyString(asRecord(value)?.threadId);
  return threadId ? { type, threadId } : undefined;
}

function toTurnStartedEvent(
  value: unknown,
  receivedAtMs: number | undefined,
): ConversationInputEvent | undefined {
  const params = asRecord(value);
  const threadId = nonEmptyString(params?.threadId);
  const turnId = nonEmptyString(asRecord(params?.turn)?.id);
  return threadId && turnId
    ? {
        type: "turn.started",
        threadId,
        turnId,
        ...(receivedAtMs === undefined ? {} : { receivedAtMs }),
      }
    : undefined;
}

function toTokenUsageEvent(value: unknown): ConversationInputEvent | undefined {
  const params = asRecord(value);
  const threadId = nonEmptyString(params?.threadId);
  const turnId = nonEmptyString(params?.turnId);
  const tokenUsage = parseThreadTokenUsage(asRecord(params?.tokenUsage));
  return threadId && turnId && tokenUsage
    ? { type: "thread.tokenUsage.updated", threadId, turnId, tokenUsage }
    : undefined;
}

function toTurnDiffEvent(value: unknown): ConversationInputEvent | undefined {
  const params = asRecord(value);
  const threadId = nonEmptyString(params?.threadId);
  const turnId = nonEmptyString(params?.turnId);
  const diff = stringValue(params?.diff);
  return threadId && turnId && diff !== undefined
    ? { type: "turn.diff.updated", threadId, turnId, diff }
    : undefined;
}

function toTurnPlanEvent(value: unknown): ConversationInputEvent | undefined {
  const params = asRecord(value);
  const threadId = nonEmptyString(params?.threadId);
  const turnId = nonEmptyString(params?.turnId);
  const explanation = strictNullableString(params?.explanation);
  const plan = parsePlanSteps(params?.plan);
  return threadId && turnId && explanation.valid && plan
    ? {
        type: "turn.plan.updated",
        threadId,
        turnId,
        explanation: explanation.value,
        plan,
      }
    : undefined;
}

function toAgentMessageDeltaEvent(
  value: unknown,
  receivedAtMs: number | undefined,
): ConversationInputEvent | undefined {
  const params = asRecord(value);
  const threadId = nonEmptyString(params?.threadId);
  const turnId = nonEmptyString(params?.turnId);
  const itemId = nonEmptyString(params?.itemId);
  const text = nonEmptyString(params?.delta);
  return threadId && turnId && itemId && text
    ? {
        type: "item.agentMessage.delta",
        threadId,
        turnId,
        itemId,
        text,
        ...(receivedAtMs === undefined ? {} : { receivedAtMs }),
      }
    : undefined;
}

function toReasoningHeartbeatEvent(
  value: unknown,
): ConversationInputEvent | undefined {
  const params = asRecord(value);
  const threadId = nonEmptyString(params?.threadId);
  const turnId = nonEmptyString(params?.turnId);
  const itemId = nonEmptyString(params?.itemId);
  return threadId && turnId && itemId
    ? {
        type: "item.reasoning.delta",
        threadId,
        turnId,
        itemId,
      }
    : undefined;
}

function toItemEvent(
  value: unknown,
  phase: "started" | "completed",
): ConversationInputEvent | undefined {
  const params = asRecord(value);
  const threadId = nonEmptyString(params?.threadId);
  const turnId = nonEmptyString(params?.turnId);
  const item = asRecord(params?.item);
  const itemId = nonEmptyString(item?.id);
  if (!threadId || !turnId || !item || !itemId) {
    return undefined;
  }
  if (item.type === "agentMessage") {
    const messagePhase = parseMessagePhase(item.phase);
    if (phase === "started") {
      return {
        type: "item.agentMessage.started",
        threadId,
        turnId,
        itemId,
        phase: messagePhase,
      };
    }
    const text = stringValue(item.text);
    return text === undefined
      ? undefined
      : {
          type: "item.agentMessage.completed",
          threadId,
          turnId,
          itemId,
          text,
          phase: messagePhase,
        };
  }
  if (item.type === "userMessage") {
    const clientId = strictNullableString(item.clientId);
    const text = userMessageText(item.content);
    return clientId.valid && text
      ? {
          type: "item.userMessage",
          threadId,
          turnId,
          itemId,
          clientId: clientId.value,
          text,
        }
      : undefined;
  }
  if (item.type === "subAgentActivity") {
    if (phase !== "completed") {
      return undefined;
    }
    const agentThreadId = nonEmptyString(item.agentThreadId);
    const agentPath = nonEmptyString(item.agentPath);
    const kind = parseSubagentActivityKind(item.kind);
    return agentThreadId && agentPath && kind
      ? {
          type: "item.subagentActivity",
          threadId,
          turnId,
          itemId,
          agentThreadId,
          agentPath,
          kind,
        }
      : undefined;
  }
  const operation = toOperationUpdate(item, phase);
  return operation
    ? { type: "item.operation.updated", threadId, turnId, operation }
    : undefined;
}

function parseSubagentActivityKind(
  value: unknown,
): "started" | "interacted" | "interrupted" | "completed" | undefined {
  return value === "started" || value === "interacted" || value === "interrupted"
      || value === "completed"
    ? value
    : undefined;
}

function toTurnErrorEvent(value: unknown): ConversationInputEvent | undefined {
  const params = asRecord(value);
  const threadId = nonEmptyString(params?.threadId);
  const turnId = nonEmptyString(params?.turnId);
  const error = parseTurnError(params?.error);
  const willRetry = params?.willRetry;
  return threadId && turnId && error.valid && error.value && typeof willRetry === "boolean"
    ? {
        type: "turn.error",
        threadId,
        turnId,
        message: error.value,
        willRetry,
        ...(error.errorCode ? { errorCode: error.errorCode } : {}),
      }
    : undefined;
}

function toTurnCompletedEvent(value: unknown): ConversationInputEvent | undefined {
  const params = asRecord(value);
  const threadId = nonEmptyString(params?.threadId);
  const turn = asRecord(params?.turn);
  const turnId = nonEmptyString(turn?.id);
  const status = parseTurnStatus(turn?.status);
  const error = parseTurnError(turn?.error);
  const durationMs = optionalDurationMs(turn?.durationMs);
  return threadId && turnId && status && error.valid && durationMs.valid
    ? {
        type: "turn.completed",
        threadId,
        turnId,
        status,
        error: error.value,
        ...(error.errorCode ? { errorCode: error.errorCode } : {}),
        ...(durationMs.value === undefined ? {} : { durationMs: durationMs.value }),
      }
    : undefined;
}

function toThreadStatusEvent(value: unknown): ConversationInputEvent | undefined {
  const params = asRecord(value);
  const threadId = nonEmptyString(params?.threadId);
  const status = parseThreadStatus(asRecord(params?.status)?.type);
  return threadId && status
    ? { type: "thread.status.changed", threadId, status }
    : undefined;
}

function toCoreThreadLifecycleEvent(
  type: "thread.closed" | "thread.archived" | "thread.deleted",
  value: unknown,
): ConversationInputEvent | undefined {
  const threadId = nonEmptyString(asRecord(value)?.threadId);
  return threadId ? { type, threadId } : undefined;
}

function toAccountUpdatedEvent(
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

function toRateLimitsUpdatedEvent(
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

function toMcpStatusEvent(
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

function toMcpOAuthCompletedEvent(
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

function toWarningEvent(
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

function parsePlanSteps(value: unknown): TurnPlanStep[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const steps: TurnPlanStep[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const step = nonEmptyString(record?.step);
    const status = parsePlanStepStatus(record?.status);
    if (!step || !status) {
      return undefined;
    }
    steps.push({ step, status });
  }
  return steps;
}

function parsePlanStepStatus(
  value: unknown,
): TurnPlanStep["status"] | undefined {
  return value === "pending" || value === "inProgress" || value === "completed"
    ? value
    : undefined;
}

function parseTurnStatus(value: unknown): TurnStatus | undefined {
  return value === "completed"
    || value === "interrupted"
    || value === "failed"
    || value === "inProgress"
    ? value
    : undefined;
}

function parseThreadStatus(value: unknown): string | undefined {
  return value === "notLoaded"
    || value === "idle"
    || value === "systemError"
    || value === "active"
    ? value
    : undefined;
}

function parseMessagePhase(value: unknown): MessagePhase | null {
  return value === "commentary" || value === "final_answer" ? value : null;
}

function parseTurnError(
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
  return value === ("misalignmentPolicyViolation" satisfies CodexErrorInfo)
    ? "misalignmentPolicyViolation"
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

function parsePlanType(
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

function parseRateLimitSnapshot(value: unknown): RateLimitSnapshot | undefined {
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

function parseThreadTokenUsage(
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

function userMessageText(value: unknown): string {
  return Array.isArray(value)
    ? value
        .map((input) => {
          const record = asRecord(input);
          return record?.type === "text" && typeof record.text === "string"
            ? record.text.trim()
            : "";
        })
        .filter(Boolean)
        .join("\n\n")
    : "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function strictNullableString(
  value: unknown,
): { valid: true; value: string | null } | { valid: false } {
  return typeof value === "string" || value === null
    ? { valid: true, value }
    : { valid: false };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalDurationMs(
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
