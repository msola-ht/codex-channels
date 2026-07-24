import type { RpcNotification } from "../codex-client/index.js";
import type { SessionRouter } from "./router.js";

const unavailableThreadNotifications = new Set([
  "thread/closed",
  "thread/archived",
  "thread/deleted",
]);

export class ThreadStateSynchronizer {
  constructor(private readonly router: SessionRouter) {}

  handle(notification: RpcNotification): void {
    if (notification.method === "thread/settings/updated") {
      const params = asRecord(notification.params);
      const settings = asRecord(params?.threadSettings);
      const threadId = stringValue(params?.threadId);
      const model = stringValue(settings?.model);
      const effort = nullableString(settings?.effort);
      const serviceTier = nullableString(settings?.serviceTier);
      if (threadId && model && effort.valid && serviceTier.valid) {
        this.router.updateModelSettings(threadId, {
          model,
          effort: effort.value,
          serviceTier: serviceTier.value,
        });
      }
      return;
    }

    if (unavailableThreadNotifications.has(notification.method)) {
      const threadId = stringValue(asRecord(notification.params)?.threadId);
      if (threadId) {
        this.router.forgetThread(threadId);
      }
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nullableString(
  value: unknown,
): { valid: true; value: string | null } | { valid: false } {
  return typeof value === "string" || value === null
    ? { valid: true, value }
    : { valid: false };
}
