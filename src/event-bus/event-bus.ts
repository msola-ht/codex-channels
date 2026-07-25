import type { Logger } from "pino";

import { BoundedAsyncQueue } from "./bounded-queue.js";

const closeTimeoutMs = 5_000;

interface Subscription<T> {
  name: string;
  queue: BoundedAsyncQueue<T>;
  worker: Promise<void>;
}

export class EventBus<T> {
  private readonly subscriptions = new Set<Subscription<T>>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly logger: Logger,
    private readonly defaultCapacity = 1_000,
  ) {}

  subscribe(
    name: string,
    handler: (event: T) => Promise<void> | void,
    capacity = this.defaultCapacity,
  ): () => void {
    if (this.closed) {
      throw new Error("事件总线已关闭");
    }
    const queue = new BoundedAsyncQueue<T>(capacity);
    const subscription: Subscription<T> = {
      name,
      queue,
      worker: this.runWorker(name, queue, handler),
    };
    this.subscriptions.add(subscription);
    return () => {
      queue.close();
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
    const workers: Promise<void>[] = [];
    for (const subscription of this.subscriptions) {
      subscription.queue.close();
      workers.push(subscription.worker);
    }
    const consumerCount = this.subscriptions.size;
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
    handler: (event: T) => Promise<void> | void,
  ): Promise<void> {
    while (true) {
      const event = await queue.shift();
      if (event === undefined) {
        return;
      }
      try {
        await handler(event);
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
