import type { Logger } from "pino";

import { BoundedAsyncQueue } from "./bounded-queue.js";

interface Subscription<T> {
  name: string;
  queue: BoundedAsyncQueue<T>;
  worker: Promise<void>;
}

export class EventBus<T> {
  private readonly subscriptions = new Set<Subscription<T>>();

  constructor(
    private readonly logger: Logger,
    private readonly defaultCapacity = 1_000,
  ) {}

  subscribe(
    name: string,
    handler: (event: T) => Promise<void> | void,
    capacity = this.defaultCapacity,
  ): () => void {
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

  async close(): Promise<void> {
    const workers: Promise<void>[] = [];
    for (const subscription of this.subscriptions) {
      subscription.queue.close();
      workers.push(subscription.worker);
    }
    this.subscriptions.clear();
    await Promise.allSettled(workers);
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
