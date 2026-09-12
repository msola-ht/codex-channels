import type {
  ModelRequestMetricSample,
  ModelRequestMetricsStore,
  ModelRequestMetricsWriter,
} from "./request-metrics.js";

const maximumPendingRecords = 10_000;
const maximumBatchSize = 32;
const flushDelayMs = 10;

interface WriteCheckpoint {
  target: number;
  threadId: string | undefined;
  turnId: string | undefined;
  succeeded: boolean;
  resolve: (succeeded: boolean) => void;
}

export class BufferedModelRequestMetricsWriter implements ModelRequestMetricsWriter {
  private readonly pending: ModelRequestMetricSample[] = [];
  private readonly checkpoints: WriteCheckpoint[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private enqueuedCount = 0;
  private processedCount = 0;
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
    this.enqueuedCount += 1;
    this.scheduleFlush();
  }

  waitForCurrentWrites(threadId?: string, turnId?: string): Promise<boolean> {
    const target = this.currentTarget(threadId, turnId);
    if (this.processedCount >= target) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.checkpoints.push({ target, threadId, turnId, succeeded: true, resolve });
    });
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

  private currentTarget(threadId?: string, turnId?: string): number {
    if (threadId === undefined) return this.enqueuedCount;
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const sample = this.pending[index]!;
      if (
        sample.threadId === threadId
        && (turnId === undefined || sample.turnId === turnId)
      ) {
        return this.processedCount + index + 1;
      }
    }
    return this.processedCount;
  }

  private flushBatch(): void {
    const samples = this.pending.splice(0, maximumBatchSize);
    if (samples.length === 0) return;
    const firstSequence = this.processedCount + 1;
    try {
      if (this.store.recordBatch) {
        try {
          this.store.recordBatch(samples);
        } catch (error) {
          this.markFailedSamples(samples, firstSequence);
          this.onError?.(asError(error));
        }
      } else {
        for (const [index, sample] of samples.entries()) {
          try {
            this.store.record(sample);
          } catch (error) {
            this.markFailedSamples([sample], firstSequence + index);
            this.onError?.(asError(error));
          }
        }
      }
    } finally {
      this.processedCount += samples.length;
      this.resolveCheckpoints();
    }
  }

  private markFailedSamples(
    samples: readonly ModelRequestMetricSample[],
    firstSequence: number,
  ): void {
    for (const checkpoint of this.checkpoints) {
      if (firstSequence > checkpoint.target) continue;
      const relevant = samples.some((sample, index) =>
        firstSequence + index <= checkpoint.target
        && (checkpoint.threadId === undefined
          || checkpoint.threadId === sample.threadId)
        && (checkpoint.turnId === undefined
          || checkpoint.turnId === sample.turnId));
      if (relevant) checkpoint.succeeded = false;
    }
  }

  private resolveCheckpoints(): void {
    let writeIndex = 0;
    for (const checkpoint of this.checkpoints) {
      if (checkpoint.target <= this.processedCount) {
        checkpoint.resolve(checkpoint.succeeded);
      } else {
        this.checkpoints[writeIndex] = checkpoint;
        writeIndex += 1;
      }
    }
    this.checkpoints.length = writeIndex;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
