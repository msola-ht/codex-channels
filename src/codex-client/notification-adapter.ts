import type { ThreadStateEvent } from "../session-routing/index.js";
import type { ServerNotification } from "../codex-protocol/index.js";
import type { RpcNotification } from "./json-rpc.js";

type RoutingNotification = Extract<
  ServerNotification,
  {
    method:
      | "thread/settings/updated"
      | "thread/archived"
      | "thread/deleted"
      | "thread/closed";
  }
>;

const routingMethods = {
  settingsUpdated: "thread/settings/updated",
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

function toThreadSettingsUpdatedEvent(
  value: unknown,
): ThreadStateEvent | undefined {
  const params = asRecord(value);
  const settings = asRecord(params?.threadSettings);
  const threadId = nonEmptyString(params?.threadId);
  const model = nonEmptyString(settings?.model);
  const effort = nullableString(settings?.effort);
  const serviceTier = nullableString(settings?.serviceTier);
  if (!threadId || !model || !effort.valid || !serviceTier.valid) {
    return undefined;
  }
  return {
    type: "thread.settings.updated",
    threadId,
    settings: {
      model,
      effort: effort.value,
      serviceTier: serviceTier.value,
    },
  };
}

function toThreadLifecycleEvent(
  type: "thread.archived" | "thread.deleted" | "thread.closed",
  value: unknown,
): ThreadStateEvent | undefined {
  const threadId = nonEmptyString(asRecord(value)?.threadId);
  return threadId ? { type, threadId } : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nullableString(
  value: unknown,
): { valid: true; value: string | null } | { valid: false } {
  return typeof value === "string" || value === null
    ? { valid: true, value }
    : { valid: false };
}
