import type { RelayMetric } from "./server.js";
import type { RelayMetricEnvelope } from "../provider-proxy/index.js";
export type { RelayMetricEnvelope } from "../provider-proxy/index.js";

export type RelayMetricOutcome = "local_dropped" | "accepted" | "rejected" | "unconfirmed";
interface Entry { envelope: RelayMetricEnvelope; bytes: number }

/** Bounded, best-effort metrics only. Acceptance never claims durable storage. */
export class RelayMetricsSender {
  private readonly pending: Entry[] = [];
  private readonly active = new Set<AbortController>();
  private bytes = 0;
  private closing = false;
  private closed: Promise<void> | undefined;
  private notifyIdle: (() => void) | undefined;
  private readonly counts: Record<RelayMetricOutcome, number> = { local_dropped: 0, accepted: 0, rejected: 0, unconfirmed: 0 };

  constructor(private readonly send: (envelope: RelayMetricEnvelope, signal: AbortSignal) => Promise<unknown>) {}

  enqueue(sample: RelayMetric): void {
    const envelope: RelayMetricEnvelope = { version: 1, providerId: sample.provider, relayRequestId: sample.relayRequestId, sample: { ...sample } };
    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    if (this.closing || Buffer.byteLength(JSON.stringify(sample)) > 16 * 1024
      || this.pending.length + this.active.size >= 256 || this.bytes + bytes > 1024 * 1024) {
      this.count("local_dropped"); return;
    }
    this.bytes += bytes; this.pending.push({ envelope, bytes }); this.pump();
  }
  diagnostics(): Readonly<Record<RelayMetricOutcome, number>> & { pending: number; active: number; bytes: number } {
    return { ...this.counts, pending: this.pending.length, active: this.active.size, bytes: this.bytes };
  }
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    this.closed = new Promise(resolve => {
      const timer = setTimeout(() => {
        for (const entry of this.pending.splice(0)) { this.bytes -= entry.bytes; this.count("local_dropped"); }
        for (const controller of this.active) controller.abort();
        this.notifyIdle = undefined; resolve();
      }, 1000);
      this.notifyIdle = () => { clearTimeout(timer); this.notifyIdle = undefined; resolve(); };
      if (!this.pending.length && !this.active.size) this.notifyIdle();
    });
    return this.closed;
  }
  private pump(): void {
    while (this.active.size < 2 && this.pending.length) {
      const entry = this.pending.shift()!;
      const controller = new AbortController(); this.active.add(controller);
      let settled = false;
      const finish = (outcome: RelayMetricOutcome): void => {
        if (settled) return;
        settled = true; this.count(outcome);
      };
      const abort = (): void => finish("unconfirmed");
      controller.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(), 1000);
      // Retain the physical slot until send settles, even if a faulty adapter ignores cancellation.
      void Promise.resolve().then(() => this.send(entry.envelope, controller.signal)).then(
        result => finish(classify(result, entry.envelope.relayRequestId)),
        () => finish("unconfirmed"),
      ).finally(() => {
        clearTimeout(timer); controller.signal.removeEventListener("abort", abort);
        this.active.delete(controller); this.bytes -= entry.bytes;
        this.pump();
        if (!this.pending.length && !this.active.size) this.notifyIdle?.();
      });
    }
  }
  private count(outcome: RelayMetricOutcome): void { this.counts[outcome] = Math.min(Number.MAX_SAFE_INTEGER, this.counts[outcome] + 1); }
}

function classify(value: unknown, requestId: string): RelayMetricOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unconfirmed";
  const response = value as Record<string, unknown>;
  if (response.version !== 1 || response.relayRequestId !== requestId) return "unconfirmed";
  if (response.result === "accepted" && Object.keys(response).every(key => ["version", "relayRequestId", "result"].includes(key))) return "accepted";
  if (response.result === "rejected" && typeof response.reason === "string"
    && ["invalid_sample", "unknown_provider", "queue_full", "closing", "unsupported_version"].includes(response.reason)
    && Object.keys(response).every(key => ["version", "relayRequestId", "result", "reason"].includes(key))) return "rejected";
  return "unconfirmed";
}
