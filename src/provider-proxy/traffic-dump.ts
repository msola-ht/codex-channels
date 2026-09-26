import type { WriteStream } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { TrafficCallTiming } from "./traffic-call-timing.js";
import { StringDecoder } from "node:string_decoder";

import type { RawData } from "ws";
import type { ProviderProxyMetrics } from "./response-metrics-observer.js";

import {
  BodyAccumulator,
  SseTerminalCollector,
  bodyBufferLimit,
  compactText,
  createTopLevelStringFieldScanner,
  decodeUtf8,
  errorText,
  eventTypeOf,
  headerValue,
  isStreamDelta,
  isTerminalResponseType,
  parseJsonValue,
  payloadOf,
  rawDataBuffer,
  requestFieldsOf,
  responseModelsOf,
  responseStateOf,
  sanitizedHeaders,
  scanTopLevelStringField,
  splitBuffer,
  splitText,
} from "./traffic-dump-content.js";
import {
  TrafficDumpStorage,
  type TrafficDumpSession,
  type TrafficPayloadPart,
} from "./traffic-dump-storage.js";

export {
  pruneModelTrafficDumpSessions,
  type PruneModelTrafficDumpOptions,
} from "./traffic-dump-retention.js";

export interface ModelTrafficDumpOptions {
  /** 转储目录，通常为 Gateway 数据目录下的 traffic 目录。 */
  directory: string;
  /** 精简模式下 `input` 保留的末尾条目数；`0` 表示按原样转储完整报文。 */
  inputItems?: number;
  /** 单个数组条目的正文上限（字节）；`0` 或不设置表示按原样转储。 */
  itemMaxBytes?: number;
  /** 历史 session 的最长保留天数；`0` 或不设置时关闭按时间清理。 */
  retentionDays?: number;
  /** 文件名前缀，用于区分主 Provider 与隔离 Provider。 */
  label: string;
  onError: (error: Error) => void;
}

export interface ModelTrafficHttpExchangeInput {
  startedAtMonotonicMs?: number;
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
 * 模型请求转储入口：建立 HTTP/WS 交换，并把 V2 文件生命周期委派给独立存储组件。
 * 只做旁路复制；写入失败由存储组件停止转储并经 onError 上报。
 */
export class ModelTrafficDump {
  private readonly inputItems: number;
  private readonly itemMaxBytes: number;
  private readonly sessions = new Set<TrafficDumpSession>();
  private readonly storage: TrafficDumpStorage;
  private readonly streams = new Set<WriteStream>();
  private writeQueue = Promise.resolve();
  private connectionCount = 0;

  constructor(options: ModelTrafficDumpOptions) {
    this.inputItems = options.inputItems ?? 0;
    this.itemMaxBytes = options.itemMaxBytes ?? 0;
    this.storage = new TrafficDumpStorage({
      directory: options.directory,
      label: options.label,
      onError: options.onError,
      retentionDays: options.retentionDays ?? 0,
    }, {
      getWriteQueue: () => this.writeQueue,
      sessions: this.sessions,
      setWriteQueue: (queue) => {
        this.writeQueue = queue;
      },
      streams: this.streams,
    });
  }

  beginHttpExchange(input: ModelTrafficHttpExchangeInput): ModelTrafficExchange {
    const session = this.storage.beginLogicalInteraction(input.startedAtMs);
    const exchange = this.createExchange(input, "http", session);
    if (input.startedAtMonotonicMs !== undefined) exchange.callTiming = new TrafficCallTiming(input.startedAtMonotonicMs);
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
    const session = this.storage.sessionForConnection(input.startedAtMs);
    const exchange = this.createExchange(input, "websocket", session);
    exchange.write({
      kind: "websocket_handshake",
      url: input.url,
      headers: sanitizedHeaders(input.headers),
    });
    return exchange;
  }

  close(): Promise<void> {
    return this.storage.close();
  }

  private createExchange(
    input: { accountId?: string; startedAtMs: number },
    transport: "http" | "websocket",
    session: TrafficDumpSession,
  ): ModelTrafficExchange {
    this.connectionCount += 1;
    const interactionId = transport === "http"
      ? this.storage.nextInteractionId(session)
      : undefined;
    return new ModelTrafficExchange(
      {
        connection: this.connectionCount,
        startedAtMs: input.startedAtMs,
        ...(input.accountId === undefined ? {} : { account: input.accountId }),
      },
      transport,
      interactionId,
      session,
      () => this.storage.currentSessionOr(session),
      (target, record) => this.storage.writeTrace(target, record),
      (target, record) => this.storage.writeInteraction(target, record),
      (target, content, encoding) => this.storage.writePayload(target, content, encoding),
      (target) => this.storage.nextInteractionId(target),
      (startedAtMs) => this.storage.beginLogicalInteraction(startedAtMs),
      (target) => this.storage.completeLogicalInteraction(target),
      (target, id) => this.storage.reference(target, id),
      this.inputItems,
      this.itemMaxBytes,
    );
  }
}

/** 单次 HTTP 交换或 WebSocket 连接；V2 索引按逻辑模型调用记录请求与终态响应。 */
export class ModelTrafficExchange {
  callTiming: TrafficCallTiming | undefined;
  private requestMetrics: { firstContentMs?: number; totalDurationMs?: number } | undefined;

  /** 复用代理观测，不从可裁剪或缓冲后的 trace 反推首内容时间。 */
  observeRequestMetrics(metrics: Pick<ProviderProxyMetrics, "firstContentMs" | "totalDurationMs" | "traffic">): void {
    this.requestMetrics = metrics;
    const interaction = this.transport === "http"
      ? this.httpInteractionId : this.activeWebSocket?.id;
    if (interaction !== undefined) {
      const reference = this.trafficReference(this.activeWebSocket?.session ?? this.initialSession, interaction);
      if (reference !== undefined) metrics.traffic = reference;
    }
  }
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
  private activeWebSocket: {
    id: number;
    session: TrafficDumpSession;
    startedAtMs: number;
  } | undefined;
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
  /** Chat 上游诊断里的实际上游提供商；只在诊断到达时记录，缺失不推断。 */
  private upstreamProvider: string | undefined;
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
    private readonly initialSession: TrafficDumpSession,
    private readonly currentSession: () => TrafficDumpSession,
    private readonly traceSink: (
      session: TrafficDumpSession,
      record: Record<string, unknown>,
    ) => void,
    private readonly interactionSink: (
      session: TrafficDumpSession,
      record: Record<string, unknown>,
    ) => void,
    private readonly payloadSink: (
      session: TrafficDumpSession,
      content: Buffer,
      encoding: "base64" | "utf8",
    ) => TrafficPayloadPart | undefined,
    private readonly nextInteractionId: (session: TrafficDumpSession) => number,
    private readonly beginLogicalInteraction: (startedAtMs: number) => TrafficDumpSession,
    private readonly completeLogicalInteraction: (session: TrafficDumpSession) => void,
    private readonly trafficReference: (session: TrafficDumpSession, id: number) => ProviderProxyMetrics["traffic"],
    private readonly inputItems: number,
    private readonly itemMaxBytes: number,
  ) {
    const limitBytes = bodyBufferLimit(inputItems, itemMaxBytes);
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
    } else if (record.kind === "chat_diagnostics") {
      const fields = record.fields as Record<string, unknown> | undefined;
      const final = fields?.["routing.finalProvider"];
      if (typeof final === "string" && final !== "") this.upstreamProvider = final;
    }
    this.writeTrace(record);
  }

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
    this.write({ kind: "response_head", status, headers: sanitized });
  }

  responseChunk(chunk: Buffer): void {
    this.responseBytes += chunk.length;
    scanTopLevelStringField(this.responseModelScanner, this.responseModelDecoder.write(chunk));
    this.sseTerminal.append(chunk);
    if (this.sseTerminal.sawResponseEvent) this.responseIsSse = true;
    this.responseBody.append(chunk);
  }

  responseEnd(endedAtMonotonicMs = performance.now()): void {
    this.finishResponseModel();
    this.sseTerminal.end();
    if (this.sseTerminal.sawResponseEvent) this.responseIsSse = true;
    this.responseBody.drain(true);
    this.write({
      kind: "response_end",
      bytes: this.responseBytes,
      durationMs: Date.now() - this.prefix.startedAtMs,
    });
    this.recordHttpResponse(undefined, undefined, undefined, endedAtMonotonicMs);
  }

  webSocketFrame(
    direction: "client" | "upstream",
    data: RawData,
    isBinary: boolean,
    receivedAtMonotonicMs?: number,
  ): void {
    const buffer = rawDataBuffer(data);
    if (!isBinary) {
      const text = buffer.toString("utf8");
      const parsed = parseJsonValue(text);
      let interaction = this.activeWebSocket?.id;
      if (direction === "client" && eventTypeOf(parsed) === "response.create") {
        this.completeActiveWebSocket("incomplete", "superseded_by_next_request", undefined, undefined, receivedAtMonotonicMs);
        this.callTiming = receivedAtMonotonicMs === undefined ? undefined : new TrafficCallTiming(receivedAtMonotonicMs);
        this.requestMetrics = undefined;
        this.responseModels = [];
        const startedAtMs = Date.now();
        const session = this.beginLogicalInteraction(startedAtMs);
        const id = this.nextInteractionId(session);
        this.activeWebSocket = { id, session, startedAtMs };
        interaction = id;
        const compacted = compactText(text, this.inputItems, this.itemMaxBytes);
        const metadata = requestFieldsOf(parsed, this.websocketHandshake?.headers);
        this.interactionSink(session, {
          ...this.prefix,
          id,
          kind: "request",
          transport: "websocket",
          url: this.websocketHandshake?.url,
          headers: this.websocketHandshake?.headers ?? {},
          payload: payloadOf(this.storeTextPayload(session, compacted)),
          startedAtMs: this.activeWebSocket.startedAtMs,
          ...metadata,
        });
      }
      if (this.dropsStreamDelta(text)) return;
      const parts = splitText(compactText(text, this.inputItems, this.itemMaxBytes));
      parts.forEach((part, index) => {
        this.writeTrace({
          kind: "websocket_frame",
          ...(interaction === undefined ? {} : { interaction }),
          direction,
          binary: false,
          part: index + 1,
          parts: parts.length,
          bytes: buffer.length,
          encoding: "utf8",
          text: part,
        });
      });
      if (direction === "upstream" && isTerminalResponseType(eventTypeOf(parsed))) {
        this.responseModels = responseModelsOf(parsed);
        this.completeActiveWebSocket(responseStateOf(eventTypeOf(parsed)), undefined, text, undefined, receivedAtMonotonicMs);
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
    endedAtMonotonicMs = performance.now(),
  ): void {
    const text = reason.toString("utf8");
    this.write({
      kind: "websocket_close",
      peer,
      code,
      ...(text.length === 0 ? {} : { reason: text.slice(0, 512) }),
    });
    this.completeActiveWebSocket("incomplete", `websocket_${peer}_closed`, undefined, undefined, endedAtMonotonicMs);
  }

  failure(scope: string, error?: unknown, endedAtMonotonicMs = performance.now()): void {
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
      this.recordHttpResponse("failed", scope, error, endedAtMonotonicMs);
    } else {
      this.completeActiveWebSocket("failed", scope, undefined, error, endedAtMonotonicMs);
    }
  }

  private writeBody(
    kind: string,
    chunk: Buffer,
    payloadParts: TrafficPayloadPart[] | undefined,
  ): void {
    const decoded = decodeUtf8(chunk);
    if (decoded === null) {
      for (const part of splitBuffer(chunk)) {
        const stored = this.payloadSink(this.storageSession(), part, "base64");
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
      const stored = this.payloadSink(
        this.storageSession(),
        Buffer.from(part, "utf8"),
        "utf8",
      );
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
    this.traceSink(this.storageSession(), {
      ...this.prefix,
      ...(this.httpInteractionId === undefined ? {} : { interaction: this.httpInteractionId }),
      ...record,
    });
  }

  private recordHttpRequest(): void {
    if (this.transport !== "http" || this.requestRecorded) return;
    this.requestRecorded = true;
    this.interactionSink(this.initialSession, {
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
    endedAtMonotonicMs = performance.now(),
  ): void {
    if (this.transport !== "http" || this.responseRecorded) return;
    this.responseRecorded = true;
    const terminal = this.sseTerminal.terminal;
    let payload = payloadOf(this.responsePayloadParts);
    if (terminal !== undefined) {
      const compacted = compactText(terminal.text, this.inputItems, this.itemMaxBytes);
      payload = payloadOf(this.storeTextPayload(this.initialSession, compacted));
    }
    const status = this.responseHeadRecord?.status ?? null;
    const terminalState = terminal === undefined
      ? undefined
      : status !== null && status >= 400 ? "failed" : responseStateOf(terminal.type);
    const state = terminalState ?? forcedState ?? (this.responseIsSse
      ? "incomplete"
      : status !== null && status >= 200 && status < 400 ? "completed" : "failed");
    this.interactionSink(this.initialSession, {
      ...this.prefix,
      id: this.httpInteractionId,
      kind: "response",
      state,
      status,
      headers: this.responseHeadRecord?.headers ?? {},
      bytes: this.responseBytes,
      durationMs: Date.now() - this.prefix.startedAtMs,
      ...(this.callTiming === undefined ? {} : { callTiming: this.callTiming.finish(endedAtMonotonicMs, this.requestMetrics?.firstContentMs, this.requestMetrics?.totalDurationMs) }),
      ...(terminal === undefined ? {} : { eventType: terminal.type }),
      ...(this.requestMetrics?.firstContentMs === undefined ? {} : { firstContentMs: this.requestMetrics.firstContentMs }),
      ...(errorScope === undefined ? {} : { errorScope }),
      ...(error === undefined ? {} : { error: errorText(error) }),
      payload,
      ...(this.upstreamProvider === undefined ? {} : { upstreamProvider: this.upstreamProvider }),
      responseModels: terminal === undefined
        ? this.responseModels
        : responseModelsOf(parseJsonValue(terminal.text)),
    });
    this.completeLogicalInteraction(this.initialSession);
  }

  private completeActiveWebSocket(
    state: "completed" | "failed" | "incomplete",
    errorScope?: string,
    text?: string,
    error?: unknown,
    endedAtMonotonicMs = performance.now(),
  ): void {
    const active = this.activeWebSocket;
    if (active === undefined) return;
    this.activeWebSocket = undefined;
    const compacted = text === undefined
      ? undefined
      : compactText(text, this.inputItems, this.itemMaxBytes);
    this.interactionSink(active.session, {
      ...this.prefix,
      id: active.id,
      kind: "response",
      transport: "websocket",
      state,
      durationMs: Date.now() - active.startedAtMs,
      ...(this.callTiming === undefined ? {} : { callTiming: this.callTiming.finish(endedAtMonotonicMs, this.requestMetrics?.firstContentMs, this.requestMetrics?.totalDurationMs) }),
      ...(this.requestMetrics?.firstContentMs === undefined ? {} : { firstContentMs: this.requestMetrics.firstContentMs }),
      ...(errorScope === undefined ? {} : { errorScope }),
      ...(error === undefined ? {} : { error: errorText(error) }),
      payload: payloadOf(compacted === undefined
        ? []
        : this.storeTextPayload(active.session, compacted)),
      responseModels: this.responseModels,
    });
    this.completeLogicalInteraction(active.session);
  }

  private storageSession(): TrafficDumpSession {
    if (this.transport === "http") return this.initialSession;
    return this.activeWebSocket?.session ?? this.currentSession();
  }

  private storeTextPayload(
    session: TrafficDumpSession,
    text: string,
  ): TrafficPayloadPart[] {
    return splitBuffer(Buffer.from(text, "utf8"))
      .flatMap((part) => {
        const stored = this.payloadSink(session, part, "utf8");
        return stored === undefined ? [] : [stored];
      });
  }
}
