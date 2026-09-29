import type { WriteStream } from "node:fs";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import type { DirectChatRequest } from "../model-api/index.js";
import { RelayDumpPayload, redactRelayValue } from "./relay-dump-payload.js";
import { relayDebugHeaders } from "./relay-debug-headers.js";
import { ChatDiagnostics } from "./chat-diagnostics.js";
import { waitForChatOperation } from "./chat-io.js";
import { pruneModelTrafficDumpSessionsAsync } from "./traffic-dump-retention.js";
import { TrafficDumpStorage, type TrafficDumpSession } from "./traffic-dump-storage.js";
import type { ProviderProxyMetrics } from "./response-metrics-observer.js";

const MiB = 1024 * 1024;
const reservationBytes = 9 * MiB + 64 * 1024;
function headersOf(headers: IncomingHttpHeaders | OutgoingHttpHeaders): Record<string, unknown> {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => ["content-type", "accept", "user-agent"].includes(key.toLowerCase())));
}

export interface DirectChatCapture {
  inbound?(value: unknown, headers: IncomingHttpHeaders): void;
  delivered?(value: unknown, stream: boolean, status: number, headers: OutgoingHttpHeaders): void;
  transformed?(operation: "headers_filtered" | "headers_overridden" | "stream_defaulted" | "json_unwrapped"): void;
  submitted(request: DirectChatRequest, headers: IncomingHttpHeaders | OutgoingHttpHeaders, path: string): void;
  head(status: number, headers: IncomingHttpHeaders | OutgoingHttpHeaders): void;
  value(value: unknown, stream: boolean): void;
  invalid(bytes: number): void;
  done(): void;
  finish(delivery: "finished" | "disconnected" | "failed", errorCode?: string, firstTokenMs?: number, responseModel?: string): ProviderProxyMetrics["traffic"];
}

/** One Relay owner, all accounts share the same V2 disk and pending-write budgets. */
export class RelayTrafficDump {
  private readonly sessions = new Set<TrafficDumpSession>();
  private readonly streams = new Set<WriteStream>();
  private queue = Promise.resolve();
  // Includes accepted writes that have not reached disk yet.
  private retained = 0;
  private protectedDuringMaintenance: string[] | undefined;
  private ready = false;
  private retentionDays = 30;
  private maintenance: Promise<void> | undefined;
  private lastMaintenance = -Infinity;
  private readonly maintenanceAbort = new AbortController();
  private active = 0;
  private reserved = 0;
  private closed = false;
  private failed = false;
  private readonly reported = new Set<string>();
  private readonly storage: TrafficDumpStorage;
  constructor(private readonly options: { directory: string; onError(error: Error): void }) {
    this.storage = new TrafficDumpStorage({ ...options, label: "relay.chat", retentionDays: this.retentionDays,
      retentionManagedExternally: true, maximumPendingBytes: 14 * MiB, rotateAfterPayloadBytes: 8 * MiB,
      onBytesAccepted: bytes => { this.retained += bytes; }, onError: () => this.fail() }, {
      sessions: this.sessions, streams: this.streams, getWriteQueue: () => this.queue, setWriteQueue: queue => { this.queue = queue; },
    });
  }
  setRetentionDays(days: number): void { this.retentionDays = days; }
  /** Initialize before enabling capture; never waits for model traffic. */
  async prepare(signal?: AbortSignal): Promise<void> {
    if (!this.ready) {
      const task = this.maintain();
      if (signal) await waitForChatOperation(task, signal);
      else await task;
    }
  }
  /** First enabled request waits for initialization, within its cancellation deadline. */
  async open(provider: string, signal: AbortSignal, debug = false): Promise<DirectChatCapture | undefined> {
    await this.prepare(signal);
    signal.throwIfAborted();
    return this.begin(provider, debug);
  }
  private maintain(): Promise<void> {
    if (this.maintenance) return this.maintenance;
    if (this.closed || this.failed) return Promise.resolve();
    const initializing = !this.ready;
    const protectedSessionDirectories = [...this.sessions].flatMap(session => session.sessionDirectory ? [session.sessionDirectory] : []);
    this.protectedDuringMaintenance = protectedSessionDirectories;
    this.maintenance = (async () => {
      const retained = await pruneModelTrafficDumpSessionsAsync({ directory: this.options.directory, label: "relay.chat", retentionDays: this.retentionDays,
        maximumBytes: 512 * MiB - reservationBytes - 128 * 1024,
        protectedSessionDirectories,
        onRemoved: bytes => { if (!initializing) this.retained -= bytes; } }, this.maintenanceAbort.signal);
      if (initializing) this.retained = retained;
      this.ready = true;
    })().catch(() => { if (!this.closed) this.fail(); }).finally(() => {
      this.lastMaintenance = performance.now(); this.maintenance = undefined; this.protectedDuringMaintenance = undefined;
    });
    return this.maintenance;
  }
  begin(provider: string, debug = false): DirectChatCapture | undefined {
    if (this.closed || this.failed || this.active >= 32) return undefined;
    const reservation = reservationBytes + (debug ? 128 * 1024 : 0);
    const full = this.retained + this.reserved + reservation > 512 * MiB;
    const elapsed = performance.now() - this.lastMaintenance;
    if (!this.ready || elapsed >= 60_000 || full && elapsed >= 1000) void this.maintain();
    if (!this.ready || full) {
      this.notice("Relay traffic dump capacity unavailable; capture skipped"); return undefined;
    }
    try {
      this.active++; this.reserved += reservation;
      let finished = false;
      const startedAtMs = Date.now();
      let submittedAt = performance.now();
      const session = this.storage.beginLogicalInteraction(startedAtMs);
      const id = this.storage.nextInteractionId(session);
      const reference = this.storage.reference(session, id);
      if (session.sessionDirectory && this.protectedDuringMaintenance && !this.protectedDuringMaintenance.includes(session.sessionDirectory)) {
        this.protectedDuringMaintenance.push(session.sessionDirectory);
      }
      let requestSaved = false;
      let status: number | undefined;
      let responseHeaders: Record<string, unknown> = {};
      let complete = false;
      let completedAt: number | undefined;
      let streaming = false;
      const upstream = new RelayDumpPayload(this.storage, session, (debug ? 4 : 8) * MiB);
      const delivered = debug ? new RelayDumpPayload(this.storage, session, 4 * MiB) : undefined;
      let inbound: { headers: Record<string, string | string[]>; headersTruncated: boolean; payload: ReturnType<RelayDumpPayload["finish"]> } | undefined;
      let inboundBody: unknown;
      let inboundHead: ReturnType<typeof relayDebugHeaders> | undefined;
      let deliveredStatus: number | undefined;
      let deliveredHeaders: ReturnType<typeof relayDebugHeaders> = { headers: {}, truncated: false };
      let upstreamHeadersTruncated = false;
      const diagnostics = new ChatDiagnostics();
      const requestChanges = new Set<string>();
      const responseChanges = new Set<string>();
      const safe = (operation: () => void): void => { if (!this.failed && !finished) try { operation(); } catch { this.fail(); } };
      return {
        ...(debug ? {
          inbound: (value: unknown, headers: IncomingHttpHeaders) => safe(() => {
            // Retain only until actual submission, so a failed outbound recheck cannot persist input.
            inboundBody = value; inboundHead = relayDebugHeaders(headers);
          }),
          delivered: (value: unknown, stream: boolean, status: number, headers: OutgoingHttpHeaders) => safe(() => {
            deliveredStatus = status; deliveredHeaders = relayDebugHeaders(headers); delivered!.value(value, stream);
          }),
          transformed: (operation: "headers_filtered" | "headers_overridden" | "stream_defaulted" | "json_unwrapped") => safe(() => {
            (operation === "json_unwrapped" ? responseChanges : requestChanges).add(operation);
          }),
        } : {}),
        submitted: (request, headers, path) => safe(() => {
          submittedAt = performance.now(); streaming = request.stream;
          if (debug && inboundHead) {
            const content = new RelayDumpPayload(this.storage, session, MiB / 2); content.value(inboundBody, false);
            inbound = { headers: inboundHead.headers, headersTruncated: inboundHead.truncated, payload: content.finish() };
            inboundBody = undefined; inboundHead = undefined;
          }
          const content = Buffer.from(redactRelayValue(request));
          const omitted = content.length > (debug ? MiB / 2 : MiB);
          const part = omitted ? undefined : this.storage.writePayload(session, content, "utf8");
          const head = debug ? relayDebugHeaders(headers) : undefined;
          this.storage.writeInteraction(session, { id, kind: "request", transport: "http", account: provider, startedAtMs,
            method: "POST", path, headers: head?.headers ?? headersOf(headers),
            ...(debug ? { headersTruncated: head!.truncated, debug: { version: 1, inbound, transformations: [...requestChanges] } } : {}), requestModel: request.model,
            bytes: Buffer.byteLength(JSON.stringify(request)), payload: { bytes: part?.bytes ?? 0, parts: part ? [part] : [], truncated: omitted } });
          requestSaved = true;
        }),
        head: (code, headers) => safe(() => { status = code; diagnostics.responseStatus(code); diagnostics.header(headers["x-request-id"]); const head = debug ? relayDebugHeaders(headers) : undefined; responseHeaders = head?.headers ?? headersOf(headers); upstreamHeadersTruncated = head?.truncated ?? false; }),
        value: (value, stream) => safe(() => {
          upstream.value(value, stream);
          const envelope = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
          diagnostics.push(!stream && envelope?.success === true && !Object.hasOwn(envelope, "choices") ? envelope.data : value);
        }),
        invalid: count => safe(() => { upstream.invalid(count); }),
        done: () => safe(() => { complete = true; completedAt = performance.now(); if (streaming) upstream.value(undefined, true); }),
        finish: (delivery, errorCode, firstTokenMs, responseModel) => {
          if (finished) return undefined;
          safe(() => {
            if (!requestSaved) return;
            const payload = upstream.finish();
            const snapshot = diagnostics.snapshot();
            const finalProvider = snapshot.fields["routing.finalProvider"];
            this.storage.writeTrace(session, { kind: "chat_diagnostics", interaction: id, ...snapshot });
            this.storage.writeInteraction(session, { id, kind: "response", transport: "http", status, headers: responseHeaders,
              ...(typeof finalProvider === "string" && finalProvider !== "" ? { upstreamProvider: finalProvider } : {}),
              ...(debug ? { headersTruncated: upstreamHeadersTruncated, debug: { version: 1,
                delivered: { status: deliveredStatus, headers: deliveredHeaders.headers, headersTruncated: deliveredHeaders.truncated,
                  payload: delivered!.finish(), state: deliveredStatus === undefined ? "not_started" : delivery }, transformations: [...responseChanges] } } : {}),
              responseModels: responseModel === undefined ? [] : [responseModel],
              state: complete ? "completed" : "incomplete", deliveryStatus: delivery, error: errorCode,
              errorScope: complete ? undefined : "upstream_response", bytes: upstream.bytes,
              payload,
              capture: "redacted_upstream_chat", firstTokenMs, callTiming: { clock: "monotonic", basis: "submitted", endMs: (completedAt ?? performance.now()) - submittedAt } });
          });
          finished = true; inboundBody = undefined; inboundHead = undefined;
          upstream.discard(); delivered?.discard(); this.active--; this.reserved -= reservation;
          this.storage.completeLogicalInteraction(session);
          return requestSaved && !this.failed ? reference : undefined;
        },
      };
    } catch { this.fail(); return undefined; }
  }
  async close(): Promise<void> {
    this.closed = true; this.maintenanceAbort.abort();
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([Promise.all([this.storage.close(), this.maintenance]), new Promise<void>(resolve => {
      timer = setTimeout(() => { this.storage.abort(); resolve(); }, 5000);
    })]); } finally { clearTimeout(timer); }
  }
  private notice(message: string): void { if (this.reported.has(message)) return; this.reported.add(message); try { this.options.onError(new Error(message)); } catch { /* Capture is a side channel. */ } }
  private fail(): void { this.failed = true; this.notice("Relay traffic dump capture failed"); }
}
