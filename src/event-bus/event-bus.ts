import type { Logger } from "pino";

import { BoundedAsyncQueue } from "./bounded-queue.js";

const closeTimeoutMs = 5_000;

interface QueuedEvent<T> {
  event: T;
  enqueuedAt: number;
  bytes: number;
}

interface EventBusBudget<T> {
  entries: number;
  bytes: number;
  size(event: T): number;
  overflow(): void;
}

interface Subscription<T> {
  name: string;
  queue: BoundedAsyncQueue<QueuedEvent<T>>;
  controller: AbortController;
  worker: Promise<void>;
}

export class EventBus<T> {
  private readonly subscriptions = new Set<Subscription<T>>();
  private readonly workers = new Set<Promise<void>>();
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readonly observers = new Set<(event: T) => void>();
  private pendingEntries = 0;
  private pendingBytes = 0;
  private overloaded = false;
  private shedEvents = 0;

  constructor(
    private readonly logger: Logger,
    private readonly defaultCapacity = 1_000,
    private readonly coalesceKey?: (event: T) => string | undefined,
    private readonly budget?: EventBusBudget<T>,
  ) {}

  subscribe(
    name: string,
    handler: (event: T, signal: AbortSignal, queueWaitMs: number) => Promise<void> | void,
    capacity = this.defaultCapacity,
  ): () => void {
    if (this.closed) {
      throw new Error("事件总线已关闭");
    }
    const queue = new BoundedAsyncQueue<QueuedEvent<T>>(capacity, (state) => {
      this.logger.warn({ consumer: name, ...state }, "关键事件积压超过队列容量，继续保留待投递事件");
    }, undefined, (entry) => this.release(entry));
    const controller = new AbortController();
    const worker = this.runWorker(name, queue, handler, controller.signal);
    this.workers.add(worker);
    void worker.then(
      () => this.workers.delete(worker),
      () => this.workers.delete(worker),
    );
    const subscription: Subscription<T> = {
      name,
      queue,
      controller,
      worker,
    };
    this.subscriptions.add(subscription);
    return () => {
      queue.close();
      controller.abort();
      this.subscriptions.delete(subscription);
    };
  }

  publish(event: T, critical = false): void {
    if (this.closed || this.overloaded) return;
    for (const observer of this.observers) observer(event);
    const key = this.coalesceKey?.(event);
    const bytes = this.budget?.size(event) ?? 0;
    if (this.budget && (this.pendingEntries + this.subscriptions.size > this.budget.entries
      || this.pendingBytes + bytes * this.subscriptions.size > this.budget.bytes)) {
      if (critical) {
        this.overloaded = true;
        this.budget.overflow();
      } else {
        this.shedEvents++;
        if (this.shedEvents === 1 || Number.isInteger(Math.log2(this.shedEvents))) {
          this.logger.warn({ shedEvents: this.shedEvents, pendingEntries: this.pendingEntries, pendingBytes: this.pendingBytes }, "事件硬预算耗尽，非关键事件未接收");
        }
      }
      return;
    }
    for (const subscription of this.subscriptions) {
      const queued = { event, enqueuedAt: performance.now(), bytes };
      this.pendingEntries++;
      this.pendingBytes += bytes;
      if (!subscription.queue.push(queued, critical, key)) {
        this.release(queued);
        this.logger.warn({ consumer: subscription.name, critical }, "事件队列已满，事件未入队");
      }
    }
  }

  /** Synchronous bounded admission only; observers must never perform blocking I/O or await delivery. */
  observe(observer: (event: T) => void): () => void {
    if (this.closed) throw new Error("事件总线已关闭");
    this.observers.add(observer);
    return () => { this.observers.delete(observer); };
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.observers.clear();
    for (const subscription of this.subscriptions) {
      subscription.queue.close();
      subscription.controller.abort();
    }
    const workers = [...this.workers];
    const consumerCount = workers.length;
    this.subscriptions.clear();
    this.closePromise = waitAtMost(
      Promise.allSettled(workers),
      closeTimeoutMs,
    ).then((completed) => {
      if (!completed) {
        this.logger.warn(
          {
            consumers: consumerCount,
            closeTimeoutMs,
          },
          "事件总线关闭等待超时",
        );
      }
    });
    return this.closePromise;
  }

  private async runWorker(
    name: string,
    queue: BoundedAsyncQueue<QueuedEvent<T>>,
    handler: (event: T, signal: AbortSignal, queueWaitMs: number) => Promise<void> | void,
    signal: AbortSignal,
  ): Promise<void> {
    while (true) {
      const queued = await queue.shift();
      if (queued === undefined) {
        return;
      }
      try {
        await handler(queued.event, signal, Math.max(0, Math.round(performance.now() - queued.enqueuedAt)));
      } catch (error) {
        this.logger.error({ err: error, consumer: name }, "事件消费者执行失败");
      } finally {
        this.release(queued);
      }
    }
  }

  private release(queued: QueuedEvent<T>): void {
    this.pendingEntries--;
    this.pendingBytes -= queued.bytes;
  }
}

async function waitAtMost<T>(
  operation: Promise<T>,
  milliseconds: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
    timer.unref();
  });
  try {
    return await Promise.race([
      operation.then(() => true),
      timeout,
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
