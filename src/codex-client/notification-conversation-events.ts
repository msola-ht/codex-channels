import type {
  ConversationInputEvent,
  TurnPlanStep,
} from "../conversation-core/index.js";
import type {
  ServerNotification,
  ThreadGoal as ProtocolThreadGoal,
  ThreadRevertedNotification,
} from "../codex-protocol/index.js";
import type { RpcNotification } from "./json-rpc.js";
import {
  toAccountUpdatedEvent,
  toMcpOAuthCompletedEvent,
  toMcpStatusEvent,
  toRateLimitsUpdatedEvent,
  toWarningEvent,
} from "./notification-account-events.js";
import {
  asRecord,
  nonEmptyString,
  optionalDurationMs,
  parseMessagePhase,
  parseThreadStatus,
  parseThreadTokenUsage,
  parseTurnError,
  parseTurnStatus,
  strictNullableString,
} from "./notification-parse-helpers.js";
import {
  toCoreThreadLifecycleEvent,
  toThreadNameUpdatedEvent,
} from "./notification-thread-state.js";
import { toOperationUpdate } from "./operation-adapter.js";
import { toThreadGoal } from "./turn-adapter.js";
import { stringValue } from "./value-primitives.js";

type CoreNotification = Extract<
  ServerNotification,
  {
    method:
      | "turn/started"
      | "hook/completed"
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

const coreMethods = {
  hookCompleted: "hook/completed",
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

export function toConversationInputEvent(
  notification: RpcNotification,
): ConversationInputEvent | undefined {
  switch (notification.method) {
    case coreMethods.hookCompleted:
      return toHookCompletedEvent(notification.params);
    case coreMethods.turnStarted:
      return toTurnStartedEvent(notification.params);
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
      return toAgentMessageDeltaEvent(notification.params);
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

function toHookCompletedEvent(value: unknown): ConversationInputEvent | undefined {
  type HookRun = Extract<ServerNotification, { method: "hook/completed" }>["params"]["run"];
  const params = asRecord(value);
  const threadId = nonEmptyString(params?.threadId);
  const run = asRecord(params?.run);
  const id = nonEmptyString(run?.id);
  const eventName = run?.eventName;
  const status = run?.status;
  const events = ["preToolUse", "permissionRequest", "postToolUse", "preCompact", "postCompact",
    "sessionStart", "sessionEnd", "userPromptSubmit", "subagentStart", "subagentStop", "stop", "interrupt"] as const satisfies readonly HookRun["eventName"][];
  if (!threadId || !id
    || typeof eventName !== "string" || !events.some((event) => event === eventName)
    || (status !== "completed" && status !== "failed" && status !== "blocked" && status !== "stopped")) return undefined;
  // Raw status messages, hook output and source paths can contain credentials or private data.
  return { type: "hook.completed", threadId, hook: { id, eventName, status } };
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

function toTurnStartedEvent(
  value: unknown,
): ConversationInputEvent | undefined {
  const params = asRecord(value);
  const threadId = nonEmptyString(params?.threadId);
  const turnId = nonEmptyString(asRecord(params?.turn)?.id);
  return threadId && turnId
    ? {
        type: "turn.started",
        threadId,
        turnId,
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
    if (item.delivery != null && item.delivery !== "async") return undefined;
    const messagePhase = item.delivery === "async" ? "commentary" : parseMessagePhase(item.phase);
    const questions = parseAsyncQuestions(item.questions);
    if (questions === false || (questions !== undefined && item.delivery !== "async")) {
      return undefined;
    }
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
          ...(item.delivery === "async" ? { delivery: "async" as const } : {}),
          ...(questions ? { questions } : {}),
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

function parseAsyncQuestions(value: unknown): Array<{ title: string; options: string[] }> | undefined | false {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length === 0) return false;
  const questions: Array<{ title: string; options: string[] }> = [];
  for (const entry of value) {
    const question = asRecord(entry);
    const title = nonEmptyString(question?.title);
    const options: unknown = question?.options;
    if (!title?.trim() || (options != null && (!Array.isArray(options) || options.length === 0
      || !options.every((option: unknown) => typeof option === "string" && option.trim().length > 0)))) {
      return false;
    }
    questions.push({ title, options: options == null ? [] : options as string[] });
  }
  return questions;
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
