export type FeishuMenuEventField =
  | "event"
  | "event_id"
  | "app_id"
  | "operator"
  | "operator.operator_id"
  | "operator.operator_id.open_id"
  | "event_key";

export class FeishuMenuEventError extends Error {
  readonly code = "invalid-menu-event";

  constructor(readonly field: FeishuMenuEventField) {
    super(`飞书机器人菜单事件字段无效：${field}`);
    this.name = "FeishuMenuEventError";
  }
}

export interface FeishuMenuEvent {
  eventId: string;
  appId: string;
  actorOpenId: string;
  eventKey: string;
}

export function decodeFeishuMenuEvent(input: unknown): FeishuMenuEvent {
  const event = requireRecord(input, "event");
  const operator = requireRecord(event.operator, "operator");
  const operatorId = requireRecord(
    operator.operator_id,
    "operator.operator_id",
  );
  return {
    eventId: requireString(event.event_id, "event_id", 128),
    appId: requireString(event.app_id, "app_id", 128),
    actorOpenId: requireString(
      operatorId.open_id,
      "operator.operator_id.open_id",
      128,
    ),
    eventKey: requireString(event.event_key, "event_key", 128),
  };
}

function requireRecord(
  value: unknown,
  field: FeishuMenuEventField,
): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new FeishuMenuEventError(field);
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  field: FeishuMenuEventField,
  maximumLength: number,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
  ) {
    throw new FeishuMenuEventError(field);
  }
  return value;
}
