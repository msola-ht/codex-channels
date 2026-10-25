import { parseQqGroupConversationId } from "../../policy/index.js";

/** Group recipients are explicit so an opaque C2C OpenID can never select a group endpoint. */
export type QqRecipient = string | { readonly groupOpenId: string };

export function qqConversationActor(conversationId: string): string | undefined {
  if (conversationId.startsWith("c2c:") && conversationId.length > 4) return conversationId.slice(4);
  return parseQqGroupConversationId(conversationId)?.memberOpenId;
}

export function qqConversationRecipient(conversationId: string): QqRecipient {
  const group = parseQqGroupConversationId(conversationId);
  if (group) return { groupOpenId: group.groupOpenId };
  if (conversationId.startsWith("c2c:") && conversationId.length > 4) return conversationId.slice(4);
  throw new Error("QQ 会话地址无效");
}

/** The physical group shares ordering and quotas across its separate member conversations. */
export function qqRecipientKey(recipient: QqRecipient): string {
  return typeof recipient === "string" ? JSON.stringify(["c2c", recipient]) : JSON.stringify(["group", recipient.groupOpenId]);
}

export function boundedQqConversationId(value: unknown): value is string {
  return typeof value === "string" && (parseQqGroupConversationId(value) !== undefined
    || value.length > 4 && value.startsWith("c2c:") && Buffer.byteLength(value) <= 512
      && !/[\p{Cc}\uD800-\uDFFF]/u.test(value));
}
