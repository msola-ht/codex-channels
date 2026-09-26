import type { Logger } from "pino";

import { BoundedAsyncQueue } from "../event-bus/index.js";
import { surfaceErrorMetadata } from "./error-metadata.js";

interface DeliveryOperation {
  critical: boolean;
  enqueuedAt: number;
  run(signal: AbortSignal): Promise<void>;
}

interface ConversationWorker {
  queue: BoundedAsyncQueue<DeliveryOperation>;
  controller: AbortController;
  done: Promise<void>;
}

export interface ConversationDeliveryQueueOptions {
  component: string;
  capacity?: number;
  closeTimeoutMs?: number;
  drainOnClose?: boolean;
  operationTimeoutMs?: number;
  errorMetadata?(error: unknown): Record<string, unknown>;
}

export class ConversationDeliveryQueue {
  private readonly workers = new Map<string, ConversationWorker>();
  private readonly capacity: number;
  private readonly closeTimeoutMs: number;
  private closed = false;
  private stopped = false;
  private readonly orderedCancellations = new Set<() => void>();
  private closePromise: Promise<void> | undefined;

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
    if (options.operationTimeoutMs !== undefined && (!Number.isInteger(options.operationTimeoutMs) || options.operationTimeoutMs <= 0)) {
      throw new Error("Conversation 输出操作超时必须是正整数");
    }
  }

  enqueue(
    conversationId: string,
    run: (signal: AbortSignal) => Promise<void>,
    critical: boolean,
  ): boolean {
    if (this.closed) {
      return false;
    }
    const worker = this.worker(conversationId);
    const accepted = worker.queue.push({ critical, run, enqueuedAt: performance.now() }, critical);
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
    run: (signal: AbortSignal) => Promise<T>,
    requestSignal?: AbortSignal,
  ): Promise<T> {
    if (requestSignal?.aborted) {
      return Promise.reject(new Error(`${this.options.component} Conversation 输出操作已取消`));
    }
    if (this.closed) {
      return Promise.reject(
        new Error(`${this.options.component} Conversation 输出队列已关闭`),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const worker = this.worker(conversationId);
      const cancellation = new AbortController();
      let started = false;
      let settled = false;
      const cleanup = (): void => {
        requestSignal?.removeEventListener("abort", cancelQueued);
        this.orderedCancellations.delete(cancel);
      };
      const cancel = (): void => {
        if (settled) return;
        settled = true;
        cancellation.abort();
        worker.queue.remove(operation);
        cleanup();
        reject(new Error(`${this.options.component} Conversation 输出操作已取消`));
      };
      const cancelQueued = (): void => { if (!started) cancel(); };
      const operation: DeliveryOperation = {
        critical: true,
        enqueuedAt: performance.now(),
        run: async (signal) => {
          if (settled) return;
          started = true;
          try {
            const combined = AbortSignal.any([signal, cancellation.signal, ...(requestSignal ? [requestSignal] : [])]);
            combined.throwIfAborted();
            resolve(await run(combined));
          } catch (error) {
            reject(
              error instanceof Error
                ? error
                : new Error(`${this.options.component} Conversation 输出操作失败`),
            );
          } finally {
            settled = true;
            cleanup();
          }
        },
      };
      this.orderedCancellations.add(cancel);
      requestSignal?.addEventListener("abort", cancelQueued, { once: true });
      const accepted = worker.queue.pushPriority(operation);
      if (!accepted) {
        cleanup();
        this.logger.warn(
          {
            component: this.options.component,
            conversationId,
            critical: true,
          },
          "Surface Conversation 输出队列已满，优先操作未入队",
        );
        reject(
          new Error(`${this.options.component} Conversation 输出队列已满，操作未入队`),
        );
      }
    });
  }

  private worker(conversationId: string): ConversationWorker {
    let worker = this.workers.get(conversationId);
    if (!worker) {
      const queue = new BoundedAsyncQueue<DeliveryOperation>(this.capacity, (state) => {
        this.logger.warn({ component: this.options.component, conversationId, ...state },
          "关键输出积压超过队列容量，继续保留待投递输出");
      });
      const controller = new AbortController();
      worker = {
        queue,
        controller,
        done: this.runWorker(conversationId, queue, controller.signal),
      };
      this.workers.set(conversationId, worker);
    }
    return worker;
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    for (const cancel of [...this.orderedCancellations]) cancel();
    for (const worker of this.workers.values()) {
      worker.queue.close();
      if (!this.options.drainOnClose) worker.controller.abort();
    }
    const conversationCount = this.workers.size;
    this.closePromise = this.finishClose(conversationCount);
    return this.closePromise;
  }

  private async finishClose(conversationCount: number): Promise<void> {
    const completed = await waitAtMost(
      Promise.allSettled([...this.workers.values()].map((worker) => worker.done)),
      this.closeTimeoutMs,
    );
    if (!completed) {
      this.stopped = true;
      for (const worker of this.workers.values()) {
        worker.controller.abort();
        while (worker.queue.size > 0) await worker.queue.shift();
      }
      this.logger.warn(
        {
          component: this.options.component,
          conversations: conversationCount,
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
    signal: AbortSignal,
  ): Promise<void> {
    while (true) {
      const operation = await queue.shift();
      if (!operation || this.stopped) {
        return;
      }
      const startedAt = performance.now();
      const deadline = new AbortController();
      const timer = this.options.operationTimeoutMs === undefined ? undefined
        : setTimeout(() => deadline.abort(new Error("渠道投递任务超过恢复预算")), this.options.operationTimeoutMs);
      timer?.unref();
      const deliverySignal = AbortSignal.any([signal, deadline.signal]);
      try {
        await operation.run(deliverySignal);
      } catch (error) {
        this.logger.warn(
          {
            ...(this.options.errorMetadata?.(error)
              ?? surfaceErrorMetadata(error)),
            component: this.options.component,
            conversationId,
            critical: operation.critical,
            queueWaitMs: Math.round(startedAt - operation.enqueuedAt),
            elapsedMs: Math.round(performance.now() - startedAt),
            deadlineExceeded: deadline.signal.aborted,
          },
          "Surface Conversation 输出失败",
        );
      } finally {
        clearTimeout(timer);
        if (operation.critical && this.options.operationTimeoutMs !== undefined) {
          this.logger.debug({ component: this.options.component, conversationId,
            queueWaitMs: Math.round(startedAt - operation.enqueuedAt), elapsedMs: Math.round(performance.now() - startedAt),
            deadlineExceeded: deadline.signal.aborted }, "Surface Conversation 输出任务已结束");
        }
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
