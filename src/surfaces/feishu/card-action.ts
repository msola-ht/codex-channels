export type FeishuCardActionField =
  | "event"
  | "context"
  | "context.open_message_id"
  | "context.open_chat_id"
  | "operator"
  | "operator.open_id"
  | "action"
  | "action.tag"
  | "action.name"
  | "action.form_name"
  | "action.value"
  | "action.form_value";

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
  formValues?: Readonly<Record<string, string>>;
}

export function decodeFeishuCardAction(input: unknown): FeishuCardAction {
  const event = requireRecord(input, "event");
  const context = requireRecord(event.context, "context");
  const operator = requireRecord(event.operator, "operator");
  const action = requireRecord(event.action, "action");

  const formValues = optionalStringRecord(
    action.form_value,
    "action.form_value",
  );
  const tag = requireString(action.tag, "action.tag");
  return {
    messageId: requireString(
      context.open_message_id,
      "context.open_message_id",
    ),
    chatId: requireString(context.open_chat_id, "context.open_chat_id"),
    actorOpenId: requireString(operator.open_id, "operator.open_id"),
    tag,
    value: normalizedActionValue(action, tag),
    ...(formValues === undefined ? {} : { formValues }),
  };
}

function normalizedActionValue(
  action: Record<string, unknown>,
  tag: string,
): Readonly<Record<string, string>> {
  if (action.value !== undefined) {
    return requireStringRecord(action.value, "action.value");
  }
  const name = optionalString(action.name, "action.name");
  const formName = optionalString(action.form_name, "action.form_name");
  const prefix = "codexc_submit_";
  const token = name?.startsWith(prefix)
    ? name.slice(prefix.length)
    : undefined;
  if (
    (tag !== "button" && tag !== "form_submit")
    || (formName !== undefined
      && formName !== "codexc_user_input"
      && formName !== "codexc_mcp_form")
    || !token
    || token.length > 64
    || !/^[A-Za-z0-9_-]+$/u.test(token)
  ) {
    throw new FeishuCardActionError("action.value");
  }
  return {
    interaction_token: token,
    decision: "submit",
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

function optionalString(
  value: unknown,
  field: FeishuCardActionField,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, field);
}

function requireStringRecord(
  value: unknown,
  field: FeishuCardActionField,
  maximumEntries = 8,
  maximumValueLength = 256,
): Readonly<Record<string, string>> {
  const record = requireRecord(value, field);
  const entries = Object.entries(record);
  if (
    entries.length === 0
    || entries.length > maximumEntries
    || entries.some(
      ([key, entry]) =>
        key.length === 0
        || key.length > 64
        || typeof entry !== "string"
        || entry.length > maximumValueLength,
    )
  ) {
    throw new FeishuCardActionError(field);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function optionalStringRecord(
  value: unknown,
  field: FeishuCardActionField,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireStringRecord(value, field, 4, 1_000);
}
