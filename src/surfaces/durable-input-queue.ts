import { DeliveryJournal, type DeliveryRecord } from "./delivery-journal.js";

export interface DurableInputQueueOptions<T> {
  journal: DeliveryJournal;
  purpose?: "input" | "output";
  stream: string;
  blockedByStream?: string;
  handle(payload: T, signal: AbortSignal, groupSize: number, sequence: number): Promise<void>;
  handleBatch?(payloads: readonly T[], signal: AbortSignal): Promise<void>;
  groupKey?(payload: T): string | undefined;
  onUncertain(id: string): void;
  concurrency?: number;
  available?(): boolean;
}

/** Acknowledgement follows durable admission, independently of business execution. */
export class DurableInputQueue<T> {
  private readonly active = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly abort = new AbortController();
  private started = false;
  private scheduled = false;
  private readonly concurrency: number;

  constructor(private readonly options: DurableInputQueueOptions<T>) {
    this.concurrency = options.concurrency ?? 8;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1) throw new Error("输入并发上限无效");
  }

  start(): void {
    if (this.started) return;
    if (this.abort.signal.aborted) throw new Error("持久输入队列已关闭");
    this.started = true;
    if (this.options.journal.recover(this.options.stream) > 0) this.options.onUncertain("recovered");
    this.schedule();
  }

  accept(id: string, lane: string, payload: T, control = false): boolean {
    if (this.abort.signal.aborted) throw new Error("持久输入队列已关闭");
    const inserted = this.options.journal.accept({ id, lane, stream: this.options.stream, payload, control }, this.options.purpose);
    this.schedule();
    return inserted;
  }

  async close(): Promise<void> {
    this.abort.abort();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([Promise.allSettled([...this.tasks]), new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private schedule(): void {
    if (!this.started || this.scheduled || this.abort.signal.aborted) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.abort.signal.aborted) return;
      try { this.pump(); } catch {
        this.abort.abort();
        try { this.options.journal.fail(); } catch { /* The startup guard remains set if the disk cannot be written. */ }
        this.options.onUncertain("storage-failure");
      }
    });
  }

  wake(): void { this.schedule(); }

  private pump(): void {
    if (this.options.available?.() === false) return;
    const pending = this.options.journal.pending(this.options.stream, this.options.blockedByStream);
    for (const row of pending) {
      if (this.inputPaused(row.control)) continue;
      const lane = `${row.control ? "control:" : "ordinary:"}${row.lane}`;
      if (this.active.has(lane) || this.active.size >= this.concurrency + (row.control ? 4 : 0)) continue;
      const record = this.options.journal.read<T>(row.id);
      const key = this.options.groupKey?.(record.payload);
      const batch = [record];
      if (key !== undefined) {
        for (const next of pending.slice(pending.indexOf(row) + 1)) {
          if (next.lane !== row.lane || next.control !== row.control) continue;
          const nextRecord = this.options.journal.read<T>(next.id);
          if (this.options.groupKey?.(nextRecord.payload) !== key) break;
          batch.push(nextRecord);
          if (batch.length >= 100) break;
        }
      }
      this.active.add(lane);
      const task = this.run(batch).finally(() => {
        this.active.delete(lane);
        this.tasks.delete(task);
        this.schedule();
      });
      this.tasks.add(task);
    }
  }

  private inputPaused(control: boolean): boolean {
    return this.options.purpose !== "output" && !control && this.options.journal.recoveryRequired;
  }

  private async run(batch: DeliveryRecord<T>[]): Promise<void> {
    if (this.options.handleBatch && this.options.groupKey?.(batch[0]!.payload) !== undefined) {
      if (this.abort.signal.aborted || this.inputPaused(batch[0]!.control)) return;
      const ids = batch.map(record => record.id);
      try {
        this.options.journal.markMany(ids, "processing");
        await this.options.handleBatch(batch.map(record => record.payload), this.abort.signal);
        if (this.abort.signal.aborted || this.inputPaused(batch[0]!.control)) throw new Error("输入组交接需要核对");
        this.options.journal.markMany(ids, "done");
      } catch {
        try { this.options.journal.markMany(ids, "uncertain"); }
        catch {
          this.abort.abort();
          try { this.options.journal.fail(); } catch { /* Keep the startup guard. */ }
        }
        for (const id of ids) this.options.onUncertain(id);
      }
      return;
    }
    await Promise.all(batch.map(async record => {
      if (this.abort.signal.aborted || this.inputPaused(record.control)) return;
      try {
        this.options.journal.mark(record.id, "processing");
        await this.options.handle(record.payload, this.abort.signal, batch.length, record.sequence);
        if (this.abort.signal.aborted || this.inputPaused(record.control)) throw new Error("输入交接需要核对");
        this.options.journal.mark(record.id, "done");
      } catch {
        try { this.options.journal.mark(record.id, "uncertain"); } catch {
          this.abort.abort();
          try { this.options.journal.fail(); } catch { /* Keep the startup guard. */ }
        }
        this.options.onUncertain(record.id);
      }
    }));
  }
}
