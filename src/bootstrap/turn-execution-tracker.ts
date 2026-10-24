import { setTimeout as delay } from "node:timers/promises";
import type { ThreadHistoryPort } from "../application/index.js";
import type { ConversationInputEvent } from "../conversation-core/index.js";
import type { AsyncTurnExecutionStore, TurnExecutionMetric } from "../observability/index.js";

/** Owns bounded history hydration; cards and WebUI only read the metrics store. */
export class TurnExecutionTracker {
  private readonly pending = new Map<string, { provider: string; throughTurnId?: string }>();
  // Connection freshness only; completeness is always read from the database.
  private readonly observed = new Map<string, string>();
  private readonly abort = new AbortController();
  private active: { threadId: string; provider: string; invalidated: boolean; reset: boolean; retryAfterInvalidation: boolean } | undefined;
  private task: Promise<void> | undefined;
  private readonly writes = new Set<Promise<void>>();
  private invalidation: Promise<void> | undefined;
  private reliable = true;
  private failureGeneration = 0;

  constructor(
    private readonly history: Pick<ThreadHistoryPort, "listThreadTurns">,
    private readonly store: AsyncTurnExecutionStore,
    private readonly changed: () => void,
    private readonly failed: (error: unknown, threadId: string) => void,
    private readonly scopedStore: (signal: AbortSignal) => AsyncTurnExecutionStore = () => store,
    private readonly fatal: (error: unknown) => void = error => failed(error, "<coverage>"),
  ) {}

  handle(event: ConversationInputEvent, provider: string): void {
    if (this.abort.signal.aborted) return;
    if (event.type !== "turn.completed" && event.type !== "thread.reverted") return;
    const threadId = event.threadId;
    const firstObservation = !this.observed.has(threadId);
    this.observe(threadId, provider);
    // Invalidate before any fallible store operation, including a failed live write.
    if (this.active?.threadId === threadId) this.active.invalidated = true;
    this.write(threadId, async () => {
      const complete = await this.store.observeTurnExecution(threadId, provider,
        event.type === "thread.reverted" ? { type: "reverted" } : {
          type: "completed", first: firstObservation,
          turn: { turnId: event.turnId, durationMs: event.durationMs ?? null, recordedAtMs: Date.now() },
        });
      // A hydration may have started while this live observation awaited its
      // Worker result. It must not replace the newer committed Turn facts.
      if (this.active?.threadId === threadId) this.active.invalidated = true;
      this.notify(threadId);
      if (complete) return;
      this.enqueue(threadId, provider, event.type === "turn.completed" ? event.turnId : undefined);
    }, () => this.enqueue(threadId, provider, event.type === "turn.completed" ? event.turnId : undefined));
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
    this.write(threadId, async () => {
      await this.store.invalidateThreadExecutions(threadId, false);
      this.notify(threadId);
    });
  }

  /** A failed live observation cannot certify an older database snapshot as complete. */
  isReliable(): boolean { return this.reliable; }

  private write(threadId: string, operation: () => Promise<void>, recover?: () => void): void {
    if (this.writes.size >= 128) {
      this.failed(new Error("轮次耗时写入队列已满"), threadId);
      this.invalidateCoverage();
      recover?.();
      return;
    }
    const task = operation().catch(error => {
      this.failed(error, threadId);
      if (this.active?.threadId === threadId) this.active.invalidated = true;
      this.invalidateCoverage();
      if (!this.abort.signal.aborted) recover?.();
    }).finally(() => this.writes.delete(task));
    this.writes.add(task);
  }

  private invalidateCoverage(): void {
    this.reliable = false;
    this.failureGeneration += 1;
    // 失效前发起的历史读取不能在全库降级后重新认证旧快照。
    if (this.active) {
      this.active.invalidated = true;
      this.active.retryAfterInvalidation = true;
    }
    this.startInvalidation();
  }

  private startInvalidation(): void {
    if (this.invalidation) return;
    let confirmedGeneration: number | undefined;
    this.invalidation = (async () => {
      let generation: number;
      do {
        generation = this.failureGeneration;
        await Promise.all([...this.writes]);
        await this.store.invalidateAllThreadExecutions();
        // 只有最新故障的持久降级得到确认后，数据库完整性标记才重新可信。
      } while (generation !== this.failureGeneration);
      confirmedGeneration = generation;
      this.reliable = true;
      this.changed();
    })().catch(error => this.fatal(error)).finally(() => {
      this.invalidation = undefined;
      // 提交确认到释放任务句柄之间到达的新故障同样需要持久降级。
      if (confirmedGeneration !== undefined && confirmedGeneration !== this.failureGeneration) this.startInvalidation();
    });
  }

  private notify(threadId: string): void {
    try { this.changed(); } catch (error) { this.failed(error, threadId); }
  }

  private enqueue(threadId: string, provider: string, throughTurnId?: string): void {
    if (this.abort.signal.aborted) return;
    if (this.pending.size >= 64 && !this.pending.has(threadId)) {
      this.invalidateCoverage();
      this.failed(new Error("轮次耗时同步队列已满"), threadId);
      return;
    }
    this.pending.set(threadId, { provider, ...(throughTurnId === undefined ? {} : { throughTurnId }) });
    this.startDrain();
  }

  async settled(): Promise<void> {
    while (this.task || this.writes.size > 0 || this.invalidation) await Promise.all([this.task, ...this.writes, this.invalidation]);
  }

  private startDrain(): void {
    if (this.task || this.abort.signal.aborted || this.pending.size === 0) return;
    this.task = Promise.resolve().then(() => this.drain()).finally(() => {
      this.task = undefined;
      this.startDrain();
    });
  }

  reset(provider?: string): void {
    if (this.active && (provider === undefined || this.active.provider === provider)) {
      this.active.invalidated = true;
      // 后续全局故障不能重新排入这个已断线代次；新同步自行创建任务。
      this.active.reset = true;
    }
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
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.settled(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("轮次耗时统计停止尚未确认")), 5_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async drain(): Promise<void> {
    while (this.pending.size > 0 && !this.abort.signal.aborted) {
      const [threadId, { provider, throughTurnId }] = this.pending.entries().next().value!;
      this.pending.delete(threadId);
      const active = { threadId, provider, invalidated: false, reset: false, retryAfterInvalidation: false };
      this.active = active;
      const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(5_000)]);
      try {
        // 先确认旧快照已经持久失效，再允许新历史建立自己的完整性。
        await this.invalidation;
        await Promise.all([...this.writes]);
        if (signal.aborted || active.invalidated) continue;
        const store = this.scopedStore(signal);
        await store.invalidateThreadExecutions(threadId, false);
        this.notify(threadId);
        let snapshot: TurnExecutionMetric[] | undefined;
        for (let attempt = 0; attempt < 3 && !active.invalidated && !signal.aborted; attempt += 1) {
          try {
            if (attempt > 0) await delay(attempt * 100, undefined, { signal });
            if (active.invalidated) break;
            const turns = await readThreadExecutions(this.history, threadId, signal);
            if (signal.aborted || active.invalidated) break;
            if (throughTurnId !== undefined && !turns.some(turn => turn.turnId === throughTurnId)) {
              throw new Error("官方历史尚未包含已完成轮次");
            }
            if (signal.aborted || active.invalidated) break;
            snapshot = turns;
            break;
          } catch (error) {
            if (!this.abort.signal.aborted && !active.invalidated) this.failed(error, threadId);
          }
        }
        // Retry only authoritative reads, never writes with an uncertain commit result.
        await Promise.all([...this.writes]);
        if (snapshot && !signal.aborted && !active.invalidated) {
          await store.replaceThreadExecutions(threadId, provider, snapshot);
          this.notify(threadId);
        }
      } catch (error) {
        const report = !this.abort.signal.aborted && !active.invalidated;
        this.invalidateCoverage();
        // 本次存储失败保持原有有界行为，不由失效恢复触发无穷重试。
        active.retryAfterInvalidation = false;
        if (report) this.failed(error, threadId);
      } finally {
        this.active = undefined;
        if (active.retryAfterInvalidation && !active.reset && !this.pending.has(threadId)) this.enqueue(threadId, provider, throughTurnId);
      }
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
    const request = history.listThreadTurns(threadId, { cursor, limit: 100, sortDirection: "desc", signal });
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
