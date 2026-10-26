/** Explicit group recipients remain a protocol primitive, without a business conversation entry point. */
export type QqRecipient = string | { readonly groupOpenId: string };

export function qqConversationActor(conversationId: string): string | undefined {
  if (conversationId.startsWith("c2c:") && conversationId.length > 4) return conversationId.slice(4);
  return undefined;
}

export function qqConversationRecipient(conversationId: string): string {
  if (conversationId.startsWith("c2c:") && conversationId.length > 4) return conversationId.slice(4);
  throw new Error("QQ 会话地址无效");
}

/** Business output only accepts a C2C recipient. */
export function qqRecipientKey(recipient: QqRecipient): string {
  if (typeof recipient !== "string") throw new Error("QQ 收件目标不受支持");
  return JSON.stringify(["c2c", recipient]);
}

export function boundedQqConversationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 4 && value.startsWith("c2c:") && Buffer.byteLength(value) <= 512
    && !/[\p{Cc}\uD800-\uDFFF]/u.test(value);
}
