import type { WriteStream } from "node:fs";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import { RelayDumpPayload, redactRelayValue } from "./relay-dump-payload.js";
import { capturedTrafficHeaders } from "./traffic-dump-headers.js";
import { ChatDiagnostics } from "./chat-diagnostics.js";
import { chatStreamError, chatUpstreamError } from "./chat-errors.js";
import { waitForChatOperation } from "./chat-io.js";
import { pruneModelTrafficDumpSessionsAsync } from "./traffic-dump-retention.js";
import { TrafficDumpStorage, type TrafficDumpSession } from "./traffic-dump-storage.js";
import type { ProviderProxyMetrics } from "./response-metrics-observer.js";

const MiB = 1024 * 1024;
const reservationBytes = 9 * MiB + 64 * 1024;

export interface DirectChatCapture {
  inbound?(value: unknown, headers: IncomingHttpHeaders): void;
  delivered?(value: unknown, stream: boolean, status: number, headers: OutgoingHttpHeaders): void;
  transformed?(operation: "headers_filtered" | "headers_overridden" | "stream_defaulted" | "store_defaulted" | "provider_routing_pinned" | "json_unwrapped"): void;
  submitted(request: Record<string, unknown> & { model: string; stream: boolean }, headers: IncomingHttpHeaders | OutgoingHttpHeaders, path: string): void;
  head(status: number, headers: IncomingHttpHeaders | OutgoingHttpHeaders): void;
  value(value: unknown, stream: boolean): void;
  invalid(bytes: number): void;
  done(status?: "completed" | "failed" | "incomplete"): void;
  finish(delivery: "finished" | "disconnected" | "failed", errorCode?: string, firstTokenMs?: number, responseModel?: string): ProviderProxyMetrics["traffic"];
}

/** One Relay owner, all accounts share the same V2 disk and pending-write budgets. */
export class RelayTrafficDump {
  private readonly sessionGroups: Set<TrafficDumpSession>[] = [];
  private get sessions(): TrafficDumpSession[] { return this.sessionGroups.flatMap(group => [...group]); }
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
  private skippedCapacity = 0;
  private readonly reported = new Set<string>();
  private readonly storage: Record<"chat" | "responses", TrafficDumpStorage>;
  constructor(private readonly options: { directory: string; onError(error: Error): void }) {
    const pendingBudget = { bytes: 0 };
    const create = (protocol: "chat" | "responses"): TrafficDumpStorage => {
      const sessions = new Set<TrafficDumpSession>(); this.sessionGroups.push(sessions);
      return new TrafficDumpStorage({ ...options, label: `relay.${protocol}`, retentionDays: this.retentionDays,
        retentionManagedExternally: true, maximumPendingBytes: 14 * MiB, pendingBudget, rotateAfterPayloadBytes: 8 * MiB,
        onBytesAccepted: bytes => { this.retained += bytes; }, onError: () => this.fail() }, {
        sessions, streams: new Set<WriteStream>(), getWriteQueue: () => this.queue, setWriteQueue: queue => { this.queue = queue; },
      });
    };
    this.storage = { chat: create("chat"), responses: create("responses") };
  }

  setRetentionDays(days: number): void { this.retentionDays = days; }
  diagnostics(): { state: "initializing" | "ready" | "failed" | "closed"; active: number; skippedCapacity: number } {
    return { state: this.closed ? "closed" : this.failed ? "failed" : this.ready ? "ready" : "initializing",
      active: this.active, skippedCapacity: this.skippedCapacity };
  }
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
      const retained = await pruneModelTrafficDumpSessionsAsync({ directory: this.options.directory, labels: ["relay.chat", "relay.responses"], retentionDays: this.retentionDays,
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
  begin(provider: string, debug = false, protocol: "chat" | "responses" = "chat"): DirectChatCapture | undefined {
    const storage = this.storage[protocol];
    if (this.closed || this.failed) return undefined;
    if (this.active >= 32) { this.skippedCapacity = Math.min(Number.MAX_SAFE_INTEGER, this.skippedCapacity + 1); return undefined; }
    const reservation = reservationBytes + (debug ? 128 * 1024 : 0);
    const full = this.retained + this.reserved + reservation > 512 * MiB;
    const elapsed = performance.now() - this.lastMaintenance;
    if (!this.ready || elapsed >= 60_000 || full && elapsed >= 1000) void this.maintain();
    if (!this.ready || full) {
      if (full) this.skippedCapacity = Math.min(Number.MAX_SAFE_INTEGER, this.skippedCapacity + 1);
      this.notice("Relay traffic dump capacity unavailable; capture skipped"); return undefined;
    }
    try {
      this.active++; this.reserved += reservation;
      let finished = false;
      const startedAtMs = Date.now();
      let submittedAt = performance.now();
      const session = storage.beginLogicalInteraction(startedAtMs);
      const id = storage.nextInteractionId(session);
      const reference = storage.reference(session, id);
      if (session.sessionDirectory && this.protectedDuringMaintenance && !this.protectedDuringMaintenance.includes(session.sessionDirectory)) {
        this.protectedDuringMaintenance.push(session.sessionDirectory);
      }
      let requestSaved = false;
      let status: number | undefined;
      let responseHeaders: Record<string, unknown> = {};
      let complete = false;
      let modelStatus: "completed" | "failed" | "incomplete" = "incomplete";
      let completedAt: number | undefined;
      let streaming = false;
      const upstream = new RelayDumpPayload(storage, session, (debug ? 4 : 8) * MiB);
      const delivered = debug ? new RelayDumpPayload(storage, session, 4 * MiB) : undefined;
      let inbound: { headers: Record<string, string | string[]>; headersTruncated: boolean; payload: ReturnType<RelayDumpPayload["finish"]> } | undefined;
      let inboundBody: unknown;
      let inboundHead: ReturnType<typeof capturedTrafficHeaders> | undefined;
      let deliveredStatus: number | undefined;
      let deliveredHeaders: ReturnType<typeof capturedTrafficHeaders> = { headers: {}, truncated: false };
      let upstreamHeadersTruncated = false;
      const diagnostics = new ChatDiagnostics();
      const requestChanges = new Set<string>();
      const responseChanges = new Set<string>();
      const safe = (operation: () => void): void => { if (!this.failed && !finished) try { operation(); } catch { this.fail(); } };
      return {
        ...(debug ? {
          inbound: (value: unknown, headers: IncomingHttpHeaders) => safe(() => {
            // Retain only until actual submission, so a failed outbound recheck cannot persist input.
            inboundBody = value; inboundHead = capturedTrafficHeaders(headers);
          }),
          delivered: (value: unknown, stream: boolean, status: number, headers: OutgoingHttpHeaders) => safe(() => {
            deliveredStatus = status; deliveredHeaders = capturedTrafficHeaders(headers); delivered!.value(value, stream);
          }),
          transformed: (operation: "headers_filtered" | "headers_overridden" | "stream_defaulted" | "store_defaulted" | "provider_routing_pinned" | "json_unwrapped") => safe(() => {
            (operation === "json_unwrapped" ? responseChanges : requestChanges).add(operation);
          }),
        } : {}),
        submitted: (request, headers, path) => safe(() => {
          submittedAt = performance.now(); streaming = request.stream;
          if (debug && inboundHead) {
            const content = new RelayDumpPayload(storage, session, MiB / 2); content.value(inboundBody, false);
            inbound = { headers: inboundHead.headers, headersTruncated: inboundHead.truncated, payload: content.finish() };
            inboundBody = undefined; inboundHead = undefined;
          }
          const content = Buffer.from(redactRelayValue(request));
          const omitted = content.length > (debug ? MiB / 2 : MiB);
          const part = omitted ? undefined : storage.writePayload(session, content, "utf8");
          const head = capturedTrafficHeaders(headers);
          storage.writeInteraction(session, { id, kind: "request", transport: "http", account: provider, startedAtMs,
            method: "POST", path, headers: head.headers, headersTruncated: head.truncated,
            ...(debug ? { debug: { version: 1, inbound, transformations: [...requestChanges] } } : {}), requestModel: request.model,
            bytes: Buffer.byteLength(JSON.stringify(request)), payload: { bytes: part?.bytes ?? 0, parts: part ? [part] : [], truncated: omitted } });
          requestSaved = true;
        }),
        head: (code, headers) => safe(() => { status = code; diagnostics.responseStatus(code); diagnostics.header(headers["x-request-id"]); const head = capturedTrafficHeaders(headers); responseHeaders = head.headers; upstreamHeadersTruncated = head.truncated; }),
        value: (value, stream) => safe(() => {
          upstream.value(value, stream);
          const envelope = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
          diagnostics.push(!stream && envelope?.success === true && !Object.hasOwn(envelope, "choices") ? envelope.data : value);
          if (protocol === "chat") {
            const error = status !== undefined && status !== 200 ? chatUpstreamError(envelope?.error, status) : chatStreamError(value);
            if (error) diagnostics.error(error.code, stream ? "stream" : "http", error.retryable);
          }
        }),
        invalid: count => safe(() => { upstream.invalid(count); }),
        done: (status = "completed") => safe(() => { complete = true; modelStatus = status; completedAt = performance.now(); if (streaming && protocol === "chat") upstream.value(undefined, true); }),
        finish: (delivery, errorCode, firstTokenMs, responseModel) => {
          if (finished) return undefined;
          safe(() => {
            if (!requestSaved) return;
            const payload = upstream.finish();
            const snapshot = diagnostics.snapshot();
            const finalProvider = snapshot.fields["routing.finalProvider"];
            if (protocol === "chat") storage.writeTrace(session, { kind: "chat_diagnostics", interaction: id, ...snapshot });
            storage.writeInteraction(session, { id, kind: "response", transport: "http", status, headers: responseHeaders, headersTruncated: upstreamHeadersTruncated,
              ...(typeof finalProvider === "string" && finalProvider !== "" ? { upstreamProvider: finalProvider } : {}),
              ...(debug ? { debug: { version: 1,
                delivered: { status: deliveredStatus, headers: deliveredHeaders.headers, headersTruncated: deliveredHeaders.truncated,
                  payload: delivered!.finish(), state: deliveredStatus === undefined ? "not_started" : delivery }, transformations: [...responseChanges] } } : {}),
              responseModels: responseModel === undefined ? [] : [responseModel],
              state: modelStatus, deliveryStatus: delivery, error: errorCode,
              errorScope: complete ? undefined : "upstream_response", bytes: upstream.bytes,
              payload,
              capture: protocol === "chat" ? "redacted_upstream_chat" : "redacted_upstream_responses", firstTokenMs, callTiming: { clock: "monotonic", basis: "submitted", endMs: (completedAt ?? performance.now()) - submittedAt } });
          });
          finished = true; inboundBody = undefined; inboundHead = undefined;
          upstream.discard(); delivered?.discard(); this.active--; this.reserved -= reservation;
          storage.completeLogicalInteraction(session);
          return requestSaved && !this.failed ? reference : undefined;
        },
      };
    } catch { this.fail(); return undefined; }
  }
  async close(): Promise<void> {
    this.closed = true; this.maintenanceAbort.abort();
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([Promise.all([...Object.values(this.storage).map(storage => storage.close()), this.maintenance]), new Promise<void>(resolve => {
      timer = setTimeout(() => { for (const storage of Object.values(this.storage)) storage.abort(); resolve(); }, 5000);
    })]); } finally { clearTimeout(timer); }
  }
  private notice(message: string): void { if (this.reported.has(message)) return; this.reported.add(message); try { this.options.onError(new Error(message)); } catch { /* Capture is a side channel. */ } }
  private fail(): void { this.failed = true; this.notice("Relay traffic dump capture failed"); }
}
