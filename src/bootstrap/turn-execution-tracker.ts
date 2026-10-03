import { setTimeout as delay } from "node:timers/promises";
import type { ThreadHistoryPort } from "../application/index.js";
import type { ConversationInputEvent } from "../conversation-core/index.js";
import type { TurnExecutionMetric, TurnExecutionStore } from "../observability/index.js";

/** Owns bounded history hydration; cards and WebUI only read the metrics store. */
export class TurnExecutionTracker {
  private readonly pending = new Map<string, { provider: string; throughTurnId?: string }>();
  // Connection freshness only; completeness is always read from the database.
  private readonly observed = new Map<string, string>();
  private readonly abort = new AbortController();
  private active: { threadId: string; provider: string; invalidated: boolean } | undefined;
  private task: Promise<void> | undefined;

  constructor(
    private readonly history: Pick<ThreadHistoryPort, "listThreadTurns">,
    private readonly store: TurnExecutionStore,
    private readonly changed: () => void,
    private readonly failed: (error: unknown, threadId: string) => void,
  ) {}

  handle(event: ConversationInputEvent, provider: string): void {
    if (this.abort.signal.aborted) return;
    if (event.type !== "turn.completed" && event.type !== "thread.reverted") return;
    const threadId = event.threadId;
    const firstObservation = !this.observed.has(threadId);
    this.observe(threadId, provider);
    // Invalidate before any fallible store operation, including a failed live write.
    if (this.active?.threadId === threadId) this.active.invalidated = true;
    try {
      if (event.type === "thread.reverted") {
        this.store.invalidateThreadExecutions(threadId);
      } else {
        if (firstObservation) this.store.invalidateThreadExecutions(threadId, false);
        this.store.recordTurnExecution(threadId, provider, {
          turnId: event.turnId, durationMs: event.durationMs ?? null, recordedAtMs: Date.now(),
        });
      }
      this.notify(threadId);
      if (this.store.isExecutionHistoryComplete(threadId)) return;
    } catch (error) {
      this.failed(error, threadId);
      this.invalidate(threadId);
    }
    this.enqueue(threadId, provider, event.type === "turn.completed" ? event.turnId : undefined);
  }

  /** Called for restored bindings as well as completions; no new Turn is required. */
  synchronize(threadId: string, provider: string): void {
    if (this.abort.signal.aborted) return;
    if (this.active?.threadId === threadId) this.active.invalidated = true;
    this.invalidate(threadId);
    this.observe(threadId, provider);
    this.enqueue(threadId, provider);
  }

  private observe(threadId: string, provider: string): void {
    this.observed.set(threadId, provider);
    if (this.observed.size > 1_024) this.observed.delete(this.observed.keys().next().value!);
  }

  private invalidate(threadId: string): void {
    try {
      this.store.invalidateThreadExecutions(threadId, false);
      this.notify(threadId);
    } catch (error) { this.failed(error, threadId); }
  }

  private notify(threadId: string): void {
    try { this.changed(); } catch (error) { this.failed(error, threadId); }
  }

  private enqueue(threadId: string, provider: string, throughTurnId?: string): void {
    if (this.pending.size >= 64 && !this.pending.has(threadId)) {
      this.failed(new Error("轮次耗时同步队列已满"), threadId);
      return;
    }
    this.pending.set(threadId, { provider, ...(throughTurnId === undefined ? {} : { throughTurnId }) });
    this.startDrain();
  }

  async settled(): Promise<void> { while (this.task) await this.task; }

  private startDrain(): void {
    if (this.task || this.abort.signal.aborted || this.pending.size === 0) return;
    this.task = Promise.resolve().then(() => this.drain()).finally(() => {
      this.task = undefined;
      this.startDrain();
    });
  }

  reset(provider?: string): void {
    if (this.active && (provider === undefined || this.active.provider === provider)) this.active.invalidated = true;
    for (const [threadId, pending] of this.pending) {
      if (provider === undefined || pending.provider === provider) this.pending.delete(threadId);
    }
    for (const [threadId, observedProvider] of this.observed) {
      if (provider !== undefined && provider !== observedProvider) continue;
      this.invalidate(threadId);
      this.observed.delete(threadId);
    }
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.pending.clear();
    this.observed.clear();
    await this.settled();
  }

  private async drain(): Promise<void> {
    while (this.pending.size > 0 && !this.abort.signal.aborted) {
      const [threadId, { provider, throughTurnId }] = this.pending.entries().next().value!;
      this.pending.delete(threadId);
      const active = { threadId, provider, invalidated: false };
      this.active = active;
      const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(5_000)]);
      try {
        for (let attempt = 0; attempt < 3 && !active.invalidated && !signal.aborted; attempt += 1) {
          try {
            if (attempt > 0) await delay(attempt * 100, undefined, { signal });
            if (active.invalidated) break;
            // Repair invalidation too if the original write failed while the database was unavailable.
            this.store.invalidateThreadExecutions(threadId, false);
            this.notify(threadId);
            const turns = await readThreadExecutions(this.history, threadId, signal);
            if (signal.aborted || active.invalidated) break;
            if (throughTurnId !== undefined && !turns.some(turn => turn.turnId === throughTurnId)) {
              throw new Error("官方历史尚未包含已完成轮次");
            }
            this.store.replaceThreadExecutions(threadId, provider, turns);
            this.notify(threadId);
            break;
          } catch (error) {
            if (!this.abort.signal.aborted && !active.invalidated) this.failed(error, threadId);
          }
        }
      } finally { this.active = undefined; }
    }
  }
}

export async function readThreadExecutions(
  history: Pick<ThreadHistoryPort, "listThreadTurns">,
  threadId: string,
  signal: AbortSignal,
): Promise<TurnExecutionMetric[]> {
  const turns: TurnExecutionMetric[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    signal.throwIfAborted();
    const request = history.listThreadTurns(threadId, { cursor, limit: 100, sortDirection: "desc" });
    const page = await new Promise<Awaited<typeof request>>((resolve, reject) => {
      const abort = () => reject(new Error("轮次耗时同步已取消或超时"));
      signal.addEventListener("abort", abort, { once: true });
      request.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
    signal.throwIfAborted();
    for (const turn of page.turns) {
      if (ids.has(turn.id)) throw new Error("轮次耗时历史包含重复轮次");
      ids.add(turn.id);
      if (turn.status === "inProgress") continue;
      turns.push({ turnId: turn.id, durationMs: turn.durationMs,
        recordedAtMs: turn.completedAt === null ? Date.now() : turn.completedAt * 1_000 });
    }
    if (page.nextCursor === null) return turns.reverse();
    if (cursors.has(page.nextCursor)) throw new Error("轮次耗时历史包含重复游标");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("轮次耗时历史超出分页上限");
}
