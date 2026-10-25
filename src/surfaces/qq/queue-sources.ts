import { randomUUID } from "node:crypto";
import type {
  QueuePreparation, QueueSubmissionConfirmation, QueueSubmissionOutcome, ThreadQueueSubmissionObserver,
} from "../../application/index.js";
import type { UserMessageIdentity } from "../../conversation-core/index.js";
import type { SurfaceTaskDeliverySource } from "../types.js";
import type { QqSourceInput } from "./message-input.js";
import type { QqTaskScope } from "./task-sources.js";
import { boundedQqConversationId, qqConversationActor } from "./addressing.js";

const MAX_ENTRIES = 4096;
const MAX_SOURCES = 128;
const MAX_WAITERS = 128;
const PREPARATION_MS = 30_000;
const DEDUP_MS = 600_000;
const SOURCE_MS = 86_400_000;
const DRAIN_MS = 60_000;

export interface QqQueueTicket {
  readonly sourceToken: string;
  readonly signal: AbortSignal;
  readonly observer: ThreadQueueSubmissionObserver;
  isCurrent(): boolean;
  cancel(): void;
}

export type QqQueueReservation = { kind: "accepted"; ticket: QqQueueTicket }
  | { kind: "rejected"; reason: "closed" | "clock" | "stale" | "expired" | "scope" | "invalid-input" | "duplicate" | "busy" | "capacity" };

interface Entry {
  readonly token: string;
  readonly dedupKey: string;
  readonly targetKey: string;
  readonly scope: Readonly<QqTaskScope>;
  readonly replyReference?: string;
  readonly deadline: number;
  readonly controller: AbortController;
  readonly candidates: Map<string, string>;
  readonly terminals: Map<string, number>;
  readonly waiters: Set<() => void>;
  preparation?: QueuePreparation;
  confirmation?: QueueSubmissionConfirmation;
  attempted: boolean;
  outcome?: QueueSubmissionOutcome;
  activeTurn?: string;
  expiresAt?: number;
  retainUntil: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Adapter-local identities only. App Server owns Queue contents and persistence. */
export class QqQueueSources {
  readonly generation = randomUUID();
  private readonly startedAt = Date.now();
  private lastWall = this.startedAt;
  private clockUnsafe = false;
  private closed = false;
  private waiterCount = 0;
  private readonly entries = new Map<string, Entry>();
  private readonly dedup = new Map<string, Entry>();
  private readonly pending = new Map<string, Entry>();

  constructor(private readonly options: {
    accountId: string;
    isCurrent: (scope: Readonly<QqTaskScope>, threadId?: string) => boolean;
  }) {
    this.options = Object.freeze({ accountId: options.accountId, isCurrent: options.isCurrent });
  }

  reserve(scope: QqTaskScope, message: QqSourceInput): QqQueueReservation {
    if (this.closed) return { kind: "rejected", reason: "closed" };
    if (message.conversationId !== scope.conversationId) return { kind: "rejected", reason: "scope" };
    const now = performance.now();
    const wall = Date.now();
    if (wall < this.lastWall) this.clockUnsafe = true;
    this.lastWall = Math.max(wall, this.lastWall);
    if (this.clockUnsafe) return { kind: "rejected", reason: "clock" };
    const kind = "kind" in message ? "interaction" : "text";
    if (![message.id, message.actorId, ...(kind === "text" && "msgIdx" in message ? [message.msgIdx] : [])].every(value => bounded(value))) {
      return { kind: "rejected", reason: "invalid-input" };
    }
    if (!Number.isSafeInteger(message.sentAtMs) || message.sentAtMs < this.startedAt
      || message.sentAtMs > wall || wall - message.sentAtMs > 60_000) return { kind: "rejected", reason: "stale" };
    const snapshot = Object.freeze({ accountId: scope.accountId, actorId: scope.actorId,
      conversationId: scope.conversationId, workspaceId: scope.workspaceId, workspaceCwd: scope.workspaceCwd });
    if (![snapshot.accountId, snapshot.actorId, snapshot.workspaceId].every(value => bounded(value))
      || !boundedQqConversationId(snapshot.conversationId) || qqConversationActor(snapshot.conversationId) !== snapshot.actorId
      || !bounded(snapshot.workspaceCwd, 32 * 1024) || snapshot.accountId !== this.options.accountId
      || snapshot.actorId !== message.actorId) return { kind: "rejected", reason: "scope" };
    this.prune();
    const allowed = this.guard(snapshot);
    if (this.closed) return { kind: "rejected", reason: "closed" };
    if (!allowed) return { kind: "rejected", reason: "scope" };
    if (this.clockUnsafe) return { kind: "rejected", reason: "clock" };
    if (performance.now() >= now + PREPARATION_MS) return { kind: "rejected", reason: "expired" };
    const dedupKey = JSON.stringify([snapshot.accountId, snapshot.conversationId, snapshot.actorId, kind, message.id,
      "msgIdx" in message ? message.msgIdx : undefined]);
    if (this.dedup.has(dedupKey)) return { kind: "rejected", reason: "duplicate" };
    const targetKey = this.targetKey(snapshot);
    if (this.pending.has(targetKey)) return { kind: "rejected", reason: "busy" };
    if (this.entries.size >= MAX_ENTRIES
      || [...this.entries.values()].filter(entry => !entry.controller.signal.aborted).length >= MAX_SOURCES) {
      return { kind: "rejected", reason: "capacity" };
    }
    const entry: Entry = { token: randomUUID(), dedupKey, targetKey, scope: snapshot,
      ...("msgIdx" in message ? { replyReference: message.msgIdx } : {}),
      deadline: now + PREPARATION_MS, controller: new AbortController(), candidates: new Map(),
      terminals: new Map(), waiters: new Set(), attempted: false, retainUntil: now + DEDUP_MS };
    this.entries.set(entry.token, entry);
    this.dedup.set(dedupKey, entry);
    this.pending.set(targetKey, entry);
    this.arm(entry, entry.deadline);
    const observer: ThreadQueueSubmissionObserver = {
      prepared: value => {
        this.requirePending(entry);
        if (entry.preparation || !bounded(value.threadId) || !bounded(value.clientUserMessageId)
          || (value.kind !== "add" && value.kind !== "start")
          || (value.kind === "start" && !bounded(value.queuedSubmissionId))) throw new Error("QQ Queue 准备身份无效");
        entry.preparation = Object.freeze(value.kind === "add"
          ? { kind: value.kind, threadId: value.threadId, clientUserMessageId: value.clientUserMessageId }
          : { kind: value.kind, threadId: value.threadId, clientUserMessageId: value.clientUserMessageId,
            queuedSubmissionId: value.queuedSubmissionId });
        // A start may explicitly select our confirmed add, but two independent
        // Queue items sharing a client ID cannot establish an unambiguous source.
        const collisions = [...this.entries.values()].filter(other => other !== entry
          && other.preparation?.threadId === value.threadId
          && other.preparation.clientUserMessageId === value.clientUserMessageId);
        if (collisions.some(other => !this.sameQueueSelection(other, entry))) {
          for (const other of collisions) this.revoke(other);
          this.revoke(entry);
          throw new Error("QQ Queue client ID 身份冲突");
        }
        this.requirePending(entry);
      },
      requestAttempted: () => {
        if (entry.attempted) throw new Error("QQ Queue 来源不能重复提交");
        entry.attempted = true;
        this.requirePending(entry);
        if (!entry.preparation) throw new Error("QQ Queue 来源尚未准备");
      },
      confirmed: value => {
        this.requirePending(entry);
        const prepared = entry.preparation;
        if (entry.confirmation || !entry.attempted || !prepared || prepared.threadId !== value.threadId
          || prepared.kind !== value.kind || (value.kind === "add"
            ? !bounded(value.queuedSubmissionId) || value.clientUserMessageId !== prepared.clientUserMessageId
            : !bounded(value.turnId))) throw new Error("QQ Queue 来源与响应不一致");
        entry.confirmation = Object.freeze(value.kind === "add"
          ? { kind: value.kind, threadId: value.threadId, queuedSubmissionId: value.queuedSubmissionId,
            clientUserMessageId: value.clientUserMessageId }
          : { kind: value.kind, threadId: value.threadId, turnId: value.turnId });
        this.wake(entry);
      },
      settled: value => { this.settle(entry, value.outcome); },
    };
    return { kind: "accepted", ticket: Object.freeze({ sourceToken: entry.token, signal: entry.controller.signal,
      observer: Object.freeze(observer), isCurrent: () => this.pendingCurrent(entry), cancel: () => this.revoke(entry) }) };
  }

  /** Synchronous official identity projection, before output capture or enrichment. */
  observeIdentity(identity: Readonly<UserMessageIdentity>): void {
    if (this.closed || ![identity.threadId, identity.turnId, identity.itemId, identity.clientUserMessageId].every(value => bounded(value))) return;
    for (const entry of this.entries.values()) {
      const prepared = entry.preparation;
      if (!prepared || prepared.threadId !== identity.threadId || prepared.clientUserMessageId !== identity.clientUserMessageId
        || !this.liveCurrent(entry)) continue;
      if (!entry.attempted) { this.revoke(entry); continue; }
      // An explicit start has a second, authoritative Turn discriminator.
      const confirmed = entry.confirmation;
      if (confirmed?.kind === "start" && confirmed.turnId !== identity.turnId) continue;
      const previousItem = entry.candidates.get(identity.turnId);
      if ((previousItem !== undefined && previousItem !== identity.itemId)
        || (prepared.kind === "add" && entry.candidates.size > 0 && !entry.candidates.has(identity.turnId))
        || (!entry.candidates.has(identity.turnId) && entry.candidates.size >= 8)) {
        this.revoke(entry); continue;
      }
      entry.candidates.set(identity.turnId, identity.itemId);
      this.activate(entry);
      this.wake(entry);
    }
  }

  capture(target: Pick<QqTaskScope, "accountId" | "conversationId">, threadId: string, turnId: string): SurfaceTaskDeliverySource | undefined {
    if (this.closed || target.accountId !== this.options.accountId || !boundedQqConversationId(target.conversationId)
      || !bounded(threadId) || !bounded(turnId)) return undefined;
    for (const entry of this.entries.values()) {
      if (entry.targetKey !== this.targetKey(target) || entry.preparation?.threadId !== threadId
        || !entry.attempted || !entry.candidates.has(turnId) || !this.liveCurrent(entry)) continue;
      if (entry.confirmation?.kind === "start" && entry.confirmation.turnId !== turnId) continue;
      return Object.freeze({ generation: this.generation, sourceToken: entry.token,
        accountId: entry.scope.accountId, conversationId: entry.scope.conversationId, threadId, turnId });
    }
    return undefined;
  }

  isCurrent(reference: SurfaceTaskDeliverySource): boolean {
    const entry = this.resolve(reference);
    return !!entry && entry.activeTurn === reference.turnId && entry.outcome === "confirmed" && this.liveCurrent(entry);
  }

  replyReference(reference: SurfaceTaskDeliverySource): string | undefined {
    return this.isCurrent(reference) ? this.resolve(reference)!.replyReference : undefined;
  }

  async awaitSource(reference: SurfaceTaskDeliverySource, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const captured = Object.freeze({ ...reference });
    const entry = this.resolve(captured);
    if (!entry || !this.liveCurrent(entry)) return false;
    if (entry.activeTurn !== undefined) return this.isCurrent(captured) && !signal.aborted;
    if (this.waiterCount >= MAX_WAITERS) return false;
    return new Promise<boolean>(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        const current = !signal.aborted && this.liveCurrent(entry);
        const excluded = entry.confirmation?.kind === "start" && entry.confirmation.turnId !== captured.turnId;
        if (done || (current && entry.activeTurn === undefined && !excluded)) return;
        done = true;
        entry.waiters.delete(finish);
        signal.removeEventListener("abort", finish);
        this.waiterCount--;
        resolve(!signal.aborted && this.isCurrent(captured));
      };
      this.waiterCount++;
      entry.waiters.add(finish);
      signal.addEventListener("abort", finish, { once: true });
      finish();
    });
  }

  terminal(reference: SurfaceTaskDeliverySource): void {
    const entry = this.resolve(reference);
    if (!entry || !entry.candidates.has(reference.turnId) || !this.liveCurrent(entry)) return;
    const deadline = performance.now() + DRAIN_MS;
    if (!entry.terminals.has(reference.turnId)) entry.terminals.set(reference.turnId, deadline);
    if (entry.activeTurn === reference.turnId) this.expireBy(entry, deadline);
  }

  /** Caller invokes only after the official delete result reports deleted=true. */
  deleted(threadId: string, queuedSubmissionId: string): void {
    if (!bounded(threadId) || !bounded(queuedSubmissionId)) return;
    for (const entry of this.entries.values()) {
      if (entry.preparation?.threadId !== threadId) continue;
      const queueId = entry.preparation.kind === "start" ? entry.preparation.queuedSubmissionId
        : entry.confirmation?.kind === "add" ? entry.confirmation.queuedSubmissionId : undefined;
      if (queueId === queuedSubmissionId) this.revoke(entry);
    }
  }

  cancelTarget(target: Pick<QqTaskScope, "accountId" | "conversationId">): void {
    for (const entry of this.entries.values()) if (entry.targetKey === this.targetKey(target)) this.revoke(entry);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.entries.values()) this.revoke(entry);
    this.entries.clear(); this.dedup.clear(); this.pending.clear();
  }

  private sameQueueSelection(previous: Entry, start: Entry): boolean {
    const previousId = previous.preparation?.kind === "start" ? previous.preparation.queuedSubmissionId
      : previous.confirmation?.kind === "add" ? previous.confirmation.queuedSubmissionId : undefined;
    // A new explicit start can select a Queue item after a prior source was
    // cancelled or its start was unknown; none of those old tickets is revived.
    return start.preparation?.kind === "start" && previousId === start.preparation.queuedSubmissionId
      && JSON.stringify(previous.scope) === JSON.stringify(start.scope);
  }

  private settle(entry: Entry, outcome: QueueSubmissionOutcome): void {
    if (entry.outcome !== undefined) {
      if (!entry.controller.signal.aborted) throw new Error("QQ Queue 来源已结算");
      if (entry.outcome === "not-submitted" && (entry.attempted || outcome !== "not-submitted")) entry.outcome = "unknown";
      return;
    }
    if (!this.pendingCurrent(entry)) { this.revoke(entry); return; }
    entry.outcome = entry.attempted && outcome === "not-submitted" ? "unknown" : outcome;
    entry.retainUntil = Math.max(entry.retainUntil, performance.now() + DEDUP_MS);
    if (this.pending.get(entry.targetKey) === entry) this.pending.delete(entry.targetKey);
    clearTimeout(entry.timer);
    if (outcome !== "confirmed" || !entry.confirmation) { this.revoke(entry); return; }
    // A confirmed add may wait indefinitely in the official Queue. Only a
    // correlated userMessage starts the active-source lifetime.
    this.activate(entry);
    this.wake(entry);
  }

  private activate(entry: Entry): void {
    if (entry.outcome !== "confirmed" || !entry.confirmation || !this.liveCurrent(entry)) return;
    const turnId = entry.confirmation.kind === "start" ? entry.confirmation.turnId : entry.candidates.keys().next().value;
    if (turnId === undefined || !entry.candidates.has(turnId)) return;
    if (entry.activeTurn === undefined) {
      entry.activeTurn = turnId;
      entry.expiresAt = performance.now() + SOURCE_MS;
      const terminal = entry.terminals.get(turnId);
      if (terminal !== undefined) entry.expiresAt = Math.min(entry.expiresAt, terminal);
      this.arm(entry, entry.expiresAt);
    }
  }

  private resolve(reference: SurfaceTaskDeliverySource): Entry | undefined {
    if (reference.kind !== undefined) return undefined;
    if (this.closed || reference.generation !== this.generation || !bounded(reference.turnId)) return undefined;
    const entry = this.entries.get(reference.sourceToken);
    return entry && entry.scope.accountId === reference.accountId && entry.scope.conversationId === reference.conversationId
      && entry.preparation?.threadId === reference.threadId ? entry : undefined;
  }

  private pendingCurrent(entry: Entry): boolean {
    return entry.outcome === undefined && this.liveCurrent(entry);
  }

  private liveCurrent(entry: Entry): boolean {
    if (this.closed || entry.controller.signal.aborted) return false;
    const deadline = entry.outcome === undefined ? entry.deadline : entry.expiresAt;
    if ((deadline !== undefined && performance.now() >= deadline) || !this.guard(entry.scope, entry.preparation?.threadId)
      || this.closed || entry.controller.signal.aborted
      || (deadline !== undefined && performance.now() >= deadline)) {
      this.revoke(entry); return false;
    }
    return true;
  }

  private requirePending(entry: Entry): void {
    if (!this.pendingCurrent(entry)) throw new Error("QQ Queue 来源已取消、过期或失权");
  }

  private guard(scope: Readonly<QqTaskScope>, threadId?: string): boolean {
    try {
      const result: unknown = this.options.isCurrent(scope, threadId);
      if (typeof result !== "boolean") { void Promise.resolve(result).catch(() => undefined); return false; }
      return result;
    } catch { return false; }
  }

  private expireBy(entry: Entry, deadline: number): void {
    entry.expiresAt = Math.min(entry.expiresAt ?? deadline, deadline);
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
    this.wake(entry);
  }

  private wake(entry: Entry): void { for (const notify of [...entry.waiters]) notify(); }

  private prune(): void {
    const now = performance.now();
    for (const entry of this.entries.values()) {
      if (!entry.controller.signal.aborted) this.liveCurrent(entry);
      if (!entry.controller.signal.aborted || entry.outcome === "unknown" || now < entry.retainUntil) continue;
      this.entries.delete(entry.token);
      this.dedup.delete(entry.dedupKey);
    }
  }

  private targetKey(target: Pick<QqTaskScope, "accountId" | "conversationId">): string {
    return JSON.stringify([target.accountId, target.conversationId]);
  }
}

function bounded(value: unknown, maxBytes = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxBytes
    && value.trim().length > 0 && Buffer.byteLength(value) <= maxBytes;
}
