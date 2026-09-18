import type { IncomingHttpHeaders } from "node:http";
import { StringDecoder } from "node:string_decoder";

import type { RawData } from "ws";

/** 单条记录的正文上限；超出后按记录切分，转储内存占用保持有界。 */
const recordPayloadLimitBytes = 1_048_576;
/** 精简时整段缓冲正文再折叠，超过该上限后按原样分片。 */
const compactionBufferLimitBytes = 32 * 1_048_576;
/** 单个 SSE 事件的解析上限；超过后停止解析终态，但不影响原始 trace。 */
const sseEventLimitCharacters = 1_048_576;
/** 摘要字段只接受短字符串，避免扫描器为异常字段持续累积内存。 */
const maximumJsonFieldCharacters = 4_096;

const credentialHeaderNames = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "openai-api-key",
  "x-goog-api-key",
]);

export function bodyBufferLimit(inputItems: number, itemMaxBytes: number): number {
  return inputItems > 0 || itemMaxBytes > 0
    ? compactionBufferLimitBytes
    : recordPayloadLimitBytes;
}

export class BodyAccumulator {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;

  constructor(
    private readonly emit: (chunk: Buffer) => void,
    private readonly limitBytes: number,
  ) {}

  append(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    if (this.bytes >= this.limitBytes) this.drain();
  }

  drain(final = false): void {
    if (this.chunks.length === 0) return;
    const buffer = Buffer.concat(this.chunks, this.bytes);
    const heldBytes = final ? 0 : incompleteUtf8SuffixBytes(buffer);
    const emittedBytes = buffer.length - heldBytes;
    if (emittedBytes > 0) this.emit(buffer.subarray(0, emittedBytes));
    this.chunks.length = 0;
    if (heldBytes > 0) this.chunks.push(Buffer.from(buffer.subarray(emittedBytes)));
    this.bytes = heldBytes;
  }
}

/** 非最终分片保留末尾未收齐的 UTF-8 字符，避免把合法正文误判为二进制。 */
function incompleteUtf8SuffixBytes(buffer: Buffer): number {
  let start = buffer.length - 1;
  while (start >= 0 && isUtf8ContinuationByte(buffer[start]!)) start -= 1;
  if (start < 0 || buffer.length - start > 4) return 0;
  const lead = buffer[start]!;
  const expected = lead >= 0xc2 && lead <= 0xdf
    ? 2
    : lead >= 0xe0 && lead <= 0xef
      ? 3
      : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1;
  const available = buffer.length - start;
  return expected > available ? available : 0;
}

export class SseTerminalCollector {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private disabled = false;
  sawResponseEvent = false;
  terminal: { text: string; type: string } | undefined;

  append(chunk: Buffer): void {
    if (this.disabled) {
      this.decoder.write(chunk);
      return;
    }
    this.pending += this.decoder.write(chunk);
    this.consume(false);
  }

  end(): void {
    if (this.disabled) {
      this.decoder.end();
      return;
    }
    this.pending += this.decoder.end();
    this.consume(true);
  }

  private consume(final: boolean): void {
    const blocks = this.pending.split(/\r?\n\r?\n/u);
    const tail = blocks.pop() ?? "";
    this.pending = final ? "" : tail;
    for (const block of blocks) {
      if (!this.inspectBounded(block)) return;
    }
    if (tail.length > sseEventLimitCharacters) {
      this.disable();
      return;
    }
    if (final && tail.length > 0) this.inspect(tail);
  }

  private inspectBounded(block: string): boolean {
    if (block.length > sseEventLimitCharacters) {
      this.disable();
      return false;
    }
    this.inspect(block);
    return true;
  }

  private disable(): void {
    this.disabled = true;
    this.pending = "";
  }

  private inspect(block: string): void {
    const data = block.split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (data.length === 0 || data === "[DONE]") return;
    const parsed = parseJsonValue(data);
    const eventLine = block.split(/\r?\n/u).find((line) => line.startsWith("event:"));
    const type = eventTypeOf(parsed) ?? eventNameOf(eventLine);
    if (type === "error" || type?.startsWith("response.") === true) {
      this.sawResponseEvent = true;
    }
    if (isTerminalResponseType(type)) this.terminal = { text: data, type };
  }
}

type JsonFieldScanPhase =
  | "afterValue"
  | "colon"
  | "done"
  | "key"
  | "skipNested"
  | "skipPrimitive"
  | "start"
  | "value";
type JsonStringPurpose = "key" | "nested" | "skipValue" | "target";

export interface TopLevelStringFieldScanner {
  capture: string;
  captureOverflow: boolean;
  field: string;
  nestedDepth: number;
  pendingKey: string | undefined;
  phase: JsonFieldScanPhase;
  stringEscaped: boolean;
  stringPurpose: JsonStringPurpose | undefined;
  value: string | undefined;
}

/** 只保留键名和目标字符串，可以跨 HTTP 正文分片持续扫描。 */
export function createTopLevelStringFieldScanner(field: string): TopLevelStringFieldScanner {
  return {
    capture: "",
    captureOverflow: false,
    field,
    nestedDepth: 0,
    pendingKey: undefined,
    phase: "start",
    stringEscaped: false,
    stringPurpose: undefined,
    value: undefined,
  };
}

export function scanTopLevelStringField(
  scanner: TopLevelStringFieldScanner,
  text: string,
): void {
  if (scanner.phase === "done") return;
  for (const character of text) {
    if (scanner.stringPurpose !== undefined) {
      scanJsonStringCharacter(scanner, character);
      continue;
    }
    if (scanner.phase === "skipNested") {
      if (character === '"') beginJsonString(scanner, "nested");
      else if (character === "{" || character === "[") scanner.nestedDepth += 1;
      else if (character === "}" || character === "]") {
        scanner.nestedDepth -= 1;
        if (scanner.nestedDepth === 0) scanner.phase = "afterValue";
      }
      continue;
    }
    if (scanner.phase === "skipPrimitive") {
      if (character === ",") scanner.phase = "key";
      else if (character === "}") scanner.phase = "done";
      continue;
    }
    if (/\s/u.test(character)) continue;
    switch (scanner.phase) {
      case "start":
        scanner.phase = character === "{" ? "key" : "done";
        break;
      case "key":
        if (character === '"') beginJsonString(scanner, "key");
        else scanner.phase = "done";
        break;
      case "colon":
        scanner.phase = character === ":" ? "value" : "done";
        break;
      case "value":
        if (scanner.pendingKey === scanner.field) {
          if (character === '"') beginJsonString(scanner, "target");
          else scanner.phase = "done";
        } else {
          beginSkippedJsonValue(scanner, character);
        }
        break;
      case "afterValue":
        if (character === ",") scanner.phase = "key";
        else scanner.phase = "done";
        break;
      default:
        scanner.phase = "done";
        break;
    }
  }
}

function beginSkippedJsonValue(
  scanner: TopLevelStringFieldScanner,
  character: string,
): void {
  if (character === '"') {
    beginJsonString(scanner, "skipValue");
  } else if (character === "{" || character === "[") {
    scanner.nestedDepth = 1;
    scanner.phase = "skipNested";
  } else {
    scanner.phase = "skipPrimitive";
  }
}

function beginJsonString(
  scanner: TopLevelStringFieldScanner,
  purpose: JsonStringPurpose,
): void {
  scanner.capture = purpose === "key" || purpose === "target" ? '"' : "";
  scanner.captureOverflow = false;
  scanner.stringEscaped = false;
  scanner.stringPurpose = purpose;
}

function scanJsonStringCharacter(
  scanner: TopLevelStringFieldScanner,
  character: string,
): void {
  const purpose = scanner.stringPurpose;
  if ((purpose === "key" || purpose === "target") && !scanner.captureOverflow) {
    scanner.capture += character;
    if (scanner.capture.length > maximumJsonFieldCharacters) {
      scanner.capture = "";
      scanner.captureOverflow = true;
    }
  }
  if (scanner.stringEscaped) {
    scanner.stringEscaped = false;
    return;
  }
  if (character === "\\") {
    scanner.stringEscaped = true;
    return;
  }
  if (character !== '"') return;
  scanner.stringPurpose = undefined;
  if (purpose === "nested") return;
  if (purpose === "skipValue") {
    scanner.phase = "afterValue";
    return;
  }
  let value: unknown;
  if (!scanner.captureOverflow) {
    try {
      value = JSON.parse(scanner.capture);
    } catch {
      scanner.phase = "done";
      return;
    }
  }
  scanner.capture = "";
  if (purpose === "key") {
    scanner.pendingKey = typeof value === "string" ? value : undefined;
    scanner.phase = "colon";
    return;
  }
  if (typeof value === "string") scanner.value = value;
  scanner.phase = "done";
}

export function payloadOf<T extends { bytes: number }>(parts: T[]): {
  bytes: number;
  parts: T[];
} {
  return {
    bytes: parts.reduce((total, part) => total + part.bytes, 0),
    parts: [...parts],
  };
}

export function eventTypeOf(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const type = (parsed as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

export function isTerminalResponseType(type: string | undefined): type is string {
  return type === "response.completed"
    || type === "response.failed"
    || type === "response.incomplete"
    || type === "error";
}

export function responseStateOf(
  type: string | undefined,
): "completed" | "failed" | "incomplete" {
  if (type === "response.completed") return "completed";
  if (type === "response.incomplete") return "incomplete";
  return type === "response.failed" || type === "error" ? "failed" : "incomplete";
}

export function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

export function requestFieldsOf(
  parsed: unknown,
  headers?: Record<string, string | string[]>,
  knownModel?: string,
): {
  requestKind?: string;
  requestModel?: string;
  threadId?: string;
  turnId?: string;
} {
  const object = typeof parsed === "object" && parsed !== null
    ? parsed as Record<string, unknown>
    : {};
  const clientMetadata = typeof object.client_metadata === "object"
    && object.client_metadata !== null
    ? object.client_metadata as Record<string, unknown>
    : {};
  const rawTurnMetadata = parsed === undefined
    ? headers?.["x-codex-turn-metadata"]
    : clientMetadata["x-codex-turn-metadata"];
  const turnMetadataValue: unknown = Array.isArray(rawTurnMetadata)
    ? (rawTurnMetadata as unknown[])[0]
    : rawTurnMetadata;
  const turnMetadata: unknown = typeof turnMetadataValue === "string"
    ? parseJsonValue(turnMetadataValue)
    : turnMetadataValue;
  const metadata = typeof turnMetadata === "object" && turnMetadata !== null
    ? turnMetadata as Record<string, unknown>
    : {};
  const model = typeof object.model === "string" ? object.model : knownModel;
  const threadId = typeof metadata.thread_id === "string"
    ? metadata.thread_id
    : typeof clientMetadata.thread_id === "string" ? clientMetadata.thread_id : undefined;
  const turnId = typeof metadata.turn_id === "string"
    ? metadata.turn_id
    : typeof clientMetadata.turn_id === "string" ? clientMetadata.turn_id : undefined;
  return {
    ...(typeof metadata.request_kind === "string"
      ? { requestKind: metadata.request_kind }
      : {}),
    ...(model === undefined ? {} : { requestModel: model }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(turnId !== undefined && turnId.length > 0 ? { turnId } : {}),
  };
}

export function responseModelsOf(parsed: unknown): string[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const object = parsed as Record<string, unknown>;
  const response = typeof object.response === "object" && object.response !== null
    ? object.response as Record<string, unknown>
    : undefined;
  const model = response?.model ?? object.model;
  return typeof model === "string" ? [model] : [];
}

export function splitBuffer(buffer: Buffer): Buffer[] {
  if (buffer.length <= recordPayloadLimitBytes) return [buffer];
  const parts: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += recordPayloadLimitBytes) {
    parts.push(buffer.subarray(offset, offset + recordPayloadLimitBytes));
  }
  return parts;
}

export function splitText(text: string): string[] {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= recordPayloadLimitBytes) return [text];
  const parts: string[] = [];
  for (let offset = 0; offset < buffer.length;) {
    let end = Math.min(offset + recordPayloadLimitBytes, buffer.length);
    if (end < buffer.length) {
      while (end > offset && isUtf8ContinuationByte(buffer[end]!)) end -= 1;
    }
    parts.push(buffer.subarray(offset, end).toString("utf8"));
    offset = end;
  }
  return parts;
}

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

export function decodeUtf8(chunk: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(chunk);
  } catch {
    return null;
  }
}

/** 精简完整 JSON 或 SSE 正文，不改变保留事件的顺序。 */
export function compactText(text: string, inputItems: number, itemMaxBytes: number): string {
  if (inputItems <= 0 && itemMaxBytes <= 0) return text;
  const whole = compactJson(text, inputItems, itemMaxBytes);
  if (whole !== undefined) return whole;
  return compactSseText(text, inputItems, itemMaxBytes);
}

function compactSseText(text: string, inputItems: number, itemMaxBytes: number): string {
  const blocks = text.split(/\r?\n\r?\n/u);
  const tail = blocks.pop() ?? "";
  const kept: string[] = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/u);
    const index = lines.findIndex((line) => line.startsWith("data: "));
    const eventLine = lines.find((line) => line.startsWith("event: "));
    if (index === -1) {
      kept.push(block);
      continue;
    }
    const data = lines[index]!.slice("data: ".length);
    const parsed = parseJsonValue(data);
    if (isStreamDelta(parsed) || isStreamDeltaType(eventNameOf(eventLine))) continue;
    const compacted = compactJsonValue(parsed, inputItems, itemMaxBytes);
    if (compacted !== undefined) lines[index] = `data: ${compacted}`;
    kept.push(lines.join("\n"));
  }
  return [...kept, tail].join("\n\n");
}

function compactJson(
  text: string,
  inputItems: number,
  itemMaxBytes: number,
): string | undefined {
  return compactJsonValue(parseJsonValue(text), inputItems, itemMaxBytes);
}

function compactJsonValue(
  parsed: unknown,
  inputItems: number,
  itemMaxBytes: number,
): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return JSON.stringify(compactValue(parsed, inputItems, false, itemMaxBytes));
}

export function parseJsonValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function isStreamDelta(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null) return false;
  return isStreamDeltaType((parsed as { type?: unknown }).type);
}

function isStreamDeltaType(type: unknown): boolean {
  return typeof type === "string" && type.endsWith(".delta");
}

function eventNameOf(eventLine: string | undefined): string | undefined {
  return eventLine === undefined ? undefined : eventLine.slice("event: ".length).trim();
}

function compactValue(
  value: unknown,
  inputItems: number,
  inResponse: boolean,
  itemMaxBytes: number,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      capEntry(compactValue(item, inputItems, inResponse, itemMaxBytes), itemMaxBytes));
  }
  if (typeof value !== "object" || value === null) return value;
  const compacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "input" && Array.isArray(item)) {
      compacted[key] = compactInput(item, inputItems).map((entry) =>
        capEntry(entry, itemMaxBytes));
    } else if (inputItems > 0 && inResponse && foldableEcho(key, item)) {
      compacted[key] = omittedMarker(byteLengthOf(item));
    } else {
      compacted[key] = capValue(
        compactValue(item, inputItems, inResponse || key === "response", itemMaxBytes),
        itemMaxBytes,
      );
    }
  }
  return compacted;
}

function capEntry(value: unknown, itemMaxBytes: number): unknown {
  if (itemMaxBytes <= 0) return value;
  const bytes = byteLengthOf(value);
  if (bytes <= itemMaxBytes) return value;
  return truncatedMarker(value, itemMaxBytes, bytes);
}

function capValue(value: unknown, itemMaxBytes: number): unknown {
  if (itemMaxBytes <= 0 || typeof value !== "string") return value;
  return capEntry(value, itemMaxBytes);
}

function truncatedMarker(
  value: unknown,
  itemMaxBytes: number,
  bytes: number,
): Record<string, unknown> {
  const half = Math.floor(itemMaxBytes / 2);
  return {
    type: "truncated",
    bytes,
    head: excerpt(value, half, false),
    tail: excerpt(value, half, true),
  };
}

function excerpt(value: unknown, maxBytes: number, fromEnd: boolean): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  const buffer = Buffer.from(text, "utf8");
  const start = fromEnd ? Math.max(0, buffer.length - maxBytes) : 0;
  return buffer.subarray(start, start + maxBytes).toString("utf8");
}

function foldableEcho(key: string, value: unknown): boolean {
  if (key === "instructions") return typeof value === "string" && value.length > 0;
  if (key === "tools") return Array.isArray(value) && value.length > 0;
  return false;
}

function compactInput(items: unknown[], inputItems: number): unknown[] {
  if (inputItems <= 0 || items.length <= inputItems) return items;
  const omitted = items.slice(0, items.length - inputItems);
  return [
    {
      omitted_bytes: byteLengthOf(omitted),
      omitted_items: omitted.length,
      type: "omitted",
    },
    ...items.slice(items.length - inputItems),
  ];
}

function omittedMarker(bytes: number): string {
  return `<omitted ${bytes} 字节>`;
}

function byteLengthOf(value: unknown): number {
  return typeof value === "string"
    ? Buffer.byteLength(value)
    : Buffer.byteLength(JSON.stringify(value) ?? "");
}

export function rawDataBuffer(data: RawData): Buffer {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return data;
}

export function sanitizedHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    output[name] = credentialHeaderNames.has(name.toLowerCase())
      ? redactHeaderValue(value)
      : value;
  }
  return output;
}

function redactHeaderValue(value: string | string[]): string | string[] {
  return Array.isArray(value) ? value.map(redactedValue) : redactedValue(value);
}

function redactedValue(value: string): string {
  const scheme = /^(Bearer|Basic|Digest)\s/iu.exec(value);
  return scheme ? `${scheme[1]} <redacted>` : "<redacted>";
}

export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : "未知错误";
}
