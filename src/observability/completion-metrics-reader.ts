import { Worker } from "node:worker_threads";
import type { SqliteModelRequestMetricsStore } from "./sqlite-request-metrics-store.js";

type Method = "threadTurnSummary" | "threadTurnTaskSummary" | "threadSummary";
export type CompletionMetricsRequest = {
  id: number;
  method: Method;
  threadId: string;
  turnId: string;
};
type Result = ReturnType<SqliteModelRequestMetricsStore[Method]>;
export type CompletionMetricsResponse = { id: number; ok: true; value: Result }
  | { id: number; ok: false };

/** Optional completion statistics must never block the Gateway event loop. */
export class CompletionMetricsReader {
  private worker: Worker | undefined;
  private terminating: Promise<void> | undefined;
  private closed = false;
  private retryAfter = 0;
  private sequence = 0;
  private readonly pending = new Map<number, {
    resolve: (value: Result) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly path: string) {}

  query<M extends Method>(
    method: M,
    threadId: string,
    turnId = "",
  ): Promise<ReturnType<SqliteModelRequestMetricsStore[M]>> {
    if (this.closed || this.terminating || Date.now() < this.retryAfter) {
      return Promise.reject(new Error("完成统计读取暂不可用"));
    }
    if (this.pending.size >= 32) {
      return Promise.reject(new Error("完成统计读取队列已满"));
    }
    if (!this.worker) {
      const worker = this.worker = new Worker(new URL("./completion-metrics-worker.js", import.meta.url), {
        workerData: { path: this.path },
      });
      worker.on("message", (response: CompletionMetricsResponse) => {
        const pending = this.pending.get(response.id);
        if (!pending) return;
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        if (response.ok) pending.resolve(response.value);
        else pending.reject(new Error("完成统计查询失败"));
      });
      worker.on("error", () => { if (this.worker === worker) this.stopWorker(); });
      worker.on("exit", () => {
        if (this.worker === worker) this.stopWorker();
      });
      worker.unref();
    }
    const id = ++this.sequence;
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => this.stopWorker(), 4_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker!.postMessage({ id, method, threadId, turnId } satisfies CompletionMetricsRequest);
      } catch {
        this.stopWorker();
      }
    }) as Promise<ReturnType<SqliteModelRequestMetricsStore[M]>>;
  }

  private stopWorker(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("完成统计读取已停止或超时"));
    }
    this.pending.clear();
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    this.retryAfter = Date.now() + 30_000;
    this.terminating = worker.terminate().then(() => undefined, () => undefined)
      .finally(() => { this.terminating = undefined; });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopWorker();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.terminating,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
