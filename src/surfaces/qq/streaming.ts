import { setTimeout as delay } from "node:timers/promises";
import type { OutputEvent } from "../../conversation-core/index.js";
import type { DeliveryCheckpoint } from "../delivery-receipt.js";
import { QQ_PASSIVE_WINDOW_MS, QQ_STREAM_BYTES, QqProtocolError, QqTextSendError, type QqProtocolClient } from "./protocol.js";
import type { QqTaskSources, QqTaskSourceReference } from "./task-sources.js";
import type { QqSendBudget } from "./send-budget.js";
import { qqBodyMarkdownPrefix } from "./body-markdown.js";
import { qqBodyMarkdownRestart, qqBodyMarkdownText } from "./message-markdown.js";

type Body = Extract<OutputEvent, { type: "text.delta" | "text.completed" }>;
interface Stream {
  key: string;
  controller: AbortController;
  source: QqTaskSourceReference;
  recipient: string;
  text: string;
  sent: string;
  index: number;
  id?: string;
  attempted: boolean;
  previewAdmitted: boolean;
  completed: boolean;
  failed: boolean;
  selected?: boolean;
  limited?: boolean;
  sealed?: boolean;
  sealTimer?: ReturnType<typeof setTimeout>;
  tail?: Promise<void>;
  anchor?: { messageId: string; sourceTimestampMs: number; signal: AbortSignal };
  deadline?: number;
  nextUpdateAt?: number;
  remainingCharacters?: number | undefined;
}

/** Disposable previews. Authoritative full Items still enter the shared delivery journal. */
export class QqBodyStreaming {
  private readonly lifetime = new AbortController();
  private readonly streams = new Map<string, Stream>();
  private readonly usedSources = new Set<string>();
  private readonly startedSources = new Map<string, { signal: AbortSignal; retire: () => void }>();

  constructor(private readonly client: Pick<QqProtocolClient, "sendStream">,
    private readonly sources: QqTaskSources, private readonly budget: QqSendBudget,
    private readonly failed: () => void, private readonly confirmed: (frames: number) => void) {}

  started(source: QqTaskSourceReference): void {
    const key = this.sourceKey(source);
    if (this.lifetime.signal.aborted || this.startedSources.has(key) || this.startedSources.size >= 4096) return;
    const signal = this.sources.cancellationSignal(source);
    if (!signal || signal.aborted) return;
    const retire = () => {
      this.startedSources.delete(key);
      this.usedSources.delete(source.sourceToken);
      for (const stream of this.streams.values()) {
        if (this.sourceKey(stream.source) === key) this.discard(stream);
      }
    };
    this.startedSources.set(key, { signal, retire });
    signal.addEventListener("abort", retire, { once: true });
  }

  /** Runs before the shared router may shed a delta. No networking in the observer. */
  observe(event: Body, source?: QqTaskSourceReference, previewAllowed = true): void {
    if (!event.target.conversationId.startsWith("c2c:")) return;
    const key = this.key(event);
    let stream = this.streams.get(key);
    if (event.type === "text.completed") {
      if (stream) stream.completed = true;
      return;
    }
    if (!source || !this.startedSources.has(this.sourceKey(source)) || this.lifetime.signal.aborted
      || (event.phase === "commentary" && previewAllowed)) return;
    if (!stream) {
      if (this.streams.size >= 128 || this.usedSources.size >= 4096 || this.usedSources.has(source.sourceToken)) return;
      stream = { key, controller: new AbortController(), source, recipient: event.target.conversationId.slice(4), text: "", sent: "",
        index: 0, attempted: false, previewAdmitted: false, completed: false, failed: false };
      this.streams.set(key, stream);
    }
    if (stream.failed || stream.completed || stream.sealed || stream.limited) return;
    stream.previewAdmitted ||= previewAllowed;
    if (stream.text.length + event.text.length > QQ_STREAM_BYTES
      || Buffer.byteLength(stream.text) + Buffer.byteLength(event.text) > QQ_STREAM_BYTES) {
      stream.limited = true; stream.text = "";
      if (stream.id) this.scheduleSeal(stream, 0);
      return;
    }
    stream.text += event.text;
  }

  /** Router permission to start best-effort work; one bounded owner per Item. */
  async update(event: Body, signal?: AbortSignal): Promise<void> {
    const stream = this.streams.get(this.key(event));
    if (!stream || !stream.previewAdmitted || stream.failed || stream.completed || stream.sealed || this.lifetime.signal.aborted) return;
    if (stream.tail) return stream.tail;
    const task = this.flush(stream, signal).catch(() => { stream.failed = true; this.failed(); })
      .finally(() => { if (stream.tail === task) delete stream.tail; });
    stream.tail = task;
    await task;
  }

  hasAdmittedPreview(event: Body): boolean {
    return this.streams.get(this.key(event))?.previewAdmitted === true;
  }

  /** Only removes a local buffer which has never been admitted for display. */
  discardUnadmitted(event: Body): void {
    const key = this.key(event);
    const stream = this.streams.get(key);
    if (!stream || stream.previewAdmitted) return;
    this.discard(stream);
  }

  /** Only a confirmed closed prefix permits active continuation; uncertain streams never switch modes. */
  async finish(event: Extract<Body, { type: "text.completed" }>, signal: AbortSignal,
    checkpoint: (value: DeliveryCheckpoint) => Promise<void>, authorized: () => boolean): Promise<
      { kind: "ordinary" } | { kind: "complete" } | { kind: "continue"; text: string; markdownStart: number }> {
    const key = this.key(event);
    const stream = this.streams.get(key);
    if (!stream) return { kind: "ordinary" };
    stream.completed = true;
    clearTimeout(stream.sealTimer);
    const bounded = AbortSignal.any([signal, this.lifetime.signal, stream.controller.signal, AbortSignal.timeout(45_000)]);
    const abort = () => stream.controller.abort();
    bounded.addEventListener("abort", abort, { once: true });
    if (bounded.aborted) abort();
    try {
      await stream.tail;
      bounded.throwIfAborted();
      if (!stream.attempted) return { kind: "ordinary" };
      const candidate = qqBodyMarkdownText(event.text);
      // Only the final unsent suffix may change representation. Never rewrite
      // a prefix already confirmed by replace-stream delivery.
      const text = candidate.startsWith(stream.sent) ? candidate : event.text;
      // A prior preview is already externally visible or uncertain, even if the final send is never attempted.
      const continuation = stream.sealed || stream.limited || Buffer.byteLength(text) > QQ_STREAM_BYTES
        || !this.fitsRemaining(stream, text)
        || performance.now() >= (stream.deadline ?? 0) - 45_000
        || qqBodyMarkdownPrefix(text, true).length !== text.length;
      const operation = continuation ? "qq-stream:prefix" : "qq-stream:complete";
      await checkpoint({ operation, state: "started" });
      bounded.throwIfAborted();
      if (stream.failed || !stream.id || !text.startsWith(stream.sent)) {
        throw new QqProtocolError("message", "invalid-response");
      }
      if (!stream.sealed) {
        await this.send(stream, continuation ? stream.sent : text, true, bounded, authorized);
        stream.sealed = true;
      }
      await checkpoint({ operation, state: "confirmed",
        ...(stream.id.length <= 256 ? { messageId: stream.id } : {}) });
      const suffix = text.slice(stream.sent.length);
      if (!suffix) { this.confirmed(stream.index); return { kind: "complete" }; }
      // Never split a completed grapheme across the old bubble and the continuation.
      let boundary = false;
      for (const segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
        if (segment.index < stream.sent.length) continue;
        boundary = segment.index === stream.sent.length;
        break;
      }
      if (!boundary) throw new QqProtocolError("message", "invalid-input");
      const marker = "正文续接：\n";
      const restart = qqBodyMarkdownRestart(text, stream.sent.length);
      return { kind: "continue", text: `${marker}${suffix}`,
        markdownStart: restart === stream.sent.length ? 0 : marker.length + restart - stream.sent.length };
    } finally {
      bounded.removeEventListener("abort", abort);
      // A later explicit journal retry selects a full-result representation and may duplicate previews.
      this.discard(stream);
    }
  }

  /** Revoke leftover previews without closing or resending any uncertain platform frame. */
  discardTurn(conversationId: string, threadId: string, turnId: string): void {
    for (const stream of this.streams.values()) {
      if (stream.source.conversationId !== conversationId || stream.source.threadId !== threadId || stream.source.turnId !== turnId) continue;
      this.discard(stream);
    }
  }

  async cancelTurn(conversationId: string, threadId: string, turnId: string): Promise<void> {
    const pending = [...this.streams.values()].filter(stream => stream.source.conversationId === conversationId
      && stream.source.threadId === threadId && stream.source.turnId === turnId).flatMap(stream => stream.tail ? [stream.tail] : []);
    this.discardTurn(conversationId, threadId, turnId);
    await Promise.allSettled(pending);
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    for (const stream of this.streams.values()) clearTimeout(stream.sealTimer);
    await Promise.allSettled([...this.streams.values()].flatMap(value => value.tail ? [value.tail] : []));
    for (const { signal, retire } of this.startedSources.values()) signal.removeEventListener("abort", retire);
    this.streams.clear(); this.usedSources.clear(); this.startedSources.clear();
  }

  private async flush(stream: Stream, caller?: AbortSignal): Promise<void> {
    const local = AbortSignal.any([this.lifetime.signal, stream.controller.signal, ...(caller ? [caller] : [])]);
    if (!(await this.sources.awaitSource(stream.source, local))) {
      this.discard(stream);
      return;
    }
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
    if (stream.completed || stream.failed || stream.sealed) return;
    if (!stream.selected) {
      // Candidate events are not source proof. Claim one Item only after the
      // exact response Turn is confirmed, synchronously across concurrent Items.
      if (this.usedSources.has(stream.source.sourceToken) || this.usedSources.size >= 4096) {
        stream.failed = true;
        return;
      }
      this.usedSources.add(stream.source.sourceToken);
      stream.selected = true;
    }
    if (stream.limited || stream.index >= 120) { await this.seal(stream, signal); return; }
    if (stream.text === stream.sent) return;
    // Start as soon as an eligible prefix exists; throttle subsequent updates.
    stream.nextUpdateAt ??= performance.now();
    const wait = Math.ceil(stream.nextUpdateAt - performance.now());
    if (wait > 0) await delay(wait, undefined, { signal });
    if (stream.completed || stream.failed || performance.now() >= stream.deadline - 15_000) return;
    // Native Markdown streams take the current full prefix, not complete blocks.
    // Retain the last grapheme: a later delta may extend it with a combining mark
    // or emoji joiner, which would invalidate a continuation boundary.
    const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(stream.text);
    let stableEnd = 0;
    for (const segment of segments) stableEnd = segment.index;
    const safeEnd = qqBodyMarkdownPrefix(stream.text.slice(0, stableEnd)).length;
    // The safety scanner may stop inside a grapheme (e.g. Prepend + '<').
    // Align its cut to the original text as well, not to the truncated prefix.
    let previewEnd = 0;
    for (const segment of segments) {
      if (segment.index > safeEnd) break;
      previewEnd = segment.index;
    }
    const text = stream.text.slice(0, previewEnd);
    if (!text.trim() || text === stream.sent || !text.startsWith(stream.sent)) return;
    if (!this.fitsRemaining(stream, text)) {
      stream.limited = true;
      await this.seal(stream, signal);
      return;
    }
    // A delta may split a UTF-16 surrogate pair; wait for the next delta instead of emitting invalid Unicode.
    if (/[\uD800-\uDFFF]/u.test(text)) return;
    await this.send(stream, text, false, signal, () => this.sources.isCurrent(stream.source));
    stream.nextUpdateAt = performance.now() + 1000;
    this.scheduleSeal(stream, stream.limited || stream.remainingCharacters === 0 || stream.index >= 120
      ? 0 : Math.max(0, stream.deadline - performance.now() - 45_000));
  }

  /** One owned boundary timer, only closes the already confirmed prefix; never emits newly buffered body. */
  private scheduleSeal(stream: Stream, wait: number): void {
    clearTimeout(stream.sealTimer);
    if (stream.completed || stream.failed || stream.sealed || this.lifetime.signal.aborted) return;
    stream.sealTimer = setTimeout(() => {
      const preceding = stream.tail;
      const task = Promise.resolve(preceding).then(async () => {
        if (!stream.completed && !stream.failed && !stream.sealed) await this.seal(stream, this.lifetime.signal);
      }).catch(() => { stream.failed = true; this.failed(); })
        .finally(() => { if (stream.tail === task) delete stream.tail; });
      stream.tail = task;
    }, wait);
    stream.sealTimer.unref();
  }

  private async seal(stream: Stream, signal: AbortSignal): Promise<void> {
    if (!stream.id || !stream.sent || stream.sealed) return;
    await this.send(stream, stream.sent, true, AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      () => this.sources.isCurrent(stream.source));
    stream.sealed = true;
    stream.text = "";
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
      if (!this.fitsRemaining(stream, content)) throw new QqProtocolError("message", "invalid-input");
    };
    guard();
    const reservation = this.budget.reserve(stream.recipient, 1);
    try {
      const result = await reservation.runPart(signal, () => this.client.sendStream({
        recipient: stream.recipient, messageId: anchor.messageId, sourceTimestampMs: anchor.sourceTimestampMs,
        content, contentType: "markdown", index: stream.index, ...(stream.id ? { streamId: stream.id } : {}), finished,
      }, { signal, beforeSend: guard }));
      const remaining = stream.remainingCharacters === undefined ? undefined
        : stream.remainingCharacters - Buffer.byteLength(content.slice(stream.sent.length));
      // Real QQ continuation responses can report zero on every accepted frame.
      // Zero is not evidence of exhaustion; only a positive hint tightens capacity.
      const reported = result.remainingCharacters === 0 ? undefined : result.remainingCharacters;
      stream.remainingCharacters = reported === undefined ? remaining
        : remaining === undefined ? reported : Math.min(remaining, reported);
      stream.attempted = true; stream.id = result.messageId; stream.sent = content; stream.index++;
      return result;
    } catch (error) {
      if (error instanceof QqTextSendError && error.outcome === "unknown") stream.attempted = true;
      throw error;
    }
  }

  private fitsRemaining(stream: Stream, content: string): boolean {
    // Upstream does not define which character unit it counts. UTF-8 bytes
    // conservatively bound the added text; the reported limit can only tighten.
    return stream.remainingCharacters === undefined
      || Buffer.byteLength(content.slice(stream.sent.length)) <= stream.remainingCharacters;
  }

  private discard(stream: Stream): void {
    stream.controller.abort();
    clearTimeout(stream.sealTimer);
    if (this.streams.get(stream.key) === stream) this.streams.delete(stream.key);
    stream.text = ""; stream.sent = "";
  }

  private key(event: Body): string {
    return JSON.stringify([event.target.conversationId, event.threadId, event.turnId, event.itemId]);
  }

  private sourceKey(source: QqTaskSourceReference): string {
    return JSON.stringify([source.sourceToken, source.threadId, source.turnId]);
  }
}
