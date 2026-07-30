export type FeishuMessageEventField =
  | "event"
  | "event_id"
  | "app_id"
  | "sender"
  | "sender.sender_id"
  | "sender.sender_id.open_id"
  | "sender.sender_type"
  | "message"
  | "message.message_id"
  | "message.create_time"
  | "message.chat_id"
  | "message.chat_type"
  | "message.message_type"
  | "message.content"
  | "message.parent_id";

export class FeishuMessageEventError extends Error {
  readonly code = "invalid-message-event";

  constructor(readonly field: FeishuMessageEventField) {
    super(`飞书消息事件字段无效：${field}`);
    this.name = "FeishuMessageEventError";
  }
}

export interface FeishuMessageEvent {
  eventId?: string;
  appId?: string;
  actorOpenId: string;
  senderType: string;
  messageId: string;
  createTime: string;
  chatId: string;
  chatType: string;
  messageType: string;
  content: string;
  parentId?: string;
}

const maximumIdentifierBytes = 1_024;
const maximumTimestampBytes = 32;
const maximumTypeBytes = 64;
const maximumContentBytes = 150 * 1_024;

export function decodeFeishuMessageEvent(input: unknown): FeishuMessageEvent {
  const event = requireRecord(input, "event");
  const sender = requireRecord(event.sender, "sender");
  const senderId = requireRecord(sender.sender_id, "sender.sender_id");
  const message = requireRecord(event.message, "message");
  const eventId = optionalString(event.event_id, "event_id");
  const appId = optionalString(event.app_id, "app_id");
  const parentId = optionalString(
    message.parent_id,
    "message.parent_id",
  );

  return {
    ...(eventId === undefined ? {} : { eventId }),
    ...(appId === undefined ? {} : { appId }),
    actorOpenId: requireString(
      senderId.open_id,
      "sender.sender_id.open_id",
      maximumIdentifierBytes,
    ),
    senderType: requireString(
      sender.sender_type,
      "sender.sender_type",
      maximumTypeBytes,
    ),
    messageId: requireString(
      message.message_id,
      "message.message_id",
      maximumIdentifierBytes,
    ),
    createTime: requireString(
      message.create_time,
      "message.create_time",
      maximumTimestampBytes,
    ),
    chatId: requireString(
      message.chat_id,
      "message.chat_id",
      maximumIdentifierBytes,
    ),
    chatType: requireString(
      message.chat_type,
      "message.chat_type",
      maximumTypeBytes,
    ),
    messageType: requireString(
      message.message_type,
      "message.message_type",
      maximumTypeBytes,
    ),
    content: requireString(
      message.content,
      "message.content",
      maximumContentBytes,
      true,
    ),
    ...(parentId === undefined ? {} : { parentId }),
  };
}

function requireRecord(
  value: unknown,
  field: FeishuMessageEventField,
): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new FeishuMessageEventError(field);
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  field: FeishuMessageEventField,
  maximumBytes: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new FeishuMessageEventError(field);
  }
  return value;
}

function optionalString(
  value: unknown,
  field: FeishuMessageEventField,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, field, maximumIdentifierBytes);
}
