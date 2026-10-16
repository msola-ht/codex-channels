import { serialize } from "node:v8";
import type { ModelRequestMetricSample, ModelRequestMetricsWriter } from "./request-metrics.js";

const maximumPendingRecords = 10_000;
const maximumPendingBytes = 16 * 1024 * 1024;
const maximumBatchSize = 32;
const flushDelayMs = 10;

interface WriteScope { threadId: string | null; turnId: string | null; requestPurpose?: "autoApprovalReview" | null }
interface WriteEntry { sample: ModelRequestMetricSample; sequence: number; bytes: number }
interface WriteCheckpoint {
  target: number;
  matches: (scope: WriteScope) => boolean;
  resolve: (succeeded: boolean) => void;
}
interface WriterStore {
  record?(sample: ModelRequestMetricSample): void | Promise<void>;
  recordBatch?(samples: readonly ModelRequestMetricSample[]): void | Promise<void>;
  close(): void | Promise<void>;
}

export class BufferedModelRequestMetricsWriter<Store extends WriterStore = WriterStore> implements ModelRequestMetricsWriter {
  private readonly pending: WriteEntry[] = [];
  private readonly checkpoints: WriteCheckpoint[] = [];
  private readonly failures: { sample: WriteScope; sequence: number }[] = [];
  private failureOverflow = false;
  private active: WriteEntry[] = [];
  private task: Promise<void> | undefined;
  private closeTask: Promise<void> | undefined;
  private drainTask: Promise<void> | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private enqueuedCount = 0;
  private pendingRelay = 0;
  private pendingBytes = 0;
  private processedCount = 0;
  private closed = false;

  constructor(
    private readonly store: Store,
    private readonly onError?: (error: Error) => void,
    private readonly onCommitted?: () => void,
  ) {}

  enqueue(sample: ModelRequestMetricSample): void {
    if (this.closed) throw new Error("模型请求指标写入器已关闭");
    let bytes: number;
    let snapshot: ModelRequestMetricSample;
    try { bytes = serialize(sample).byteLength; }
    catch (error) { this.recordFailure(sample, 0); throw error; }
    if (this.pending.length + this.active.length >= maximumPendingRecords || this.pendingBytes + bytes > maximumPendingBytes) {
      this.recordFailure(sample, 0);
      throw new Error("模型请求指标待写队列已满");
    }
    if (sample.source === "relay" && this.pendingRelay >= 256) {
      this.recordFailure(sample, 0);
      throw new Error("Relay 指标待写队列已满");
    }
    try { snapshot = structuredClone(sample); }
    catch (error) { this.recordFailure(sample, 0); throw error; }
    if (sample.source === "relay") this.pendingRelay += 1;
    this.pendingBytes += bytes;
    this.pending.push({ sample: snapshot, sequence: ++this.enqueuedCount, bytes });
    this.scheduleFlush();
  }

  waitForCurrentWritesInScopes(
    scopes: readonly { threadId: string; turnId?: string }[],
    requestPurpose: "autoApprovalReview" | null,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.waitForMatchingWrites(scopeMatcher(scopes, requestPurpose), signal);
  }

  async waitForCurrentWritesInScope(
    resolveScopes: () => Promise<readonly { threadId: string; turnId?: string }[]>,
    requestPurpose: "autoApprovalReview" | null,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const target = this.enqueuedCount;
    // Only completion of this watermark matters here; failures are checked
    // against the database's authoritative task/session scope below.
    await this.waitForMatchingWrites(() => true, signal);
    signal?.throwIfAborted();
    const scopes = await resolveScopes();
    signal?.throwIfAborted();
    return this.succeeded(target, scopeMatcher(scopes, requestPurpose));
  }

  private waitForMatchingWrites(matchesScope: (scope: WriteScope) => boolean, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("模型请求指标等待已取消"));
    let target = this.processedCount;
    for (const entry of [...this.active, ...this.pending]) {
      if (matchesScope(entry.sample)) target = entry.sequence;
    }
    if (target <= this.processedCount) return Promise.resolve(this.succeeded(target, matchesScope));
    if (this.checkpoints.length >= 1_024) return Promise.reject(new Error("模型请求指标等待队列已满"));
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        signal?.removeEventListener("abort", abort);
        const index = this.checkpoints.indexOf(checkpoint);
        if (index !== -1) this.checkpoints.splice(index, 1);
      };
      const abort = (): void => {
        cleanup();
        reject(signal?.reason instanceof Error ? signal.reason : new Error("模型请求指标等待已取消"));
      };
      const checkpoint: WriteCheckpoint = { target, matches: matchesScope,
        resolve: succeeded => { cleanup(); resolve(succeeded); } };
      this.checkpoints.push(checkpoint);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    this.drainTask ??= (async () => {
      const deadline = Date.now() + 5_000;
      let expired = false;
      await this.task;
      while (this.pending.length > 0) {
        if (Date.now() >= deadline) {
          expired = true;
          const entries = this.pending.splice(0);
          this.markFailed(entries);
          this.pendingBytes = 0;
          this.pendingRelay = 0;
          this.processedCount = entries.at(-1)!.sequence;
          for (const checkpoint of this.checkpoints.splice(0)) checkpoint.resolve(false);
          this.report(new Error("指标关闭排空预算耗尽，剩余样本未写入"));
          break;
        }
        await this.flushBatch();
      }
      if (expired) throw new Error("指标关闭排空预算耗尽");
    })();
    const drain = this.drainTask;
    this.closeTask ??= (async () => {
      try { await drain; }
      finally { await this.store.close(); }
    })().finally(() => { this.closeTask = undefined; });
    const close = this.closeTask;
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      close,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("指标写入器关闭尚未确认")), 5_000); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.task || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.task = this.flushBatch().finally(() => {
        this.task = undefined;
        if (this.pending.length > 0) this.scheduleFlush();
      });
    }, flushDelayMs);
    this.flushTimer.unref?.();
  }

  private async flushBatch(): Promise<void> {
    const entries = this.pending.splice(0, maximumBatchSize);
    if (entries.length === 0) return;
    this.active = entries;
    let committed = false;
    try {
      if (this.store.recordBatch) {
        try { await this.store.recordBatch(entries.map(entry => entry.sample)); committed = true; }
        catch (error) { this.markFailed(entries); this.report(error); }
      } else {
        for (const entry of entries) {
          try {
            if (!this.store.record) throw new Error("指标写入端口缺失");
            await this.store.record(entry.sample);
            committed = true;
          } catch (error) { this.markFailed([entry]); this.report(error); }
        }
      }
    } finally {
      this.pendingRelay -= entries.filter(entry => entry.sample.source === "relay").length;
      this.pendingBytes -= entries.reduce((sum, entry) => sum + entry.bytes, 0);
      this.processedCount = entries.at(-1)!.sequence;
      this.active = [];
      for (let index = this.checkpoints.length - 1; index >= 0; index--) {
        const checkpoint = this.checkpoints[index]!;
        if (checkpoint.target > this.processedCount) continue;
        this.checkpoints.splice(index, 1);
        checkpoint.resolve(this.succeeded(checkpoint.target, checkpoint.matches));
      }
    }
    if (committed) {
      try { this.onCommitted?.(); } catch (error) { this.report(error); }
    }
  }

  private markFailed(entries: readonly WriteEntry[]): void {
    for (const entry of entries) this.recordFailure(entry.sample, entry.sequence);
  }

  private recordFailure(scope: WriteScope, sequence: number): void {
    const existing = this.failures.find(entry => entry.sample.threadId === scope.threadId && entry.sample.turnId === scope.turnId
      && (entry.sample.requestPurpose ?? null) === (scope.requestPurpose ?? null));
    if (existing) { existing.sequence = Math.min(existing.sequence, sequence); return; }
    if (this.failures.length >= maximumPendingRecords) { this.failureOverflow = true; return; }
    this.failures.push({ sequence, sample: { threadId: scope.threadId, turnId: scope.turnId, requestPurpose: scope.requestPurpose ?? null } });
  }

  private succeeded(target: number, matchesScope: (scope: WriteScope) => boolean): boolean {
    return !this.failureOverflow && !this.failures.some(entry => entry.sequence <= target && matchesScope(entry.sample));
  }

  private report(error: unknown): void {
    try { this.onError?.(error instanceof Error ? error : new Error("指标写入失败")); } catch { /* Failure reporting cannot strand a watermark. */ }
  }
}

function scopeMatcher(scopes: readonly { threadId: string; turnId?: string }[], requestPurpose: "autoApprovalReview" | null): (scope: WriteScope) => boolean {
  const threads = new Map<string, Set<string> | undefined>();
  for (const scope of scopes) {
    if (threads.has(scope.threadId) && threads.get(scope.threadId) === undefined) continue;
    if (scope.turnId === undefined) threads.set(scope.threadId, undefined);
    else {
      const turns = threads.get(scope.threadId) ?? new Set<string>();
      turns.add(scope.turnId);
      threads.set(scope.threadId, turns);
    }
  }
  return scope => {
    // Thread/task summaries only consume requests attributed to a concrete Turn.
    if (scope.threadId === null || scope.turnId === null || !threads.has(scope.threadId) || (scope.requestPurpose ?? null) !== requestPurpose) return false;
    const turns = threads.get(scope.threadId);
    return turns === undefined || turns.has(scope.turnId);
  };
}
