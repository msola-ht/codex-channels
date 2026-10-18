import type { ReasoningGuardInput } from "../application/index.js";
import type { RpcNotification } from "./json-rpc.js";
import { asRecord, nonEmptyString } from "./notification-parse-helpers.js";

/** Raw text is transient guard input, never a channel event or a persisted metric. */
export function toReasoningGuardInput(notification: RpcNotification): ReasoningGuardInput | undefined {
  if (!["item/reasoning/textDelta", "item/reasoning/summaryTextDelta", "item/started", "item/completed"].includes(notification.method)) return undefined;
  const params = asRecord(notification.params);
  const threadId = nonEmptyString(params?.threadId);
  const turnId = nonEmptyString(params?.turnId);
  if (!threadId || !turnId || threadId.length > 256 || turnId.length > 256) return undefined;
  if (notification.method === "item/started" || notification.method === "item/completed") {
    return nonEmptyString(asRecord(params?.item)?.id) ? { kind: "boundary", threadId, turnId } : undefined;
  }
  const itemId = nonEmptyString(params?.itemId);
  const source = notification.method === "item/reasoning/textDelta" ? "raw" : "summary";
  const index = source === "raw" ? params?.contentIndex : params?.summaryIndex;
  return itemId && itemId.length <= 256 && typeof index === "number" && Number.isSafeInteger(index) && index >= 0
    && typeof params?.delta === "string"
    ? { kind: "delta", source, threadId, turnId, itemId, contentIndex: index, delta: params.delta } : undefined;
}
