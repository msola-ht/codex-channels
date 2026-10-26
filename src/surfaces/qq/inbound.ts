const MAX_IDENTIFIER_BYTES = 512;
const MAX_CONTENT_BYTES = 16 * 1024;
const MAX_EXT_ITEMS = 32;
const MAX_EXT_BYTES = 8 * 1024;
const MAX_TIMESTAMP_BYTES = 128;
const MAX_IMAGES = 4;
const MAX_IMAGE_METADATA_BYTES = 8 * 1024;
const MAX_IMAGE_URL_BYTES = 2048;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 5_000_000;
const MAX_REFERENCE_BYTES = 32 * 1024;
const CONTROL_CHARACTER = /\p{Cc}/u;
// With the Unicode flag, a valid surrogate pair is one non-surrogate code point.
const INVALID_UNICODE = /[\uD800-\uDFFF]/u;

export interface QqInboundTextMessage {
  readonly id: string;
  readonly actorId: string;
  readonly conversationId: string;
  readonly content: string;
  readonly msgIdx: string;
  readonly sentAtMs: number;
  readonly images?: readonly QqInboundImage[];
  readonly file?: QqInboundFile;
  readonly media?: QqInboundMedia;
  readonly quotedText?: string;
}

export type QqInboundMedia =
  | { readonly kind: "voice"; readonly referenceText?: string; readonly wavUrl?: string }
  | { readonly kind: "video"; readonly url: string; readonly size?: number };

export interface QqInboundFile {
  readonly url: string;
  readonly filename: string;
  readonly size?: number;
}

export interface QqInboundImage {
  readonly url: string;
  readonly filename?: string;
  readonly size?: number;
  readonly contentType: "image/jpeg" | "image/png" | "image/gif";
}

export type QqInboundFailureCategory = "malformed" | "unsupported" | "too-large";
export type QqInboundFailureField =
  | "envelope" | "message" | "message-type" | "scene"
  | "attachments" | "ark-data" | "message-elements"
  | "id" | "actor-id" | "content" | "ext" | "msg-idx" | "timestamp";
export type QqInboundFailureReason =
  | "invalid-type" | "invalid-value" | "invalid-unicode" | "empty"
  | "limit-exceeded" | "non-text" | "non-default-scene" | "reference"
  | "mixed-attachments" | "unsupported-attachment-fields" | "unsupported-attachment-type" | "missing-voice-content"
  | "missing-msg-idx" | "duplicate-msg-idx" | "unsupported-timestamp";

/** Only routing metadata survives rejection; rejected text and attachments never become input. */
export type QqRejectedInput = Pick<QqInboundTextMessage, "id" | "actorId" | "conversationId" | "msgIdx" | "sentAtMs"> & {
  readonly content: "";
  readonly rejection: QqInboundFailureReason;
};

export type QqTextEventResult =
  | { readonly kind: "supported"; readonly message: QqInboundTextMessage }
  | { readonly kind: "ignored"; readonly reason: "non-message-event" }
  | {
    readonly kind: "rejected";
    readonly category: QqInboundFailureCategory;
    readonly field: QqInboundFailureField;
    readonly reason: QqInboundFailureReason;
    readonly reply?: QqRejectedInput;
  };

type Rejection = Extract<QqTextEventResult, { kind: "rejected" }>;

/**
 * Parses an already decoded Dispatch envelope against the locked QQ event contract:
 * qq-api-v2-2026-10-23-message-reference/autogen/event/c2c_message_create.txt.
 * It grants no authorization, performs no deduplication or freshness check, and
 * returns only copied text, source fields and validated attachment metadata. It never
 * downloads attachments or forwards an event credential to an attachment URL.
 */
export function parseQqTextEvent(value: unknown): QqTextEventResult {
  if (!record(value) || value.op !== 0 || typeof value.t !== "string"
    || !/^[A-Z][A-Z0-9_]{0,79}$/u.test(value.t)) {
    return reject("malformed", "envelope", "invalid-value");
  }
  if (value.t !== "C2C_MESSAGE_CREATE") {
    return { kind: "ignored", reason: "non-message-event" };
  }
  const message = value.d;
  if (!record(message)) return reject("malformed", "message", "invalid-type");
  if (typeof message.message_type !== "number" || !Number.isInteger(message.message_type)) {
    return reject("malformed", "message-type", "invalid-type");
  }
  if (message.message_type !== 0 && message.message_type !== 103) return reject("unsupported", "message-type", "non-text");
  const scene = message.message_scene;
  if (!record(scene) || typeof scene.source !== "string") {
    return reject("malformed", "scene", "invalid-type");
  }
  if (scene.source !== "default") return reject("unsupported", "scene", "non-default-scene");

  if (message.message_type === 0 && "msg_elements" in message) {
    if (!Array.isArray(message.msg_elements)) return reject("malformed", "message-elements", "invalid-type");
    if (message.msg_elements.length > 0) return reject("unsupported", "message-elements", "non-text");
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
  if ("member_openid" in message.author && message.author.member_openid !== ""
    || "group_openid" in message && message.group_openid !== "") return reject("malformed", "actor-id", "invalid-value");
  const actorId = parseIdentifier(message.author.user_openid, "actor-id");
  if (typeof actorId !== "string") return actorId;
  const conversationId = `c2c:${actorId}`;
  if (typeof message.content !== "string") return reject("malformed", "content", "invalid-type");
  if (Buffer.byteLength(message.content, "utf8") > MAX_CONTENT_BYTES) {
    return reject("too-large", "content", "limit-exceeded");
  }
  if (INVALID_UNICODE.test(message.content)) return reject("malformed", "content", "invalid-unicode");

  if (!Array.isArray(scene.ext)) return reject("malformed", "ext", "invalid-type");
  if (scene.ext.length > MAX_EXT_ITEMS) return reject("too-large", "ext", "limit-exceeded");
  const extensions: readonly unknown[] = scene.ext;
  let extBytes = 0;
  let msgIdx: string | undefined;
  let refMsgIdx: string | undefined;
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
    if (key === "ref_msg_idx") {
      if (message.message_type !== 103) return reject("unsupported", "ext", "reference");
      if (refMsgIdx !== undefined) return reject("malformed", "ext", "reference");
      const candidate = parseIdentifier(entry.slice(separator + 1), "msg-idx");
      if (typeof candidate !== "string") return candidate;
      refMsgIdx = candidate;
      continue;
    }
    if (key !== "msg_idx") continue;
    if (msgIdx !== undefined) return reject("malformed", "msg-idx", "duplicate-msg-idx");
    const candidate = parseIdentifier(entry.slice(separator + 1), "msg-idx");
    if (typeof candidate !== "string") return candidate;
    msgIdx = candidate;
  }
  if (msgIdx === undefined) return reject("malformed", "msg-idx", "missing-msg-idx");
  const quotedText = message.message_type === 103 ? parseReference(message.msg_elements, refMsgIdx) : undefined;
  if (quotedText !== undefined && typeof quotedText !== "string") return quotedText;
  const timestamp = parseTimestamp(message.timestamp);
  if (typeof timestamp !== "number") return timestamp;
  // Validate the whole message source before making an attachment rejection replyable.
  // Admission still owns allowlists, freshness, deduplication and send authorization.
  const attachmentFailure = (failure: Rejection): Rejection => ({ ...failure, reply: {
    id, actorId, conversationId, msgIdx, sentAtMs: timestamp, content: "", rejection: failure.reason,
  } });
  const attachments = "attachments" in message ? message.attachments : [];
  const media = parseMedia(attachments);
  if (media && "category" in media) return attachmentFailure(media);
  const file = parseFile(media ? [] : attachments);
  if (file && "kind" in file) return attachmentFailure(file);
  const images = parseImages(file || media ? [] : attachments);
  if (!Array.isArray(images)) return attachmentFailure(images);
  if (message.content.trim().length === 0 && images.length === 0 && !file && !media) return reject("malformed", "content", "empty");
  // The validated strings are copied individually; no upstream object escapes.
  return {
    kind: "supported",
    message: {
      id,
      actorId,
      conversationId,
      content: message.content,
      msgIdx,
      sentAtMs: timestamp,
      ...(images.length > 0 ? { images } : {}),
      ...(file ? { file } : {}),
      ...(media ? { media } : {}),
      ...(quotedText !== undefined ? { quotedText } : {}),
    },
  };
}

function parseMedia(value: unknown): QqInboundMedia | Rejection | undefined {
  if (!Array.isArray(value)) return reject("malformed", "attachments", "invalid-type");
  if (value.length > MAX_IMAGES) return reject("too-large", "attachments", "limit-exceeded");
  if (!value.some((item: unknown) => record(item) && (item.content_type === "voice" || item.content_type === "video/mp4"))) return;
  if (value.length !== 1) return reject("unsupported", "attachments", "mixed-attachments");
  const item: unknown = value[0];
  if (!record(item)) return reject("malformed", "attachments", "invalid-type");
  const voice = item.content_type === "voice";
  const keys = ["url", "filename", "size", "content_type", ...(voice ? ["voice_wav_url", "asr_refer_text"] : [])];
  if (Object.keys(item).some(key => !keys.includes(key))) return reject("unsupported", "attachments", "unsupported-attachment-fields");
  const metadata = parseAttachmentMetadata(item, voice ? undefined : 64 * 1024 * 1024);
  if ("kind" in metadata) return metadata;
  if (!voice) return { kind: "video", url: metadata.url, ...(metadata.size !== undefined ? { size: metadata.size } : {}) };
  let referenceText: string | undefined;
  if ("asr_refer_text" in item) {
    if (typeof item.asr_refer_text !== "string") return reject("malformed", "attachments", "invalid-type");
    if (Buffer.byteLength(item.asr_refer_text) > MAX_CONTENT_BYTES) return reject("too-large", "attachments", "limit-exceeded");
    if (INVALID_UNICODE.test(item.asr_refer_text)) return reject("malformed", "attachments", "invalid-unicode");
    if (item.asr_refer_text.trim()) referenceText = item.asr_refer_text;
  }
  let wavUrl: string | undefined;
  if ("voice_wav_url" in item) {
    const parsed = parseAttachmentUrl(item.voice_wav_url);
    if (typeof parsed !== "string") return parsed;
    wavUrl = parsed;
  }
  if (!referenceText && !wavUrl) return reject("unsupported", "attachments", "missing-voice-content");
  return { kind: "voice", ...(referenceText ? { referenceText } : {}), ...(wavUrl ? { wavUrl } : {}) };
}

function parseFile(value: unknown): QqInboundFile | Rejection | undefined {
  if (!Array.isArray(value)) return reject("malformed", "attachments", "invalid-type");
  if (value.length > MAX_IMAGES) return reject("too-large", "attachments", "limit-exceeded");
  const files = value.filter((item: unknown) => record(item) && item.content_type === "file");
  if (!files.length) return;
  if (value.length !== 1) return reject("unsupported", "attachments", "mixed-attachments");
  const file: unknown = files[0];
  if (!record(file) || Object.keys(file).some(key => !["url", "filename", "size", "content_type"].includes(key))) {
    return reject("unsupported", "attachments", "unsupported-attachment-fields");
  }
  const validated = parseAttachmentMetadata(file, MAX_FILE_BYTES);
  if ("kind" in validated) return validated;
  if (typeof file.filename !== "string") return reject("malformed", "attachments", "invalid-type");
  if (Buffer.byteLength(file.filename) > 255) return reject("too-large", "attachments", "limit-exceeded");
  if (typeof file.size === "number" && file.size > MAX_FILE_BYTES) return reject("too-large", "attachments", "limit-exceeded");
  return { ...validated, filename: file.filename };
}

function parseReference(value: unknown, refMsgIdx: string | undefined): string | Rejection {
  if (!refMsgIdx || !Array.isArray(value)) return reject("malformed", "message-elements", "reference");
  // Bound the entire untrusted tree before serializing or considering a match.
  let nodes = 0;
  let bytes = 0;
  const bounded = (node: unknown, depth: number): boolean => {
    if (++nodes > 256 || depth > 8) return false;
    if (typeof node === "string") { bytes += Buffer.byteLength(node); return bytes <= MAX_REFERENCE_BYTES && !INVALID_UNICODE.test(node); }
    if (Array.isArray(node)) return node.length <= 32 && node.every(child => bounded(child, depth + 1));
    if (record(node)) return Object.keys(node).length <= 32 && Object.entries(node).every(([key, child]) => bounded(key, depth + 1) && bounded(child, depth + 1));
    return node === null || typeof node === "number" || typeof node === "boolean";
  };
  if (!bounded(value, 0) || Buffer.byteLength(JSON.stringify(value)) > MAX_REFERENCE_BYTES) {
    return reject("too-large", "message-elements", "limit-exceeded");
  }
  const seen = new Set<string>();
  let selected: Record<string, unknown> | undefined;
  for (const element of value as unknown[]) {
    if (!record(element)) return reject("malformed", "message-elements", "invalid-type");
    const index = parseIdentifier(element.msg_idx, "msg-idx");
    if (typeof index !== "string") return index;
    if (seen.has(index)) return reject("malformed", "message-elements", "reference");
    seen.add(index);
    // Nested histories are not an input source in this batch.
    if ("msg_elements" in element && (!Array.isArray(element.msg_elements) || element.msg_elements.length > 0)) {
      return reject("unsupported", "message-elements", "reference");
    }
    if (index === refMsgIdx) selected = element;
  }
  if (!selected) return reject("malformed", "message-elements", "reference");
  if (selected.message_type !== 0 && selected.message_type !== 103) return reject("unsupported", "message-elements", "non-text");
  if (typeof selected.content !== "string") return reject("malformed", "message-elements", "invalid-type");
  if ("ark_data" in selected && (!record(selected.ark_data) || Object.keys(selected.ark_data).length > 0)) {
    return reject("unsupported", "message-elements", "non-text");
  }
  if ("attachments" in selected && !Array.isArray(selected.attachments)) return reject("malformed", "attachments", "invalid-type");
  const annotations: string[] = [];
  for (const attachment of (selected.attachments ?? []) as unknown[]) {
    if (!record(attachment) || typeof attachment.content_type !== "string") return reject("malformed", "attachments", "invalid-type");
    // Only a fixed annotation escapes; URLs, filenames and credentials never do.
    annotations.push(attachment.content_type.startsWith("image/") ? "[引用消息包含图片，未读取]" : "[引用消息包含附件，未读取]");
  }
  const text = [selected.content, ...annotations].filter(Boolean).join("\n");
  if (!text.trim()) return reject("malformed", "message-elements", "empty");
  return text;
}

function parseImages(value: unknown): QqInboundImage[] | Rejection {
  if (!Array.isArray(value)) return reject("malformed", "attachments", "invalid-type");
  if (value.length > MAX_IMAGES) return reject("too-large", "attachments", "limit-exceeded");
  const images: QqInboundImage[] = [];
  let metadataBytes = 0;
  for (const attachment of value as unknown[]) {
    if (!record(attachment)) return reject("malformed", "attachments", "invalid-type");
    if (Object.keys(attachment).some(key => !["url", "filename", "size", "content_type", "width", "height"].includes(key))) {
      return reject("unsupported", "attachments", "unsupported-attachment-fields");
    }
    const contentType = attachment.content_type;
    if (typeof contentType !== "string") return reject("malformed", "attachments", "invalid-type");
    if (contentType !== "image/jpeg" && contentType !== "image/png" && contentType !== "image/gif") {
      return reject("unsupported", "attachments", "unsupported-attachment-type");
    }
    const metadata = parseAttachmentMetadata(attachment, MAX_IMAGE_BYTES);
    if ("kind" in metadata) return metadata;
    metadataBytes += Buffer.byteLength(JSON.stringify(attachment));
    if (metadataBytes > MAX_IMAGE_METADATA_BYTES) return reject("too-large", "attachments", "limit-exceeded");
    images.push({ ...metadata, contentType });
  }
  return images;
}

function parseAttachmentUrl(url: unknown): string | Rejection {
  if (typeof url !== "string") return reject("malformed", "attachments", "invalid-type");
  if (Buffer.byteLength(url) > MAX_IMAGE_URL_BYTES) return reject("too-large", "attachments", "limit-exceeded");
  if (INVALID_UNICODE.test(url)) return reject("malformed", "attachments", "invalid-unicode");
  if (!/^https:\/\/[^/?#]/u.test(url) || /[\s\p{Cc}\p{Cf}\\]/u.test(url)) return reject("malformed", "attachments", "invalid-value");
  let parsed: URL;
  try { parsed = new URL(url); } catch { return reject("malformed", "attachments", "invalid-value"); }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.hash
    || url.includes("#") || url.slice("https://".length).split(/[/?#]/u, 1)[0]?.includes("@")
    || (parsed.port && parsed.port !== "443")) return reject("malformed", "attachments", "invalid-value");
  return url;
}

function parseAttachmentMetadata(attachment: Record<string, unknown>, maximumBytes: number | undefined): Omit<QqInboundFile, "filename"> & { filename?: string } | Rejection {
  const url = parseAttachmentUrl(attachment.url);
  if (typeof url !== "string") return url;
  const filename = attachment.filename;
  if ("filename" in attachment) {
    if (typeof filename !== "string") return reject("malformed", "attachments", "invalid-type");
    if (Buffer.byteLength(filename) > MAX_IDENTIFIER_BYTES) return reject("too-large", "attachments", "limit-exceeded");
    if (INVALID_UNICODE.test(filename)) return reject("malformed", "attachments", "invalid-unicode");
    if (!filename.trim() || /[\p{Cc}\p{Cf}\\/]/u.test(filename) || filename === "." || filename === "..") {
      return reject("malformed", "attachments", "invalid-value");
    }
  }
  const size = attachment.size;
  if ("size" in attachment) {
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
      return reject("malformed", "attachments", "invalid-value");
    }
    if (maximumBytes !== undefined && size > maximumBytes) return reject("too-large", "attachments", "limit-exceeded");
  }
  for (const dimension of ["width", "height"] as const) {
    if (dimension in attachment && (typeof attachment[dimension] !== "number"
      || !Number.isSafeInteger(attachment[dimension]) || attachment[dimension] <= 0)) {
      return reject("malformed", "attachments", "invalid-value");
    }
  }
  return { url,
    ...(typeof filename === "string" ? { filename } : {}),
    ...(typeof size === "number" ? { size } : {}),
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

export function parseTimestamp(value: unknown): number | Rejection {
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
