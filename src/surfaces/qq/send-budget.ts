import { setTimeout as delay } from "node:timers/promises";
import { QqProtocolError, QqTextSendError } from "./protocol.js";
import { qqRecipientKey } from "./addressing.js";

const RESULT_HEADROOM = 8;
const STATUS_HEADROOM = 2;
// Personal authentication: 10 QPS per bot, 20 QPM / 1000 daily per recipient.
// The daily counter is conservative rolling time, process-local, not a server quota ledger.
const REQUEST_INTERVAL_MS = 100;
const RECIPIENT_MINUTE_LIMIT = 20;
const RECIPIENT_DAY_LIMIT = 1000;

interface ReservationPart { held: boolean; released: boolean; settledAt: number }
type QqSendScope = { key: string; status: boolean; progress?: boolean } | "startup" | "interaction" | "critical-interaction" | "delivery" | "delivery-progress";
/** Local admission failure, never a QQ HTTP rate-limit response. */
export class QqBudgetError extends QqProtocolError {
  constructor(readonly budgetScope: "recipient-capacity" | "turn-capacity" | "waiter-capacity" | "recipient-minute" | "recipient-day" | "turn-progress" | "turn-status" | "turn-text",
    readonly budgetUsed: number, readonly budgetLimit: number, readonly requestedParts: number, readonly headroom: number) {
    super("message", "budget");
    this.name = "QqBudgetError";
  }
}

export function qqBudgetDiagnostics(error: unknown): Record<string, string | number> {
  return error instanceof QqBudgetError ? { budgetSource: "local", budgetScope: error.budgetScope,
    budgetUsed: error.budgetUsed, budgetLimit: error.budgetLimit, requestedParts: error.requestedParts,
    headroom: error.headroom } : {};
}

export interface QqSendReservation {
  runPart<T extends { messageId: string }>(signal: AbortSignal, send: () => Promise<T>): Promise<T>;
  release(): void;
}

/** One account generation, metadata only. Reservations are never refunded after unknown outcomes. */
export class QqSendBudget {
  private nextRequest = 0;
  private tail: Promise<void> = Promise.resolve();
  private readonly recipients = new Map<string, ReservationPart[]>();
  private readonly turns = new Map<string, { text: number; status: number; progress: number; until: number }>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private waiterCount = 0;

  /** Only unstarted durable delivery may wait; caller owns its unchanged deadline. */
  async reserveAfterWait(destination: string, parts: number, scope: "delivery" | "delivery-progress", signal: AbortSignal): Promise<QqSendReservation> {
    const recipient = qqRecipientKey(destination);
    for (;;) {
      signal.throwIfAborted();
      try { return this.reserve(destination, parts, scope); }
      catch (error) {
        if (!(error instanceof QqBudgetError) || error.budgetScope !== "recipient-minute") throw error;
      }
      if (this.waiterCount >= 128) throw new QqBudgetError("waiter-capacity", this.waiterCount, 128, parts, 0);
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let done = false;
        const waiting = this.waiters.get(recipient) ?? new Set<() => void>();
        const wake = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", wake);
          waiting.delete(wake);
          if (!waiting.size) this.waiters.delete(recipient);
          this.waiterCount--;
          if (signal.aborted) reject(signal.reason instanceof Error ? signal.reason : new QqProtocolError("message", "cancelled")); else resolve();
        };
        waiting.add(wake);
        this.waiters.set(recipient, waiting);
        this.waiterCount++;
        signal.addEventListener("abort", wake, { once: true });
        const now = performance.now();
        const pending = (this.recipients.get(recipient) ?? []).filter(part => !part.released && (part.held || part.settledAt + 60_000 > now));
        // The window may expire between reserve() and registering this wait.
        // Schedule a fresh admission even if no future settlement can wake us.
        const expiration = pending.length + parts <= RECIPIENT_MINUTE_LIMIT ? now
          : pending.filter(part => !part.held).reduce((earliest, part) => Math.min(earliest, part.settledAt + 60_000), Infinity);
        if (Number.isFinite(expiration)) {
          timer = setTimeout(wake, Math.max(1, Math.ceil(expiration - now)));
          timer.unref();
        }
        if (signal.aborted) wake();
      });
    }
  }

  reserve(destination: string, parts: number, scope?: QqSendScope): QqSendReservation {
    const recipient = qqRecipientKey(destination);
    const now = performance.now();
    const turn = typeof scope === "object" ? scope : undefined;
    const day = 86_400_000;
    for (const [key, values] of this.recipients) {
      const retained = values.filter(value => !value.released && (value.held || value.settledAt > now - day));
      if (retained.length) this.recipients.set(key, retained); else this.recipients.delete(key);
    }
    for (const [key, value] of this.turns) if (value.until <= now) this.turns.delete(key);
    const recipientTimes = this.recipients.get(recipient) ?? [];
    const usage = turn ? this.turns.get(turn.key) ?? { text: 0, status: 0, progress: 0, until: now + day } : undefined;
    // Optional output must leave room for one complete result and its terminal
    // status. Result output itself leaves this Turn's remaining status slots.
    // The headroom is admission policy, never additional platform quota.
    const headroom = turn && !turn.progress
      ? turn.status ? 0 : Math.max(0, STATUS_HEADROOM - usage!.status)
      : scope === undefined || scope === "critical-interaction" || scope === "delivery" || scope === "delivery-progress"
        ? 0 : RESULT_HEADROOM + STATUS_HEADROOM;
    if (!Number.isSafeInteger(parts) || parts < 1 || parts > 8) throw new QqProtocolError("message", "invalid-input");
    if (scope !== undefined && !this.recipients.has(recipient) && this.recipients.size >= 4096)
      throw new QqBudgetError("recipient-capacity", this.recipients.size, 4096, parts, 0);
    if (turn && !this.turns.has(turn.key) && this.turns.size >= 4096)
      throw new QqBudgetError("turn-capacity", this.turns.size, 4096, parts, 0);
    const minuteUsed = recipientTimes.filter(value => value.held || value.settledAt > now - 60_000).length;
    if (scope !== undefined && recipientTimes.length + parts + headroom > RECIPIENT_DAY_LIMIT)
      throw new QqBudgetError("recipient-day", recipientTimes.length, RECIPIENT_DAY_LIMIT, parts, headroom);
    if (scope !== undefined && minuteUsed + parts + headroom > RECIPIENT_MINUTE_LIMIT)
      throw new QqBudgetError("recipient-minute", minuteUsed, RECIPIENT_MINUTE_LIMIT, parts, headroom);
    if (usage && turn) {
      const used = turn.progress ? usage.progress : turn.status ? usage.status : usage.text;
      const limit = turn.progress ? 8 : turn.status ? 2 : 16;
      if (used + parts > limit) throw new QqBudgetError(turn.progress ? "turn-progress" : turn.status ? "turn-status" : "turn-text", used, limit, parts, 0);
    }
    if (usage && turn) {
      if (turn.progress) usage.progress += parts;
      else if (turn.status) usage.status += parts; else usage.text += parts;
      this.turns.set(turn.key, usage);
    }
    const reserved: ReservationPart[] = Array.from({ length: parts }, () => ({ held: true, released: false, settledAt: 0 }));
    if (scope !== undefined) {
      // In-flight requests remain charged, including slow uploads. Start the
      // rolling window at settlement, not at an invented future plan deadline.
      recipientTimes.push(...reserved);
      this.recipients.set(recipient, recipientTimes);
    }
    let next = 0;
    let closed = false;
    const releasePart = (part: ReservationPart): void => {
      if (part.released) return;
      part.released = true;
      if (usage && turn) {
        if (turn.progress) usage.progress--;
        else if (turn.status) usage.status--; else usage.text--;
      }
      this.wakeRecipient(recipient);
    };
    return { runPart: (signal, send) => {
      const part = reserved[next++];
      if (!part || closed) return Promise.reject(new QqProtocolError("message", "invalid-input"));
      let started = false;
      let abortQueued!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abortQueued = () => {
          if (started) return;
          releasePart(part);
          reject(new QqTextSendError("not-sent", new QqProtocolError("message", "cancelled")));
        };
        signal.addEventListener("abort", abortQueued, { once: true });
        if (signal.aborted) abortQueued();
      });
      const task = this.tail.then(async () => {
        signal.throwIfAborted();
        if (closed || part.released) throw new QqProtocolError("message", "cancelled");
        // Timers may wake slightly early; recheck the monotonic deadline.
        while (performance.now() < this.nextRequest) {
          await delay(Math.ceil(this.nextRequest - performance.now()), undefined, { signal });
        }
        signal.throwIfAborted();
        if (closed || part.released) throw new QqProtocolError("message", "cancelled");
        started = true;
        signal.removeEventListener("abort", abortQueued);
        try { return await send(); }
        catch (error) {
          if (error instanceof QqTextSendError && error.outcome === "not-sent") releasePart(part);
          throw error;
        } finally {
          part.held = false;
          part.settledAt = performance.now();
          this.nextRequest = part.settledAt + REQUEST_INTERVAL_MS;
          this.wakeRecipient(recipient);
        }
      }).catch(error => {
        if (!started) throw new QqTextSendError("not-sent", error instanceof QqProtocolError
          ? error : new QqProtocolError("message", signal.aborted ? "cancelled" : "invalid-input"));
        throw error;
      }).finally(() => {
        signal.removeEventListener("abort", abortQueued);
        if (!started) releasePart(part);
      });
      this.tail = task.then(() => {}, () => {});
      return Promise.race([task, cancelled]);
    }, release: () => {
      if (closed) return;
      closed = true;
      // Claimed parts are settled by runPart, including cancellation while
      // waiting behind another request. Never refund an in-flight outcome.
      for (const part of reserved.slice(next)) releasePart(part);
    } };
  }

  private wakeRecipient(recipient: string): void {
    for (const wake of [...(this.waiters.get(recipient) ?? [])]) wake();
  }
}
