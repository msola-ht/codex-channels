export type FeishuCardActionField =
  | "event"
  | "context"
  | "context.open_message_id"
  | "context.open_chat_id"
  | "operator"
  | "operator.open_id"
  | "action"
  | "action.tag"
  | "action.value";

export class FeishuCardActionError extends Error {
  readonly code = "invalid-card-action";

  constructor(readonly field: FeishuCardActionField) {
    super(`飞书卡片动作字段无效：${field}`);
    this.name = "FeishuCardActionError";
  }
}

export interface FeishuCardAction {
  messageId: string;
  chatId: string;
  actorOpenId: string;
  tag: string;
  value: Readonly<Record<string, string>>;
}

export function decodeFeishuCardAction(input: unknown): FeishuCardAction {
  const event = requireRecord(input, "event");
  const context = requireRecord(event.context, "context");
  const operator = requireRecord(event.operator, "operator");
  const action = requireRecord(event.action, "action");

  return {
    messageId: requireString(
      context.open_message_id,
      "context.open_message_id",
    ),
    chatId: requireString(context.open_chat_id, "context.open_chat_id"),
    actorOpenId: requireString(operator.open_id, "operator.open_id"),
    tag: requireString(action.tag, "action.tag"),
    value: requireStringRecord(action.value, "action.value"),
  };
}

function requireRecord(
  value: unknown,
  field: FeishuCardActionField,
): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new FeishuCardActionError(field);
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  field: FeishuCardActionField,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FeishuCardActionError(field);
  }
  return value;
}

function requireStringRecord(
  value: unknown,
  field: FeishuCardActionField,
): Readonly<Record<string, string>> {
  const record = requireRecord(value, field);
  const entries = Object.entries(record);
  if (
    entries.length === 0
    || entries.length > 8
    || entries.some(
      ([key, entry]) =>
        key.length === 0
        || key.length > 64
        || typeof entry !== "string"
        || entry.length > 256,
    )
  ) {
    throw new FeishuCardActionError(field);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}
