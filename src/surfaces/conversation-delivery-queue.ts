import type { Logger } from "pino";

import { BoundedAsyncQueue } from "../event-bus/index.js";

interface DeliveryOperation {
  critical: boolean;
  run(): Promise<void>;
}

interface ConversationWorker {
  queue: BoundedAsyncQueue<DeliveryOperation>;
  done: Promise<void>;
}

export interface ConversationDeliveryQueueOptions {
  component: string;
  capacity?: number;
  closeTimeoutMs?: number;
  errorMetadata?(error: unknown): Record<string, unknown>;
}

export class ConversationDeliveryQueue {
  private readonly workers = new Map<string, ConversationWorker>();
  private readonly capacity: number;
  private readonly closeTimeoutMs: number;
  private closed = false;

  constructor(
    private readonly logger: Logger,
    private readonly options: ConversationDeliveryQueueOptions,
  ) {
    this.capacity = options.capacity ?? 200;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    if (!Number.isInteger(this.capacity) || this.capacity <= 0) {
      throw new Error("Conversation 输出队列容量必须是正整数");
    }
    if (!Number.isInteger(this.closeTimeoutMs) || this.closeTimeoutMs <= 0) {
      throw new Error("Conversation 输出队列关闭超时必须是正整数");
    }
  }

  enqueue(
    conversationId: string,
    run: () => Promise<void>,
    critical: boolean,
  ): boolean {
    if (this.closed) {
      return false;
    }
    let worker = this.workers.get(conversationId);
    if (!worker) {
      const queue = new BoundedAsyncQueue<DeliveryOperation>(this.capacity);
      worker = {
        queue,
        done: this.runWorker(conversationId, queue),
      };
      this.workers.set(conversationId, worker);
    }
    const accepted = worker.queue.push({ critical, run }, critical);
    if (!accepted) {
      this.logger.warn(
        {
          component: this.options.component,
          conversationId,
          critical,
        },
        "Surface Conversation 输出队列已满，输出未入队",
      );
    }
    return accepted;
  }

  runOrdered<T>(
    conversationId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new Error(`${this.options.component} Conversation 输出队列已关闭`),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const accepted = this.enqueue(conversationId, async () => {
        try {
          resolve(await run());
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error(`${this.options.component} Conversation 输出操作失败`),
          );
        }
      }, true);
      if (!accepted) {
        reject(
          new Error(`${this.options.component} Conversation 输出队列已满，操作未入队`),
        );
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const worker of this.workers.values()) {
      worker.queue.close();
    }
    const completed = await waitAtMost(
      Promise.allSettled([...this.workers.values()].map((worker) => worker.done)),
      this.closeTimeoutMs,
    );
    if (!completed) {
      this.logger.warn(
        {
          component: this.options.component,
          conversations: this.workers.size,
          closeTimeoutMs: this.closeTimeoutMs,
        },
        "Surface Conversation 输出队列关闭等待超时",
      );
    }
    this.workers.clear();
  }

  private async runWorker(
    conversationId: string,
    queue: BoundedAsyncQueue<DeliveryOperation>,
  ): Promise<void> {
    while (true) {
      const operation = await queue.shift();
      if (!operation) {
        return;
      }
      try {
        await operation.run();
      } catch (error) {
        this.logger.warn(
          {
            ...(this.options.errorMetadata?.(error) ?? {
              errorType: error instanceof Error ? error.name : typeof error,
            }),
            component: this.options.component,
            conversationId,
            critical: operation.critical,
          },
          "Surface Conversation 输出失败",
        );
      }
      if (queue.size === 0) {
        const current = this.workers.get(conversationId);
        if (current?.queue === queue) {
          this.workers.delete(conversationId);
        }
        return;
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
