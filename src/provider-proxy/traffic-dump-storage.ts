import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { join } from "node:path";
import type { ProviderProxyMetrics } from "./response-metrics-observer.js";

import {
  securePrivateDirectorySync,
  securePrivateFileSync,
} from "../../runtime/private-file.mjs";
import {
  modelTrafficDumpFileSizeLimitBytes,
  pruneModelTrafficDumpSessions,
} from "./traffic-dump-retention.js";

const millisecondsPerDay = 24 * 60 * 60 * 1_000;
/** 长驻 App Server 按天切分 session，使时间保留可以持续清理完整历史批次。 */
const sessionRotationIntervalMs = millisecondsPerDay;
/** 待写缓冲达到该大小后立即落盘，不等待请求结束。 */
const flushThresholdBytes = 262_144;
/** 低流量时的最长落盘等待，兼顾实时查看与小记录合并。 */
const flushIntervalMs = 100;

export interface TrafficPayloadPart {
  bytes: number;
  encoding: "base64" | "utf8";
  file: string;
  offset: number;
}

export interface TrafficDumpSession {
  activeInteractions: number;
  closing: boolean;
  flushTimer: NodeJS.Timeout | undefined;
  interactionCount: number;
  interactionStream: WriteStream | undefined;
  payloadFileIndex: number;
  payloadStream: WriteStream | undefined;
  payloadWrittenBytes: number;
  pending: string[];
  pendingBytes: number;
  sessionDirectory: string | undefined;
  startedAtMs: number;
  traceFileIndex: number;
  traceStream: WriteStream | undefined;
  traceWrittenBytes: number;
  writerSession: string;
}

interface TrafficDumpStorageOptions {
  directory: string;
  label: string;
  onError: (error: Error) => void;
  retentionDays: number;
}

export interface TrafficDumpStorageState {
  getWriteQueue: () => Promise<void>;
  sessions: Set<TrafficDumpSession>;
  setWriteQueue: (queue: Promise<void>) => void;
  streams: Set<WriteStream>;
}

/** V2 转储 session、文件流、轮转和顺序写入。 */
export class TrafficDumpStorage {
  private readonly directory: string;
  private readonly label: string;
  private readonly onError: (error: Error) => void;
  private readonly retentionDays: number;
  private currentSession: TrafficDumpSession | undefined;
  private closed = false;
  private failed = false;

  constructor(
    options: TrafficDumpStorageOptions,
    private readonly state: TrafficDumpStorageState,
  ) {
    this.directory = options.directory;
    this.label = options.label.replace(/[^A-Za-z0-9._-]+/gu, "_");
    this.onError = options.onError;
    this.retentionDays = options.retentionDays;
  }

  private get sessions(): Set<TrafficDumpSession> {
    return this.state.sessions;
  }

  private get streams(): Set<WriteStream> {
    return this.state.streams;
  }

  private get writeQueue(): Promise<void> {
    return this.state.getWriteQueue();
  }

  private set writeQueue(queue: Promise<void>) {
    this.state.setWriteQueue(queue);
  }

  sessionForConnection(startedAtMs: number): TrafficDumpSession {
    return this.ensureCurrentSession(startedAtMs, false);
  }

  currentSessionOr(fallback: TrafficDumpSession): TrafficDumpSession {
    return this.currentSession ?? fallback;
  }

  beginLogicalInteraction(startedAtMs: number): TrafficDumpSession {
    const session = this.ensureCurrentSession(startedAtMs, true);
    session.activeInteractions += 1;
    return session;
  }

  completeLogicalInteraction(session: TrafficDumpSession): void {
    if (session.activeInteractions > 0) session.activeInteractions -= 1;
    if (session !== this.currentSession) this.retireSession(session);
  }

  nextInteractionId(session: TrafficDumpSession): number {
    session.interactionCount += 1;
    return session.interactionCount;
  }

  reference(session: TrafficDumpSession, interaction: number): ProviderProxyMetrics["traffic"] {
    if (this.closed || this.failed) return undefined;
    try {
      this.ensureSessionDirectory(session);
      return { label: this.label, session: session.writerSession, interaction };
    } catch (error) {
      this.fail(error);
      return undefined;
    }
  }

  writeTrace(session: TrafficDumpSession, record: Record<string, unknown>): void {
    if (this.closed || this.failed) return;
    const line = `${JSON.stringify({ ts: Date.now(), ...record })}\n`;
    session.pending.push(line);
    session.pendingBytes += Buffer.byteLength(line);
    if (session.pendingBytes >= flushThresholdBytes) {
      this.flush(session);
      return;
    }
    this.scheduleFlush(session);
  }

  writeInteraction(session: TrafficDumpSession, record: Record<string, unknown>): void {
    if (this.closed || this.failed) return;
    try {
      const line = `${JSON.stringify({ version: 2, ts: Date.now(), ...record })}\n`;
      this.enqueueWrite(this.ensureInteractionStream(session), line);
    } catch (error) {
      this.fail(error);
    }
  }

  writePayload(
    session: TrafficDumpSession,
    content: Buffer,
    encoding: "base64" | "utf8",
  ): TrafficPayloadPart | undefined {
    if (this.closed || this.failed) return undefined;
    try {
      if (session.payloadStream && session.payloadWrittenBytes > 0
        && session.payloadWrittenBytes + content.length > modelTrafficDumpFileSizeLimitBytes) {
        const stream = session.payloadStream;
        session.payloadStream = undefined;
        session.payloadWrittenBytes = 0;
        session.payloadFileIndex += 1;
        this.enqueueClose(stream);
      }
      const stream = this.ensurePayloadStream(session);
      const part = {
        bytes: content.length,
        encoding,
        file: `payload-${session.payloadFileIndex}.bin`,
        offset: session.payloadWrittenBytes,
      } satisfies TrafficPayloadPart;
      session.payloadWrittenBytes += content.length;
      this.enqueueWrite(stream, content);
      return part;
    } catch (error) {
      this.fail(error);
      return undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.currentSession = undefined;
    for (const session of [...this.sessions]) this.retireSession(session, true);
    await this.writeQueue;
    await Promise.all([...this.streams].map((stream) => {
      if (stream.closed) return Promise.resolve();
      return new Promise<void>((resolveClose) => {
        stream.once("close", resolveClose);
        if (!stream.destroyed) stream.end();
      });
    }));
  }

  private ensureCurrentSession(startedAtMs: number, rotate: boolean): TrafficDumpSession {
    const current = this.currentSession;
    if (
      current !== undefined
      && (!rotate || startedAtMs - current.startedAtMs < sessionRotationIntervalMs)
    ) return current;
    const session = this.createSession(startedAtMs);
    this.currentSession = session;
    if (current !== undefined) this.retireSession(current);
    return session;
  }

  private createSession(startedAtMs: number): TrafficDumpSession {
    const session: TrafficDumpSession = {
      activeInteractions: 0,
      closing: false,
      flushTimer: undefined,
      interactionCount: 0,
      interactionStream: undefined,
      payloadFileIndex: 1,
      payloadStream: undefined,
      payloadWrittenBytes: 0,
      pending: [],
      pendingBytes: 0,
      sessionDirectory: undefined,
      startedAtMs,
      traceFileIndex: 1,
      traceStream: undefined,
      traceWrittenBytes: 0,
      writerSession: new Date(startedAtMs).toISOString().replace(/[:.]/gu, "-"),
    };
    this.sessions.add(session);
    return session;
  }

  private flush(session: TrafficDumpSession): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = undefined;
    }
    if (this.failed || session.pending.length === 0) return;
    const content = session.pending.join("");
    const contentBytes = Buffer.byteLength(content);
    session.pending = [];
    session.pendingBytes = 0;
    try {
      if (session.traceStream
        && session.traceWrittenBytes + contentBytes > modelTrafficDumpFileSizeLimitBytes) {
        this.rotateTrace(session);
      }
      session.traceWrittenBytes += contentBytes;
      this.enqueueWrite(this.ensureTraceStream(session), content);
    } catch (error) {
      this.fail(error);
    }
  }

  private scheduleFlush(session: TrafficDumpSession): void {
    if (session.flushTimer) return;
    session.flushTimer = setTimeout(() => {
      session.flushTimer = undefined;
      this.flush(session);
    }, flushIntervalMs);
    session.flushTimer.unref();
  }

  private rotateTrace(session: TrafficDumpSession): void {
    const stream = session.traceStream;
    session.traceStream = undefined;
    session.traceWrittenBytes = 0;
    session.traceFileIndex += 1;
    if (stream) this.enqueueClose(stream);
  }

  private ensureTraceStream(session: TrafficDumpSession): WriteStream {
    if (session.traceStream) return session.traceStream;
    session.traceStream = this.createSessionStream(
      session,
      `trace-${session.traceFileIndex}.jsonl`,
    );
    return session.traceStream;
  }

  private ensureInteractionStream(session: TrafficDumpSession): WriteStream {
    if (session.interactionStream) return session.interactionStream;
    session.interactionStream = this.createSessionStream(session, "interactions.jsonl");
    return session.interactionStream;
  }

  private ensurePayloadStream(session: TrafficDumpSession): WriteStream {
    if (session.payloadStream) return session.payloadStream;
    session.payloadStream = this.createSessionStream(
      session,
      `payload-${session.payloadFileIndex}.bin`,
    );
    return session.payloadStream;
  }

  private createSessionStream(session: TrafficDumpSession, name: string): WriteStream {
    const path = join(this.ensureSessionDirectory(session), name);
    if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
    securePrivateFileSync(path);
    const stream = createWriteStream(path, { flags: "a" });
    stream.on("error", (error: unknown) => this.fail(error));
    stream.on("close", () => this.streams.delete(stream));
    this.streams.add(stream);
    return stream;
  }

  private ensureSessionDirectory(sessionState: TrafficDumpSession): string {
    if (sessionState.sessionDirectory) return sessionState.sessionDirectory;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    securePrivateDirectorySync(this.directory);
    let suffix = 1;
    let session: string;
    for (;;) {
      session = `${sessionState.writerSession}${suffix === 1 ? "" : `-${suffix}`}`;
      const name = `${this.label}-${session}`;
      const path = join(this.directory, name);
      try {
        mkdirSync(path, { mode: 0o700 });
        sessionState.sessionDirectory = path;
        break;
      } catch (error) {
        if (!isFileExistsError(error)) throw error;
        suffix += 1;
      }
    }
    securePrivateDirectorySync(sessionState.sessionDirectory);
    const manifestPath = join(sessionState.sessionDirectory, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify({
      createdAtMs: sessionState.startedAtMs,
      label: this.label,
      session,
      version: 2,
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    securePrivateFileSync(manifestPath);
    sessionState.writerSession = session;
    this.pruneSessions();
    return sessionState.sessionDirectory;
  }

  private pruneSessions(): void {
    const protectedSessionDirectories = [...this.sessions]
      .flatMap((session) => session.sessionDirectory === undefined
        ? []
        : [session.sessionDirectory]);
    pruneModelTrafficDumpSessions({
      directory: this.directory,
      label: this.label,
      retentionDays: this.retentionDays,
      protectedSessionDirectories,
    });
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

  private retireSession(session: TrafficDumpSession, force = false): void {
    if (session.closing || (!force && session.activeInteractions > 0)) return;
    session.closing = true;
    this.flush(session);
    const streams = [session.traceStream, session.interactionStream, session.payloadStream]
      .filter((stream): stream is WriteStream => stream !== undefined);
    session.traceStream = undefined;
    session.interactionStream = undefined;
    session.payloadStream = undefined;
    for (const stream of streams) this.enqueueClose(stream);
    this.writeQueue = this.writeQueue.then(() => {
      this.sessions.delete(session);
      if (!this.failed) this.pruneSessions();
    }).catch((error: unknown) => this.fail(error));
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    const streams = [...this.streams];
    for (const session of this.sessions) {
      session.traceStream = undefined;
      session.interactionStream = undefined;
      session.payloadStream = undefined;
      session.pending = [];
      session.pendingBytes = 0;
      if (session.flushTimer) {
        clearTimeout(session.flushTimer);
        session.flushTimer = undefined;
      }
    }
    for (const stream of streams) stream.destroy();
    try {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // 转储与错误回调都属于旁路，不能影响模型请求转发。
    }
  }
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
