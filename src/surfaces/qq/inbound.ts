const MAX_IDENTIFIER_BYTES = 512;
const MAX_CONTENT_BYTES = 16 * 1024;
const MAX_EXT_ITEMS = 32;
const MAX_EXT_BYTES = 8 * 1024;
const MAX_TIMESTAMP_BYTES = 128;
const CONTROL_CHARACTER = /\p{Cc}/u;
// With the Unicode flag, a valid surrogate pair is one non-surrogate code point.
const INVALID_UNICODE = /[\uD800-\uDFFF]/u;

export interface QqInboundTextMessage {
  readonly id: string;
  readonly actorId: string;
  readonly content: string;
  readonly msgIdx: string;
  readonly sentAtMs: number;
}

export type QqInboundFailureCategory = "malformed" | "unsupported" | "too-large";
export type QqInboundFailureField =
  | "envelope" | "message" | "message-type" | "scene"
  | "attachments" | "ark-data" | "message-elements"
  | "id" | "actor-id" | "content" | "ext" | "msg-idx" | "timestamp";
export type QqInboundFailureReason =
  | "invalid-type" | "invalid-value" | "invalid-unicode" | "empty"
  | "limit-exceeded" | "non-text" | "non-default-scene" | "reference"
  | "missing-msg-idx" | "duplicate-msg-idx" | "unsupported-timestamp";

export type QqTextEventResult =
  | { readonly kind: "supported"; readonly message: QqInboundTextMessage }
  | { readonly kind: "ignored"; readonly reason: "non-c2c-event" }
  | {
    readonly kind: "rejected";
    readonly category: QqInboundFailureCategory;
    readonly field: QqInboundFailureField;
    readonly reason: QqInboundFailureReason;
  };

type Rejection = Extract<QqTextEventResult, { kind: "rejected" }>;

/**
 * Parses an already decoded Dispatch envelope against the locked QQ event contract:
 * qq-api-v2-2026-10-23-message-reference/autogen/event/c2c_message_create.txt.
 * It grants no authorization, performs no deduplication or freshness check, and
 * returns no original event, extension list, credential or attachment data.
 */
export function parseQqTextEvent(value: unknown): QqTextEventResult {
  if (!record(value) || value.op !== 0 || typeof value.t !== "string"
    || !/^[A-Z][A-Z0-9_]{0,79}$/u.test(value.t)) {
    return reject("malformed", "envelope", "invalid-value");
  }
  if (value.t !== "C2C_MESSAGE_CREATE") {
    return { kind: "ignored", reason: "non-c2c-event" };
  }
  const message = value.d;
  if (!record(message)) return reject("malformed", "message", "invalid-type");
  if (typeof message.message_type !== "number" || !Number.isInteger(message.message_type)) {
    return reject("malformed", "message-type", "invalid-type");
  }
  if (message.message_type !== 0) return reject("unsupported", "message-type", "non-text");
  const scene = message.message_scene;
  if (!record(scene) || typeof scene.source !== "string") {
    return reject("malformed", "scene", "invalid-type");
  }
  if (scene.source !== "default") return reject("unsupported", "scene", "non-default-scene");

  for (const [key, field] of [
    ["attachments", "attachments"], ["msg_elements", "message-elements"],
  ] as const) {
    if (!(key in message)) continue;
    const elements: unknown = message[key];
    if (!Array.isArray(elements)) return reject("malformed", field, "invalid-type");
    if (elements.length > 0) return reject("unsupported", field, "non-text");
  }
  if ("ark_data" in message) {
    if (!record(message.ark_data)) return reject("malformed", "ark-data", "invalid-type");
    if (Object.keys(message.ark_data).length > 0) {
      return reject("unsupported", "ark-data", "non-text");
    }
  }

  const id = parseIdentifier(message.id, "id");
  if (typeof id !== "string") return id;
  if (!record(message.author)) return reject("malformed", "actor-id", "invalid-type");
  const actorId = parseIdentifier(message.author.user_openid, "actor-id");
  if (typeof actorId !== "string") return actorId;
  if (typeof message.content !== "string") return reject("malformed", "content", "invalid-type");
  if (Buffer.byteLength(message.content, "utf8") > MAX_CONTENT_BYTES) {
    return reject("too-large", "content", "limit-exceeded");
  }
  if (INVALID_UNICODE.test(message.content)) return reject("malformed", "content", "invalid-unicode");
  if (message.content.trim().length === 0) return reject("malformed", "content", "empty");

  if (!Array.isArray(scene.ext)) return reject("malformed", "ext", "invalid-type");
  if (scene.ext.length > MAX_EXT_ITEMS) return reject("too-large", "ext", "limit-exceeded");
  const extensions: readonly unknown[] = scene.ext;
  let extBytes = 0;
  let msgIdx: string | undefined;
  for (const entry of extensions) {
    if (typeof entry !== "string") return reject("malformed", "ext", "invalid-type");
    extBytes += Buffer.byteLength(entry, "utf8");
    if (extBytes > MAX_EXT_BYTES) return reject("too-large", "ext", "limit-exceeded");
    if (INVALID_UNICODE.test(entry)) return reject("malformed", "ext", "invalid-unicode");
    const separator = entry.indexOf("=");
    if (separator <= 0 || CONTROL_CHARACTER.test(entry.slice(0, separator))) {
      return reject("malformed", "ext", "invalid-value");
    }
    const key = entry.slice(0, separator);
    if (key === "ref_msg_idx") return reject("unsupported", "ext", "reference");
    if (key !== "msg_idx") continue;
    if (msgIdx !== undefined) return reject("malformed", "msg-idx", "duplicate-msg-idx");
    const candidate = parseIdentifier(entry.slice(separator + 1), "msg-idx");
    if (typeof candidate !== "string") return candidate;
    msgIdx = candidate;
  }
  if (msgIdx === undefined) return reject("malformed", "msg-idx", "missing-msg-idx");

  const timestamp = parseTimestamp(message.timestamp);
  if (typeof timestamp !== "number") return timestamp;
  // The validated strings are copied individually; no upstream object escapes.
  return {
    kind: "supported",
    message: {
      id,
      actorId,
      content: message.content,
      msgIdx,
      sentAtMs: timestamp,
    },
  };
}

function parseIdentifier(value: unknown, field: "id" | "actor-id" | "msg-idx"): string | Rejection {
  if (typeof value !== "string") return reject("malformed", field, "invalid-type");
  if (Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES) {
    return reject("too-large", field, "limit-exceeded");
  }
  if (INVALID_UNICODE.test(value)) return reject("malformed", field, "invalid-unicode");
  if (value.length === 0) return reject("malformed", field, "empty");
  if (CONTROL_CHARACTER.test(value)) return reject("malformed", field, "invalid-value");
  return value;
}

function parseTimestamp(value: unknown): number | Rejection {
  if (typeof value !== "string") return reject("malformed", "timestamp", "invalid-type");
  if (value.length > MAX_TIMESTAMP_BYTES || Buffer.byteLength(value, "utf8") > MAX_TIMESTAMP_BYTES) {
    return reject("too-large", "timestamp", "limit-exceeded");
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match) return reject("malformed", "timestamp", "invalid-value");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > (monthDays[month - 1] ?? 0)
    || hour > 23 || minute > 59 || second > 60 || offsetHour > 23 || offsetMinute > 59) {
    return reject("malformed", "timestamp", "invalid-value");
  }
  // Leap seconds have no distinct representation in the Unix-millisecond result.
  if (second === 60) {
    return reject("unsupported", "timestamp", "unsupported-timestamp");
  }
  const milliseconds = Number((match[7] ?? "").slice(0, 3).padEnd(3, "0"));
  // RFC3339 -00:00 still identifies a UTC instant; only the local offset is unknown.
  const offset = (match[9] === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  const date = new Date(0);
  // setUTCFullYear preserves years 0000–0099 instead of treating them as 1900–1999.
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milliseconds);
  return date.getTime() - offset * 60_000;
}

function reject(
  category: QqInboundFailureCategory,
  field: QqInboundFailureField,
  reason: QqInboundFailureReason,
): Rejection {
  return { kind: "rejected", category, field, reason };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
