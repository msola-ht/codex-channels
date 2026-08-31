import type { Logger } from "pino";

import { BoundedAsyncQueue } from "./bounded-queue.js";

const closeTimeoutMs = 5_000;

interface Subscription<T> {
  name: string;
  queue: BoundedAsyncQueue<T>;
  controller: AbortController;
  worker: Promise<void>;
}

export class EventBus<T> {
  private readonly subscriptions = new Set<Subscription<T>>();
  private readonly workers = new Set<Promise<void>>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly logger: Logger,
    private readonly defaultCapacity = 1_000,
  ) {}

  subscribe(
    name: string,
    handler: (event: T, signal: AbortSignal) => Promise<void> | void,
    capacity = this.defaultCapacity,
  ): () => void {
    if (this.closed) {
      throw new Error("事件总线已关闭");
    }
    const queue = new BoundedAsyncQueue<T>(capacity);
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
    for (const subscription of this.subscriptions) {
      if (!subscription.queue.push(event, critical)) {
        this.logger.warn({ consumer: subscription.name, critical }, "事件队列已满，事件未入队");
      }
    }
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
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
    queue: BoundedAsyncQueue<T>,
    handler: (event: T, signal: AbortSignal) => Promise<void> | void,
    signal: AbortSignal,
  ): Promise<void> {
    while (true) {
      const event = await queue.shift();
      if (event === undefined) {
        return;
      }
      try {
        await handler(event, signal);
      } catch (error) {
        this.logger.error({ err: error, consumer: name }, "事件消费者执行失败");
      }
    }
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
