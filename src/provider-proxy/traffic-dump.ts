import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { RawData } from "ws";

import {
  securePrivateDirectorySync,
  securePrivateFileSync,
} from "../../runtime/private-file.mjs";

/** 单条记录的正文上限；超出后按记录切分，转储内存占用保持有界。 */
const recordPayloadLimitBytes = 1_048_576;
/**
 * 开启精简时先整段缓冲正文再折叠：分片只能是完整正文的一半，无法折叠半截 JSON。
 * 超过该上限时按原样分片写出，避免为超大正文无限占用内存。
 */
const compactionBufferLimitBytes = 32 * 1_048_576;
/** 单个正文或 trace 文件上限，达到后写入下一个文件。 */
const fileSizeLimitBytes = 64 * 1_048_576;
/** 同一 Provider 的历史完整 session 约保留 320 MiB；当前 session 不在写入中途删除。 */
const retainedBytesPerLabel = 5 * fileSizeLimitBytes;
/** 待写缓冲达到该大小后立即落盘，不等待请求结束。 */
const flushThresholdBytes = 262_144;
/** 低流量时的最长落盘等待，兼顾实时查看与小记录合并。 */
const flushIntervalMs = 100;
/** 单个 SSE 事件的解析上限；超过后停止解析终态，但不影响报文转发与原始 trace。 */
const sseEventLimitCharacters = 1_048_576;
/** 摘要字段只接受短字符串，避免扫描器为异常字段持续累积内存。 */
const maximumJsonFieldCharacters = 4_096;

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
  /**
   * 单个数组条目的正文上限（字节）；超过时只保留头尾并写入截断标记。
   * `0` 或不设置表示按原样转储。
   */
  itemMaxBytes?: number;
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

interface TrafficPayloadPart {
  bytes: number;
  encoding: "base64" | "utf8";
  file: string;
  offset: number;
}

interface TrafficPayload {
  bytes: number;
  parts: TrafficPayloadPart[];
}

/**
 * 模型请求转储：把统计代理两侧的完整报文按 JSON Lines 写入私有文件。
 * 只做旁路复制，不改变转发、背压和指标采集行为；写入失败时停止转储并由 onError 上报。
 */
export class ModelTrafficDump {
  private readonly directory: string;
  private readonly inputItems: number;
  private readonly itemMaxBytes: number;
  private readonly label: string;
  private readonly onError: (error: Error) => void;
  private readonly writerSession = new Date().toISOString().replace(/[:.]/gu, "-");
  private readonly streams = new Set<WriteStream>();
  private sessionDirectory: string | undefined;
  private traceStream: WriteStream | undefined;
  private interactionStream: WriteStream | undefined;
  private payloadStream: WriteStream | undefined;
  private pending: string[] = [];
  private pendingBytes = 0;
  private flushTimer: NodeJS.Timeout | undefined;
  private traceWrittenBytes = 0;
  private traceFileIndex = 1;
  private payloadWrittenBytes = 0;
  private payloadFileIndex = 1;
  private connectionCount = 0;
  private interactionCount = 0;
  private writeQueue = Promise.resolve();
  private closed = false;
  private failed = false;

  constructor(options: ModelTrafficDumpOptions) {
    this.directory = options.directory;
    this.inputItems = options.inputItems ?? 0;
    this.itemMaxBytes = options.itemMaxBytes ?? 0;
    this.label = options.label.replace(/[^A-Za-z0-9._-]+/gu, "_");
    this.onError = options.onError;
  }

  beginHttpExchange(input: ModelTrafficHttpExchangeInput): ModelTrafficExchange {
    const exchange = this.createExchange(input, "http");
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
    const exchange = this.createExchange(input, "websocket");
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
    await this.writeQueue;
    this.traceStream = undefined;
    this.interactionStream = undefined;
    this.payloadStream = undefined;
    await Promise.all([...this.streams].map((stream) =>
      new Promise<void>((resolveClose) => {
        stream.once("close", () => resolveClose());
        stream.end();
      })));
  }

  private createExchange(input: {
    accountId?: string;
    startedAtMs: number;
  }, transport: "http" | "websocket"): ModelTrafficExchange {
    this.connectionCount += 1;
    const interactionId = transport === "http" ? this.nextInteractionId() : undefined;
    return new ModelTrafficExchange(
      {
        connection: this.connectionCount,
        startedAtMs: input.startedAtMs,
        ...(input.accountId === undefined ? {} : { account: input.accountId }),
      },
      transport,
      interactionId,
      (record) => this.writeTrace(record),
      (record) => this.writeInteraction(record),
      (content, encoding) => this.writePayload(content, encoding),
      () => this.nextInteractionId(),
      this.inputItems,
      this.itemMaxBytes,
    );
  }

  private nextInteractionId(): number {
    this.interactionCount += 1;
    return this.interactionCount;
  }

  private writeTrace(record: Record<string, unknown>): void {
    if (this.closed || this.failed) return;
    const line = `${JSON.stringify({ ts: Date.now(), ...record })}\n`;
    this.pending.push(line);
    this.pendingBytes += Buffer.byteLength(line);
    if (this.pendingBytes >= flushThresholdBytes) {
      this.flush();
      return;
    }
    this.scheduleFlush();
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.failed || this.pending.length === 0) return;
    const content = this.pending.join("");
    const contentBytes = Buffer.byteLength(content);
    this.pending = [];
    this.pendingBytes = 0;
    try {
      if (this.traceStream && this.traceWrittenBytes + contentBytes > fileSizeLimitBytes) {
        this.rotateTrace();
      }
      this.traceWrittenBytes += contentBytes;
      const stream = this.ensureTraceStream();
      this.enqueueWrite(stream, content);
    } catch (error) {
      this.fail(error);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, flushIntervalMs);
    this.flushTimer.unref();
  }

  private rotateTrace(): void {
    const stream = this.traceStream;
    this.traceStream = undefined;
    this.traceWrittenBytes = 0;
    this.traceFileIndex += 1;
    if (stream) this.enqueueClose(stream);
  }

  private writeInteraction(record: Record<string, unknown>): void {
    if (this.closed || this.failed) return;
    try {
      const line = `${JSON.stringify({ version: 2, ts: Date.now(), ...record })}\n`;
      this.enqueueWrite(this.ensureInteractionStream(), line);
    } catch (error) {
      this.fail(error);
    }
  }

  private writePayload(
    content: Buffer,
    encoding: "base64" | "utf8",
  ): TrafficPayloadPart | undefined {
    if (this.closed || this.failed) return undefined;
    try {
      if (this.payloadStream && this.payloadWrittenBytes > 0
        && this.payloadWrittenBytes + content.length > fileSizeLimitBytes) {
        const stream = this.payloadStream;
        this.payloadStream = undefined;
        this.payloadWrittenBytes = 0;
        this.payloadFileIndex += 1;
        this.enqueueClose(stream);
      }
      const stream = this.ensurePayloadStream();
      const part = {
        bytes: content.length,
        encoding,
        file: `payload-${this.payloadFileIndex}.bin`,
        offset: this.payloadWrittenBytes,
      } satisfies TrafficPayloadPart;
      this.payloadWrittenBytes += content.length;
      this.enqueueWrite(stream, content);
      return part;
    } catch (error) {
      this.fail(error);
      return undefined;
    }
  }

  private ensureTraceStream(): WriteStream {
    if (this.traceStream) return this.traceStream;
    this.traceStream = this.createSessionStream(`trace-${this.traceFileIndex}.jsonl`);
    return this.traceStream;
  }

  private ensureInteractionStream(): WriteStream {
    if (this.interactionStream) return this.interactionStream;
    this.interactionStream = this.createSessionStream("interactions.jsonl");
    return this.interactionStream;
  }

  private ensurePayloadStream(): WriteStream {
    if (this.payloadStream) return this.payloadStream;
    this.payloadStream = this.createSessionStream(`payload-${this.payloadFileIndex}.bin`);
    return this.payloadStream;
  }

  private createSessionStream(name: string): WriteStream {
    const path = join(this.ensureSessionDirectory(), name);
    if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
    securePrivateFileSync(path);
    const stream = createWriteStream(path, { flags: "a" });
    stream.on("error", (error: unknown) => this.fail(error));
    stream.on("close", () => this.streams.delete(stream));
    this.streams.add(stream);
    return stream;
  }

  private ensureSessionDirectory(): string {
    if (this.sessionDirectory) return this.sessionDirectory;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    securePrivateDirectorySync(this.directory);
    let suffix = 1;
    let session: string;
    for (;;) {
      session = `${this.writerSession}${suffix === 1 ? "" : `-${suffix}`}`;
      const name = `${this.label}-${session}`;
      const path = join(this.directory, name);
      try {
        mkdirSync(path, { mode: 0o700 });
        this.sessionDirectory = path;
        break;
      } catch (error) {
        if (!isFileExistsError(error)) throw error;
        suffix += 1;
      }
    }
    securePrivateDirectorySync(this.sessionDirectory);
    const manifestPath = join(this.sessionDirectory, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify({
      createdAtMs: Date.now(),
      label: this.label,
      session,
      version: 2,
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    securePrivateFileSync(manifestPath);
    this.retainNewestSessions();
    return this.sessionDirectory;
  }

  private retainNewestSessions(): void {
    const sessions = readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const path = join(this.directory, entry.name);
        const manifest = readManifest(path);
        return manifest?.version === 2 && manifest.label === this.label
          ? [{ createdAtMs: manifest.createdAtMs, path, size: directorySize(path) }]
          : [];
      })
      .sort((left, right) => right.createdAtMs - left.createdAtMs);
    let retained = 0;
    for (const session of sessions) {
      retained += session.size;
      if (session.path === this.sessionDirectory || retained <= retainedBytesPerLabel) continue;
      rmSync(session.path, { force: true, recursive: true });
    }
  }

  private enqueueWrite(stream: WriteStream, content: string | Buffer): void {
    this.writeQueue = this.writeQueue.then(() => {
      if (this.failed) return;
      return new Promise<void>((resolveWrite, rejectWrite) => {
        stream.write(content, (error) => error === null || error === undefined
          ? resolveWrite()
          : rejectWrite(error));
      });
    }).catch((error: unknown) => this.fail(error));
  }

  private enqueueClose(stream: WriteStream): void {
    this.writeQueue = this.writeQueue.then(() => {
      if (stream.closed || stream.destroyed) return;
      return new Promise<void>((resolveClose) => {
        stream.once("close", resolveClose);
        stream.end();
      });
    }).catch((error: unknown) => this.fail(error));
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    const streams = [...this.streams];
    this.traceStream = undefined;
    this.interactionStream = undefined;
    this.payloadStream = undefined;
    this.pending = [];
    this.pendingBytes = 0;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    for (const stream of streams) stream.destroy();
    try {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // 转储与错误回调都属于旁路，不能影响模型请求转发。
    }
  }
}

/** 单次 HTTP 交换或 WebSocket 连接；V2 索引按逻辑模型调用记录请求与终态响应。 */
export class ModelTrafficExchange {
  private readonly requestBody: BodyAccumulator;
  private readonly responseBody: BodyAccumulator;
  private readonly partNumbers = new Map<string, number>();
  private readonly requestPayloadParts: TrafficPayloadPart[] = [];
  private readonly responsePayloadParts: TrafficPayloadPart[] = [];
  private readonly sseTerminal = new SseTerminalCollector();
  private readonly requestModelDecoder = new StringDecoder("utf8");
  private readonly requestModelScanner = createTopLevelStringFieldScanner("model");
  private readonly responseModelDecoder = new StringDecoder("utf8");
  private readonly responseModelScanner = createTopLevelStringFieldScanner("model");
  private activeWebSocket: { id: number; startedAtMs: number } | undefined;
  private requestHead: {
    headers: Record<string, string | string[]>;
    method: string;
    path: string;
  } | undefined;
  private responseHeadRecord: {
    headers: Record<string, string | string[]>;
    status: number | null;
  } | undefined;
  private requestModel: string | undefined;
  private responseModels: string[] = [];
  private websocketHandshake: {
    headers: Record<string, string | string[]>;
    url: string;
  } | undefined;
  private requestBytes = 0;
  private responseBytes = 0;
  private requestRecorded = false;
  private responseRecorded = false;
  private failureRecorded = false;
  private responseIsSse = false;
  private requestModelFinished = false;
  private responseModelFinished = false;

  constructor(
    private readonly prefix: {
      connection: number;
      startedAtMs: number;
      account?: string;
    },
    private readonly transport: "http" | "websocket",
    private readonly httpInteractionId: number | undefined,
    private readonly traceSink: (record: Record<string, unknown>) => void,
    private readonly interactionSink: (record: Record<string, unknown>) => void,
    private readonly payloadSink: (
      content: Buffer,
      encoding: "base64" | "utf8",
    ) => TrafficPayloadPart | undefined,
    private readonly nextInteractionId: () => number,
    private readonly inputItems: number,
    private readonly itemMaxBytes: number,
  ) {
    const limitBytes = inputItems > 0 || itemMaxBytes > 0
      ? compactionBufferLimitBytes
      : recordPayloadLimitBytes;
    this.requestBody = new BodyAccumulator(
      (chunk) => this.writeBody("request_body", chunk, this.requestPayloadParts),
      limitBytes,
    );
    this.responseBody = new BodyAccumulator(
      (chunk) => this.writeBody(
        "response_body",
        chunk,
        this.responseIsSse ? undefined : this.responsePayloadParts,
      ),
      limitBytes,
    );
  }

  write(record: Record<string, unknown>): void {
    if (record.kind === "request_head") {
      this.requestHead = {
        headers: record.headers as Record<string, string | string[]>,
        method: String(record.method),
        path: String(record.path),
      };
    } else if (record.kind === "websocket_handshake") {
      this.websocketHandshake = {
        headers: record.headers as Record<string, string | string[]>,
        url: String(record.url),
      };
    }
    this.writeTrace(record);
  }

  /** 精简模式丢弃流式增量：逐条增量只重复框架字段，完整文本由 `*.done` 事件承载。 */
  private dropsStreamDelta(text: string): boolean {
    return this.inputItems > 0 && isStreamDelta(parseJsonValue(text));
  }

  requestChunk(chunk: Buffer): void {
    this.requestBytes += chunk.length;
    scanTopLevelStringField(this.requestModelScanner, this.requestModelDecoder.write(chunk));
    this.requestBody.append(chunk);
  }

  requestEnd(): void {
    this.finishRequestModel();
    this.requestBody.drain(true);
    this.write({ kind: "request_end", bytes: this.requestBytes });
    this.recordHttpRequest();
  }

  responseHead(status: number | null, headers: IncomingHttpHeaders): void {
    const sanitized = sanitizedHeaders(headers);
    this.responseHeadRecord = { status, headers: sanitized };
    this.responseIsSse = headerValue(headers, "content-type")
      ?.toLowerCase().includes("text/event-stream") ?? false;
    this.write({
      kind: "response_head",
      status,
      headers: sanitized,
    });
  }

  responseChunk(chunk: Buffer): void {
    this.responseBytes += chunk.length;
    scanTopLevelStringField(this.responseModelScanner, this.responseModelDecoder.write(chunk));
    this.sseTerminal.append(chunk);
    if (this.sseTerminal.sawResponseEvent) this.responseIsSse = true;
    this.responseBody.append(chunk);
  }

  responseEnd(): void {
    this.finishResponseModel();
    this.sseTerminal.end();
    if (this.sseTerminal.sawResponseEvent) this.responseIsSse = true;
    this.responseBody.drain(true);
    this.write({
      kind: "response_end",
      bytes: this.responseBytes,
      durationMs: Date.now() - this.prefix.startedAtMs,
    });
    this.recordHttpResponse();
  }

  webSocketFrame(
    direction: "client" | "upstream",
    data: RawData,
    isBinary: boolean,
  ): void {
    const buffer = rawDataBuffer(data);
    if (!isBinary) {
      const text = buffer.toString("utf8");
      const parsed = parseJsonValue(text);
      let interaction = this.activeWebSocket?.id;
      if (direction === "client" && eventTypeOf(parsed) === "response.create") {
        this.completeActiveWebSocket("incomplete", "superseded_by_next_request");
        this.responseModels = [];
        const id = this.nextInteractionId();
        this.activeWebSocket = { id, startedAtMs: Date.now() };
        interaction = id;
        const compacted = compactText(text, this.inputItems, this.itemMaxBytes);
        const metadata = requestFieldsOf(parsed, this.websocketHandshake?.headers);
        this.interactionSink({
          ...this.prefix,
          id,
          kind: "request",
          transport: "websocket",
          url: this.websocketHandshake?.url,
          headers: this.websocketHandshake?.headers ?? {},
          payload: payloadOf(this.storeTextPayload(compacted)),
          startedAtMs: this.activeWebSocket.startedAtMs,
          ...metadata,
        });
      }
      if (this.dropsStreamDelta(text)) return;
      const parts = splitText(compactText(text, this.inputItems, this.itemMaxBytes));
      parts.forEach((text, index) => {
        this.writeTrace({
          kind: "websocket_frame",
          ...(interaction === undefined ? {} : { interaction }),
          direction,
          binary: false,
          part: index + 1,
          parts: parts.length,
          bytes: buffer.length,
          encoding: "utf8",
          text,
        });
      });
      if (direction === "upstream" && isTerminalResponseType(eventTypeOf(parsed))) {
        this.responseModels = responseModelsOf(parsed);
        this.completeActiveWebSocket(responseStateOf(eventTypeOf(parsed)), undefined, text);
      }
      return;
    }
    const parts = splitBuffer(buffer);
    parts.forEach((part, index) => {
      this.writeTrace({
        kind: "websocket_frame",
        ...(this.activeWebSocket === undefined ? {} : { interaction: this.activeWebSocket.id }),
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
    this.completeActiveWebSocket("incomplete", `websocket_${peer}_closed`);
  }

  failure(scope: string, error?: unknown): void {
    if (this.failureRecorded) return;
    this.failureRecorded = true;
    this.finishRequestModel();
    this.finishResponseModel();
    this.requestBody.drain(true);
    this.responseBody.drain(true);
    this.write({
      kind: "error",
      scope,
      ...(error === undefined ? {} : { message: errorText(error) }),
    });
    if (this.transport === "http") {
      this.recordHttpRequest();
      this.recordHttpResponse("failed", scope, error);
    } else {
      this.completeActiveWebSocket("failed", scope, undefined, error);
    }
  }

  /** 正文先折叠再按记录上限分片：一条记录可能来自压缩后的多段，编号仍按写入顺序递增。 */
  private writeBody(
    kind: string,
    chunk: Buffer,
    payloadParts: TrafficPayloadPart[] | undefined,
  ): void {
    const decoded = decodeUtf8(chunk);
    if (decoded === null) {
      for (const part of splitBuffer(chunk)) {
        const stored = this.payloadSink(part, "base64");
        if (stored) payloadParts?.push(stored);
        this.write({
          kind,
          part: this.nextPart(kind),
          bytes: part.length,
          encoding: "base64",
          data: part.toString("base64"),
        });
      }
      return;
    }
    const text = compactText(decoded, this.inputItems, this.itemMaxBytes);
    if (kind === "response_body") {
      const models = responseModelsOf(parseJsonValue(decoded));
      if (models.length > 0) this.responseModels = models;
    }
    for (const part of splitText(text)) {
      const stored = this.payloadSink(Buffer.from(part, "utf8"), "utf8");
      if (stored) payloadParts?.push(stored);
      this.write({
        kind,
        part: this.nextPart(kind),
        bytes: Buffer.byteLength(part),
        encoding: "utf8",
        text: part,
      });
    }
  }

  private nextPart(kind: string): number {
    const next = (this.partNumbers.get(kind) ?? 0) + 1;
    this.partNumbers.set(kind, next);
    return next;
  }

  private finishRequestModel(): void {
    if (this.requestModelFinished) return;
    this.requestModelFinished = true;
    scanTopLevelStringField(this.requestModelScanner, this.requestModelDecoder.end());
    this.requestModel = this.requestModelScanner.value;
  }

  private finishResponseModel(): void {
    if (this.responseModelFinished) return;
    this.responseModelFinished = true;
    scanTopLevelStringField(this.responseModelScanner, this.responseModelDecoder.end());
    if (this.responseModelScanner.value !== undefined) {
      this.responseModels = [this.responseModelScanner.value];
    }
  }

  private writeTrace(record: Record<string, unknown>): void {
    this.traceSink({
      ...this.prefix,
      ...(this.httpInteractionId === undefined ? {} : { interaction: this.httpInteractionId }),
      ...record,
    });
  }

  private recordHttpRequest(): void {
    if (this.transport !== "http" || this.requestRecorded) return;
    this.requestRecorded = true;
    this.interactionSink({
      ...this.prefix,
      id: this.httpInteractionId,
      kind: "request",
      transport: "http",
      method: this.requestHead?.method,
      path: this.requestHead?.path,
      headers: this.requestHead?.headers ?? {},
      bytes: this.requestBytes,
      payload: payloadOf(this.requestPayloadParts),
      ...requestFieldsOf(undefined, this.requestHead?.headers, this.requestModel),
    });
  }

  private recordHttpResponse(
    forcedState?: "failed" | "incomplete",
    errorScope?: string,
    error?: unknown,
  ): void {
    if (this.transport !== "http" || this.responseRecorded) return;
    this.responseRecorded = true;
    const terminal = this.sseTerminal.terminal;
    let payload = payloadOf(this.responsePayloadParts);
    if (terminal !== undefined) {
      const compacted = compactText(terminal.text, this.inputItems, this.itemMaxBytes);
      payload = payloadOf(this.storeTextPayload(compacted));
    }
    const status = this.responseHeadRecord?.status ?? null;
    const terminalState = terminal === undefined
      ? undefined
      : status !== null && status >= 400 ? "failed" : responseStateOf(terminal.type);
    const state = terminalState ?? forcedState ?? (this.responseIsSse
      ? "incomplete"
      : status !== null && status >= 200 && status < 400 ? "completed" : "failed");
    this.interactionSink({
      ...this.prefix,
      id: this.httpInteractionId,
      kind: "response",
      state,
      status,
      headers: this.responseHeadRecord?.headers ?? {},
      bytes: this.responseBytes,
      durationMs: Date.now() - this.prefix.startedAtMs,
      ...(terminal === undefined ? {} : { eventType: terminal.type }),
      ...(errorScope === undefined ? {} : { errorScope }),
      ...(error === undefined ? {} : { error: errorText(error) }),
      payload,
      responseModels: terminal === undefined
        ? this.responseModels
        : responseModelsOf(parseJsonValue(terminal.text)),
    });
  }

  private completeActiveWebSocket(
    state: "completed" | "failed" | "incomplete",
    errorScope?: string,
    text?: string,
    error?: unknown,
  ): void {
    const active = this.activeWebSocket;
    if (active === undefined) return;
    this.activeWebSocket = undefined;
    const compacted = text === undefined
      ? undefined
      : compactText(text, this.inputItems, this.itemMaxBytes);
    this.interactionSink({
      ...this.prefix,
      id: active.id,
      kind: "response",
      transport: "websocket",
      state,
      durationMs: Date.now() - active.startedAtMs,
      ...(errorScope === undefined ? {} : { errorScope }),
      ...(error === undefined ? {} : { error: errorText(error) }),
      payload: payloadOf(compacted === undefined ? [] : this.storeTextPayload(compacted)),
      responseModels: this.responseModels,
    });
  }

  private storeTextPayload(text: string): TrafficPayloadPart[] {
    return splitBuffer(Buffer.from(text, "utf8"))
      .flatMap((part) => {
        const stored = this.payloadSink(part, "utf8");
        return stored === undefined ? [] : [stored];
      });
  }
}

class BodyAccumulator {
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

class SseTerminalCollector {
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

interface TopLevelStringFieldScanner {
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
function createTopLevelStringFieldScanner(field: string): TopLevelStringFieldScanner {
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

function scanTopLevelStringField(scanner: TopLevelStringFieldScanner, text: string): void {
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

function payloadOf(parts: TrafficPayloadPart[]): TrafficPayload {
  return {
    bytes: parts.reduce((total, part) => total + part.bytes, 0),
    parts: [...parts],
  };
}

function eventTypeOf(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const type = (parsed as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function isTerminalResponseType(type: string | undefined): type is string {
  return type === "response.completed"
    || type === "response.failed"
    || type === "response.incomplete"
    || type === "error";
}

function responseStateOf(
  type: string | undefined,
): "completed" | "failed" | "incomplete" {
  if (type === "response.completed") return "completed";
  if (type === "response.incomplete") return "incomplete";
  return type === "response.failed" || type === "error" ? "failed" : "incomplete";
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

function requestFieldsOf(
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
  const rawTurnMetadata = headers?.["x-codex-turn-metadata"]
    ?? clientMetadata["x-codex-turn-metadata"];
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
  return {
    ...(typeof metadata.request_kind === "string"
      ? { requestKind: metadata.request_kind }
      : {}),
    ...(model === undefined ? {} : { requestModel: model }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(typeof metadata.turn_id === "string" && metadata.turn_id.length > 0
      ? { turnId: metadata.turn_id }
      : {}),
  };
}

function responseModelsOf(parsed: unknown): string[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const object = parsed as Record<string, unknown>;
  const response = typeof object.response === "object" && object.response !== null
    ? object.response as Record<string, unknown>
    : undefined;
  const model = response?.model ?? object.model;
  return typeof model === "string" ? [model] : [];
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

function decodeUtf8(chunk: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(chunk);
  } catch {
    return null;
  }
}

/**
 * 精简模式：丢弃流式增量事件，`input` 只保留末尾若干条，并折叠响应回显的 `instructions`
 * 与 `tools`。完整 JSON 直接折叠；SSE 正文按事件折叠，但不改变保留事件的分帧。
 */
function compactText(text: string, inputItems: number, itemMaxBytes: number): string {
  if (inputItems <= 0 && itemMaxBytes <= 0) return text;
  const whole = compactJson(text, inputItems, itemMaxBytes);
  if (whole !== undefined) return whole;
  return compactSseText(text, inputItems, itemMaxBytes);
}

/** 末尾不完整的 SSE 分块原样保留：它可能只是跨分片事件的半截，无法判断类型。 */
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

function parseJsonValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 流式增量事件：逐条只重复框架字段，完整文本由同一条目的 `*.done` 事件承载。 */
function isStreamDelta(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null) return false;
  return isStreamDeltaType((parsed as { type?: unknown }).type);
}

/** SSE 类型既可能写在 `event:` 行，也可能写在 data 的 `type` 字段，两者都要识别。 */
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

/**
 * 单个条目或超长字符串字段超过上限时只保留头尾：完整正文通常没有再读的价值，头尾足以定位问题。
 * 数组与对象本身不在这里截断，它们的元素和字段由递归处理。
 * 上限按 UTF-8 字节计算，截断处可能落在多字节字符上，此时以替换字符收尾。
 */
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

/** 只折叠有内容的响应回显字段，空字符串与空数组原样保留。 */
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

function readManifest(directory: string): {
  createdAtMs: number;
  label: string;
  session: string;
  version: number;
} | undefined {
  try {
    const value = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as {
      createdAtMs?: unknown;
      label?: unknown;
      session?: unknown;
      version?: unknown;
    };
    return typeof value.createdAtMs === "number"
      && typeof value.label === "string"
      && typeof value.session === "string"
      && typeof value.version === "number"
      ? value as { createdAtMs: number; label: string; session: string; version: number }
      : undefined;
  } catch {
    return undefined;
  }
}

function directorySize(directory: string): number {
  return readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const path = join(directory, entry.name);
    return total + (entry.isDirectory() ? directorySize(path) : statSync(path).size);
  }, 0);
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : "未知错误";
}
