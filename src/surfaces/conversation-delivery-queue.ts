import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import { BoundedAsyncQueue } from "../event-bus/index.js";
import { observeSurfaceStage, surfaceDiagnosticContext, withSurfaceDiagnosticContext } from "./diagnostics.js";
import { DeliveryReceipt } from "./delivery-receipt.js";

interface DeliveryOperation {
  critical: boolean;
  enqueuedAt: number;
  context: ReturnType<typeof surfaceDiagnosticContext>;
  purpose: "output" | "ordered" | "answer" | "operation-log" | "turn-completion";
  requestSignal?: AbortSignal;
  run(signal: AbortSignal): Promise<void>;
  receipt?: DeliveryReceipt;
  release?: () => void;
  cleanup?: () => void;
  settled?: () => void;
}

export interface ConversationDeliveryOptions {
  /**
   * 同一 Conversation 内仍在等待执行的同键输出只保留最新一份。
   * 用于按秒刷新的中间状态：既不让它无限积压，也不在平台变慢时静默丢弃。
   */
  coalesceKey?: string;
  purpose?: DeliveryOperation["purpose"];
  signal?: AbortSignal;
  /** Called after execution or removal, once the queue no longer owns the operation. */
  settled?: () => void;
}

interface ConversationWorker {
  queue: BoundedAsyncQueue<DeliveryOperation>;
  controller: AbortController;
  done: Promise<void>;
}

export interface ConversationDeliveryQueueOptions {
  component: string;
  capacity?: number;
  /** 路由层逐 Token 入队时可关闭普通调试阶段，保留终态与警告。 */
  logIntermediateStages?: boolean;
  closeTimeoutMs?: number;
  /** 普通输出可在关闭期限内排空；有序交互仍立即取消。 */
  drainOnClose?: boolean;
  maximumPendingOperations?: number;
  onOverload?(): void;
  errorMetadata?(error: unknown): Record<string, unknown>;
}

export class ConversationDeliveryQueue {
  private readonly workers = new Map<string, ConversationWorker>();
  private readonly capacity: number;
  private readonly stageLogger: Pick<Logger, "debug" | "info" | "warn">;
  private readonly closeTimeoutMs: number;
  private closed = false;
  private stopped = false;
  private readonly orderedCancellations = new Set<() => void>();
  private closePromise: Promise<void> | undefined;
  private pendingOperations = 0;

  constructor(
    private readonly logger: Logger,
    private readonly options: ConversationDeliveryQueueOptions,
  ) {
    this.stageLogger = options.logIntermediateStages === false
      ? { debug: () => {}, info: logger.info.bind(logger), warn: logger.warn.bind(logger) }
      : logger;
    this.capacity = options.capacity ?? 200;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    if (!Number.isInteger(this.capacity) || this.capacity <= 0) {
      throw new Error("Conversation 输出队列容量必须是正整数");
    }
    if (!Number.isInteger(this.closeTimeoutMs) || this.closeTimeoutMs <= 0) {
      throw new Error("Conversation 输出队列关闭超时必须是正整数");
    }
    if (options.maximumPendingOperations !== undefined
      && (!Number.isSafeInteger(options.maximumPendingOperations) || options.maximumPendingOperations <= 0)) throw new Error("输出操作硬上限必须是正整数");
  }

  enqueue(
    conversationId: string,
    run: (signal: AbortSignal) => Promise<void>,
    critical: boolean,
    options?: ConversationDeliveryOptions,
  ): boolean {
    if (this.closed) {
      DeliveryReceipt.current()?.fail(new Error("可靠输出队列已关闭"));
      this.logger.warn({ ...surfaceDiagnosticContext(), component: this.options.component,
        conversationId, critical, reason: "closed" }, "Surface 输出未入队");
      return false;
    }
    if (DeliveryReceipt.current()?.controller.signal.aborted || options?.signal?.aborted) return false;
    const replacesPending = options?.coalesceKey !== undefined
      && this.workers.get(conversationId)?.queue.hasPendingKey(options.coalesceKey) === true;
    if (!replacesPending && !this.hasCapacity()) return false;
    const worker = this.worker(conversationId);
    const operation = this.operation(conversationId, critical, run, options?.purpose);
    if (options?.signal) operation.requestSignal = options.signal;
    if (options?.settled) operation.settled = options.settled;
    const accepted = worker.queue.push(operation, critical, options?.coalesceKey);
    if (accepted && (operation.receipt || options?.signal)) {
      const signal = AbortSignal.any([...(operation.receipt ? [operation.receipt.controller.signal] : []),
        ...(options?.signal ? [options.signal] : [])]);
      const cancel = (): void => {
        if (worker.queue.remove(operation)) operation.release?.();
      };
      operation.cleanup = () => signal.removeEventListener("abort", cancel);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    }
    this.stageLogger.debug({ ...operation.context, critical, accepted, pending: worker.queue.size },
      "Surface 输出入队结果");
    if (!accepted) {
      operation.receipt?.fail(new Error("可靠输出未入队"));
      operation.release?.();
      this.logger.warn(
        {
          ...operation.context,
          critical,
          pending: worker.queue.size,
          capacity: this.capacity,
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
    if (!this.hasCapacity()) return Promise.reject(new Error("输出操作硬预算已满"));
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
        if (worker.queue.remove(operation)) {
          operation.receipt?.fail(new Error("可靠输出操作已取消"));
          operation.release?.();
        }
        this.logger.debug({ ...operation.context, started, outcome: "cancelled" },
          "Surface 有序输出已取消");
        cleanup();
        reject(new Error(`${this.options.component} Conversation 输出操作已取消`));
      };
      const cancelQueued = (): void => { if (!started) cancel(); };
      const operation = this.operation(conversationId, true, async (signal) => {
        if (settled) return;
        started = true;
        try {
          signal.throwIfAborted();
          resolve(await run(signal));
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error(`${this.options.component} Conversation 输出操作失败`),
          );
          throw error;
        } finally {
          settled = true;
          cleanup();
        }
      });
      operation.purpose = "ordered";
      operation.requestSignal = requestSignal
        ? AbortSignal.any([requestSignal, cancellation.signal]) : cancellation.signal;
      this.orderedCancellations.add(cancel);
      requestSignal?.addEventListener("abort", cancelQueued, { once: true });
      const accepted = worker.queue.pushPriority(operation);
      this.logger.debug({ ...operation.context, critical: true, accepted, pending: worker.queue.size },
        "Surface 输出入队结果");
      if (!accepted) {
        cleanup();
        operation.receipt?.fail(new Error("可靠输出未入队"));
        operation.release?.();
        this.logger.warn(
          {
            ...operation.context,
            critical: true,
            pending: worker.queue.size,
            capacity: this.capacity,
          },
          "Surface Conversation 输出队列已满，优先操作未入队",
        );
        reject(
          new Error(`${this.options.component} Conversation 输出队列已满，操作未入队`),
        );
      }
    });
  }

  private operation(
    conversationId: string,
    critical: boolean,
    run: DeliveryOperation["run"],
    purpose: DeliveryOperation["purpose"] = "output",
  ): DeliveryOperation {
    const receipt = DeliveryReceipt.current();
    this.pendingOperations++;
    const releaseReceipt = receipt?.retain();
    let released = false;
    const operation: DeliveryOperation = {
      critical, run, purpose, enqueuedAt: performance.now(),
      ...(receipt ? { receipt } : {}),
      release: () => {
        if (released) return;
        released = true;
        operation.cleanup?.();
        this.pendingOperations--;
        releaseReceipt?.();
        operation.settled?.();
      },
      context: {
        ...surfaceDiagnosticContext(),
        component: this.options.component,
        conversationId,
        deliveryId: randomUUID(),
      },
    };
    return operation;
  }

  private hasCapacity(): boolean {
    if (this.pendingOperations < (this.options.maximumPendingOperations ?? Infinity)) return true;
    DeliveryReceipt.current()?.fail(new Error("可靠输出操作硬预算已满"));
    this.logger.error({ component: this.options.component, pending: this.pendingOperations }, "输出操作硬预算耗尽，未入队输出不得视为送达");
    this.options.onOverload?.();
    return false;
  }

  private worker(conversationId: string): ConversationWorker {
    let worker = this.workers.get(conversationId);
    if (!worker) {
      const queue = new BoundedAsyncQueue<DeliveryOperation>(this.capacity, (state) => {
        this.logger.warn({ component: this.options.component, conversationId, ...state },
          "关键输出积压超过队列容量，继续保留待投递输出");
      }, (state) => {
        // 平台变慢时同键中间状态会被就地替换；记录深度便于判断是否需要调整容量。
        this.logger.debug(
          { component: this.options.component, conversationId, ...state },
          "Surface Conversation 输出队列合并了同键输出",
        );
      }, (operation, reason) => {
        operation.cleanup?.();
        operation.receipt?.fail(new Error("可靠输出被替换"));
        operation.release?.();
        const fields = { ...operation.context, critical: operation.critical, reason };
        if (reason === "capacity") this.logger.warn(fields, "Surface 中间输出因积压被替换");
        else this.logger.debug(fields, "Surface 中间输出已合并");
      });
      const controller = new AbortController();
      worker = {
        queue,
        controller,
        done: DeliveryReceipt.without(() => this.runWorker(conversationId, queue, controller.signal)),
      };
      this.workers.set(conversationId, worker);
    }
    return worker;
  }

  /** 等待当前任务结束，不关闭队列；调用方须先暂停该队列的新入队。 */
  waitForIdle(): Promise<boolean> {
    return waitAtMost(
      Promise.allSettled([...this.workers.values()].map((worker) => worker.done)),
      this.closeTimeoutMs,
    );
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
      for (const [conversationId, worker] of this.workers) {
        worker.controller.abort();
        const pending = worker.queue.size;
        if (pending > 0) this.logger.warn({ component: this.options.component, conversationId, pending },
          "Surface 关闭超时，排队输出未投递");
        while (worker.queue.size > 0) {
          const operation = await worker.queue.shift();
          operation?.receipt?.fail(new Error("可靠输出未完成即关闭"));
          operation?.release?.();
        }
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
        operation?.receipt?.fail(new Error("可靠输出未完成即关闭"));
        operation?.release?.();
        return;
      }
      try {
        const operationSignal = AbortSignal.any([signal,
          ...(operation.requestSignal ? [operation.requestSignal] : []),
          ...(operation.receipt ? [operation.receipt.controller.signal] : []),
        ]);
        await withSurfaceDiagnosticContext(operation.context, () => observeSurfaceStage(
          this.stageLogger,
          {
            stage: "delivery",
            purpose: operation.purpose,
            queueWaitMs: Math.max(0, Math.round(performance.now() - operation.enqueuedAt)),
            pending: queue.size,
            critical: operation.critical,
            signal: operationSignal,
            ...(this.options.errorMetadata === undefined ? {} : {
              errorMetadata: (error: unknown) => this.options.errorMetadata!(error),
            }),
          },
          () => {
            // Ordinary output retains its existing close/drain policy. Durable
            // receipts and ordered requests must never start after cancellation.
            operation.receipt?.controller.signal.throwIfAborted();
            operation.requestSignal?.throwIfAborted();
            return operation.receipt ? operation.receipt.run(() => operation.run(operationSignal)) : DeliveryReceipt.without(() => operation.run(operationSignal));
          },
        ));
      } catch (error) {
        operation.receipt?.fail(error);
        // 诊断边界已经记录失败，继续处理后续输出。
      } finally {
        operation.release?.();
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
