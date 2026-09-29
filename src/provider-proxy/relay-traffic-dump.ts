import type { WriteStream } from "node:fs";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import type { DirectChatRequest } from "../model-api/index.js";
import { pruneModelTrafficDumpSessions } from "./traffic-dump-retention.js";
import { TrafficDumpStorage, type TrafficDumpSession, type TrafficPayloadPart } from "./traffic-dump-storage.js";
import type { ProviderProxyMetrics } from "./response-metrics-observer.js";

const MiB = 1024 * 1024;
const reservationBytes = 9 * MiB + 64 * 1024;
const sensitive = new Set(["authorization", "cookie", "set-cookie", "api_key", "api-key", "access_token", "refresh_token", "secret"]);
function redact(value: unknown): unknown {
  // JSON replacer avoids recursive traversal of attacker-controlled nesting.
  return JSON.parse(JSON.stringify(value, (key, item: unknown) => sensitive.has(key.toLowerCase()) ? "[REDACTED]" : item)) as unknown;
}
function headersOf(headers: IncomingHttpHeaders | OutgoingHttpHeaders): Record<string, unknown> {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => ["content-type", "accept", "user-agent"].includes(key.toLowerCase())));
}

export interface DirectChatCapture {
  submitted(request: DirectChatRequest, headers: IncomingHttpHeaders | OutgoingHttpHeaders, path: string): void;
  head(status: number, headers: IncomingHttpHeaders | OutgoingHttpHeaders): void;
  value(value: unknown, stream: boolean): void;
  invalid(bytes: number): void;
  done(): void;
  finish(delivery: "finished" | "disconnected" | "failed", errorCode?: string, firstTokenMs?: number): ProviderProxyMetrics["traffic"];
}

/** One Relay owner, all accounts share the same V2 disk and pending-write budgets. */
export class RelayTrafficDump {
  private readonly sessions = new Set<TrafficDumpSession>();
  private readonly streams = new Set<WriteStream>();
  private queue = Promise.resolve();
  private reserved = 0;
  private active = 0;
  private closed = false;
  private failed = false;
  private reported = false;
  private readonly storage: TrafficDumpStorage;
  constructor(private readonly options: { directory: string; onError(error: Error): void }) {
    this.storage = new TrafficDumpStorage({ ...options, label: "relay.chat", retentionDays: 7, maximumBytes: 512 * MiB,
      maximumPendingBytes: 15 * MiB, rotateAfterPayloadBytes: 8 * MiB, onError: () => this.fail() }, {
      sessions: this.sessions, streams: this.streams, getWriteQueue: () => this.queue, setWriteQueue: queue => { this.queue = queue; },
    });
  }
  begin(provider: string): DirectChatCapture | undefined {
    if (this.closed || this.failed || this.active >= 32) return undefined;
    try {
      const budget = 512 * MiB - this.reserved - reservationBytes;
      const retained = pruneModelTrafficDumpSessions({ directory: this.options.directory, label: "relay.chat", retentionDays: 7,
        maximumBytes: Math.max(0, budget), protectedSessionDirectories: [...this.sessions].flatMap(session => session.sessionDirectory ? [session.sessionDirectory] : []) });
      if (budget < 0 || retained > budget) { this.notice("Relay traffic dump disk capacity exceeded"); return undefined; }
      this.reserved += reservationBytes;
      this.active++;
      let finished = false;
      const startedAtMs = Date.now();
      let submittedAt = performance.now();
      const session = this.storage.beginLogicalInteraction(startedAtMs);
      const id = this.storage.nextInteractionId(session);
      const reference = this.storage.reference(session, id);
      let requestSaved = false;
      let status: number | undefined;
      let responseHeaders: Record<string, unknown> = {};
      let bytes = 0;
      let truncated = false;
      let complete = false;
      let completedAt: number | undefined;
      let streaming = false;
      const parts: TrafficPayloadPart[] = [];
      let pending: Buffer[] = [];
      let pendingBytes = 0;
      const flush = (): void => {
        if (!pendingBytes) return;
        const content = Buffer.concat(pending, pendingBytes); pending = []; pendingBytes = 0;
        const part = this.storage.writePayload(session, content, "utf8");
        if (part) {
          const previous = parts.at(-1);
          if (previous && previous.file === part.file && previous.offset + previous.bytes === part.offset) previous.bytes += part.bytes;
          else parts.push(part);
        }
      };
      const append = (content: Buffer): void => {
        bytes += content.length;
        if (truncated || bytes > 8 * MiB) { truncated = true; return; }
        pending.push(content); pendingBytes += content.length;
        if (pendingBytes >= 32 * 1024) flush();
      };
      const safe = (operation: () => void): void => { if (!this.failed && !finished) try { operation(); } catch { this.fail(); } };
      return {
        submitted: (request, headers, path) => safe(() => {
          submittedAt = performance.now(); streaming = request.stream;
          const content = Buffer.from(JSON.stringify(redact(request)));
          const omitted = content.length > MiB;
          const part = omitted ? undefined : this.storage.writePayload(session, content, "utf8");
          this.storage.writeInteraction(session, { id, kind: "request", transport: "http", account: provider, startedAtMs,
            method: "POST", path, headers: headersOf(headers), requestModel: request.model,
            bytes: Buffer.byteLength(JSON.stringify(request)), payload: { bytes: part?.bytes ?? 0, parts: part ? [part] : [], truncated: omitted } });
          requestSaved = true;
        }),
        head: (code, headers) => safe(() => { status = code; responseHeaders = headersOf(headers); }),
        value: (value, stream) => safe(() => {
          const content = Buffer.from(stream ? `data: ${JSON.stringify(redact(value))}\n\n` : JSON.stringify(redact(value)));
          append(content);
        }),
        invalid: count => safe(() => { bytes += count; truncated = true; }),
        done: () => safe(() => { complete = true; completedAt = performance.now(); if (streaming) append(Buffer.from("data: [DONE]\n\n")); }),
        finish: (delivery, errorCode, firstTokenMs) => {
          if (finished) return undefined;
          safe(() => {
            if (!requestSaved) return;
            flush();
            this.storage.writeInteraction(session, { id, kind: "response", transport: "http", status, headers: responseHeaders,
              state: complete ? "completed" : "incomplete", deliveryStatus: delivery, error: errorCode,
              errorScope: complete ? undefined : "upstream_response", bytes,
              payload: { bytes: parts.reduce((sum, part) => sum + part.bytes, 0), parts, truncated },
              capture: "redacted_upstream_chat", firstTokenMs, callTiming: { clock: "monotonic", basis: "submitted", endMs: (completedAt ?? performance.now()) - submittedAt } });
          });
          finished = true; pending = []; pendingBytes = 0; this.active--;
          this.storage.completeLogicalInteraction(session);
          void this.queue.finally(() => { this.reserved -= reservationBytes; });
          return requestSaved && !this.failed ? reference : undefined;
        },
      };
    } catch { this.fail(); return undefined; }
  }
  async close(): Promise<void> {
    this.closed = true;
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([this.storage.close(), new Promise<void>(resolve => {
      timer = setTimeout(() => { this.storage.abort(); resolve(); }, 5000);
    })]); } finally { clearTimeout(timer); }
  }
  private notice(message: string): void { if (this.reported) return; this.reported = true; try { this.options.onError(new Error(message)); } catch { /* Capture is a side channel. */ } }
  private fail(): void { this.failed = true; this.notice("Relay traffic dump capture failed"); }
}
