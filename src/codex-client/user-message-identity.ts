import type { UserMessageIdentity } from "../conversation-core/index.js";
import type { ServerNotification } from "../codex-protocol/index.js";
import type { RpcNotification } from "./json-rpc.js";
import { asRecord } from "./notification-parse-helpers.js";

type ItemStarted = Extract<ServerNotification, { method: "item/started" }>;
const itemStartedMethod = "item/started" satisfies ItemStarted["method"];
const userMessageType = "userMessage" satisfies ItemStarted["params"]["item"]["type"];

/** Project identity before asynchronous consumers, including for media-only input. */
export function toUserMessageIdentity(notification: RpcNotification): UserMessageIdentity | undefined {
  if (notification.method !== itemStartedMethod) return undefined;
  const params = asRecord(notification.params);
  const item = asRecord(params?.item);
  if (item?.type !== userMessageType) return undefined;
  const threadId = identityString(params?.threadId);
  const turnId = identityString(params?.turnId);
  const itemId = identityString(item.id);
  const clientUserMessageId = identityString(item.clientId);
  if (!threadId || !turnId || !itemId || !clientUserMessageId) return undefined;
  // Never read content: text, media, paths and credentials stay outside this port.
  return Object.freeze({ threadId, turnId, itemId, clientUserMessageId });
}

function identityString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim().length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value)
    ? value : undefined;
}
