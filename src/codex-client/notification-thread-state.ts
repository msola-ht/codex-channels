import type { ConversationInputEvent } from "../conversation-core/index.js";
import type {
  ServerNotification,
  ThreadQueueChangedNotification,
} from "../codex-protocol/index.js";
import type { ThreadStateEvent } from "../session-routing/index.js";
import type { RpcNotification } from "./json-rpc.js";
import {
  asRecord,
  nonEmptyString,
  strictNullableString,
} from "./notification-parse-helpers.js";
import { toThreadApprovalsReviewer } from "./thread-adapter.js";

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

const routingMethods = {
  settingsUpdated: "thread/settings/updated",
  nameUpdated: "thread/name/updated",
  archived: "thread/archived",
  deleted: "thread/deleted",
  closed: "thread/closed",
} as const satisfies Record<string, RoutingNotification["method"]>;

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

/** 线程名变更的共享解析：Thread 缺失即忽略，空白名称归一为 null。 */
function parseThreadNameUpdated(value: unknown): { threadId: string; name: string | null } | undefined {
  const params = asRecord(value);
  const threadId = nonEmptyString(params?.threadId);
  if (!threadId) return undefined;
  const name = params?.threadName;
  return { threadId, name: typeof name === "string" && name.trim() ? name : null };
}

function parseThreadId(value: unknown): string | undefined {
  return nonEmptyString(asRecord(value)?.threadId);
}

function toThreadNameUpdatedStateEvent(value: unknown): ThreadStateEvent | undefined {
  const parsed = parseThreadNameUpdated(value);
  return parsed ? { type: "thread.name.updated", ...parsed } : undefined;
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
      approvalsReviewer: toThreadApprovalsReviewer(settings?.approvalsReviewer),
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
  const threadId = parseThreadId(value);
  return threadId ? { type, threadId } : undefined;
}

export function toThreadNameUpdatedEvent(value: unknown): ConversationInputEvent | undefined {
  const parsed = parseThreadNameUpdated(value);
  return parsed ? { type: "thread.name.updated", ...parsed } : undefined;
}

export function toCoreThreadLifecycleEvent(
  type: "thread.closed" | "thread.archived" | "thread.deleted",
  value: unknown,
): ConversationInputEvent | undefined {
  const threadId = parseThreadId(value);
  return threadId ? { type, threadId } : undefined;
}
