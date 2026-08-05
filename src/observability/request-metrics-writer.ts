import type {
  ModelRequestMetricSample,
  ModelRequestMetricsStore,
  ModelRequestMetricsWriter,
} from "./request-metrics.js";

const maximumPendingRecords = 10_000;
const maximumBatchSize = 1;
const flushDelayMs = 10;

export class BufferedModelRequestMetricsWriter implements ModelRequestMetricsWriter {
  private readonly pending: ModelRequestMetricSample[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    private readonly store: ModelRequestMetricsStore,
    private readonly onError?: (error: Error) => void,
  ) {}

  enqueue(sample: ModelRequestMetricSample): void {
    if (this.closed) throw new Error("模型请求指标写入器已关闭");
    if (this.pending.length >= maximumPendingRecords) {
      throw new Error("模型请求指标待写队列已满");
    }
    this.pending.push(sample);
    this.scheduleFlush();
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    while (this.pending.length > 0) this.flushBatch();
    this.store.close();
    return Promise.resolve();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushBatch();
      if (this.pending.length > 0) this.scheduleFlush();
    }, flushDelayMs);
    this.flushTimer.unref?.();
  }

  private flushBatch(): void {
    for (const sample of this.pending.splice(0, maximumBatchSize)) {
      try {
        this.store.record(sample);
      } catch (error) {
        this.onError?.(asError(error));
      }
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
