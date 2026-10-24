import { randomUUID } from "node:crypto";
import type { SubmissionObserver, SubmissionOutcome, SubmissionPreparation } from "../../application/index.js";
import type { QqInboundTextMessage } from "./inbound.js";

const MAX_ENTRIES = 4096;
const MAX_SOURCES = 128;
const MAX_WAITERS = 128;
const PREPARATION_MS = 30_000;
const DEDUP_MS = 600_000;
const SOURCE_MS = 86_400_000;
const DRAIN_MS = 60_000;

export interface QqTaskScope {
  readonly accountId: string;
  readonly actorId: string;
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly workspaceCwd: string;
}

/** A reference, never persisted authorization. No message body or credentials. */
export interface QqTaskSourceReference {
  readonly generation: string;
  readonly sourceToken: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly threadId: string;
  readonly turnId: string;
}

export interface QqTaskTicket {
  readonly sourceToken: string;
  readonly signal: AbortSignal;
  readonly observer: SubmissionObserver;
  /** Use for Application's live input guard, including after asynchronous waits. */
  isCurrent(): boolean;
  /** Does not interrupt an App Server task or revoke another ticket's source. */
  cancel(): void;
}

export type QqTaskReservation = { kind: "accepted"; ticket: QqTaskTicket }
  | { kind: "rejected"; reason: "closed" | "clock" | "stale" | "expired" | "scope" | "invalid-input" | "duplicate" | "busy" | "capacity" };

interface Entry {
  readonly token: string;
  readonly dedupKey: string;
  readonly targetKey: string;
  readonly scope: Readonly<QqTaskScope>;
  readonly message: Readonly<{ id: string; msgIdx: string; sentAtMs: number }>;
  readonly receivedAt: number;
  readonly deadline: number;
  readonly controller: AbortController;
  readonly waiters: Set<() => void>;
  readonly terminals: Map<string, number>;
  preparation?: SubmissionPreparation;
  attempted: boolean;
  confirmedTurn?: string;
  outcome?: SubmissionOutcome;
  source?: Entry;
  retainUntil: number;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** One adapter generation. Caller owns authorization, App Server and output bodies. */
export class QqTaskSources {
  readonly generation = randomUUID();
  private readonly startedAt = Date.now();
  private lastWall = this.startedAt;
  private clockUnsafe = false;
  private closed = false;
  private waiterCount = 0;
  private readonly entries = new Map<string, Entry>();
  private readonly dedup = new Map<string, Entry>();
  private readonly pending = new Map<string, Entry>();
  private readonly sources = new Map<string, Entry>();

  constructor(private readonly options: {
    accountId: string;
    /** Must verify the exact actor/workspace and, once known, Thread ownership. */
    isCurrent: (scope: Readonly<QqTaskScope>, threadId?: string) => boolean;
  }) {
    this.options = Object.freeze({ accountId: options.accountId, isCurrent: options.isCurrent });
  }

  reserve(scope: QqTaskScope, message: Pick<QqInboundTextMessage, "id" | "actorId" | "msgIdx" | "sentAtMs">): QqTaskReservation {
    if (this.closed) return { kind: "rejected", reason: "closed" };
    const receivedAt = performance.now();
    const original = Object.freeze({ id: message.id, actorId: message.actorId, msgIdx: message.msgIdx, sentAtMs: message.sentAtMs });
    const wall = Date.now();
    if (wall < this.lastWall) this.clockUnsafe = true;
    this.lastWall = Math.max(wall, this.lastWall);
    if (this.clockUnsafe) return { kind: "rejected", reason: "clock" };
    // Local metadata budgets, independent of upstream validity or authorization.
    if (![original.id, original.actorId, original.msgIdx].every(value => bounded(value))) {
      return { kind: "rejected", reason: "invalid-input" };
    }
    if (!Number.isSafeInteger(original.sentAtMs) || original.sentAtMs < this.startedAt
      || original.sentAtMs > wall || wall - original.sentAtMs > 60_000) return { kind: "rejected", reason: "stale" };
    const snapshot = Object.freeze({ accountId: scope.accountId, actorId: scope.actorId,
      conversationId: scope.conversationId, workspaceId: scope.workspaceId, workspaceCwd: scope.workspaceCwd });
    if (![snapshot.accountId, snapshot.actorId, snapshot.conversationId, snapshot.workspaceId].every(value => bounded(value))
      || !bounded(snapshot.workspaceCwd, 32 * 1024)
      || snapshot.accountId !== this.options.accountId || snapshot.actorId !== original.actorId) return { kind: "rejected", reason: "scope" };
    this.prune();
    if (this.closed) return { kind: "rejected", reason: "closed" };
    const allowed = this.guard(snapshot);
    if (this.closed) return { kind: "rejected", reason: "closed" };
    if (!allowed) return { kind: "rejected", reason: "scope" };
    if (this.clockUnsafe) return { kind: "rejected", reason: "clock" };
    if (performance.now() >= receivedAt + PREPARATION_MS) return { kind: "rejected", reason: "expired" };
    const dedupKey = JSON.stringify([snapshot.accountId, snapshot.actorId, original.id, original.msgIdx]);
    if (this.dedup.has(dedupKey)) return { kind: "rejected", reason: "duplicate" };
    const targetKey = this.targetKey(snapshot);
    if (this.pending.has(targetKey)) return { kind: "rejected", reason: "busy" };
    // Reserve source capacity before input submission, including possible start-or-steer.
    if (this.entries.size >= MAX_ENTRIES || this.sources.size + this.pending.size >= MAX_SOURCES) {
      return { kind: "rejected", reason: "capacity" };
    }
    const entry: Entry = { token: randomUUID(), dedupKey, targetKey, scope: snapshot,
      message: Object.freeze({ id: original.id, msgIdx: original.msgIdx, sentAtMs: original.sentAtMs }),
      receivedAt, deadline: receivedAt + PREPARATION_MS, expiresAt: receivedAt + SOURCE_MS, retainUntil: receivedAt + DEDUP_MS,
      controller: new AbortController(), waiters: new Set(), terminals: new Map(), attempted: false };
    this.entries.set(entry.token, entry);
    this.dedup.set(dedupKey, entry);
    this.pending.set(targetKey, entry);
    this.arm(entry, entry.deadline);
    const observer: SubmissionObserver = {
      prepared: value => {
        this.requirePending(entry);
        if (entry.preparation || !bounded(value.threadId) || !bounded(value.clientUserMessageId)
          || (value.kind === "steer" && !bounded(value.expectedTurnId))) throw new Error("QQ 提交来源准备身份无效");
        entry.preparation = Object.freeze({ ...value });
        this.requirePending(entry);
      },
      requestAttempted: () => {
        if (entry.attempted) throw new Error("QQ 提交来源不能重复提交");
        entry.attempted = true;
        this.requirePending(entry);
        if (!entry.preparation) throw new Error("QQ 提交来源尚未准备");
      },
      confirmed: value => {
        this.requirePending(entry);
        const prepared = entry.preparation;
        if (entry.confirmedTurn !== undefined || !entry.attempted || !prepared || prepared.threadId !== value.threadId || !bounded(value.turnId)
          || (prepared.kind === "steer" && prepared.expectedTurnId !== value.turnId)) {
          throw new Error("QQ 提交来源与响应不一致");
        }
        entry.confirmedTurn = value.turnId;
      },
      settled: value => { this.settle(entry, value.outcome); },
    };
    return { kind: "accepted", ticket: Object.freeze({ sourceToken: entry.token, signal: entry.controller.signal,
      observer: Object.freeze(observer), isCurrent: () => this.pendingCurrent(entry), cancel: () => this.revoke(entry) }) };
  }

  /** Called synchronously for each live event, before any enrichment or mailbox wait. */
  capture(target: Pick<QqTaskScope, "accountId" | "conversationId">, threadId: string, turnId: string): QqTaskSourceReference | undefined {
    if (this.closed || target.accountId !== this.options.accountId || !bounded(target.conversationId)
      || !bounded(threadId) || !bounded(turnId)) return undefined;
    const key = this.turnKey(target, threadId, turnId);
    let entry = this.sources.get(key);
    if (entry && !this.sourceCurrent(entry)) entry = undefined;
    if (!entry) {
      const pending = this.pending.get(this.targetKey(target));
      if (!pending || !pending.attempted || !this.pendingCurrent(pending)
        || pending.preparation?.threadId !== threadId
        || (pending.preparation.kind === "steer" && pending.preparation.expectedTurnId !== turnId)) return undefined;
      entry = pending;
    }
    return Object.freeze({ generation: this.generation, sourceToken: entry.token,
      accountId: entry.scope.accountId, conversationId: entry.scope.conversationId, threadId, turnId });
  }

  isCurrent(reference: QqTaskSourceReference): boolean {
    const entry = this.resolve(reference);
    if (!entry || entry.outcome !== "confirmed" || entry.confirmedTurn !== reference.turnId
      || entry.controller.signal.aborted || !entry.source) return false;
    const source = entry.source;
    const current = this.sourceCurrent(source);
    return current && !this.closed && !entry.controller.signal.aborted && entry.source === source;
  }

  async awaitSource(reference: QqTaskSourceReference, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const captured = Object.freeze({ ...reference });
    const entry = this.resolve(captured);
    if (!entry) return false;
    if (entry.outcome !== undefined) return this.isCurrent(captured) && !signal.aborted;
    if (!this.pendingCurrent(entry) || this.waiterCount >= MAX_WAITERS) return false;
    return new Promise<boolean>(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        const waiting = !signal.aborted && entry.outcome === undefined && this.pendingCurrent(entry);
        // pendingCurrent may revoke and synchronously re-enter this waiter.
        if (done || waiting) return;
        done = true;
        entry.waiters.delete(finish);
        signal.removeEventListener("abort", finish);
        this.waiterCount--;
        const current = this.isCurrent(captured);
        resolve(current && !signal.aborted);
      };
      this.waiterCount++;
      entry.waiters.add(finish);
      signal.addEventListener("abort", finish, { once: true });
      finish();
    });
  }

  /** May precede the submit response. Records only a Turn ID and a monotonic deadline. */
  terminal(reference: QqTaskSourceReference): void {
    const entry = this.resolve(reference);
    if (!entry) return;
    const deadline = performance.now() + DRAIN_MS;
    if (entry.outcome === undefined) {
      if (entry.terminals.has(reference.turnId)) return;
      if (entry.terminals.size >= 8) { this.revoke(entry); return; }
      entry.terminals.set(reference.turnId, deadline);
    } else if (this.isCurrent(reference) && entry.source) {
      this.expireBy(entry.source, deadline);
    }
  }

  cancelTarget(target: Pick<QqTaskScope, "accountId" | "conversationId">): void {
    const key = this.targetKey(target);
    for (const entry of this.entries.values()) if (entry.targetKey === key) this.revoke(entry);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.entries.values()) this.revoke(entry);
    this.entries.clear(); this.dedup.clear(); this.pending.clear(); this.sources.clear();
  }

  private settle(entry: Entry, outcome: SubmissionOutcome): void {
    if (entry.outcome !== undefined) {
      if (!entry.controller.signal.aborted) throw new Error("QQ 提交来源已结算");
      // Cancellation/expiry may settle locally before Application unwinds.
      // A late callback cannot revive a source or downgrade an uncertain write.
      if (entry.outcome === "not-submitted" && (entry.attempted || outcome !== "not-submitted")) entry.outcome = "unknown";
      return;
    }
    const current = this.pendingCurrent(entry);
    if (!current) {
      this.revoke(entry);
      if (entry.outcome === "not-submitted" && (entry.attempted || outcome !== "not-submitted")) entry.outcome = "unknown";
      return;
    }
    entry.outcome = entry.attempted && outcome === "not-submitted" ? "unknown" : outcome;
    entry.retainUntil = Math.max(entry.retainUntil, performance.now() + DEDUP_MS);
    if (this.pending.get(entry.targetKey) === entry) this.pending.delete(entry.targetKey);
    clearTimeout(entry.timer);
    if (outcome !== "confirmed" || !entry.confirmedTurn || !entry.preparation) {
      this.revoke(entry); return;
    }
    const key = this.turnKey(entry.scope, entry.preparation.threadId, entry.confirmedTurn);
    const previous = this.sources.get(key);
    const keepPrevious = previous && this.sourceCurrent(previous);
    if (!this.guard(entry.scope, entry.preparation.threadId) || this.closed || entry.controller.signal.aborted
      || performance.now() >= entry.deadline) { this.revoke(entry); return; }
    if (keepPrevious) {
      // A new input never replaces the original recipient, scope or source deadline.
      if (JSON.stringify(previous.scope) !== JSON.stringify(entry.scope)) { this.revoke(entry); return; }
      entry.source = previous;
    } else {
      entry.source = entry;
      this.sources.set(key, entry);
      this.arm(entry, entry.expiresAt);
    }
    const terminal = entry.terminals.get(entry.confirmedTurn);
    if (terminal !== undefined) this.expireBy(entry.source, terminal);
    entry.terminals.clear();
    this.wake(entry);
  }

  private resolve(reference: QqTaskSourceReference): Entry | undefined {
    if (this.closed || reference.generation !== this.generation || !bounded(reference.turnId)) return undefined;
    const entry = this.entries.get(reference.sourceToken);
    return entry && entry.scope.accountId === reference.accountId
      && entry.scope.conversationId === reference.conversationId
      && entry.preparation?.threadId === reference.threadId ? entry : undefined;
  }

  private pendingCurrent(entry: Entry): boolean {
    if (this.closed || entry.controller.signal.aborted || entry.outcome !== undefined) return false;
    if (performance.now() >= entry.deadline || !this.guard(entry.scope, entry.preparation?.threadId)
      || this.closed || entry.controller.signal.aborted || entry.outcome !== undefined || performance.now() >= entry.deadline) {
      this.revoke(entry); return false;
    }
    return true;
  }

  private sourceCurrent(entry: Entry): boolean {
    if (this.closed || entry.controller.signal.aborted || entry.source !== entry || entry.outcome !== "confirmed") return false;
    if (performance.now() >= entry.expiresAt || !this.guard(entry.scope, entry.preparation?.threadId)
      || this.closed || entry.controller.signal.aborted || entry.source !== entry || entry.outcome !== "confirmed"
      || performance.now() >= entry.expiresAt) {
      this.revoke(entry); return false;
    }
    return true;
  }

  private requirePending(entry: Entry): void {
    if (!this.pendingCurrent(entry)) throw new Error("QQ 提交来源已取消、过期或失权");
  }

  private guard(scope: Readonly<QqTaskScope>, threadId?: string): boolean {
    try {
      const result: unknown = this.options.isCurrent(scope, threadId);
      if (typeof result !== "boolean") {
        void Promise.resolve(result).catch(() => undefined);
        return false;
      }
      return result;
    }
    catch { return false; }
  }

  private expireBy(entry: Entry, deadline: number): void {
    entry.expiresAt = Math.min(entry.expiresAt, deadline);
    if (entry.expiresAt <= performance.now()) this.revoke(entry);
    else this.arm(entry, entry.expiresAt);
  }

  private arm(entry: Entry, deadline: number): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.revoke(entry), Math.max(0, deadline - performance.now()));
    entry.timer.unref();
  }

  private revoke(entry: Entry): void {
    clearTimeout(entry.timer);
    if (entry.outcome === undefined) entry.outcome = entry.attempted ? "unknown" : "not-submitted";
    if (this.pending.get(entry.targetKey) === entry) this.pending.delete(entry.targetKey);
    if (!entry.controller.signal.aborted) {
      entry.retainUntil = Math.max(entry.retainUntil, performance.now() + DEDUP_MS);
      entry.controller.abort();
    }
    if (entry.preparation && entry.confirmedTurn) {
      const key = this.turnKey(entry.scope, entry.preparation.threadId, entry.confirmedTurn);
      if (this.sources.get(key) === entry) this.sources.delete(key);
    }
    this.wake(entry);
  }

  private wake(entry: Entry): void { for (const notify of [...entry.waiters]) notify(); }

  private prune(): void {
    const now = performance.now();
    for (const entry of this.entries.values()) {
      if (entry.source === entry) this.sourceCurrent(entry);
      if (entry.outcome === undefined || entry.outcome === "unknown") continue;
      if (entry.source && this.sourceCurrent(entry.source)) continue;
      this.revoke(entry);
      if (now < entry.retainUntil) continue;
      this.entries.delete(entry.token);
      this.dedup.delete(entry.dedupKey);
    }
  }

  private targetKey(target: Pick<QqTaskScope, "accountId" | "conversationId">): string {
    return JSON.stringify([target.accountId, target.conversationId]);
  }

  private turnKey(target: Pick<QqTaskScope, "accountId" | "conversationId">, threadId: string, turnId: string): string {
    return JSON.stringify([target.accountId, target.conversationId, threadId, turnId]);
  }
}

function bounded(value: unknown, maxBytes = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxBytes
    && value.trim().length > 0 && Buffer.byteLength(value) <= maxBytes;
}
