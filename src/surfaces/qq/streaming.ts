import { setTimeout as delay } from "node:timers/promises";
import type { OutputEvent } from "../../conversation-core/index.js";
import type { DeliveryCheckpoint } from "../delivery-receipt.js";
import { QQ_PASSIVE_WINDOW_MS, QQ_STREAM_BYTES, QqProtocolError, QqTextSendError, type QqProtocolClient } from "./protocol.js";
import type { QqTaskSources, QqTaskSourceReference } from "./task-sources.js";
import type { QqSendBudget } from "./send-budget.js";

type Body = Extract<OutputEvent, { type: "text.delta" | "text.completed" }>;
interface Stream {
  controller: AbortController;
  source: QqTaskSourceReference;
  recipient: string;
  text: string;
  sent: string;
  index: number;
  id?: string;
  attempted: boolean;
  completed: boolean;
  failed: boolean;
  tail?: Promise<void>;
  anchor?: { messageId: string; sourceTimestampMs: number; signal: AbortSignal };
  deadline?: number;
  nextUpdateAt?: number;
}

/** Disposable previews. Authoritative full Items still enter the shared delivery journal. */
export class QqBodyStreaming {
  private readonly lifetime = new AbortController();
  private readonly streams = new Map<string, Stream>();
  private readonly usedSources = new Set<string>();
  private readonly startedSources = new Set<string>();

  constructor(private readonly client: Pick<QqProtocolClient, "sendStream">,
    private readonly sources: QqTaskSources, private readonly budget: QqSendBudget,
    private readonly failed: () => void, private readonly confirmed: (frames: number) => void) {}

  started(source: QqTaskSourceReference): void {
    if (this.startedSources.size < 4096) this.startedSources.add(source.sourceToken);
  }

  /** Runs before the shared router may shed a delta. No networking in the observer. */
  observe(event: Body, source?: QqTaskSourceReference): void {
    const key = this.key(event);
    let stream = this.streams.get(key);
    if (event.type === "text.completed") {
      if (stream) stream.completed = true;
      return;
    }
    if (!source || !this.startedSources.has(source.sourceToken) || this.lifetime.signal.aborted || event.phase === "commentary") return;
    if (!stream) {
      if (this.streams.size >= 128 || this.usedSources.size >= 4096 || this.usedSources.has(source.sourceToken)) return;
      this.usedSources.add(source.sourceToken);
      stream = { controller: new AbortController(), source, recipient: event.target.conversationId.slice(4), text: "", sent: "",
        index: 0, attempted: false, completed: false, failed: false };
      this.streams.set(key, stream);
    }
    if (stream.failed || stream.completed) return;
    if (stream.text.length + event.text.length > QQ_STREAM_BYTES
      || Buffer.byteLength(stream.text) + Buffer.byteLength(event.text) > QQ_STREAM_BYTES) {
      stream.failed = true; stream.text = ""; this.failed(); return;
    }
    stream.text += event.text;
  }

  /** Router permission to start best-effort work; one bounded owner per Item. */
  async update(event: Body, signal?: AbortSignal): Promise<void> {
    const stream = this.streams.get(this.key(event));
    if (!stream || stream.failed || stream.completed || this.lifetime.signal.aborted) return;
    if (stream.tail) return stream.tail;
    const task = this.flush(stream, signal).catch(() => { stream.failed = true; this.failed(); })
      .finally(() => { if (stream.tail === task) delete stream.tail; });
    stream.tail = task;
    await task;
  }

  /** Returns false only when no frame could have reached QQ. No implicit full replay after partial output. */
  async finish(event: Extract<Body, { type: "text.completed" }>, signal: AbortSignal,
    checkpoint: (value: DeliveryCheckpoint) => Promise<void>, authorized: () => boolean): Promise<boolean> {
    const key = this.key(event);
    const stream = this.streams.get(key);
    if (!stream) return false;
    stream.completed = true;
    const bounded = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(45_000)]);
    const abort = () => stream.controller.abort();
    bounded.addEventListener("abort", abort, { once: true });
    if (bounded.aborted) abort();
    try {
      await stream.tail;
      if (!stream.attempted) return false;
      // A prior preview is already externally visible or uncertain, even if the final send is never attempted.
      await checkpoint({ operation: "qq-stream:complete", state: "started" });
      if (stream.failed || !stream.id || !event.text.startsWith(stream.sent)) {
        throw new QqProtocolError("message", "invalid-response");
      }
      const result = await this.send(stream, event.text, true, bounded, authorized);
      await checkpoint({ operation: "qq-stream:complete", state: "confirmed",
        ...(result.messageId.length <= 256 ? { messageId: result.messageId } : {}) });
      this.confirmed(stream.index);
      return true;
    } finally {
      bounded.removeEventListener("abort", abort);
      stream.controller.abort();
      // A later explicit journal retry uses the existing complete-text path and may duplicate previews.
      this.streams.delete(key);
      stream.text = ""; stream.sent = "";
    }
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled([...this.streams.values()].flatMap(value => value.tail ? [value.tail] : []));
    this.streams.clear(); this.usedSources.clear(); this.startedSources.clear();
  }

  private async flush(stream: Stream, caller?: AbortSignal): Promise<void> {
    const local = AbortSignal.any([this.lifetime.signal, stream.controller.signal, ...(caller ? [caller] : [])]);
    if (!(await this.sources.awaitSource(stream.source, local))) return;
    const anchor = this.sources.streamSource(stream.source);
    if (!anchor) return;
    const remaining = QQ_PASSIVE_WINDOW_MS - (Date.now() - anchor.sourceTimestampMs);
    // Reserve enough time for the final request; expired/no-preview Items retain ordinary active delivery.
    if (remaining <= 15_000 || remaining > QQ_PASSIVE_WINDOW_MS) return;
    stream.anchor ??= anchor;
    stream.deadline ??= performance.now() + remaining;
    const timeLeft = Math.ceil(stream.deadline - performance.now());
    if (timeLeft <= 0) return;
    const signal = AbortSignal.any([local, anchor.signal, AbortSignal.timeout(timeLeft)]);
    if (stream.completed || stream.failed || stream.index >= 120 || stream.text === stream.sent) return;
    stream.nextUpdateAt ??= performance.now() + 1000;
    const wait = Math.ceil(stream.nextUpdateAt - performance.now());
    if (wait > 0) await delay(wait, undefined, { signal });
    if (stream.completed || stream.failed || performance.now() >= stream.deadline - 15_000) return;
    const text = stream.text;
    if (!text.trim() || text === stream.sent) return;
    // A delta may split a UTF-16 surrogate pair; wait for the next delta instead of emitting invalid Unicode.
    if (/[\uD800-\uDFFF]/u.test(text)) return;
    await this.send(stream, text, false, signal, () => this.sources.isCurrent(stream.source));
    stream.nextUpdateAt = performance.now() + 1000;
  }

  private async send(stream: Stream, content: string, finished: boolean, caller: AbortSignal,
    authorized: () => boolean): Promise<{ messageId: string }> {
    const anchor = stream.anchor;
    if (!anchor || stream.deadline === undefined) throw new QqProtocolError("message", "authorization");
    const signal = AbortSignal.any([caller, this.lifetime.signal, stream.controller.signal, anchor.signal]);
    const guard = (): undefined => {
      signal.throwIfAborted();
      if (!this.sources.isCurrent(stream.source) || authorized() !== true) throw new QqProtocolError("message", "authorization");
      if (performance.now() >= stream.deadline!) throw new QqProtocolError("message", "expired");
      if (!content.startsWith(stream.sent)) throw new QqProtocolError("message", "invalid-input");
    };
    guard();
    const reservation = this.budget.reserve(stream.recipient, 1);
    try {
      const result = await reservation.runPart(signal, () => this.client.sendStream({
        recipient: stream.recipient, messageId: anchor.messageId, sourceTimestampMs: anchor.sourceTimestampMs,
        content, index: stream.index, ...(stream.id ? { streamId: stream.id } : {}), finished,
      }, { signal, beforeSend: guard }));
      stream.attempted = true; stream.id = result.messageId; stream.sent = content; stream.index++;
      return result;
    } catch (error) {
      if (error instanceof QqTextSendError && error.outcome === "unknown") stream.attempted = true;
      throw error;
    }
  }

  private key(event: Body): string {
    return JSON.stringify([event.target.conversationId, event.threadId, event.turnId, event.itemId]);
  }
}
