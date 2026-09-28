import { AsyncLocalStorage } from "node:async_hooks";

export interface DeliveryCheckpoint {
  operation: string;
  state: "started" | "confirmed" | "rejected";
  messageId?: string;
}

const context = new AsyncLocalStorage<DeliveryReceipt>();

/** Tracks the actual queued operations produced by one durable output, including nested enqueues. */
export class DeliveryReceipt {
  private pending = 1;
  private retained = false;
  private failure: unknown;
  private contentIncomplete = false;
  private completeContentConfirmed = false;
  private resolve!: () => void;
  private reject!: (error: unknown) => void;
  readonly done = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  readonly controller = new AbortController();

  constructor(readonly checkpoint: (value: DeliveryCheckpoint) => Promise<void>, signal: AbortSignal) {
    void this.done.catch(() => {});
    const abort = (): void => {
      this.controller.abort();
      this.reject(new Error("可靠投递已取消"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void this.done.then(() => signal.removeEventListener("abort", abort), () => signal.removeEventListener("abort", abort));
  }

  static current(): DeliveryReceipt | undefined { return context.getStore(); }
  run<T>(call: () => T): T { return context.run(this, call); }
  retain(): () => void {
    this.retained = true;
    this.pending++;
    let released = false;
    return () => { if (!released) { released = true; this.release(); } };
  }
  markContentIncomplete(): void { this.contentIncomplete = true; }
  /** Only a confirmed artifact containing the original full result can satisfy this. */
  confirmCompleteContent(): void { this.completeContentConfirmed = true; }
  needsCompleteContent(): boolean { return this.contentIncomplete && !this.completeContentConfirmed; }
  fail(error: unknown): void { this.failure ??= error; this.controller.abort(); }
  async record(value: DeliveryCheckpoint): Promise<void> {
    try { await this.checkpoint(value); }
    catch (error) { this.fail(error); throw error; }
  }
  release(): void {
    if (--this.pending !== 0) return;
    if (this.failure) this.reject(this.failure);
    else if (this.needsCompleteContent()) this.reject(new Error("可靠结果内容未完整确认"));
    else if (!this.retained) this.reject(new Error("可靠输出未产生投递操作"));
    else this.resolve();
  }
}

export async function captureDelivery(
  call: () => void,
  signal: AbortSignal,
  checkpoint: (value: DeliveryCheckpoint) => Promise<void>,
): Promise<void> {
  signal.throwIfAborted();
  const receipt = new DeliveryReceipt(checkpoint, signal);
  try { receipt.run(call); } catch (error) { receipt.fail(error); }
  finally { receipt.release(); }
  await receipt.done;
}

export async function checkpointDelivery<T>(operation: string, call: () => Promise<T>, definitelyRejected?: (error: unknown) => boolean): Promise<T> {
  const receipt = DeliveryReceipt.current();
  if (!receipt) return call();
  receipt.controller.signal.throwIfAborted();
  await receipt.record({ operation, state: "started" });
  receipt.controller.signal.throwIfAborted();
  let result: T;
  try { result = await call(); }
  catch (error) {
    if (definitelyRejected?.(error)) await receipt.record({ operation, state: "rejected" });
    else receipt.fail(error);
    throw error;
  }
  const candidate: unknown = typeof result === "string" || typeof result === "number" ? result
    : result && typeof result === "object" && "message_id" in result ? result.message_id
    : result && typeof result === "object" && "messageId" in result ? result.messageId : undefined;
  const messageId = (typeof candidate === "string" || typeof candidate === "number") && String(candidate).length <= 256
    ? String(candidate) : undefined;
  await receipt.record({ operation, state: "confirmed", ...(messageId === undefined ? {} : { messageId }) });
  return result;
}
