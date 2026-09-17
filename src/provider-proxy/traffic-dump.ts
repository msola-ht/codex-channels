import {
  closeSync,
  createWriteStream,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  type WriteStream,
} from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";

import type { RawData } from "ws";

import {
  securePrivateDirectorySync,
  securePrivateFileSync,
} from "../../runtime/private-file.mjs";

/** 单条记录的正文上限；超出后按记录切分，转储内存占用保持有界。 */
const recordPayloadLimitBytes = 1_048_576;
/** 单个转储文件上限，达到后写入下一个文件。 */
const fileSizeLimitBytes = 64 * 1_048_576;
/** 同一目录保留的转储文件数量，超出后删除最旧文件。 */
const retainedFileCount = 5;
/** 待写缓冲达到该大小后立即落盘，不等待请求结束。 */
const flushThresholdBytes = 262_144;

/** 只保留认证方案，凭据本身不写盘。 */
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

export interface ModelTrafficDumpOptions {
  /** 转储目录，通常为 Gateway 数据目录下的 traffic 目录。 */
  directory: string;
  /**
   * 精简模式下 `input` 保留的末尾条目数；`0` 表示按原样转储完整报文。
   * 大于 `0` 时同时折叠响应回显的 `instructions` 与 `tools`。
   */
  inputItems?: number;
  /** 文件名前缀，用于区分主 Provider 与隔离 Provider。 */
  label: string;
  onError: (error: Error) => void;
}

export interface ModelTrafficHttpExchangeInput {
  accountId?: string;
  headers: IncomingHttpHeaders;
  method: string;
  path: string;
  startedAtMs: number;
}

export interface ModelTrafficWebSocketExchangeInput {
  accountId?: string;
  headers: IncomingHttpHeaders;
  startedAtMs: number;
  url: string;
}

/**
 * 模型请求转储：把统计代理两侧的完整报文按 JSON Lines 写入私有文件。
 * 只做旁路复制，不改变转发、背压和指标采集行为；写入失败时停止转储并由 onError 上报。
 */
export class ModelTrafficDump {
  private readonly directory: string;
  private readonly inputItems: number;
  private readonly label: string;
  private readonly onError: (error: Error) => void;
  private readonly streams = new Set<WriteStream>();
  private stream: WriteStream | undefined;
  private pending: string[] = [];
  private pendingBytes = 0;
  private writtenBytes = 0;
  private fileIndex = 1;
  private exchangeCount = 0;
  private closed = false;
  private failed = false;

  constructor(options: ModelTrafficDumpOptions) {
    this.directory = options.directory;
    this.inputItems = options.inputItems ?? 0;
    this.label = options.label.replace(/[^A-Za-z0-9._-]+/gu, "_");
    this.onError = options.onError;
  }

  beginHttpExchange(input: ModelTrafficHttpExchangeInput): ModelTrafficExchange {
    const exchange = this.createExchange(input);
    exchange.write({
      kind: "request_head",
      method: input.method,
      path: input.path,
      headers: sanitizedHeaders(input.headers),
    });
    return exchange;
  }

  beginWebSocketExchange(
    input: ModelTrafficWebSocketExchangeInput,
  ): ModelTrafficExchange {
    const exchange = this.createExchange(input);
    exchange.write({
      kind: "websocket_handshake",
      url: input.url,
      headers: sanitizedHeaders(input.headers),
    });
    return exchange;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.flush();
    this.stream = undefined;
    await Promise.all([...this.streams].map((stream) =>
      new Promise<void>((resolveClose) => {
        stream.once("close", () => resolveClose());
        stream.end();
      })));
  }

  private createExchange(input: {
    accountId?: string;
    startedAtMs: number;
  }): ModelTrafficExchange {
    this.exchangeCount += 1;
    return new ModelTrafficExchange(
      {
        exchange: this.exchangeCount,
        startedAtMs: input.startedAtMs,
        ...(input.accountId === undefined ? {} : { account: input.accountId }),
      },
      (record) => this.write(record),
      this.inputItems,
    );
  }

  private write(record: Record<string, unknown>): void {
    if (this.closed || this.failed) return;
    const line = `${JSON.stringify({ ts: Date.now(), ...record })}\n`;
    this.pending.push(line);
    this.pendingBytes += Buffer.byteLength(line);
    if (this.pendingBytes >= flushThresholdBytes) this.flush();
  }

  private flush(): void {
    if (this.failed || this.pending.length === 0) return;
    const content = this.pending.join("");
    const contentBytes = Buffer.byteLength(content);
    this.pending = [];
    this.pendingBytes = 0;
    try {
      if (this.stream && this.writtenBytes + contentBytes > fileSizeLimitBytes) {
        this.rotate();
      }
      this.writtenBytes += contentBytes;
      this.ensureStream().write(content);
    } catch (error) {
      this.fail(error);
    }
  }

  private rotate(): void {
    const stream = this.stream;
    this.stream = undefined;
    this.writtenBytes = 0;
    this.fileIndex += 1;
    stream?.end();
  }

  private ensureStream(): WriteStream {
    if (this.stream) return this.stream;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    securePrivateDirectorySync(this.directory);
    let path: string;
    for (;;) {
      path = join(this.directory, this.fileName());
      try {
        closeSync(openSync(path, "wx", 0o600));
        break;
      } catch (error) {
        if (isFileExistsError(error)) {
          this.fileIndex += 1;
          continue;
        }
        throw error;
      }
    }
    securePrivateFileSync(path);
    const stream = createWriteStream(path, { flags: "a" });
    stream.on("error", (error: unknown) => this.fail(error));
    stream.on("close", () => this.streams.delete(stream));
    this.streams.add(stream);
    this.stream = stream;
    this.retainNewestFiles();
    return stream;
  }

  private fileName(): string {
    const startedAt = new Date().toISOString().replace(/[:.]/gu, "-");
    return `${this.label}-${startedAt}-${this.fileIndex}.jsonl`;
  }

  private retainNewestFiles(): void {
    const prefix = `${this.label}-`;
    const own = readdirSync(this.directory)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".jsonl"))
      .sort();
    for (const name of own.slice(0, Math.max(0, own.length - retainedFileCount))) {
      try {
        rmSync(join(this.directory, name), { force: true });
      } catch (error) {
        this.fail(error);
      }
    }
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    const stream = this.stream;
    this.stream = undefined;
    this.pending = [];
    this.pendingBytes = 0;
    stream?.destroy();
    this.onError(error instanceof Error ? error : new Error(String(error)));
  }
}

/** 单次请求或 WebSocket 连接的转储记录，正文按上限切分为多条记录。 */
export class ModelTrafficExchange {
  private readonly requestBody: BodyAccumulator;
  private readonly responseBody: BodyAccumulator;
  private requestBytes = 0;
  private responseBytes = 0;
  private failureRecorded = false;

  constructor(
    private readonly prefix: {
      exchange: number;
      startedAtMs: number;
      account?: string;
    },
    private readonly sink: (record: Record<string, unknown>) => void,
    private readonly inputItems: number,
  ) {
    this.requestBody = new BodyAccumulator(
      (part, chunk) => this.writeBody("request_body", part, chunk),
    );
    this.responseBody = new BodyAccumulator(
      (part, chunk) => this.writeBody("response_body", part, chunk),
    );
  }

  write(record: Record<string, unknown>): void {
    this.sink({ ...this.prefix, ...record });
  }

  requestChunk(chunk: Buffer): void {
    this.requestBytes += chunk.length;
    this.requestBody.append(chunk);
  }

  requestEnd(): void {
    this.requestBody.drain();
    this.write({ kind: "request_end", bytes: this.requestBytes });
  }

  responseHead(status: number | null, headers: IncomingHttpHeaders): void {
    this.write({
      kind: "response_head",
      status,
      headers: sanitizedHeaders(headers),
    });
  }

  responseChunk(chunk: Buffer): void {
    this.responseBytes += chunk.length;
    this.responseBody.append(chunk);
  }

  responseEnd(): void {
    this.responseBody.drain();
    this.write({
      kind: "response_end",
      bytes: this.responseBytes,
      durationMs: Date.now() - this.prefix.startedAtMs,
    });
  }

  webSocketFrame(
    direction: "client" | "upstream",
    data: RawData,
    isBinary: boolean,
  ): void {
    const buffer = rawDataBuffer(data);
    if (!isBinary) {
      const parts = splitText(compactText(buffer.toString("utf8"), this.inputItems));
      parts.forEach((text, index) => {
        this.write({
          kind: "websocket_frame",
          direction,
          binary: false,
          part: index + 1,
          parts: parts.length,
          bytes: buffer.length,
          encoding: "utf8",
          text,
        });
      });
      return;
    }
    const parts = splitBuffer(buffer);
    parts.forEach((part, index) => {
      this.write({
        kind: "websocket_frame",
        direction,
        binary: true,
        part: index + 1,
        parts: parts.length,
        bytes: buffer.length,
        encoding: "base64",
        data: part.toString("base64"),
      });
    });
  }

  webSocketClose(
    peer: "client" | "upstream",
    code: number,
    reason: Buffer,
  ): void {
    const text = reason.toString("utf8");
    this.write({
      kind: "websocket_close",
      peer,
      code,
      ...(text.length === 0 ? {} : { reason: text.slice(0, 512) }),
    });
  }

  failure(scope: string, error?: unknown): void {
    if (this.failureRecorded) return;
    this.failureRecorded = true;
    this.requestBody.drain();
    this.responseBody.drain();
    this.write({
      kind: "error",
      scope,
      ...(error === undefined ? {} : { message: errorText(error) }),
    });
  }

  private writeBody(kind: string, part: number, chunk: Buffer): void {
    const decoded = decodeUtf8(chunk);
    const text = decoded === null ? null : compactText(decoded, this.inputItems);
    this.write({
      kind,
      part,
      bytes: chunk.length,
      ...(text === null
        ? { encoding: "base64", data: chunk.toString("base64") }
        : { encoding: "utf8", text }),
    });
  }
}

class BodyAccumulator {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private part = 1;

  constructor(
    private readonly emit: (part: number, chunk: Buffer) => void,
  ) {}

  append(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    if (this.bytes >= recordPayloadLimitBytes) this.drain();
  }

  drain(): void {
    if (this.chunks.length === 0) return;
    this.emit(this.part, Buffer.concat(this.chunks));
    this.chunks.length = 0;
    this.bytes = 0;
    this.part += 1;
  }
}

function splitBuffer(buffer: Buffer): Buffer[] {
  if (buffer.length <= recordPayloadLimitBytes) return [buffer];
  const parts: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += recordPayloadLimitBytes) {
    parts.push(buffer.subarray(offset, offset + recordPayloadLimitBytes));
  }
  return parts;
}

function splitText(text: string): string[] {
  if (Buffer.byteLength(text) <= recordPayloadLimitBytes) return [text];
  const parts: string[] = [];
  for (let offset = 0; offset < text.length; offset += recordPayloadLimitBytes) {
    parts.push(text.slice(offset, offset + recordPayloadLimitBytes));
  }
  return parts;
}

function decodeUtf8(chunk: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(chunk);
  } catch {
    return null;
  }
}

/**
 * 精简模式：`input` 只保留末尾若干条，并折叠响应回显的 `instructions` 与 `tools`。
 * 完整 JSON 直接折叠；SSE 正文按 `data:` 行逐条折叠，不改变事件分帧。
 */
function compactText(text: string, inputItems: number): string {
  if (inputItems <= 0) return text;
  const whole = compactJson(text, inputItems);
  if (whole !== undefined) return whole;
  return text.split("\n").map((line) => {
    if (!line.startsWith("data: ")) return line;
    const data = compactJson(line.slice("data: ".length), inputItems);
    return data === undefined ? line : `data: ${data}`;
  }).join("\n");
}

function compactJson(text: string, inputItems: number): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return JSON.stringify(compactValue(parsed, inputItems, false));
}

function compactValue(value: unknown, inputItems: number, inResponse: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => compactValue(item, inputItems, inResponse));
  }
  if (typeof value !== "object" || value === null) return value;
  const compacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "input" && Array.isArray(item)) {
      compacted[key] = compactInput(item, inputItems);
    } else if (inResponse && foldableEcho(key, item)) {
      compacted[key] = omittedMarker(byteLengthOf(item));
    } else {
      compacted[key] = compactValue(item, inputItems, inResponse || key === "response");
    }
  }
  return compacted;
}

/** 只折叠有内容的响应回显字段，空字符串与空数组原样保留。 */
function foldableEcho(key: string, value: unknown): boolean {
  if (key === "instructions") return typeof value === "string" && value.length > 0;
  if (key === "tools") return Array.isArray(value) && value.length > 0;
  return false;
}

function compactInput(items: unknown[], inputItems: number): unknown[] {
  if (items.length <= inputItems) return items;
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

function rawDataBuffer(data: RawData): Buffer {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return data;
}

function sanitizedHeaders(
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
  return Array.isArray(value)
    ? value.map(redactedValue)
    : redactedValue(value);
}

function redactedValue(value: string): string {
  const scheme = /^(Bearer|Basic|Digest)\s/iu.exec(value);
  return scheme ? `${scheme[1]} <redacted>` : "<redacted>";
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : "未知错误";
}
