import { setTimeout as delay } from "node:timers/promises";
import { QqProtocolError } from "./protocol.js";
import { qqRecipientKey, type QqRecipient } from "./addressing.js";

/** One account generation, metadata only. Reservations are never refunded after unknown outcomes. */
export class QqSendBudget {
  private nextRequest = 0;
  private tail: Promise<void> = Promise.resolve();
  private readonly recipients = new Map<string, number[]>();
  private account: number[] = [];
  private readonly turns = new Map<string, { text: number; status: number; progress: number; until: number }>();

  reserve(destination: QqRecipient, parts: number, scope?: { key: string; status: boolean; progress?: boolean } | "startup" | "interaction", planTimeoutMs = 45_000): {
    runPart<T extends { messageId: string }>(signal: AbortSignal, send: () => Promise<T>): Promise<T>;
  } {
    const recipient = qqRecipientKey(destination);
    if (planTimeoutMs !== 45_000 && planTimeoutMs !== 120_000) throw new QqProtocolError("message", "invalid-input");
    const now = performance.now();
    const turn = typeof scope === "object" ? scope : undefined;
    const day = 86_400_000;
    for (const [key, values] of this.recipients) {
      const retained = values.filter(value => value > now - day);
      if (retained.length) this.recipients.set(key, retained); else this.recipients.delete(key);
    }
    for (const [key, value] of this.turns) if (value.until <= now) this.turns.delete(key);
    this.account = this.account.filter(value => value > now - 60_000);
    const recipientTimes = this.recipients.get(recipient) ?? [];
    const usage = turn ? this.turns.get(turn.key) ?? { text: 0, status: 0, progress: 0, until: now + day } : undefined;
    if (!Number.isSafeInteger(parts) || parts < 1 || parts > 8) throw new QqProtocolError("message", "invalid-input");
    if ((!this.recipients.has(recipient) && this.recipients.size >= 4096)
      || (turn && !this.turns.has(turn.key) && this.turns.size >= 4096)
      || (scope !== undefined && (this.account.length + parts > 24
        || recipientTimes.filter(value => value > now - 60_000).length + parts > 16
        || recipientTimes.length + parts > 800))
      || (usage && turn && (turn.progress ? usage.progress + parts > 8 : turn.status ? usage.status + parts > 2 : usage.text + parts > 16))) {
      throw new QqProtocolError("message", "budget");
    }
    if (usage && turn) {
      if (turn.progress) usage.progress += parts;
      else if (turn.status) usage.status += parts; else usage.text += parts;
      this.turns.set(turn.key, usage);
    }
    if (scope !== undefined) {
      // Hold the full reservation through the entire bounded send plan.
      // This conservatively counts queued requests in all rolling windows.
      const reserved = Array<number>(parts).fill(now + planTimeoutMs);
      recipientTimes.push(...reserved);
      this.recipients.set(recipient, recipientTimes);
      this.account.push(...reserved);
    }
    let remaining = parts;
    return { runPart: (signal, send) => {
      const task = this.tail.then(async () => {
        signal.throwIfAborted();
        if (--remaining < 0) throw new QqProtocolError("message", "invalid-input");
        const wait = Math.ceil(this.nextRequest - performance.now());
        if (wait > 0) await delay(wait, undefined, { signal });
        signal.throwIfAborted();
        try { return await send(); }
        finally { this.nextRequest = performance.now() + 250; }
      });
      this.tail = task.then(() => {}, () => {});
      return task;
    } };
  }
}
